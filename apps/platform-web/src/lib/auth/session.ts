import 'server-only';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import {
  clearedSessionCookie,
  createSignInState,
  sessionCookie,
  verifySignInState,
} from '@tryggsignal/identity';
import type { TenantContext } from '@tryggsignal/tenancy';

/**
 * Masterplan 178–181: sign-in happens on the tenant's own host, against the
 * tenant's own data plane, and the resulting session cookie is host-bound.
 */

export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Authentication is not configured for this environment.');
    this.name = 'AuthNotConfiguredError';
  }
}

export class SignInRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SignInRejectedError';
  }
}

function dataPlane(): { url: string; key: string } {
  // The tenant data plane is resolved from the deployment record; until the
  // per-municipality projects exist (EB-02) this is the development plane.
  const url = process.env.CONTROL_PLANE_SUPABASE_URL;
  const key = process.env.CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY;
  if (url === undefined || key === undefined) throw new AuthNotConfiguredError();
  return { url, key };
}

function stateSecret(): string {
  const secret = process.env.SIGN_IN_STATE_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new AuthNotConfiguredError();
  }
  return secret;
}

export function issueSignInState(context: TenantContext, returnTo: string): string {
  return createSignInState(context, returnTo, stateSecret()).state;
}

export function checkSignInState(context: TenantContext, state: string): string {
  return verifySignInState(state, context, stateSecret()).returnTo;
}

/**
 * Exchanges credentials for a session and stores it in the host-bound cookie.
 * The internal user must already exist and be ACTIVE: a valid token from the
 * identity provider is not by itself permission to work in a municipality
 * (masterplan 14).
 */
export async function signInWithPassword(
  context: TenantContext,
  email: string,
  password: string,
): Promise<void> {
  const { url, key } = dataPlane();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error !== null || data.session === null) {
    // Deliberately unspecific: the response must not reveal whether the address
    // exists in this municipality.
    throw new SignInRejectedError('Fel e-postadress eller lösenord.');
  }

  const authed = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });

  const { data: internalUser } = await authed
    .schema('identity')
    .from('users')
    .select('id, status')
    .eq('auth_user_id', data.user?.id ?? '')
    .maybeSingle<{ id: string; status: string }>();

  if (internalUser === null || internalUser.status !== 'ACTIVE') {
    await client.auth.signOut();
    throw new SignInRejectedError(
      'Kontot är inte upplagt för den här kommunen. Kontakta din administratör.',
    );
  }

  const cookie = sessionCookie(context, data.session.access_token, data.session.expires_in);
  const store = await cookies();
  store.set(cookie.name, cookie.value, cookie.options);
}

export async function signOut(context: TenantContext): Promise<void> {
  const cookie = clearedSessionCookie(context);
  const store = await cookies();
  store.set(cookie.name, cookie.value, cookie.options);
}
