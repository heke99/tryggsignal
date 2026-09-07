import { currentTenant } from '@/lib/tenant/context';

/**
 * Tenant shell. The tenant is taken from the resolved host context, never from
 * the route parameter — the parameter exists only because the proxy rewrites
 * into this segment (masterplan 159).
 */
export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant();

  return (
    <>
      <header
        style={{
          borderBottom: '1px solid var(--ts-border)',
          padding: '0.75rem 1.25rem',
        }}
      >
        <strong>{tenant.tenantSlug}</strong>{' '}
        <span className="meta">· {tenant.resolvedHostname}</span>
      </header>
      {children}
    </>
  );
}
