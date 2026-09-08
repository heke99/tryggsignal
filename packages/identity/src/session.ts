/**
 * Masterplan 180, 181, 183: host-bound sessions, an explicit central-login
 * handoff, and CSRF protection on the sign-in flow.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantCookieName } from '@tryggsignal/tenancy';

export interface SessionCookieSpec {
  readonly name: string;
  readonly value: string;
  readonly options: {
    readonly httpOnly: true;
    readonly secure: true;
    readonly sameSite: 'lax' | 'strict';
    readonly path: '/';
    readonly maxAge: number;
  };
}

/**
 * A `__Host-` prefixed cookie may not carry a Domain attribute, so the browser
 * refuses to send it to any other host. That is what stops one municipality's
 * portal from ever seeing another's session, wildcard subdomain or custom domain.
 */
export function sessionCookie(
  context: TenantContext,
  token: string,
  maxAgeSeconds = 8 * 3600,
): SessionCookieSpec {
  return {
    name: tenantCookieName(context, 'session'),
    value: token,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSeconds,
    },
  };
}

export function clearedSessionCookie(context: TenantContext): SessionCookieSpec {
  return { ...sessionCookie(context, '', 0), value: '' };
}

// ---------------------------------------------------------------------------
// Sign-in state (masterplan 183)
// ---------------------------------------------------------------------------

export interface SignInState {
  readonly nonce: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly returnTo: string;
  readonly issuedAt: number;
}

export class InvalidSignInStateError extends Error {}

const STATE_TTL_MS = 10 * 60_000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * The state is bound to the tenant AND the domain it was issued on, so a state
 * minted on one municipality's host cannot complete a sign-in on another's.
 */
export function createSignInState(
  context: TenantContext,
  returnTo: string,
  secret: string,
  now: number = Date.now(),
): { readonly state: string; readonly parsed: SignInState } {
  const parsed: SignInState = {
    nonce: randomBytes(16).toString('base64url'),
    tenantId: context.tenantId,
    domainId: context.domainId,
    returnTo: safeReturnTo(returnTo),
    issuedAt: now,
  };
  const payload = Buffer.from(JSON.stringify(parsed)).toString('base64url');
  return { state: `${payload}.${sign(payload, secret)}`, parsed };
}

export function verifySignInState(
  state: string,
  context: TenantContext,
  secret: string,
  now: number = Date.now(),
): SignInState {
  const [payload, signature] = state.split('.');
  if (payload === undefined || signature === undefined) {
    throw new InvalidSignInStateError('Malformed sign-in state.');
  }

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new InvalidSignInStateError('Sign-in state signature does not verify.');
  }

  let parsed: SignInState;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignInState;
  } catch {
    throw new InvalidSignInStateError('Sign-in state payload is not readable.');
  }

  if (now - parsed.issuedAt > STATE_TTL_MS) {
    throw new InvalidSignInStateError('Sign-in state has expired.');
  }
  if (parsed.tenantId !== context.tenantId || parsed.domainId !== context.domainId) {
    throw new InvalidSignInStateError('Sign-in state was issued for a different tenant or domain.');
  }
  return parsed;
}

/**
 * Masterplan 181: the launcher hands off to the tenant's own host. Only a
 * same-site path is ever accepted as a return target, so a crafted `returnTo`
 * cannot turn the login flow into an open redirect.
 */
export function safeReturnTo(candidate: string | null | undefined): string {
  if (candidate == null || candidate.length === 0) return '/';
  if (!candidate.startsWith('/')) return '/';
  // `//evil.example` and `/\evil.example` are protocol-relative URLs.
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (candidate.includes('\n') || candidate.includes('\r')) return '/';
  return candidate;
}

/**
 * Masterplan 175/181: the central gateway may only send a user to a host that is
 * a verified domain of a tenant they actually have a relation to.
 */
export function buildHandoffUrl(
  target: { readonly canonicalHostname: string; readonly slug: string },
  authorizedSlugs: readonly string[],
  returnTo: string,
): string {
  if (!authorizedSlugs.includes(target.slug)) {
    throw new InvalidSignInStateError(
      `The signed-in user has no verified relation to "${target.slug}".`,
    );
  }
  const url = new URL(`https://${target.canonicalHostname}/login`);
  url.searchParams.set('returnTo', safeReturnTo(returnTo));
  return url.toString();
}
