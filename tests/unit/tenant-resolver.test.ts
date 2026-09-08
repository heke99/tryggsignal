import { describe, expect, it } from 'vitest';
import {
  TenantResolver,
  type TenantDirectory,
  type TenantDomainRecord,
  type TenantRecord,
} from '@tryggsignal/tenancy';

const deployment = {
  id: 'dep-1',
  supabaseProjectRef: 'mjolbyref',
  supabaseRegion: 'eu-north-1',
  supabaseUrl: 'https://mjolbyref.supabase.co',
  publishableKey: 'sb_publishable_test',
  privilegedCredentialReference: 'tenant/mjolby/service',
  schemaVersion: '0007',
  status: 'ACTIVE',
  healthStatus: 'HEALTHY',
};

function directory(
  domains: readonly TenantDomainRecord[],
  tenants: readonly TenantRecord[],
): TenantDirectory {
  return {
    async findDomain(hostname) {
      return domains.find((d) => d.normalizedHostname === hostname) ?? null;
    },
    async findTenant(tenantId) {
      return tenants.find((t) => t.id === tenantId) ?? null;
    },
  };
}

const mjolby: TenantRecord = {
  id: 'tenant-mjolby',
  slug: 'mjolby',
  displayName: 'Mjölby kommun',
  status: 'ACTIVE',
  canonicalHostname: 'samhallsbyggnad.mjolby.se',
  brandingVersion: 3,
  authConfigurationReference: 'auth/mjolby',
  deployment,
};

const domains: TenantDomainRecord[] = [
  {
    id: 'dom-1',
    tenantId: 'tenant-mjolby',
    normalizedHostname: 'mjolby.tryggsignal.se',
    domainType: 'PLATFORM_SUBDOMAIN',
    status: 'ACTIVE',
    isCanonical: false,
  },
  {
    id: 'dom-2',
    tenantId: 'tenant-mjolby',
    normalizedHostname: 'samhallsbyggnad.mjolby.se',
    domainType: 'CUSTOM_DOMAIN',
    status: 'ACTIVE',
    isCanonical: true,
  },
  {
    id: 'dom-3',
    tenantId: 'tenant-mjolby',
    normalizedHostname: 'nydoman.mjolby.se',
    domainType: 'CUSTOM_DOMAIN',
    status: 'VERIFYING',
    isCanonical: false,
  },
];

const resolver = new TenantResolver(directory(domains, [mjolby]), {
  rootDomain: 'tryggsignal.se',
  previewHostSuffix: 'vercel.app',
});

describe('TenantResolver (masterplan 157–159, 171)', () => {
  it('routes reserved platform hosts before tenant lookup', async () => {
    const cases: Array<[string, string]> = [
      ['tryggsignal.se', 'MARKETING'],
      ['www.tryggsignal.se', 'MARKETING'],
      ['app.tryggsignal.se', 'APP_GATEWAY'],
      ['kommuner.tryggsignal.se', 'MUNICIPALITY_DISCOVERY'],
      ['platform.tryggsignal.se', 'PLATFORM_ADMIN'],
      ['tryggsignal-abc123.vercel.app', 'APP_GATEWAY'],
    ];
    for (const [host, surface] of cases) {
      const resolution = await resolver.resolve(host);
      expect(resolution.kind, host).toBe('PLATFORM');
      if (resolution.kind === 'PLATFORM') expect(resolution.surface).toBe(surface);
    }
  });

  it('resolves an active platform subdomain to its tenant and data plane', async () => {
    const resolution = await resolver.resolve('MJOLBY.tryggsignal.se');
    expect(resolution.kind).toBe('TENANT');
    if (resolution.kind !== 'TENANT') return;
    expect(resolution.context).toMatchObject({
      tenantId: 'tenant-mjolby',
      tenantSlug: 'mjolby',
      domainType: 'PLATFORM_SUBDOMAIN',
      canonicalDomain: 'samhallsbyggnad.mjolby.se',
      brandingVersion: 3,
      dataPlaneReference: 'mjolbyref',
      resolvedHostname: 'mjolby.tryggsignal.se',
    });
  });

  it('resolves a verified custom domain to the same tenant', async () => {
    const resolution = await resolver.resolve('samhallsbyggnad.mjolby.se');
    expect(resolution.kind).toBe('TENANT');
    if (resolution.kind === 'TENANT') {
      expect(resolution.context.domainType).toBe('CUSTOM_DOMAIN');
      expect(resolution.context.tenantId).toBe('tenant-mjolby');
    }
  });

  it('refuses unknown, unverified, suspended and invalid hosts', async () => {
    expect(await resolver.resolve('okand.tryggsignal.se')).toMatchObject({
      kind: 'REJECTED',
      reason: 'UNKNOWN_DOMAIN',
    });
    expect(await resolver.resolve('nydoman.mjolby.se')).toMatchObject({
      kind: 'REJECTED',
      reason: 'DOMAIN_NOT_ACTIVE',
    });
    expect(await resolver.resolve('999.999.999.999')).toMatchObject({
      kind: 'REJECTED',
      reason: 'INVALID_HOSTNAME',
    });

    const suspended = new TenantResolver(directory(domains, [{ ...mjolby, status: 'SUSPENDED' }]), {
      rootDomain: 'tryggsignal.se',
    });
    expect(await suspended.resolve('mjolby.tryggsignal.se')).toMatchObject({
      kind: 'REJECTED',
      reason: 'TENANT_NOT_ACTIVE',
    });

    const unhealthy = new TenantResolver(
      directory(domains, [{ ...mjolby, deployment: { ...deployment, status: 'PROVISIONING' } }]),
      { rootDomain: 'tryggsignal.se' },
    );
    expect(await unhealthy.resolve('mjolby.tryggsignal.se')).toMatchObject({
      kind: 'REJECTED',
      reason: 'DEPLOYMENT_UNAVAILABLE',
    });
  });
});

describe('local development hosts', () => {
  const devResolver = new TenantResolver(directory(domains, [mjolby]), {
    rootDomain: 'tryggsignal.se',
    developmentHostSuffix: 'localhost',
  });

  it('serves the gateway on bare localhost so `pnpm dev` is usable', async () => {
    const resolution = await devResolver.resolve('localhost:3000');
    expect(resolution.kind).toBe('PLATFORM');
    if (resolution.kind === 'PLATFORM') expect(resolution.surface).toBe('APP_GATEWAY');
  });

  it('maps <slug>.localhost onto the equivalent platform host', async () => {
    const resolution = await devResolver.resolve('mjolby.localhost:3000');
    expect(resolution.kind).toBe('TENANT');
    if (resolution.kind === 'TENANT') expect(resolution.context.tenantSlug).toBe('mjolby');
  });

  it('keeps the reserved hosts reserved in development too', async () => {
    for (const [host, surface] of [
      ['app.localhost', 'APP_GATEWAY'],
      ['kommuner.localhost', 'MUNICIPALITY_DISCOVERY'],
      ['platform.localhost', 'PLATFORM_ADMIN'],
    ] as const) {
      const resolution = await devResolver.resolve(host);
      expect(resolution.kind, host).toBe('PLATFORM');
      if (resolution.kind === 'PLATFORM') expect(resolution.surface).toBe(surface);
    }
  });

  it('does not map a multi-label development host', async () => {
    expect(await devResolver.resolve('a.mjolby.localhost')).toMatchObject({ kind: 'REJECTED' });
  });

  it('is inert when the suffix is not configured, which is how production runs', async () => {
    expect(await resolver.resolve('mjolby.localhost')).toMatchObject({
      kind: 'REJECTED',
      reason: 'UNKNOWN_DOMAIN',
    });
    expect(await resolver.resolve('localhost')).toMatchObject({ kind: 'REJECTED' });
  });
});
