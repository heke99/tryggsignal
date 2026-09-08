import { NextResponse, type NextRequest } from 'next/server';
import {
  TenantResolver,
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
 * This layer is routing, not authorization. A session cookie's presence is only
 * a cheap missing-session fast path; protected server layouts validate the JWT
 * against the resolved tenant Auth server before rendering any data.
 */

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'tryggsignal.se';
const PREVIEW_SUFFIX = process.env.PREVIEW_HOST_SUFFIX ?? 'vercel.app';
const TRUST_FORWARDED_HOST = process.env.TRUST_FORWARDED_HOST === 'true';

const DEVELOPMENT_HOST_SUFFIX =
  process.env.NODE_ENV === 'production' ? undefined : (process.env.DEV_HOST_SUFFIX ?? 'localhost');

const resolver = new TenantResolver(tenantDirectory(), {
  rootDomain: ROOT_DOMAIN,
  previewHostSuffix: PREVIEW_SUFFIX,
  ...(DEVELOPMENT_HOST_SUFFIX === undefined
    ? {}
    : { developmentHostSuffix: DEVELOPMENT_HOST_SUFFIX }),
});

const PLATFORM_SURFACE_PATHS = {
  MARKETING: '/marknad',
  APP_GATEWAY: '/gateway',
  MUNICIPALITY_DISCOVERY: '/kommuner',
  PLATFORM_ADMIN: '/platform',
} as const;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const forwarded = new Headers(request.headers);
  for (const header of INBOUND_TENANT_HEADERS) forwarded.delete(header);

  const host = requestHostname(request.headers, { trustForwardedHost: TRUST_FORWARDED_HOST });
  if (!host.ok) return rewriteTo(request, '/domain-not-found', forwarded);

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

  if (isPlatformOnlyPath(pathname)) {
    return rewriteTo(request, '/domain-not-found', forwarded);
  }

  // Absence is enough to redirect early. Presence is NOT proof of authentication;
  // tenantClient().auth.getUser(token) performs that proof on protected surfaces.
  if (
    requiresSession(pathname) &&
    request.cookies.get(tenantCookieName(resolution.context, 'session')) === undefined
  ) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = `?returnTo=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(login);
  }

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
