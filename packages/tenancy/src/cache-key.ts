/**
 * Masterplan 142/184/202: any cache entry for tenant-specific information must
 * carry the verified tenant, domain, hostname and branding version in its key.
 *
 * Every component is encoded before joining. Without that, a namespace such as
 * "cases:a" collides with namespace "cases" + part "a", which is a real cache
 * poisoning primitive even when the tenant prefix itself is correct.
 */
import type { TenantContext } from './types';

function cacheComponent(value: string): string {
  return encodeURIComponent(value);
}

export function tenantCacheKey(
  context: TenantContext,
  namespace: string,
  ...parts: readonly string[]
): string {
  return [
    'ts',
    context.tenantId,
    context.domainId,
    context.resolvedHostname,
    `b${context.brandingVersion}`,
    namespace,
    ...parts,
  ]
    .map(cacheComponent)
    .join(':');
}

/** Cookie names are host-bound (masterplan 180) so a tenant host cannot read another's session. */
export function tenantCookieName(context: Pick<TenantContext, 'tenantSlug'>, base: string): string {
  return `__Host-ts_${context.tenantSlug}_${base}`;
}
