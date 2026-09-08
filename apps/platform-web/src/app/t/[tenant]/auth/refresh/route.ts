import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnTo } from '@tryggsignal/identity';
import { currentTenant } from '@/lib/tenant/context';
import { refreshSession } from '@/lib/auth/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await currentTenant();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const refreshed = await refreshSession(context);

  if (refreshed) {
    // safeReturnTo only accepts same-site absolute paths, so resolving it against
    // the current request preserves path + query without creating an open redirect.
    return NextResponse.redirect(new URL(returnTo, request.url));
  }

  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = `?error=session&returnTo=${encodeURIComponent(returnTo)}`;
  return NextResponse.redirect(login);
}
