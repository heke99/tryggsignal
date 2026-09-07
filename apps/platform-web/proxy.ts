import { NextResponse, type NextRequest } from 'next/server';
import { TenantResolver, requestHostname } from '@tryggsignal/tenancy';
import { tenantDirectory } from '@/lib/tenant/directory';
import { INBOUND_TENANT_HEADERS, TENANT_HEADERS, tenantHeadersFor } from '@/lib/tenant/context';

/**
 * Masterplan 157–159, 177: hostname routing for the whole platform.
 *
 *   request → normalize hostname → reserved host? → platform route
 *                                → otherwise      → verified tenant domain
 *                                                 → tenant context → rewrite
 *
 * This layer is routing, not authorization: every data operation still checks
 * the tenant data plane and RBAC/ABAC/RLS behind it (masterplan 158).
 */

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'tryggsignal.se';
const PREVIEW_SUFFIX = process.env.PREVIEW_HOST_SUFFIX ?? 'vercel.app';
// Only true when the deployment genuinely sits behind an additional trusted
// proxy; on Vercel the platform sets `host` itself (masterplan 160).
const TRUST_FORWARDED_HOST = process.env.TRUST_FORWARDED_HOST === 'true';

const resolver = new TenantResolver(tenantDirectory(), {
  rootDomain: ROOT_DOMAIN,
  previewHostSuffix: PREVIEW_SUFFIX,
});

const PLATFORM_SURFACE_PATHS = {
  MARKETING: '/marknad',
  APP_GATEWAY: '/gateway',
  MUNICIPALITY_DISCOVERY: '/kommuner',
  PLATFORM_ADMIN: '/platform',
} as const;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // Strip any inbound copy of the tenant headers before anything else: only this
  // proxy may set them.
  const forwarded = new Headers(request.headers);
  for (const header of INBOUND_TENANT_HEADERS) forwarded.delete(header);

  const host = requestHostname(request.headers, { trustForwardedHost: TRUST_FORWARDED_HOST });
  if (!host.ok) {
    return rewriteTo(request, '/domain-not-found', forwarded);
  }
  forwarded.set(TENANT_HEADERS.hostname, host.hostname);

  const resolution = await resolver.resolve(host.hostname);

  if (resolution.kind === 'REJECTED') {
    forwarded.set('x-ts-rejection', resolution.reason);
    return rewriteTo(request, '/domain-not-found', forwarded);
  }

  if (resolution.kind === 'PLATFORM') {
    forwarded.set(TENANT_HEADERS.surface, resolution.surface);
    const base = PLATFORM_SURFACE_PATHS[resolution.surface];
    return rewriteTo(request, `${base}${normalizedPath(request)}`, forwarded);
  }

  for (const [name, value] of Object.entries(tenantHeadersFor(resolution.context))) {
    forwarded.set(name, value);
  }

  // Everything a tenant host serves lives under /t/<slug>/…, so a platform-only
  // path such as /platform can never be reached from a municipality domain.
  return rewriteTo(
    request,
    `/t/${resolution.context.tenantSlug}${normalizedPath(request)}`,
    forwarded,
  );
}

function normalizedPath(request: NextRequest): string {
  const { pathname } = request.nextUrl;
  return pathname === '/' ? '' : pathname;
}

function rewriteTo(request: NextRequest, pathname: string, requestHeaders: Headers): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname === '' ? '/' : pathname;
  return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
