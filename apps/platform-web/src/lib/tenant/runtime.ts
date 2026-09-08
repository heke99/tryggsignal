import 'server-only';

import { createHmac } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { EnvSecretProvider } from '@tryggsignal/config';
import { assertDeploymentMatchesContext } from '@tryggsignal/database';
import type { TenantAuthConfiguration, AudienceKind } from '@tryggsignal/identity';
import type {
  RateLimitedAction,
  TenantContext,
  TenantDeploymentRecord,
} from '@tryggsignal/tenancy';
import { RATE_LIMITS } from '@tryggsignal/tenancy';

export class TenantRuntimeUnavailableError extends Error {
  constructor(
    readonly code:
      | 'CONTROL_PLANE_UNAVAILABLE'
      | 'DEPLOYMENT_UNAVAILABLE'
      | 'AUTH_CONFIG_UNAVAILABLE'
      | 'RATE_LIMIT_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'TenantRuntimeUnavailableError';
  }
}

interface RuntimeRow {
  deployment_id: string;
  supabase_project_ref: string;
  supabase_region: string;
  supabase_url: string;
  publishable_key: string;
  schema_version: string;
  deployment_status: string;
  health_status: string;
}

export interface TenantRuntimeDeployment
  extends Pick<
    TenantDeploymentRecord,
    | 'id'
    | 'supabaseProjectRef'
    | 'supabaseRegion'
    | 'supabaseUrl'
    | 'publishableKey'
    | 'schemaVersion'
    | 'status'
    | 'healthStatus'
  > {}

interface AuthRow {
  reference: string;
  tenant_id: string;
  audience: AudienceKind;
  kind: TenantAuthConfiguration['kind'];
  display_name: string;
  issuer: string | null;
  metadata_url: string | null;
  credential_reference: string | null;
  allowed_email_domains: string[];
  environment: string;
  enabled: boolean;
}

interface RateLimitRow {
  allowed: boolean;
  remaining: number;
  reset_at: string;
}

let controlPlaneClientPromise: Promise<SupabaseClient> | undefined;

async function controlPlaneServerClient(): Promise<SupabaseClient> {
  if (controlPlaneClientPromise !== undefined) return controlPlaneClientPromise;

  controlPlaneClientPromise = (async () => {
    const url = process.env.CONTROL_PLANE_SUPABASE_URL;
    const reference = process.env.CONTROL_PLANE_SECRET_REFERENCE;
    if (url === undefined || reference === undefined || reference.length === 0) {
      throw new TenantRuntimeUnavailableError('CONTROL_PLANE_UNAVAILABLE');
    }

    const secrets = new EnvSecretProvider(process.env);
    const credential = await secrets.getSecret(reference);

    return createClient(url, credential.value, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  })();

  return controlPlaneClientPromise;
}

/**
 * Phase B / masterplan 171–174:
 * verified hostname context -> exact deployment lookup -> mismatch assertion.
 *
 * No control-plane fallback exists. If the exact deployment cannot be resolved,
 * the request stops with DEPLOYMENT_UNAVAILABLE.
 */
export async function resolveTenantRuntime(
  context: TenantContext,
): Promise<TenantRuntimeDeployment> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client
    .rpc('resolve_tenant_runtime', {
      p_hostname: context.resolvedHostname,
      p_tenant_id: context.tenantId,
      p_deployment_id: context.deploymentId,
      p_data_plane_reference: context.dataPlaneReference,
    })
    .maybeSingle<RuntimeRow>();

  if (error !== null || data === null) {
    throw new TenantRuntimeUnavailableError('DEPLOYMENT_UNAVAILABLE');
  }

  const deployment: TenantRuntimeDeployment = {
    id: data.deployment_id,
    supabaseProjectRef: data.supabase_project_ref,
    supabaseRegion: data.supabase_region,
    supabaseUrl: data.supabase_url,
    publishableKey: data.publishable_key,
    schemaVersion: data.schema_version,
    status: data.deployment_status,
    healthStatus: data.health_status,
  };

  assertDeploymentMatchesContext(context, deployment);
  return deployment;
}

/** Resolve the tenant's actual configured identity provider, never a default. */
export async function resolveTenantAuthConfiguration(
  context: TenantContext,
  audience: AudienceKind,
): Promise<TenantAuthConfiguration> {
  if (context.authConfigurationReference.length === 0) {
    throw new TenantRuntimeUnavailableError('AUTH_CONFIG_UNAVAILABLE');
  }

  const client = await controlPlaneServerClient();
  const { data, error } = await client
    .rpc('resolve_tenant_auth_config', {
      p_hostname: context.resolvedHostname,
      p_tenant_id: context.tenantId,
      p_reference: context.authConfigurationReference,
      p_audience: audience,
    })
    .maybeSingle<AuthRow>();

  if (error !== null || data === null) {
    throw new TenantRuntimeUnavailableError('AUTH_CONFIG_UNAVAILABLE');
  }

  return {
    reference: data.reference,
    tenantId: data.tenant_id,
    audience: data.audience,
    kind: data.kind,
    displayName: data.display_name,
    issuer: data.issuer,
    metadataUrl: data.metadata_url,
    credentialReference: data.credential_reference,
    enabled: data.enabled,
    allowedEmailDomains: data.allowed_email_domains,
  };
}

/**
 * Masterplan 84 / phase C6: one control-plane counter is shared by every Vercel
 * instance and region. The raw subject (for auth normally the client IP) never
 * leaves the server; only a keyed HMAC is persisted.
 */
export async function consumeDistributedRateLimit(
  context: TenantContext,
  action: RateLimitedAction,
  subject: string,
): Promise<{ readonly allowed: boolean; readonly remaining: number; readonly resetAt: Date }> {
  const secret = process.env.RATE_LIMIT_KEY_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new TenantRuntimeUnavailableError('RATE_LIMIT_UNAVAILABLE');
  }

  const rule = RATE_LIMITS[action];
  const digest = createHmac('sha256', secret)
    .update(`${action}:${context.tenantId}:${subject}`)
    .digest('hex');

  const client = await controlPlaneServerClient();
  const { data, error } = await client
    .rpc('consume_rate_limit', {
      p_bucket_key: `${action}:${context.tenantId}:${digest}`,
      p_window_seconds: Math.ceil(rule.windowMs / 1000),
      p_limit: rule.limit,
    })
    .maybeSingle<RateLimitRow>();

  if (error !== null || data === null) {
    throw new TenantRuntimeUnavailableError('RATE_LIMIT_UNAVAILABLE');
  }

  return {
    allowed: data.allowed,
    remaining: data.remaining,
    resetAt: new Date(data.reset_at),
  };
}
