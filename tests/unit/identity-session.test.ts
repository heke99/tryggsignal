import { describe, expect, it } from 'vitest';
import {
  assertUsableInEnvironment,
  buildHandoffUrl,
  clearedSessionCookie,
  createSignInState,
  IdentityProviderUnavailableError,
  InvalidSignInStateError,
  safeReturnTo,
  selectAuthConfiguration,
  sessionCookie,
  verifySignInState,
  type TenantAuthConfiguration,
} from '@tryggsignal/identity';
import type { TenantContext } from '@tryggsignal/tenancy';

const context: TenantContext = {
  tenantId: 'tenant-a',
  tenantSlug: 'alfakommun',
  domainId: 'dom-1',
  domainType: 'PLATFORM_SUBDOMAIN',
  canonicalDomain: 'alfakommun.tryggsignal.se',
  brandingVersion: 1,
  deploymentId: 'dep-1',
  dataPlaneReference: 'refa',
  authConfigurationReference: 'auth/a',
  resolvedHostname: 'alfakommun.tryggsignal.se',
};

const otherContext: TenantContext = {
  ...context,
  tenantId: 'tenant-b',
  tenantSlug: 'betakommun',
  domainId: 'dom-2',
  resolvedHostname: 'betakommun.tryggsignal.se',
};

const SECRET = 'test-signing-secret';

describe('session cookies (masterplan 180)', () => {
  it('uses a __Host- prefixed, httpOnly, secure cookie', () => {
    const cookie = sessionCookie(context, 'token');
    expect(cookie.name).toBe('__Host-ts_alfakommun_session');
    expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, path: '/' });
  });

  it('names the cookie differently per tenant so hosts cannot collide', () => {
    expect(sessionCookie(otherContext, 'token').name).not.toBe(
      sessionCookie(context, 'token').name,
    );
  });

  it('clears by expiring the same name', () => {
    const cleared = clearedSessionCookie(context);
    expect(cleared.name).toBe(sessionCookie(context, 'x').name);
    expect(cleared.options.maxAge).toBe(0);
    expect(cleared.value).toBe('');
  });
});

describe('sign-in state (masterplan 183)', () => {
  it('round-trips a state it issued', () => {
    const { state } = createSignInState(context, '/handlaggning', SECRET);
    expect(verifySignInState(state, context, SECRET)).toMatchObject({
      tenantId: 'tenant-a',
      returnTo: '/handlaggning',
    });
  });

  it('refuses a state issued for another tenant or domain', () => {
    const { state } = createSignInState(context, '/', SECRET);
    expect(() => verifySignInState(state, otherContext, SECRET)).toThrow(InvalidSignInStateError);
  });

  it('refuses a tampered or wrongly signed state', () => {
    const { state } = createSignInState(context, '/', SECRET);
    expect(() => verifySignInState(state, context, 'other-secret')).toThrow(
      InvalidSignInStateError,
    );
    expect(() => verifySignInState(`${state}x`, context, SECRET)).toThrow(InvalidSignInStateError);
    expect(() => verifySignInState('garbage', context, SECRET)).toThrow(InvalidSignInStateError);
  });

  it('expires after its window', () => {
    const now = Date.now();
    const { state } = createSignInState(context, '/', SECRET, now);
    expect(() => verifySignInState(state, context, SECRET, now + 11 * 60_000)).toThrow(/expired/);
  });
});

describe('return targets (masterplan 181)', () => {
  it('accepts a same-site path', () => {
    expect(safeReturnTo('/handlaggning/arenden/1')).toBe('/handlaggning/arenden/1');
  });

  it('refuses anything that could leave the site', () => {
    for (const candidate of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '/ok\nSet-Cookie: x=1',
      '',
      null,
    ]) {
      expect(safeReturnTo(candidate)).toBe('/');
    }
  });
});

describe('central login handoff (masterplan 175)', () => {
  it('sends the user to the tenant canonical host', () => {
    expect(
      buildHandoffUrl(
        { canonicalHostname: 'bygglov.alfakommun.se', slug: 'alfakommun' },
        ['alfakommun'],
        '/handlaggning',
      ),
    ).toBe('https://bygglov.alfakommun.se/login?returnTo=%2Fhandlaggning');
  });

  it('refuses a tenant the user has no relation to', () => {
    expect(() =>
      buildHandoffUrl(
        { canonicalHostname: 'betakommun.tryggsignal.se', slug: 'betakommun' },
        ['alfakommun'],
        '/',
      ),
    ).toThrow(InvalidSignInStateError);
  });
});

const config = (overrides: Partial<TenantAuthConfiguration>): TenantAuthConfiguration => ({
  reference: 'auth/a/staff',
  tenantId: 'tenant-a',
  audience: 'STAFF',
  kind: 'ENTRA_ID',
  displayName: 'Alfakommun Entra ID',
  issuer: 'https://login.microsoftonline.com/abc',
  metadataUrl: null,
  credentialReference: 'tenant/alfakommun/entra',
  enabled: true,
  allowedEmailDomains: ['alfakommun.se'],
  ...overrides,
});

describe('identity configuration selection (masterplan 15/116/178)', () => {
  it('picks the configuration matching the email domain', () => {
    const chosen = selectAuthConfiguration(
      [
        config({ reference: 'a', allowedEmailDomains: ['konsult.se'] }),
        config({ reference: 'b', allowedEmailDomains: ['alfakommun.se'] }),
      ],
      {
        tenantId: 'tenant-a',
        audience: 'STAFF',
        environment: 'PRODUCTION',
        email: 'a@alfakommun.se',
      },
    );
    expect(chosen.reference).toBe('b');
  });

  it('never falls through to another tenant or audience', () => {
    expect(() =>
      selectAuthConfiguration([config({ tenantId: 'tenant-b' })], {
        tenantId: 'tenant-a',
        audience: 'STAFF',
        environment: 'DEV',
      }),
    ).toThrow(IdentityProviderUnavailableError);

    expect(() =>
      selectAuthConfiguration([config({ audience: 'EXTERNAL' })], {
        tenantId: 'tenant-a',
        audience: 'STAFF',
        environment: 'DEV',
      }),
    ).toThrow(IdentityProviderUnavailableError);
  });

  it('ignores a disabled configuration', () => {
    expect(() =>
      selectAuthConfiguration([config({ enabled: false })], {
        tenantId: 'tenant-a',
        audience: 'STAFF',
        environment: 'DEV',
      }),
    ).toThrow(IdentityProviderUnavailableError);
  });

  it('refuses Sweden Connect in production until the official connection exists', () => {
    expect(() =>
      assertUsableInEnvironment(
        config({ kind: 'SWEDEN_CONNECT', audience: 'EXTERNAL', credentialReference: 'ref' }),
        'PRODUCTION',
      ),
    ).toThrow(/official connection/);
    expect(() =>
      assertUsableInEnvironment(
        config({ kind: 'SWEDEN_CONNECT', audience: 'EXTERNAL', credentialReference: 'ref' }),
        'TEST',
      ),
    ).not.toThrow();
  });

  it('reports a missing credential as EXTERNAL_BLOCKED rather than trying to connect', () => {
    expect(() =>
      assertUsableInEnvironment(config({ credentialReference: null }), 'PRODUCTION'),
    ).toThrow(/EXTERNAL_BLOCKED/);
  });
});
