import { currentTenant } from '@/lib/tenant/context';

export default async function Page() {
  const tenant = await currentTenant();

  return (
    <main>
      <h1>Mina sidor</h1>
      <p>Ansökningar, ärendestatus, kompletteringar och meddelanden för sökande och ombud.</p>
      <p className="meta">
        Data hämtas från kommunens eget data plane ({tenant.dataPlaneReference || 'ej kopplat'}) med
        användarens session och RLS.
      </p>
    </main>
  );
}
