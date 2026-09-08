import { describe, expect, it } from 'vitest';
import { normalizeHostname, requestHostname } from '@tryggsignal/tenancy';

describe('normalizeHostname (masterplan 160)', () => {
  it('lowercases, strips port and trailing dot', () => {
    expect(normalizeHostname('Mjolby.Tryggsignal.SE:443.')).toEqual({
      ok: false,
      error: 'INVALID_PORT',
    });
    expect(normalizeHostname('Mjolby.Tryggsignal.SE.')).toEqual({
      ok: true,
      hostname: 'mjolby.tryggsignal.se',
    });
    expect(normalizeHostname('mjolby.tryggsignal.se:3000')).toEqual({
      ok: true,
      hostname: 'mjolby.tryggsignal.se',
    });
    expect(normalizeHostname('mjolby.tryggsignal.se:443:444')).toEqual({
      ok: false,
      error: 'INVALID_PORT',
    });
    expect(normalizeHostname('mjolby.tryggsignal.se:70000')).toEqual({
      ok: false,
      error: 'INVALID_PORT',
    });
  });

  it('converts internationalized hostnames to their ASCII form', () => {
    const result = normalizeHostname('mjölby.tryggsignal.se');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.hostname).toBe('xn--mjlby-kua.tryggsignal.se');
  });

  it('rejects hosts that must never reach a tenant lookup', () => {
    for (const host of ['', '   ', '..', 'a..b.se', '-bad.tryggsignal.se', 'bad-.tryggsignal.se']) {
      expect(normalizeHostname(host).ok).toBe(false);
    }
    expect(normalizeHostname('127.0.0.1').error).toBe('IP_LITERAL_NOT_ALLOWED');
    expect(normalizeHostname('[::1]').error).toBe('IP_LITERAL_NOT_ALLOWED');
    expect(normalizeHostname(`${'a'.repeat(64)}.tryggsignal.se`).error).toBe('INVALID_LABEL');
  });

  it('rejects ambiguous forwarded-host chains even behind a trusted proxy', () => {
    const headers = new Headers({
      host: 'mjolby.tryggsignal.se',
      'x-forwarded-host': 'mjolby.tryggsignal.se, attacker.example',
    });
    expect(requestHostname(headers, { trustForwardedHost: true })).toEqual({
      ok: false,
      error: 'INVALID_CHARACTERS',
    });
  });

  it('ignores untrusted forwarded host unless the deployment trusts the proxy', () => {
    const headers = new Headers({
      host: 'mjolby.tryggsignal.se',
      'x-forwarded-host': 'attacker.example.com',
    });
    expect(requestHostname(headers, { trustForwardedHost: false })).toEqual({
      ok: true,
      hostname: 'mjolby.tryggsignal.se',
    });
    expect(requestHostname(headers, { trustForwardedHost: true })).toEqual({
      ok: true,
      hostname: 'attacker.example.com',
    });
  });
});
