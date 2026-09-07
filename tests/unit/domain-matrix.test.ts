import { describe, expect, it } from 'vitest';
import {
  isReservedSubdomain,
  normalizeHostname,
  TenantResolver,
  tenantCacheKey,
  tenantCookieName,
  validateTenantSlug,
  type TenantDirectory,
  type TenantDomainRecord,
  type TenantRecord,
} from '@tryggsignal/tenancy';

/**
 * Masterplan 201–204: the domain and tenant test matrix. These are the negative
 * cases that must hold before any custom domain may go live.
 */

const deployment = {
  id: 'dep-a',
  supabaseProjectRef: 'refa',
  supabaseRegion: 'eu-north-1',
  supabaseUrl: 'https://refa.supabase.co',
  publishableKey: 'sb_publishable_a',
  privilegedCredentialReference: 'tenant/a/service',
  schemaVersion: '1',
  status: 'ACTIVE',
  healthStatus: 'HEALTHY',
};

const tenantA: TenantRecord = {
  id: 'tenant-a',
  slug: 'alfakommun',
  displayName: 'Alfakommun',
  status: 'ACTIVE',
  canonicalHostname: 'bygglov.alfakommun.se',
  brandingVersion: 2,
  authConfigurationReference: 'auth/a',
  deployment,
};

const tenantB: TenantRecord = {
  ...tenantA,
  id: 'tenant-b',
  slug: 'betakommun',
  canonicalHostname: 'betakommun.tryggsignal.se',
  brandingVersion: 1,
  authConfigurationReference: 'auth/b',
  deployment: {
    ...deployment,
    id: 'dep-b',
    supabaseProjectRef: 'refb',
    supabaseUrl: 'https://refb.supabase.co',
  },
};

const domains: TenantDomainRecord[] = [
  {
    id: 'd1',
    tenantId: 'tenant-a',
    normalizedHostname: 'alfakommun.tryggsignal.se',
    domainType: 'PLATFORM_SUBDOMAIN',
    status: 'ACTIVE',
    isCanonical: false,
  },
  {
    id: 'd2',
    tenantId: 'tenant-a',
    normalizedHostname: 'bygglov.alfakommun.se',
    domainType: 'CUSTOM_DOMAIN',
    status: 'ACTIVE',
    isCanonical: true,
  },
  {
    id: 'd3',
    tenantId: 'tenant-b',
    normalizedHostname: 'betakommun.tryggsignal.se',
    domainType: 'PLATFORM_SUBDOMAIN',
    status: 'ACTIVE',
    isCanonical: true,
  },
  {
    id: 'd4',
    tenantId: 'tenant-b',
    normalizedHostname: 'gammal.betakommun.se',
    domainType: 'CUSTOM_DOMAIN',
    status: 'DISABLED',
    isCanonical: false,
  },
  {
    id: 'd5',
    tenantId: 'tenant-a',
    normalizedHostname: 'ny.alfakommun.se',
    domainType: 'CUSTOM_DOMAIN',
    status: 'VERIFIED',
    isCanonical: false,
  },
];

const directory: TenantDirectory = {
  async findDomain(host) {
    return domains.find((d) => d.normalizedHostname === host) ?? null;
  },
  async findTenant(id) {
    return [tenantA, tenantB].find((t) => t.id === id) ?? null;
  },
};

const resolver = new TenantResolver(directory, { rootDomain: 'tryggsignal.se' });

describe('domain routing matrix (masterplan 201)', () => {
  const expectations: readonly [string, string][] = [
    ['tryggsignal.se', 'PLATFORM'],
    ['www.tryggsignal.se', 'PLATFORM'],
    ['app.tryggsignal.se', 'PLATFORM'],
    ['kommuner.tryggsignal.se', 'PLATFORM'],
    ['alfakommun.tryggsignal.se', 'TENANT'],
    ['bygglov.alfakommun.se', 'TENANT'],
    ['betakommun.tryggsignal.se', 'TENANT'],
    ['gammal.betakommun.se', 'REJECTED'],
    ['ny.alfakommun.se', 'REJECTED'],
    ['okand.tryggsignal.se', 'REJECTED'],
    ['helt.okand.example.com', 'REJECTED'],
  ];

  it.each(expectations)('routes %s as %s', async (host, kind) => {
    const resolution = await resolver.resolve(host);
    expect(resolution.kind).toBe(kind);
  });

  it('never resolves a VERIFIED-but-not-ACTIVE domain to a tenant', async () => {
    expect(await resolver.resolve('ny.alfakommun.se')).toMatchObject({
      kind: 'REJECTED',
      reason: 'DOMAIN_NOT_ACTIVE',
    });
  });
});

describe('cross-tenant negative tests (masterplan 202)', () => {
  it('gives two municipalities different data planes from their own hosts', async () => {
    const a = await resolver.resolve('alfakommun.tryggsignal.se');
    const b = await resolver.resolve('betakommun.tryggsignal.se');
    if (a.kind !== 'TENANT' || b.kind !== 'TENANT') throw new Error('expected tenant resolutions');
    expect(a.context.dataPlaneReference).not.toBe(b.context.dataPlaneReference);
    expect(a.context.tenantId).not.toBe(b.context.tenantId);
  });

  it('resolves a custom domain and its platform subdomain to the same tenant', async () => {
    const viaCustom = await resolver.resolve('bygglov.alfakommun.se');
    const viaPlatform = await resolver.resolve('alfakommun.tryggsignal.se');
    if (viaCustom.kind !== 'TENANT' || viaPlatform.kind !== 'TENANT')
      throw new Error('expected tenants');
    expect(viaCustom.context.tenantId).toBe(viaPlatform.context.tenantId);
    // The domain identity still differs, which is what keeps cache and cookie
    // scoping per host rather than per tenant only.
    expect(viaCustom.context.domainId).not.toBe(viaPlatform.context.domainId);
  });

  it('keeps cache keys and cookie names disjoint between tenants', async () => {
    const a = await resolver.resolve('alfakommun.tryggsignal.se');
    const b = await resolver.resolve('betakommun.tryggsignal.se');
    if (a.kind !== 'TENANT' || b.kind !== 'TENANT') throw new Error('expected tenant resolutions');
    expect(tenantCacheKey(a.context, 'cases')).not.toBe(tenantCacheKey(b.context, 'cases'));
    expect(tenantCookieName(a.context, 'session')).not.toBe(tenantCookieName(b.context, 'session'));
  });

  it('uses a __Host- prefixed cookie so it cannot be set for a parent domain', async () => {
    const a = await resolver.resolve('alfakommun.tryggsignal.se');
    if (a.kind !== 'TENANT') throw new Error('expected a tenant resolution');
    expect(tenantCookieName(a.context, 'session').startsWith('__Host-')).toBe(true);
  });
});

describe('hostname spoofing (masterplan 160/167)', () => {
  it('does not let a lookalike host resolve to a tenant', async () => {
    for (const host of [
      'alfakommun.tryggsignal.se.evil.example',
      'alfakommun.tryggsignal.se%2eevil.example',
      'xn--alfakommun-abc.tryggsignal.se',
      'ALFAKOMMUN.TRYGGSIGNAL.SE.',
    ]) {
      const resolution = await resolver.resolve(host);
      if (host === 'ALFAKOMMUN.TRYGGSIGNAL.SE.') {
        // The same host in a different case and with a trailing dot is the same host.
        expect(resolution.kind).toBe('TENANT');
      } else {
        expect(resolution.kind, host).toBe('REJECTED');
      }
    }
  });

  it('rejects a host that is not a valid hostname at all', async () => {
    for (const host of ['', ' ', 'http://alfakommun.tryggsignal.se', '10.0.0.1', 'a'.repeat(300)]) {
      expect((await resolver.resolve(host)).kind, host).toBe('REJECTED');
    }
  });

  it('normalizes before comparing, not after', () => {
    expect(normalizeHostname('BYGGLOV.Alfakommun.SE.')).toEqual({
      ok: true,
      hostname: 'bygglov.alfakommun.se',
    });
  });
});

describe('reserved namespace (masterplan 161)', () => {
  it('never lets a municipality claim a platform host', () => {
    for (const label of ['app', 'kommuner', 'admin', 'api', 'platform', 'www']) {
      expect(isReservedSubdomain(label)).toBe(true);
      expect(validateTenantSlug(label)).toMatchObject({ ok: false, error: 'RESERVED' });
    }
  });
});
