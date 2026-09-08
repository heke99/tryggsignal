import Image from 'next/image';
import type { Metadata } from 'next';
import { cache, type CSSProperties } from 'react';
import { brandingCssVariableMap } from '@tryggsignal/tenancy';
import type { TenantContext } from '@tryggsignal/tenancy';
import { currentTenant } from '@/lib/tenant/context';
import { resolvePublishedBranding, type TenantBrandingView } from '@/lib/tenant/branding';

interface TenantBrandingContext {
  readonly tenant: TenantContext;
  readonly branding: TenantBrandingView;
}

const currentTenantBranding = cache(async (): Promise<TenantBrandingContext> => {
  const tenant = await currentTenant();
  const branding = await resolvePublishedBranding(tenant);
  return { tenant, branding };
});

export async function generateMetadata(): Promise<Metadata> {
  const { branding } = await currentTenantBranding();
  return {
    title: {
      default: branding.displayName,
      template: `%s | ${branding.displayName}`,
    },
    icons:
      branding.faviconUrl === undefined
        ? undefined
        : {
            icon: [{ url: branding.faviconUrl }],
          },
  };
}

/**
 * Tenant shell. The tenant is taken from the resolved host context, never from
 * the route parameter — the parameter exists only because the proxy rewrites
 * into this segment (masterplan 159).
 */
export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const { tenant, branding } = await currentTenantBranding();
  const style = brandingCssVariableMap(branding) as CSSProperties;

  return (
    <div style={style} data-branding-version={branding.version}>
      <header
        style={{
          borderBottom: '1px solid var(--ts-border)',
          padding: '0.75rem 1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
        }}
      >
        {branding.logoUrl !== undefined ? (
          <Image
            src={branding.logoUrl}
            alt={`${branding.displayName} logotyp`}
            width={180}
            height={60}
            sizes="180px"
            priority
            style={{ width: 'auto', maxWidth: '11rem', height: '3rem', objectFit: 'contain' }}
          />
        ) : (
          <strong>{branding.shortName ?? branding.displayName}</strong>
        )}
        <span className="meta">· {tenant.resolvedHostname}</span>
      </header>
      {children}
      {branding.showTryggsignalBranding ? (
        <footer
          className="meta"
          style={{ borderTop: '1px solid var(--ts-border)', padding: '1rem 1.25rem' }}
        >
          Powered by Tryggsignal
        </footer>
      ) : null}
    </div>
  );
}
