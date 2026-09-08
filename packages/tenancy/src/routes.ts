/**
 * Masterplan 177: the tenant route map, and which routes require a session.
 * The proxy uses this to redirect an unauthenticated request to /login instead
 * of letting a page render and fail later.
 *
 * This is a routing convenience, not the security boundary: every data read is
 * still decided by RBAC/ABAC/RLS in the tenant data plane (masterplan 158).
 */

export const TENANT_PUBLIC_ROUTES: readonly string[] = [
  '/',
  '/login',
  '/domain-not-found',
  '/tillganglighet',
  '/personuppgifter',
];

export const TENANT_PROTECTED_PREFIXES: readonly string[] = [
  '/handlaggning',
  '/mina-sidor',
  '/kommunadmin',
  '/logga-ut',
];

export function requiresSession(pathname: string): boolean {
  if (TENANT_PUBLIC_ROUTES.includes(pathname)) return false;
  return TENANT_PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Masterplan 177: `/platform` is never reachable from a municipality host. */
export function isPlatformOnlyPath(pathname: string): boolean {
  return pathname === '/platform' || pathname.startsWith('/platform/');
}
