import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnTo } from '@tryggsignal/identity';
import { currentTenant } from '@/lib/tenant/context';
import { refreshSession } from '@/lib/auth/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await currentTenant();
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const refreshed = await refreshSession(context);

  const target = request.nextUrl.clone();
  if (refreshed) {
    target.pathname = returnTo;
    target.search = '';
  } else {
    target.pathname = '/login';
    target.search = `?error=session&returnTo=${encodeURIComponent(returnTo)}`;
  }
  return NextResponse.redirect(target);
}
