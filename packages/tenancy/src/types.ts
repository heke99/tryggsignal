/** Masterplan 162, 163, 172: control-plane shapes consumed by the resolver. */

export const DOMAIN_TYPES = ['PLATFORM_SUBDOMAIN', 'CUSTOM_DOMAIN', 'PLATFORM_RESERVED'] as const;
export type DomainType = (typeof DOMAIN_TYPES)[number];

export const DOMAIN_STATUSES = [
  'PENDING',
  'AWAITING_DNS',
  'VERIFYING',
  'VERIFIED',
  'ACTIVE',
  'FAILED',
  'DISABLED',
  'REMOVED',
] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/** Only ACTIVE domains may serve tenant data. VERIFIED is not yet servable. */
export const SERVABLE_DOMAIN_STATUSES: ReadonlySet<DomainStatus> = new Set<DomainStatus>([
  'ACTIVE',
]);

export const TENANT_STATUSES = [
  'PROVISIONING',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'OFFBOARDED',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface TenantDomainRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly normalizedHostname: string;
  readonly domainType: DomainType;
  readonly status: DomainStatus;
  readonly isCanonical: boolean;
}

export interface TenantDeploymentRecord {
  readonly id: string;
  readonly supabaseProjectRef: string;
  readonly supabaseRegion: string;
  readonly supabaseUrl: string;
  /** Publishable (anon) key only — never a privileged credential. */
  readonly publishableKey: string;
  /** Masterplan 172/173: a reference into the secret provider, never a secret. */
  readonly privilegedCredentialReference: string;
  readonly schemaVersion: string;
  readonly status: string;
  readonly healthStatus: string;
}

export interface TenantRecord {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly canonicalHostname: string;
  readonly brandingVersion: number;
  readonly authConfigurationReference: string;
  readonly deployment: TenantDeploymentRecord;
}

/** Masterplan 159: the resolver's output contract. */
export interface TenantContext {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly domainId: string;
  readonly domainType: DomainType;
  readonly canonicalDomain: string;
  readonly brandingVersion: number;
  readonly deploymentId: string;
  readonly dataPlaneReference: string;
  readonly authConfigurationReference: string;
  /** The verified hostname this context was resolved from. */
  readonly resolvedHostname: string;
}

/** Masterplan 151/177: platform-owned hosts never resolve to a tenant. */
export type PlatformSurface =
  | 'MARKETING'
  | 'APP_GATEWAY'
  | 'MUNICIPALITY_DISCOVERY'
  | 'PLATFORM_ADMIN';

export type ResolutionFailure =
  | 'INVALID_HOSTNAME'
  | 'UNKNOWN_DOMAIN'
  | 'DOMAIN_NOT_ACTIVE'
  | 'TENANT_NOT_ACTIVE'
  | 'DEPLOYMENT_UNAVAILABLE';

export type Resolution =
  | { readonly kind: 'PLATFORM'; readonly surface: PlatformSurface; readonly hostname: string }
  | { readonly kind: 'TENANT'; readonly context: TenantContext }
  | {
      readonly kind: 'REJECTED';
      readonly reason: ResolutionFailure;
      readonly hostname: string | null;
    };

/**
 * What the control plane knows about one hostname, as far as routing is
 * concerned. Deliberately excludes the deployment's keys and credential
 * reference: routing decides which municipality a request belongs to, it does
 * not open a connection (masterplan 172/173).
 */
export interface HostLookup {
  readonly domainId: string;
  readonly domainType: DomainType;
  readonly domainStatus: DomainStatus;
  readonly tenantId: string | null;
  readonly tenantSlug: string | null;
  readonly tenantStatus: TenantStatus | null;
  readonly canonicalHostname: string | null;
  readonly brandingVersion: number | null;
  readonly authConfigurationReference: string | null;
  readonly deploymentId: string | null;
  readonly deploymentStatus: string | null;
  readonly dataPlaneReference: string | null;
}

/** Port implemented by the control-plane directory (Supabase, cache, or test double). */
export interface TenantDirectory {
  findDomain(normalizedHostname: string): Promise<TenantDomainRecord | null>;
  findTenant(tenantId: string): Promise<TenantRecord | null>;
  /**
   * Resolves a hostname in one round trip. Implementations that can do this
   * should: the proxy runs on every request, so two lookups per request is a
   * cost paid by every page view (masterplan 185). The resolver falls back to
   * `findDomain` + `findTenant` when it is absent.
   */
  lookupHost?(normalizedHostname: string): Promise<HostLookup | null>;
}
