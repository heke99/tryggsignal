import 'server-only';
import { cookies } from 'next/headers';
import { createTenantUserClient } from '@tryggsignal/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantCookieName } from '@tryggsignal/tenancy';

/**
 * Masterplan 171/174: reads run against the tenant's own data plane with the
 * user's session, so RLS decides what comes back. There is no privileged
 * fallback client on this path.
 */
export class TenantDataPlaneUnavailableError extends Error {
  constructor(reference: string) {
    super(`No data-plane configuration is available for "${reference}" in this environment.`);
    this.name = 'TenantDataPlaneUnavailableError';
  }
}

export interface DataPlaneSession {
  readonly client: SupabaseClient;
  readonly authenticated: boolean;
}

export async function tenantClient(context: TenantContext): Promise<DataPlaneSession> {
  const url = process.env.CONTROL_PLANE_SUPABASE_URL;
  const key = process.env.CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY;
  if (url === undefined || key === undefined) {
    throw new TenantDataPlaneUnavailableError(context.dataPlaneReference);
  }

  // Masterplan 180: the session cookie is host-bound and named per tenant, so a
  // cookie minted for one municipality is not even looked for on another host.
  const store = await cookies();
  const token = store.get(tenantCookieName(context, 'session'))?.value ?? null;

  return {
    client: createTenantUserClient({ url, publishableKey: key }, token),
    authenticated: token !== null,
  };
}
