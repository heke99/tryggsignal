import 'server-only';
import { cookies } from 'next/headers';
import { createTenantUserClient } from '@tryggsignal/database';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantCookieName } from '@tryggsignal/tenancy';
import {
  resolveTenantRuntime,
  TenantRuntimeUnavailableError,
} from '@/lib/tenant/runtime';

/**
 * Masterplan 171/174: reads run against the tenant's own data plane with the
 * user's session, so RLS decides what comes back. There is no control-plane or
 * default-project fallback on this path.
 */
export class TenantDataPlaneUnavailableError extends Error {
  constructor(reference: string) {
    super(
      `No data-plane configuration is available for "${reference}" in this environment.`,
    );
    this.name = 'TenantDataPlaneUnavailableError';
  }
}

export interface DataPlaneSession {
  readonly client: SupabaseClient;
  /** True only after Supabase Auth has validated the JWT over the network. */
  readonly authenticated: boolean;
}

export async function tenantClient(context: TenantContext): Promise<DataPlaneSession> {
  let deployment;
  try {
    deployment = await resolveTenantRuntime(context);
  } catch (error) {
    if (error instanceof TenantRuntimeUnavailableError) {
      throw new TenantDataPlaneUnavailableError(context.dataPlaneReference);
    }
    throw error;
  }

  const target = {
    url: deployment.supabaseUrl,
    publishableKey: deployment.publishableKey,
  };

  // Masterplan 180: both cookies are host-bound and named per tenant.
  const store = await cookies();
  const token = store.get(tenantCookieName(context, 'session'))?.value ?? null;
  const client = createTenantUserClient(target, token);

  if (token === null) {
    return { client, authenticated: false };
  }

  // Supabase's server-side guidance is explicit: getUser(jwt) performs an Auth
  // network request and returns an authentic user. Cookie presence alone is not
  // an authorization signal.
  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);

  return {
    client,
    authenticated: error === null && user !== null,
  };
}
