import { describe, expect, it } from 'vitest';
import {
  MemoryRateLimitStore,
  RATE_LIMITS,
  checkRateLimit,
  isPlatformOnlyPath,
  rateLimitKey,
  requiresSession,
} from '@tryggsignal/tenancy';

describe('tenant route guard (masterplan 177)', () => {
  it('protects the staff, citizen and admin surfaces', () => {
    for (const path of [
      '/handlaggning',
      '/handlaggning/arenden/123',
      '/mina-sidor',
      '/mina-sidor/ansokan',
      '/kommunadmin',
      '/logga-ut',
    ]) {
      expect(requiresSession(path), path).toBe(true);
    }
  });

  it('leaves the public entry points open', () => {
    for (const path of ['/', '/login', '/domain-not-found', '/tillganglighet']) {
      expect(requiresSession(path), path).toBe(false);
    }
  });

  it('does not protect a path that merely starts with the same letters', () => {
    expect(requiresSession('/handlaggningsstod')).toBe(false);
  });

  it('marks the platform surface as platform-only', () => {
    expect(isPlatformOnlyPath('/platform')).toBe(true);
    expect(isPlatformOnlyPath('/platform/tenants')).toBe(true);
    expect(isPlatformOnlyPath('/platformer')).toBe(false);
  });
});

describe('rate limiting (masterplan 84)', () => {
  it('scopes the budget per tenant', () => {
    expect(rateLimitKey({ action: 'auth', tenantId: 'a', subject: '1.2.3.4' })).not.toBe(
      rateLimitKey({ action: 'auth', tenantId: 'b', subject: '1.2.3.4' }),
    );
  });

  it('allows up to the limit and then refuses', () => {
    const store = new MemoryRateLimitStore();
    const parts = { action: 'auth' as const, tenantId: 'a', subject: '1.2.3.4' };
    for (let attempt = 1; attempt <= RATE_LIMITS.auth.limit; attempt += 1) {
      expect(checkRateLimit(store, parts, 1_000).allowed, `attempt ${attempt}`).toBe(true);
    }
    expect(checkRateLimit(store, parts, 1_000).allowed).toBe(false);
  });

  it('opens a fresh window after the interval', () => {
    const store = new MemoryRateLimitStore();
    const parts = { action: 'auth' as const, tenantId: 'a', subject: '1.2.3.4' };
    for (let attempt = 0; attempt <= RATE_LIMITS.auth.limit; attempt += 1) {
      checkRateLimit(store, parts, 1_000);
    }
    expect(checkRateLimit(store, parts, 1_000).allowed).toBe(false);
    expect(checkRateLimit(store, parts, 1_000 + RATE_LIMITS.auth.windowMs + 1).allowed).toBe(true);
  });

  it('keeps one subject from consuming another subject budget', () => {
    const store = new MemoryRateLimitStore();
    for (let attempt = 0; attempt <= RATE_LIMITS.auth.limit; attempt += 1) {
      checkRateLimit(store, { action: 'auth', tenantId: 'a', subject: 'attacker' }, 1_000);
    }
    expect(
      checkRateLimit(store, { action: 'auth', tenantId: 'a', subject: 'innocent' }, 1_000).allowed,
    ).toBe(true);
  });

  it('applies the strictest budget to export and the loosest to ordinary traffic', () => {
    expect(RATE_LIMITS.export.limit).toBeLessThan(RATE_LIMITS.search.limit);
    expect(RATE_LIMITS.auth.limit).toBeLessThan(RATE_LIMITS.default.limit);
  });
});
