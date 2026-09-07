import { describe, expect, it } from 'vitest';
import { tenantCacheKey, tenantCookieName, type TenantContext } from '@tryggsignal/tenancy';

const context: TenantContext = {
  tenantId: 'tenant-a',
  tenantSlug: 'mjolby',
  domainId: 'dom-1',
  domainType: 'PLATFORM_SUBDOMAIN',
  canonicalDomain: 'mjolby.tryggsignal.se',
  brandingVersion: 2,
  deploymentId: 'dep-1',
  dataPlaneReference: 'ref',
  authConfigurationReference: 'auth/mjolby',
  resolvedHostname: 'mjolby.tryggsignal.se',
};

describe('tenant cache and cookie scoping (masterplan 142, 180, 184)', () => {
  it('includes tenant, domain and branding version in the cache key', () => {
    expect(tenantCacheKey(context, 'branding')).toBe('ts:tenant-a:dom-1:b2:branding');
  });

  it('produces different keys for different tenants and branding versions', () => {
    const other = { ...context, tenantId: 'tenant-b', domainId: 'dom-2' };
    expect(tenantCacheKey(other, 'branding')).not.toBe(tenantCacheKey(context, 'branding'));
    expect(tenantCacheKey({ ...context, brandingVersion: 3 }, 'branding')).not.toBe(
      tenantCacheKey(context, 'branding'),
    );
  });

  it('uses host-bound cookie names per tenant', () => {
    expect(tenantCookieName(context, 'session')).toBe('__Host-ts_mjolby_session');
    expect(tenantCookieName({ tenantSlug: 'linkoping' }, 'session')).not.toBe(
      tenantCookieName(context, 'session'),
    );
  });
});
