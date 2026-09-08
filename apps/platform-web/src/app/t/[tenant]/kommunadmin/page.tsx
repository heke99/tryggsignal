import { currentTenant } from '@/lib/tenant/context';

export default async function Page() {
  const tenant = await currentTenant();

  return (
    <main id="innehall">
      <h1>Kommunadmin</h1>
      <p>
        Organisation, roller, branding, domäner och integrationer för kommunens administratörer.
      </p>
      <p className="meta">
        Data hämtas från kommunens eget data plane ({tenant.dataPlaneReference || 'ej kopplat'}) med
        användarens session och RLS.
      </p>
    </main>
  );
}
