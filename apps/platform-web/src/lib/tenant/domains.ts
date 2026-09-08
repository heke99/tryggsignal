import 'server-only';

import { VercelDomainProvider, VercelDomainProviderError } from '@tryggsignal/integrations';
import {
  customDomainLifecycle,
  validateCustomDomainCandidate,
  type DomainDnsStatus,
  type DomainOwnershipStatus,
  type DomainTlsStatus,
  type DomainVerificationChallenge,
  type TenantContext,
} from '@tryggsignal/tenancy';
import { controlPlaneServerClient } from '@/lib/tenant/runtime';

interface DomainRow {
  domain_id: string;
  hostname: string;
  normalized_hostname: string;
  domain_type: 'PLATFORM_SUBDOMAIN' | 'CUSTOM_DOMAIN' | 'PLATFORM_RESERVED';
  status:
    | 'PENDING'
    | 'AWAITING_DNS'
    | 'VERIFYING'
    | 'VERIFIED'
    | 'ACTIVE'
    | 'FAILED'
    | 'DISABLED'
    | 'REMOVED';
  is_canonical: boolean;
  is_fallback: boolean;
  vercel_project_id: string | null;
  provider_domain_id: string | null;
  ownership_status: DomainOwnershipStatus;
  dns_status: DomainDnsStatus;
  tls_status: DomainTlsStatus;
  verification_challenges: DomainVerificationChallenge[];
  provider_misconfigured: boolean | null;
  last_checked_at: string | null;
  last_error: string | null;
  verified_at: string | null;
  activated_at: string | null;
  disabled_at: string | null;
}

export interface TenantDomainView {
  readonly id: string;
  readonly hostname: string;
  readonly normalizedHostname: string;
  readonly domainType: DomainRow['domain_type'];
  readonly status: DomainRow['status'];
  readonly isCanonical: boolean;
  readonly isFallback: boolean;
  readonly vercelProjectId: string | null;
  readonly providerDomainId: string | null;
  readonly ownershipStatus: DomainOwnershipStatus;
  readonly dnsStatus: DomainDnsStatus;
  readonly tlsStatus: DomainTlsStatus;
  readonly verificationChallenges: readonly DomainVerificationChallenge[];
  readonly providerMisconfigured: boolean | null;
  readonly lastCheckedAt: string | null;
  readonly lastError: string | null;
  readonly verifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly disabledAt: string | null;
}

export class DomainRuntimeError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_UNAVAILABLE'
      | 'INVALID_DOMAIN'
      | 'CONTROL_PLANE_WRITE_FAILED'
      | 'PROVIDER_WRITE_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'DomainRuntimeError';
  }
}

function provider(): VercelDomainProvider {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_DOMAIN_TEAM_ID ?? process.env.VERCEL_ORG_ID;
  const projectId = process.env.VERCEL_DOMAIN_PROJECT_ID ?? process.env.VERCEL_PROJECT_ID;

  if (!token || !teamId || !projectId) {
    throw new DomainRuntimeError(
      'PROVIDER_UNAVAILABLE',
      'Vercel domain provider is not configured for this environment.',
    );
  }

  return new VercelDomainProvider({ token, teamId, projectId });
}

function toView(row: DomainRow): TenantDomainView {
  return {
    id: row.domain_id,
    hostname: row.hostname,
    normalizedHostname: row.normalized_hostname,
    domainType: row.domain_type,
    status: row.status,
    isCanonical: row.is_canonical,
    isFallback: row.is_fallback,
    vercelProjectId: row.vercel_project_id,
    providerDomainId: row.provider_domain_id,
    ownershipStatus: row.ownership_status,
    dnsStatus: row.dns_status,
    tlsStatus: row.tls_status,
    verificationChallenges: row.verification_challenges ?? [],
    providerMisconfigured: row.provider_misconfigured,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    verifiedAt: row.verified_at,
    activatedAt: row.activated_at,
    disabledAt: row.disabled_at,
  };
}

export async function listTenantDomains(
  context: TenantContext,
): Promise<readonly TenantDomainView[]> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client.rpc('list_tenant_domains', {
    p_tenant_id: context.tenantId,
  });

  if (error !== null || !Array.isArray(data)) {
    throw new DomainRuntimeError(
      'CONTROL_PLANE_WRITE_FAILED',
      error?.message ?? 'Could not list tenant domains.',
    );
  }

  return (data as DomainRow[]).map(toView);
}

async function syncProviderState(
  context: TenantContext,
  domainId: string,
  actorId: string,
  state: Awaited<ReturnType<VercelDomainProvider['inspect']>>,
): Promise<void> {
  const lifecycle = customDomainLifecycle(state);
  const client = await controlPlaneServerClient();
  const { error } = await client.rpc('sync_custom_domain_provider_state', {
    p_tenant_id: context.tenantId,
    p_domain_id: domainId,
    p_ownership_status: lifecycle.ownershipStatus,
    p_dns_status: lifecycle.dnsStatus,
    p_tls_status: lifecycle.tlsStatus,
    p_verification_challenges: state.verification,
    p_provider_misconfigured: lifecycle.dnsStatus === 'MISCONFIGURED',
    p_last_error: state.error ?? null,
    p_actor: actorId,
  });

  if (error !== null) {
    throw new DomainRuntimeError('CONTROL_PLANE_WRITE_FAILED', error.message);
  }
}

export async function requestTenantCustomDomain(
  context: TenantContext,
  actorId: string,
  rawHostname: string,
): Promise<string> {
  const candidate = validateCustomDomainCandidate(
    rawHostname,
    process.env.ROOT_DOMAIN ?? 'tryggsignal.se',
  );
  if (!candidate.ok) {
    throw new DomainRuntimeError('INVALID_DOMAIN', candidate.reason);
  }

  const vercel = provider();
  const client = await controlPlaneServerClient();
  const projectId = process.env.VERCEL_DOMAIN_PROJECT_ID ?? process.env.VERCEL_PROJECT_ID;
  if (!projectId) throw new DomainRuntimeError('PROVIDER_UNAVAILABLE', 'Missing Vercel project.');

  const { data: domainId, error: requestError } = await client.rpc('request_custom_domain', {
    p_tenant_id: context.tenantId,
    p_actor: actorId,
    p_hostname: candidate.hostname,
    p_normalized_hostname: candidate.hostname,
    p_vercel_project_id: projectId,
  });

  if (requestError !== null || typeof domainId !== 'string') {
    throw new DomainRuntimeError(
      'CONTROL_PLANE_WRITE_FAILED',
      requestError?.message ?? 'Could not reserve custom domain.',
    );
  }

  try {
    const added = await vercel.add(candidate.hostname);
    const { error: attachError } = await client.rpc('attach_custom_domain_provider', {
      p_tenant_id: context.tenantId,
      p_domain_id: domainId,
      p_vercel_project_id: projectId,
      p_provider_domain_id: added.providerDomainId,
      p_verification_challenges: added.verification,
      p_actor: actorId,
    });
    if (attachError !== null) {
      throw new DomainRuntimeError('CONTROL_PLANE_WRITE_FAILED', attachError.message);
    }

    const state = await vercel.inspect(candidate.hostname);
    await syncProviderState(context, domainId, actorId, state);
  } catch (error) {
    if (error instanceof DomainRuntimeError) throw error;

    const message =
      error instanceof VercelDomainProviderError || error instanceof Error
        ? error.message
        : 'Vercel domain request failed.';
    const { error: syncError } = await client.rpc('sync_custom_domain_provider_state', {
      p_tenant_id: context.tenantId,
      p_domain_id: domainId,
      p_ownership_status: 'FAILED',
      p_dns_status: 'UNKNOWN',
      p_tls_status: 'UNKNOWN',
      p_verification_challenges: [],
      p_provider_misconfigured: null,
      p_last_error: message.slice(0, 1000),
      p_actor: actorId,
    });
    if (syncError !== null) {
      throw new DomainRuntimeError('CONTROL_PLANE_WRITE_FAILED', syncError.message);
    }
    throw new DomainRuntimeError('PROVIDER_WRITE_FAILED', message);
  }

  return domainId;
}

export async function verifyTenantCustomDomain(
  context: TenantContext,
  actorId: string,
  domain: TenantDomainView,
): Promise<void> {
  if (domain.domainType !== 'CUSTOM_DOMAIN') {
    throw new DomainRuntimeError('INVALID_DOMAIN', 'Only custom domains can be verified.');
  }

  const state = await provider().verify(domain.normalizedHostname);
  await syncProviderState(context, domain.id, actorId, state);
}

export async function activateTenantCustomDomain(
  context: TenantContext,
  actorId: string,
  domainId: string,
): Promise<void> {
  const client = await controlPlaneServerClient();
  const { error } = await client.rpc('activate_custom_domain', {
    p_tenant_id: context.tenantId,
    p_domain_id: domainId,
    p_actor: actorId,
  });
  if (error !== null) {
    throw new DomainRuntimeError('CONTROL_PLANE_WRITE_FAILED', error.message);
  }
}

export async function disableTenantCustomDomain(
  context: TenantContext,
  actorId: string,
  domain: TenantDomainView,
  reason: string,
): Promise<void> {
  const client = await controlPlaneServerClient();
  const { error } = await client.rpc('disable_custom_domain', {
    p_tenant_id: context.tenantId,
    p_domain_id: domain.id,
    p_reason: reason,
    p_actor: actorId,
  });
  if (error !== null) {
    throw new DomainRuntimeError('CONTROL_PLANE_WRITE_FAILED', error.message);
  }

  try {
    await provider().remove(domain.normalizedHostname);
  } catch {
    // Routing is already disabled in the control plane. Provider cleanup can be
    // retried safely without re-exposing the hostname to tenant traffic.
  }
}
