import { NextResponse, type NextRequest } from 'next/server';
import {
  MemoryRateLimitStore,
  TenantResolver,
  checkRateLimit,
  isPlatformOnlyPath,
  requestHostname,
  requiresSession,
  tenantCookieName,
} from '@tryggsignal/tenancy';
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

// Masterplan 160: the development host mapping is a hostname rewrite, so it must
// never be active in production, where a Host header is attacker-controlled.
const DEVELOPMENT_HOST_SUFFIX =
  process.env.NODE_ENV === 'production' ? undefined : (process.env.DEV_HOST_SUFFIX ?? 'localhost');

const resolver = new TenantResolver(tenantDirectory(), {
  rootDomain: ROOT_DOMAIN,
  previewHostSuffix: PREVIEW_SUFFIX,
  ...(DEVELOPMENT_HOST_SUFFIX === undefined
    ? {}
    : { developmentHostSuffix: DEVELOPMENT_HOST_SUFFIX }),
});

// Masterplan 84: one store per instance; the key carries the tenant so one
// municipality cannot exhaust another's budget.
const rateLimitStore = new MemoryRateLimitStore();

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

  const { pathname } = request.nextUrl;

  // Masterplan 177: the platform surface is never reachable from a municipality
  // host, whatever the path looks like.
  if (isPlatformOnlyPath(pathname)) {
    return rewriteTo(request, '/domain-not-found', forwarded);
  }

  // Masterplan 84: the sign-in endpoint is the one that must not be brute-forced.
  if (request.method === 'POST' && pathname === '/login') {
    const decision = checkRateLimit(rateLimitStore, {
      action: 'auth',
      tenantId: resolution.context.tenantId,
      subject: clientAddress(request),
    });
    if (!decision.allowed) {
      return new NextResponse('För många inloggningsförsök. Försök igen om en stund.', {
        status: 429,
        headers: {
          'retry-after': String(Math.ceil((decision.resetAt - Date.now()) / 1000)),
          'content-type': 'text/plain; charset=utf-8',
        },
      });
    }
  }

  // Route guard: send an unauthenticated request to the tenant's own login page
  // rather than rendering a page that will fail its data reads. The cookie is
  // host-bound, so its mere presence already proves it was issued for this host.
  if (
    requiresSession(pathname) &&
    request.cookies.get(tenantCookieName(resolution.context, 'session')) === undefined
  ) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = `?returnTo=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }

  // Everything a tenant host serves lives under /t/<slug>/…, so a platform-only
  // path such as /platform can never be reached from a municipality domain.
  return rewriteTo(
    request,
    `/t/${resolution.context.tenantSlug}${normalizedPath(request)}`,
    forwarded,
  );
}

/**
 * The client address as reported by the platform. On Vercel `x-forwarded-for` is
 * set by the edge; the leftmost entry is the client.
 */
function clientAddress(request: NextRequest): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  return forwardedFor?.split(',')[0]?.trim() ?? 'unknown';
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
