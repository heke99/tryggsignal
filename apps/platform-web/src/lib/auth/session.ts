import 'server-only';

import { headers, cookies } from 'next/headers';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  clearedRefreshSessionCookie,
  clearedSessionCookie,
  createSignInState,
  refreshSessionCookie,
  sessionCookie,
  verifySignInState,
  type AudienceKind,
} from '@tryggsignal/identity';
import { tenantCookieName, type TenantContext } from '@tryggsignal/tenancy';
import {
  consumeDistributedRateLimit,
  resolveTenantAuthConfiguration,
  resolveTenantRuntime,
  TenantRuntimeUnavailableError,
} from '@/lib/tenant/runtime';

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

export class RateLimitRejectedError extends Error {
  constructor(readonly resetAt: Date) {
    super('Too many sign-in attempts.');
    this.name = 'RateLimitRejectedError';
  }
}

function stateSecret(): string {
  const secret = process.env.SIGN_IN_STATE_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new AuthNotConfiguredError();
  }
  return secret;
}

function authClient(target: { url: string; publishableKey: string }): SupabaseClient {
  return createClient(target.url, target.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function requirePasswordRuntime(
  context: TenantContext,
  audience: AudienceKind,
): Promise<{
  readonly url: string;
  readonly publishableKey: string;
}> {
  try {
    const [deployment, configuration] = await Promise.all([
      resolveTenantRuntime(context),
      resolveTenantAuthConfiguration(context, audience),
    ]);

    if (configuration.kind !== 'SUPABASE_PASSWORD') {
      throw new AuthNotConfiguredError();
    }

    return {
      url: deployment.supabaseUrl,
      publishableKey: deployment.publishableKey,
    };
  } catch (error) {
    if (error instanceof AuthNotConfiguredError) throw error;
    if (error instanceof TenantRuntimeUnavailableError) throw new AuthNotConfiguredError();
    throw error;
  }
}

async function internalUserIsActive(
  client: SupabaseClient,
  authUserId: string,
  expectedUserType?: 'STAFF' | 'EXTERNAL',
): Promise<boolean> {
  const { data, error } = await client
    .schema('identity')
    .from('users')
    .select('id, status, user_type')
    .eq('auth_user_id', authUserId)
    .maybeSingle<{ id: string; status: string; user_type: string }>();

  return (
    error === null &&
    data !== null &&
    data.status === 'ACTIVE' &&
    (expectedUserType === undefined || data.user_type === expectedUserType)
  );
}

async function clientAddress(): Promise<string> {
  const store = await headers();
  const forwardedFor = store.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
}

async function writeSessionCookies(
  context: TenantContext,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  const store = await cookies();
  const access = sessionCookie(context, accessToken, expiresIn);
  const refresh = refreshSessionCookie(context, refreshToken);
  store.set(access.name, access.value, access.options);
  store.set(refresh.name, refresh.value, refresh.options);
}

export async function clearSessionCookies(context: TenantContext): Promise<void> {
  const store = await cookies();
  const access = clearedSessionCookie(context);
  const refresh = clearedRefreshSessionCookie(context);
  store.set(access.name, access.value, access.options);
  store.set(refresh.name, refresh.value, refresh.options);
}

export function issueSignInState(context: TenantContext, returnTo: string): string {
  return createSignInState(context, returnTo, stateSecret()).state;
}

export function checkSignInState(context: TenantContext, state: string): string {
  return verifySignInState(state, context, stateSecret()).returnTo;
}

/**
 * Password auth is only accepted when the tenant's resolved STAFF auth
 * configuration explicitly says SUPABASE_PASSWORD. It never falls back to the
 * control-plane project or to a global auth provider.
 */
export async function signInWithPassword(
  context: TenantContext,
  email: string,
  password: string,
  audience: AudienceKind = 'STAFF',
): Promise<void> {
  let rateLimit;
  try {
    rateLimit = await consumeDistributedRateLimit(context, 'auth', await clientAddress());
  } catch (error) {
    if (error instanceof TenantRuntimeUnavailableError) throw new AuthNotConfiguredError();
    throw error;
  }
  if (!rateLimit.allowed) throw new RateLimitRejectedError(rateLimit.resetAt);

  const target = await requirePasswordRuntime(context, audience);
  const client = authClient(target);

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error !== null || data.session === null || data.user === null) {
    throw new SignInRejectedError('Fel e-postadress eller lösenord.');
  }

  const authed = createClient(target.url, target.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });

  if (
    !(await internalUserIsActive(
      authed,
      data.user.id,
      audience === 'EXTERNAL' ? 'EXTERNAL' : 'STAFF',
    ))
  ) {
    await client.auth.signOut({ scope: 'local' });
    throw new SignInRejectedError(
      audience === 'EXTERNAL'
        ? 'Kontot är inte upplagt för Mina sidor i den här kommunen.'
        : 'Kontot är inte upplagt för den här kommunen. Kontakta din administratör.',
    );
  }

  await writeSessionCookies(
    context,
    data.session.access_token,
    data.session.refresh_token,
    data.session.expires_in,
  );
}

/**
 * Refresh is executed from a Route Handler, where cookie writes are legal.
 * Refresh-token rotation is persisted immediately.
 */
export async function refreshSession(context: TenantContext): Promise<boolean> {
  let deployment;
  try {
    deployment = await resolveTenantRuntime(context);
  } catch {
    await clearSessionCookies(context);
    return false;
  }

  const store = await cookies();
  const refreshToken = store.get(tenantCookieName(context, 'refresh'))?.value;
  if (refreshToken === undefined || refreshToken.length === 0) {
    await clearSessionCookies(context);
    return false;
  }

  const client = authClient({
    url: deployment.supabaseUrl,
    publishableKey: deployment.publishableKey,
  });
  const { data, error } = await client.auth.refreshSession({ refresh_token: refreshToken });
  if (error !== null || data.session === null || data.user === null) {
    await clearSessionCookies(context);
    return false;
  }

  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser(data.session.access_token);

  if (
    userError !== null ||
    user === null ||
    !(await internalUserIsActive(
      createClient(deployment.supabaseUrl, deployment.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      }),
      user.id,
    ))
  ) {
    await client.auth.signOut({ scope: 'local' });
    await clearSessionCookies(context);
    return false;
  }

  await writeSessionCookies(
    context,
    data.session.access_token,
    data.session.refresh_token,
    data.session.expires_in,
  );
  return true;
}

export async function signOut(context: TenantContext): Promise<void> {
  try {
    const deployment = await resolveTenantRuntime(context);
    const store = await cookies();
    const accessToken = store.get(tenantCookieName(context, 'session'))?.value;
    const refreshToken = store.get(tenantCookieName(context, 'refresh'))?.value;

    if (accessToken !== undefined && refreshToken !== undefined) {
      const client = authClient({
        url: deployment.supabaseUrl,
        publishableKey: deployment.publishableKey,
      });
      const { error } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      if (error === null) await client.auth.signOut({ scope: 'local' });
    }
  } finally {
    await clearSessionCookies(context);
  }
}
