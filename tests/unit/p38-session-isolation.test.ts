import { describe, expect, it } from 'vitest';
import {
  createSignInState,
  InvalidSignInStateError,
  refreshSessionCookie,
  safeReturnTo,
  sessionCookie,
  verifySignInState,
} from '@tryggsignal/identity';
import type { TenantContext } from '@tryggsignal/tenancy';

const platform: TenantContext = {
  tenantId: 'tenant-a',
  tenantSlug: 'alfakommun',
  domainId: 'domain-platform',
  domainType: 'PLATFORM_SUBDOMAIN',
  canonicalDomain: 'alfakommun.tryggsignal.se',
  brandingVersion: 1,
  deploymentId: 'dep-a',
  dataPlaneReference: 'project-a',
  authConfigurationReference: 'auth/a/staff',
  resolvedHostname: 'alfakommun.tryggsignal.se',
};

const custom: TenantContext = {
  ...platform,
  domainId: 'domain-custom',
  domainType: 'CUSTOM_DOMAIN',
  canonicalDomain: 'bygglov.alfakommun.se',
  resolvedHostname: 'bygglov.alfakommun.se',
};

const wrongTenant: TenantContext = {
  ...platform,
  tenantId: 'tenant-b',
  tenantSlug: 'betakommun',
  domainId: 'domain-b',
  deploymentId: 'dep-b',
  dataPlaneReference: 'project-b',
  authConfigurationReference: 'auth/b/staff',
  resolvedHostname: 'betakommun.tryggsignal.se',
  canonicalDomain: 'betakommun.tryggsignal.se',
};

const rotatedAuth: TenantContext = {
  ...custom,
  authConfigurationReference: 'auth/a/staff-v2',
};

const SECRET = 'p38-test-secret-at-least-thirty-two-characters';

describe('P38 host-only session isolation', () => {
  it('never emits a Domain attribute on access or refresh cookies', () => {
    for (const cookie of [sessionCookie(custom, 'access'), refreshSessionCookie(custom, 'refresh')]) {
      expect(cookie.name.startsWith('__Host-')).toBe(true);
      expect(cookie.options).toMatchObject({ secure: true, httpOnly: true, path: '/' });
      expect('domain' in cookie.options).toBe(false);
    }
  });

  it('keeps tenant cookie namespaces distinct', () => {
    expect(sessionCookie(platform, 'x').name).not.toBe(sessionCookie(wrongTenant, 'x').name);
  });
});

describe('P38 callback binding', () => {
  it('accepts state only on the exact host/domain/auth configuration that issued it', () => {
    const { state } = createSignInState(custom, '/handlaggning?filter=open', SECRET);
    const verified = verifySignInState(state, custom, SECRET);
    expect(verified.hostname).toBe('bygglov.alfakommun.se');
    expect(verified.authConfigurationReference).toBe('auth/a/staff');
    expect(verified.returnTo).toBe('/handlaggning?filter=open');
  });

  it('denies a custom-domain state on the fallback host even for the same tenant', () => {
    const { state } = createSignInState(custom, '/', SECRET);
    expect(() => verifySignInState(state, platform, SECRET)).toThrow(InvalidSignInStateError);
  });

  it('denies wrong-tenant callback state', () => {
    const { state } = createSignInState(custom, '/', SECRET);
    expect(() => verifySignInState(state, wrongTenant, SECRET)).toThrow(InvalidSignInStateError);
  });

  it('denies stale callback state after tenant auth configuration rotation', () => {
    const { state } = createSignInState(custom, '/', SECRET);
    expect(() => verifySignInState(state, rotatedAuth, SECRET)).toThrow(InvalidSignInStateError);
  });

  it('denies future-dated callback state outside clock skew', () => {
    const now = Date.now();
    const { state } = createSignInState(custom, '/', SECRET, now + 60_000);
    expect(() => verifySignInState(state, custom, SECRET, now)).toThrow(/timestamp/);
  });
});

describe('P38 open redirect gate', () => {
  it('allows only same-origin relative targets', () => {
    expect(safeReturnTo('/handlaggning?a=1#top')).toBe('/handlaggning?a=1#top');
  });

  it('collapses external, protocol-relative, backslash and control-character targets', () => {
    for (const candidate of [
      'https://evil.example/a',
      '//evil.example/a',
      '/\\evil.example/a',
      '/a\\b',
      'javascript:alert(1)',
      '/ok\r\nLocation: https://evil.example',
    ]) {
      expect(safeReturnTo(candidate)).toBe('/');
    }
  });
});
