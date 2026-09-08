import 'server-only';

import { redirect } from 'next/navigation';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from '@/lib/data/client';

export async function requireTenantSession(
  context: TenantContext,
  returnTo: string,
): Promise<void> {
  try {
    const session = await tenantClient(context);
    if (session.authenticated) return;
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      redirect('/login?error=configuration');
    }
    throw error;
  }

  redirect(`/auth/refresh?returnTo=${encodeURIComponent(returnTo)}`);
}
