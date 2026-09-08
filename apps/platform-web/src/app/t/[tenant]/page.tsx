import { currentTenant } from '@/lib/tenant/context';

export default async function TenantEntry() {
  const tenant = await currentTenant();

  return (
    <main id="innehall">
      <h1>Kommunportal</h1>
      <p>Konfigurerad ingång för {tenant.tenantSlug}.</p>
      <div className="card">
        <p className="meta">Kanonisk domän: {tenant.canonicalDomain}</p>
        <p className="meta">Brandingversion: {tenant.brandingVersion}</p>
        <p className="meta">Domäntyp: {tenant.domainType}</p>
      </div>
      <ul>
        <li>
          <a href="/handlaggning">Handläggning</a>
        </li>
        <li>
          <a href="/mina-sidor">Mina sidor</a>
        </li>
        <li>
          <a href="/kommunadmin">Kommunadmin</a>
        </li>
      </ul>
    </main>
  );
}
