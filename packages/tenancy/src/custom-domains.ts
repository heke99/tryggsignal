import { normalizeHostname } from './hostname';
import type { DomainStatus } from './types';

export interface DomainVerificationChallenge {
  readonly type: string;
  readonly domain: string;
  readonly value: string;
  readonly reason?: string | undefined;
}

export type DomainOwnershipStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'FAILED';
export type DomainDnsStatus = 'UNKNOWN' | 'MISSING' | 'MISCONFIGURED' | 'OK';
export type DomainTlsStatus = 'UNKNOWN' | 'PENDING' | 'ISSUED' | 'FAILED' | 'EXPIRING';

export interface CustomDomainProviderState {
  readonly verified: boolean;
  readonly dnsStatus: DomainDnsStatus;
  readonly tlsStatus: DomainTlsStatus;
  readonly verification: readonly DomainVerificationChallenge[];
  readonly providerDomainId?: string | undefined;
  readonly error?: string | null | undefined;
}

export interface CustomDomainLifecycleState {
  readonly status: DomainStatus;
  readonly ownershipStatus: DomainOwnershipStatus;
  readonly dnsStatus: DomainDnsStatus;
  readonly tlsStatus: DomainTlsStatus;
}

export type CustomDomainCandidate =
  | { readonly ok: true; readonly hostname: string }
  | {
      readonly ok: false;
      readonly reason: 'INVALID_HOSTNAME' | 'PLATFORM_NAMESPACE';
    };

/**
 * P37: a municipal custom domain may never claim Tryggsignal's own namespace.
 * Platform subdomains are provisioned separately and remain the fallback host.
 */
export function validateCustomDomainCandidate(
  rawHostname: string,
  rootDomain = 'tryggsignal.se',
): CustomDomainCandidate {
  const normalized = normalizeHostname(rawHostname);
  if (!normalized.ok) return { ok: false, reason: 'INVALID_HOSTNAME' };

  const root = normalizeHostname(rootDomain);
  if (!root.ok) throw new Error('rootDomain must be a valid hostname');

  if (
    normalized.hostname === root.hostname ||
    normalized.hostname.endsWith(`.${root.hostname}`)
  ) {
    return { ok: false, reason: 'PLATFORM_NAMESPACE' };
  }

  return { ok: true, hostname: normalized.hostname };
}

/** An unverified or misconfigured domain is never servable. */
export function customDomainLifecycle(
  state: CustomDomainProviderState,
): CustomDomainLifecycleState {
  if (!state.verified) {
    return {
      status: state.error ? 'FAILED' : 'AWAITING_DNS',
      ownershipStatus: state.error ? 'FAILED' : 'PENDING',
      dnsStatus: state.dnsStatus,
      tlsStatus: state.tlsStatus,
    };
  }

  if (state.dnsStatus !== 'OK') {
    return {
      status: 'VERIFYING',
      ownershipStatus: 'VERIFIED',
      dnsStatus: state.dnsStatus,
      tlsStatus: state.tlsStatus,
    };
  }

  if (state.tlsStatus !== 'ISSUED') {
    return {
      status: 'VERIFYING',
      ownershipStatus: 'VERIFIED',
      dnsStatus: 'OK',
      tlsStatus: state.tlsStatus,
    };
  }

  return {
    status: 'VERIFIED',
    ownershipStatus: 'VERIFIED',
    dnsStatus: 'OK',
    tlsStatus: 'ISSUED',
  };
}

export function domainCanActivate(state: {
  readonly status: DomainStatus;
  readonly ownershipStatus: DomainOwnershipStatus;
  readonly dnsStatus: DomainDnsStatus;
  readonly tlsStatus: DomainTlsStatus;
}): boolean {
  return (
    state.status === 'VERIFIED' &&
    state.ownershipStatus === 'VERIFIED' &&
    state.dnsStatus === 'OK' &&
    state.tlsStatus === 'ISSUED'
  );
}

/** P37 takeover guard: a released host cannot silently move to another tenant. */
export function takeoverBlocked(
  requestedTenantId: string,
  previousTenantId: string | null | undefined,
): boolean {
  return previousTenantId != null && previousTenantId !== requestedTenantId;
}
