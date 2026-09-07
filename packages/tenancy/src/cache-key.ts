/**
 * Masterplan 142/184: any cache entry for tenant-specific information must carry
 * the verified tenant, domain and branding version in its key.
 */
import type { TenantContext } from './types';

export function tenantCacheKey(
  context: TenantContext,
  namespace: string,
  ...parts: readonly string[]
): string {
  return [
    'ts',
    context.tenantId,
    context.domainId,
    `b${context.brandingVersion}`,
    namespace,
    ...parts,
  ].join(':');
}

/** Cookie names are host-bound (masterplan 180) so a tenant host cannot read another's session. */
export function tenantCookieName(context: Pick<TenantContext, 'tenantSlug'>, base: string): string {
  return `__Host-ts_${context.tenantSlug}_${base}`;
}
