/**
 * Masterplan 7, 52, 171, 174: connection model and data-plane binding.
 *
 * - Browser and user-facing server code use the publishable key plus the user
 *   session, so every read passes RLS in the tenant's own data plane.
 * - Privileged credentials are resolved through the SecretProvider, server-only,
 *   for a narrow set of platform operations.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SecretProvider } from '@tryggsignal/config';
import type { TenantContext, TenantDeploymentRecord } from '@tryggsignal/tenancy';

export interface DataPlaneTarget {
  readonly url: string;
  readonly publishableKey: string;
}

/** Client bound to the resolved tenant data plane, carrying the user's session. */
export function createTenantUserClient(
  target: DataPlaneTarget,
  accessToken: string | null,
): SupabaseClient {
  return createClient(target.url, target.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` },
    },
  });
}

export class DataPlaneMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Data plane mismatch: tenant context expects ${expected} but deployment is ${actual}`);
    this.name = 'DataPlaneMismatchError';
  }
}

/**
 * Masterplan 153/171: the host-resolved tenant context and the deployment record
 * must agree before any client is created. A mismatch is a hard failure, never a
 * fallback to a default project.
 *
 * The runtime resolver deliberately does not return privileged credential
 * references, therefore only the identity fields needed for this assertion are
 * required here.
 */
export function assertDeploymentMatchesContext(
  context: TenantContext,
  deployment: Pick<TenantDeploymentRecord, 'id' | 'supabaseProjectRef'>,
): void {
  if (context.deploymentId !== deployment.id) {
    throw new DataPlaneMismatchError(context.deploymentId, deployment.id);
  }
  if (context.dataPlaneReference !== deployment.supabaseProjectRef) {
    throw new DataPlaneMismatchError(context.dataPlaneReference, deployment.supabaseProjectRef);
  }
}

/**
 * Server-only privileged client. Requires an explicit reason so every privileged
 * use is greppable and auditable (masterplan 174).
 */
export async function createPrivilegedClient(
  deployment: TenantDeploymentRecord,
  secrets: SecretProvider,
  reason: string,
): Promise<SupabaseClient> {
  if (typeof window !== 'undefined') {
    throw new Error('Privileged Supabase clients must never be constructed in the browser.');
  }
  if (reason.trim().length === 0) {
    throw new Error('A privileged client requires a documented reason for the audit trail.');
  }
  const secret = await secrets.getSecret(deployment.privilegedCredentialReference);
  return createClient(deployment.supabaseUrl, secret.value, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
