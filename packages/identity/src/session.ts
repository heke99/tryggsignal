/**
 * Masterplan 180, 181, 183, 203: host-bound sessions, an explicit central-login
 * handoff, callback isolation, and CSRF protection on the sign-in flow.
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

function authCookie(
  context: TenantContext,
  base: 'session' | 'refresh',
  token: string,
  maxAgeSeconds: number,
): SessionCookieSpec {
  return {
    name: tenantCookieName(context, base),
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

/**
 * A `__Host-` prefixed cookie may not carry a Domain attribute, so the browser
 * refuses to send it to any other host. That is what stops one municipality's
 * portal from ever seeing another's session — including custom/fallback hosts
 * for the same municipality.
 */
export function sessionCookie(
  context: TenantContext,
  token: string,
  maxAgeSeconds = 8 * 3600,
): SessionCookieSpec {
  return authCookie(context, 'session', token, maxAgeSeconds);
}

/** Refresh tokens are also host-only and never exposed to client JavaScript. */
export function refreshSessionCookie(
  context: TenantContext,
  token: string,
  maxAgeSeconds = 30 * 24 * 3600,
): SessionCookieSpec {
  return authCookie(context, 'refresh', token, maxAgeSeconds);
}

export function clearedSessionCookie(context: TenantContext): SessionCookieSpec {
  return authCookie(context, 'session', '', 0);
}

export function clearedRefreshSessionCookie(context: TenantContext): SessionCookieSpec {
  return authCookie(context, 'refresh', '', 0);
}

// ---------------------------------------------------------------------------
// Sign-in state (masterplan 183/203)
// ---------------------------------------------------------------------------

export interface SignInState {
  readonly nonce: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly authConfigurationReference: string;
  readonly returnTo: string;
  readonly issuedAt: number;
}

export class InvalidSignInStateError extends Error {}

const STATE_TTL_MS = 10 * 60_000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

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
    hostname: context.resolvedHostname,
    authConfigurationReference: context.authConfigurationReference,
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
  const [payload, signature, extra] = state.split('.');
  if (payload === undefined || signature === undefined || extra !== undefined) {
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

  if (!Number.isFinite(parsed.issuedAt) || parsed.issuedAt > now + 30_000) {
    throw new InvalidSignInStateError('Sign-in state timestamp is invalid.');
  }
  if (now - parsed.issuedAt > STATE_TTL_MS) {
    throw new InvalidSignInStateError('Sign-in state has expired.');
  }
  if (
    parsed.tenantId !== context.tenantId ||
    parsed.domainId !== context.domainId ||
    parsed.hostname !== context.resolvedHostname ||
    parsed.authConfigurationReference !== context.authConfigurationReference
  ) {
    throw new InvalidSignInStateError(
      'Sign-in state was issued for a different tenant, domain, host, or auth configuration.',
    );
  }
  return parsed;
}

export function safeReturnTo(candidate: string | null | undefined): string {
  if (candidate == null || candidate.length === 0) return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (/\p{Cc}/u.test(candidate) || candidate.includes('\\')) return '/';

  try {
    const base = new URL('https://return.invalid/');
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

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
