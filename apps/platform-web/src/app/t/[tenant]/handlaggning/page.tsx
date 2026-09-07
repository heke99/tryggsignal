import { currentTenant } from '@/lib/tenant/context';

export default async function Page() {
  const tenant = await currentTenant();

  return (
    <main>
      <h1>Handläggning</h1>
      <p>Ärenden, tillsyn, inspektioner och beslut för handläggare.</p>
      <p className="meta">
        Data hämtas från kommunens eget data plane ({tenant.dataPlaneReference || 'ej kopplat'}) med
        användarens session och RLS.
      </p>
    </main>
  );
}
