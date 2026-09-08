import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';

export default async function Page() {
  const tenant = await currentTenant();

  return (
    <main id="innehall">
      <h1>Kommunadmin</h1>
      <p>
        Organisation, roller, branding, domäner och integrationer för kommunens administratörer.
      </p>
      <nav aria-label="Kommunadministration" className="card">
        <ul>
          <li>
            <Link href="/kommunadmin/branding">Branding</Link>
          </li>
          <li>
            <Link href="/kommunadmin/domaner">Domäner</Link>
          </li>
        </ul>
      </nav>
      <p className="meta">
        Data hämtas från kommunens eget data plane ({tenant.dataPlaneReference || 'ej kopplat'}) med
        användarens session och RLS.
      </p>
    </main>
  );
}
