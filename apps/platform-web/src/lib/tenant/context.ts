import 'server-only';
import { headers } from 'next/headers';
import type { DomainType, TenantContext } from '@tryggsignal/tenancy';

/**
 * Masterplan 158/159: the proxy is the only writer of these headers, and it
 * strips any inbound copy first. Route handlers and server components read the
 * tenant from here and never from a query parameter, body or cookie.
 */
export const TENANT_HEADERS = {
  tenantId: 'x-ts-tenant-id',
  tenantSlug: 'x-ts-tenant-slug',
  domainId: 'x-ts-domain-id',
  domainType: 'x-ts-domain-type',
  canonicalDomain: 'x-ts-canonical-domain',
  brandingVersion: 'x-ts-branding-version',
  deploymentId: 'x-ts-deployment-id',
  dataPlane: 'x-ts-data-plane',
  authConfig: 'x-ts-auth-config',
  hostname: 'x-ts-hostname',
  surface: 'x-ts-surface',
} as const;

export const INBOUND_TENANT_HEADERS: readonly string[] = Object.values(TENANT_HEADERS);

export function tenantHeadersFor(context: TenantContext): Record<string, string> {
  return {
    [TENANT_HEADERS.tenantId]: context.tenantId,
    [TENANT_HEADERS.tenantSlug]: context.tenantSlug,
    [TENANT_HEADERS.domainId]: context.domainId,
    [TENANT_HEADERS.domainType]: context.domainType,
    [TENANT_HEADERS.canonicalDomain]: context.canonicalDomain,
    [TENANT_HEADERS.brandingVersion]: String(context.brandingVersion),
    [TENANT_HEADERS.deploymentId]: context.deploymentId,
    [TENANT_HEADERS.dataPlane]: context.dataPlaneReference,
    [TENANT_HEADERS.authConfig]: context.authConfigurationReference,
    [TENANT_HEADERS.hostname]: context.resolvedHostname,
  };
}

export class MissingTenantContextError extends Error {
  constructor() {
    super('No tenant context on this request. A tenant route was reached without host resolution.');
    this.name = 'MissingTenantContextError';
  }
}

export async function currentTenant(): Promise<TenantContext> {
  const store = await headers();
  const tenantId = store.get(TENANT_HEADERS.tenantId);
  const tenantSlug = store.get(TENANT_HEADERS.tenantSlug);
  const domainId = store.get(TENANT_HEADERS.domainId);
  const hostname = store.get(TENANT_HEADERS.hostname);

  if (tenantId === null || tenantSlug === null || domainId === null || hostname === null) {
    throw new MissingTenantContextError();
  }

  return {
    tenantId,
    tenantSlug,
    domainId,
    domainType: (store.get(TENANT_HEADERS.domainType) ?? 'PLATFORM_SUBDOMAIN') as DomainType,
    canonicalDomain: store.get(TENANT_HEADERS.canonicalDomain) ?? hostname,
    brandingVersion: Number(store.get(TENANT_HEADERS.brandingVersion) ?? '1'),
    deploymentId: store.get(TENANT_HEADERS.deploymentId) ?? '',
    dataPlaneReference: store.get(TENANT_HEADERS.dataPlane) ?? '',
    authConfigurationReference: store.get(TENANT_HEADERS.authConfig) ?? '',
    resolvedHostname: hostname,
  };
}
