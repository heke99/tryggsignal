import { describe, expect, it } from 'vitest';
import {
  customDomainLifecycle,
  domainCanActivate,
  takeoverBlocked,
  validateCustomDomainCandidate,
} from '@tryggsignal/tenancy';

describe('P37 custom domain lifecycle', () => {
  it('rejects Tryggsignal-owned namespace as a municipal custom domain', () => {
    for (const host of [
      'tryggsignal.se',
      'www.tryggsignal.se',
      'alpha.tryggsignal.se',
      'kommuner.tryggsignal.se',
    ]) {
      expect(validateCustomDomainCandidate(host)).toEqual({
        ok: false,
        reason: 'PLATFORM_NAMESPACE',
      });
    }
  });

  it('normalizes legitimate external custom domains', () => {
    expect(validateCustomDomainCandidate(' BYGGLOV.Example.SE. ')).toEqual({
      ok: true,
      hostname: 'bygglov.example.se',
    });
  });

  it('keeps unverified domains blocked', () => {
    const lifecycle = customDomainLifecycle({
      verified: false,
      dnsStatus: 'MISSING',
      tlsStatus: 'UNKNOWN',
      verification: [],
    });
    expect(lifecycle.status).toBe('AWAITING_DNS');
    expect(domainCanActivate(lifecycle)).toBe(false);
  });

  it('keeps verified but DNS-misconfigured domains blocked', () => {
    const lifecycle = customDomainLifecycle({
      verified: true,
      dnsStatus: 'MISCONFIGURED',
      tlsStatus: 'PENDING',
      verification: [],
    });
    expect(lifecycle.status).toBe('VERIFYING');
    expect(domainCanActivate(lifecycle)).toBe(false);
  });

  it('requires valid TLS before a domain may activate', () => {
    const lifecycle = customDomainLifecycle({
      verified: true,
      dnsStatus: 'OK',
      tlsStatus: 'PENDING',
      verification: [],
    });
    expect(lifecycle.status).toBe('VERIFYING');
    expect(domainCanActivate(lifecycle)).toBe(false);
  });

  it('marks a fully verified provider state ready for explicit activation', () => {
    const lifecycle = customDomainLifecycle({
      verified: true,
      dnsStatus: 'OK',
      tlsStatus: 'ISSUED',
      verification: [],
    });
    expect(lifecycle.status).toBe('VERIFIED');
    expect(domainCanActivate(lifecycle)).toBe(true);
  });

  it('blocks silent takeover of a released hostname by another tenant', () => {
    expect(takeoverBlocked('tenant-b', 'tenant-a')).toBe(true);
    expect(takeoverBlocked('tenant-a', 'tenant-a')).toBe(false);
    expect(takeoverBlocked('tenant-a', null)).toBe(false);
  });
});
