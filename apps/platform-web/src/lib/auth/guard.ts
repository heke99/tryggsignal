import 'server-only';

import { redirect } from 'next/navigation';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Permission } from '@tryggsignal/authorization';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from '@/lib/data/client';

export interface TenantPermissionSession {
  readonly client: SupabaseClient;
  readonly actorId: string;
}

async function authenticatedTenantClient(
  context: TenantContext,
  returnTo: string,
): Promise<SupabaseClient> {
  try {
    const session = await tenantClient(context);
    if (session.authenticated) return session.client;
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      redirect('/login?error=configuration');
    }
    throw error;
  }

  redirect(`/auth/refresh?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function requireTenantSession(
  context: TenantContext,
  returnTo: string,
): Promise<void> {
  await authenticatedTenantClient(context, returnTo);
}

/**
 * Tenant-level administration is authorized in the municipality data plane,
 * using the user's validated JWT and RBAC. A signed-in session by itself is not
 * sufficient for control-plane writes.
 */
export async function requireTenantPermission(
  context: TenantContext,
  permission: Permission,
  returnTo: string,
): Promise<TenantPermissionSession> {
  const client = await authenticatedTenantClient(context, returnTo);
  const [{ data: allowed, error: permissionError }, { data: actorId, error: actorError }] =
    await Promise.all([
      client.schema('authz').rpc('has_tenant_permission', { p_permission: permission }),
      client.schema('authz').rpc('current_user_id'),
    ]);

  if (
    permissionError !== null ||
    actorError !== null ||
    allowed !== true ||
    typeof actorId !== 'string' ||
    actorId.length === 0
  ) {
    redirect('/kommunadmin?error=permission');
  }

  return { client, actorId };
}
