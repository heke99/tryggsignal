import { currentTenant } from '@/lib/tenant/context';

/** Masterplan 178/180: authentication is per tenant and the session is host-bound. */
export default async function TenantLogin() {
  const tenant = await currentTenant();

  return (
    <main>
      <h1>Logga in</h1>
      <p className="meta">
        Inloggning sker mot kommunens konfigurerade identitetsleverantör (
        {tenant.authConfigurationReference || 'ej konfigurerad'}).
      </p>
    </main>
  );
}
