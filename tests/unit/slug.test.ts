import { describe, expect, it } from 'vitest';
import { RESERVED_SUBDOMAINS, validateTenantSlug } from '@tryggsignal/tenancy';

describe('validateTenantSlug (masterplan 161)', () => {
  it('accepts a valid municipality slug', () => {
    expect(validateTenantSlug('mjolby')).toEqual({ ok: true, slug: 'mjolby' });
    expect(validateTenantSlug('ostra-goinge')).toEqual({ ok: true, slug: 'ostra-goinge' });
  });

  it('rejects every reserved subdomain', () => {
    for (const reserved of RESERVED_SUBDOMAINS) {
      expect(validateTenantSlug(reserved)).toEqual({ ok: false, error: 'RESERVED' });
    }
  });

  it('rejects malformed slugs', () => {
    for (const slug of ['Mjolby', 'mjolby.se', 'mjolby ', '-mjolby', 'mjolby-', 'mjöl by', '']) {
      expect(validateTenantSlug(slug).ok).toBe(false);
    }
  });
});
