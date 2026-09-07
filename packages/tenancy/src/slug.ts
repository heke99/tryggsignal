/** Masterplan 161: reserved subdomains and municipality slug validation. */

export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'www',
  'app',
  'kommuner',
  'admin',
  'api',
  'docs',
  'status',
  'auth',
  'support',
  'mail',
  'notify',
  'assets',
  'cdn',
  'test',
  'preview',
  'staging',
  // Additional platform-owned hosts kept out of the tenant namespace.
  'platform',
  'security',
  'billing',
  'internal',
  'metrics',
  'webhooks',
]);

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type SlugError = 'EMPTY' | 'INVALID_FORMAT' | 'RESERVED' | 'TOO_LONG';

export type SlugResult =
  | { readonly ok: true; readonly slug: string }
  | { readonly ok: false; readonly error: SlugError };

export function validateTenantSlug(input: string | null | undefined): SlugResult {
  if (input == null) return { ok: false, error: 'EMPTY' };
  const slug = input;
  if (slug.length === 0) return { ok: false, error: 'EMPTY' };
  // Masterplan 161: no whitespace anywhere — not even leading/trailing, which a
  // trim would silently accept.
  if (/\s/.test(slug)) return { ok: false, error: 'INVALID_FORMAT' };
  if (slug.length > 63) return { ok: false, error: 'TOO_LONG' };
  if (slug !== slug.toLowerCase() || !SLUG_PATTERN.test(slug)) {
    return { ok: false, error: 'INVALID_FORMAT' };
  }
  if (RESERVED_SUBDOMAINS.has(slug)) return { ok: false, error: 'RESERVED' };
  return { ok: true, slug };
}

export function isReservedSubdomain(label: string): boolean {
  return RESERVED_SUBDOMAINS.has(label.toLowerCase());
}
