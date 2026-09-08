import { normalizeHostname } from './hostname';
import { SERVABLE_DOMAIN_STATUSES } from './types';
import type { PlatformSurface, Resolution, TenantDirectory } from './types';

/**
 * Masterplan 157–159: reserved exact hosts are resolved before wildcard tenant
 * lookup, and a hostname only becomes a tenant context after it matches an
 * ACTIVE domain record belonging to an ACTIVE tenant with a healthy data plane.
 */
export interface ResolverConfig {
  /** Apex marketing domain, e.g. `tryggsignal.se`. */
  readonly rootDomain: string;
  /** Optional preview/test suffix, e.g. `vercel.app`, mapped to the gateway. */
  readonly previewHostSuffix?: string;
  /**
   * Local development suffix, normally `localhost`. When set, `localhost` serves
   * the gateway and `<slug>.localhost` resolves as `<slug>.<rootDomain>`, so a
   * developer can work on several municipalities without editing /etc/hosts.
   *
   * The caller must leave this unset in production: it is a hostname rewrite, and
   * a production deployment that accepted it would let an attacker-controlled
   * Host header choose a tenant. `apps/platform-web/proxy.ts` only passes it when
   * NODE_ENV is not "production".
   */
  readonly developmentHostSuffix?: string;
}

const PLATFORM_HOSTS: ReadonlyMap<string, PlatformSurface> = new Map([
  ['app', 'APP_GATEWAY'],
  ['kommuner', 'MUNICIPALITY_DISCOVERY'],
  ['platform', 'PLATFORM_ADMIN'],
  ['admin', 'PLATFORM_ADMIN'],
]);

export class TenantResolver {
  constructor(
    private readonly directory: TenantDirectory,
    private readonly config: ResolverConfig,
  ) {}

  async resolve(rawHostname: string | null | undefined): Promise<Resolution> {
    const normalized = normalizeHostname(rawHostname);
    if (!normalized.ok) {
      return { kind: 'REJECTED', reason: 'INVALID_HOSTNAME', hostname: null };
    }
    const hostname = this.applyDevelopmentSuffix(normalized.hostname);

    const platform = this.platformSurfaceFor(hostname);
    if (platform !== null) {
      return { kind: 'PLATFORM', surface: platform, hostname };
    }

    const domain = await this.directory.findDomain(hostname);
    if (domain === null) {
      return { kind: 'REJECTED', reason: 'UNKNOWN_DOMAIN', hostname };
    }
    if (!SERVABLE_DOMAIN_STATUSES.has(domain.status)) {
      return { kind: 'REJECTED', reason: 'DOMAIN_NOT_ACTIVE', hostname };
    }

    const tenant = await this.directory.findTenant(domain.tenantId);
    if (tenant === null || tenant.status !== 'ACTIVE') {
      return { kind: 'REJECTED', reason: 'TENANT_NOT_ACTIVE', hostname };
    }
    if (tenant.deployment.status !== 'ACTIVE') {
      return { kind: 'REJECTED', reason: 'DEPLOYMENT_UNAVAILABLE', hostname };
    }

    return {
      kind: 'TENANT',
      context: {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        domainId: domain.id,
        domainType: domain.domainType,
        canonicalDomain: tenant.canonicalHostname,
        brandingVersion: tenant.brandingVersion,
        deploymentId: tenant.deployment.id,
        dataPlaneReference: tenant.deployment.supabaseProjectRef,
        authConfigurationReference: tenant.authConfigurationReference,
        resolvedHostname: hostname,
      },
    };
  }

  /**
   * Rewrites a development hostname to the equivalent platform hostname, so the
   * rest of resolution — reserved hosts included — behaves exactly as it will in
   * production. Returns the hostname untouched when no suffix is configured.
   */
  private applyDevelopmentSuffix(hostname: string): string {
    const suffix = this.config.developmentHostSuffix?.toLowerCase();
    if (suffix === undefined || suffix.length === 0) return hostname;

    if (hostname === suffix) return `app.${this.config.rootDomain.toLowerCase()}`;
    if (hostname.endsWith(`.${suffix}`)) {
      const label = hostname.slice(0, -(suffix.length + 1));
      // Only a single label maps; `a.b.localhost` stays unresolvable rather than
      // silently becoming something else.
      if (!label.includes('.')) return `${label}.${this.config.rootDomain.toLowerCase()}`;
    }
    return hostname;
  }

  /** Reserved exact hosts, checked before any wildcard tenant resolution. */
  private platformSurfaceFor(hostname: string): PlatformSurface | null {
    const root = this.config.rootDomain.toLowerCase();
    if (hostname === root || hostname === `www.${root}`) return 'MARKETING';

    if (hostname.endsWith(`.${root}`)) {
      const label = hostname.slice(0, -(root.length + 1));
      if (!label.includes('.')) {
        const surface = PLATFORM_HOSTS.get(label);
        if (surface !== undefined) return surface;
      }
    }

    const previewSuffix = this.config.previewHostSuffix;
    if (previewSuffix !== undefined && hostname.endsWith(`.${previewSuffix.toLowerCase()}`)) {
      // Masterplan 205: preview deployments never serve a production tenant by host.
      return 'APP_GATEWAY';
    }

    return null;
  }
}
