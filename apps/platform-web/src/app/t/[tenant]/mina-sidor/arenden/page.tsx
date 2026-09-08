import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { loadCitizenCases } from '@/lib/data/citizen';

export const dynamic = 'force-dynamic';

export default async function CitizenCasesPage() {
  const tenant = await currentTenant();
  const cases = await loadCitizenCases(tenant);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mina sidor</p>
          <h1>Ärenden</h1>
        </div>
        <div className="inline-action">
          <Link className="button-secondary" href="/mina-sidor">
            Översikt
          </Link>
          <Link className="button-primary" href="/mina-sidor/ansokan">
            Ny ansökan
          </Link>
        </div>
      </div>

      {!cases.available ? (
        <div className="card" role="status">
          <p>{cases.reason ?? 'Dina ärenden kunde inte hämtas.'}</p>
        </div>
      ) : (
        <section className="card" aria-labelledby="citizen-case-list-heading">
          <h2 id="citizen-case-list-heading">Dina ärenden ({cases.rows.length})</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Ärende</th>
                  <th scope="col">Typ</th>
                  <th scope="col">Status</th>
                  <th scope="col">Fas</th>
                  <th scope="col">Uppdaterat</th>
                </tr>
              </thead>
              <tbody>
                {cases.rows.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link href={`/mina-sidor/arenden/${item.id}`}>
                        {item.caseNumber} — {item.title}
                      </Link>
                    </td>
                    <td>{item.processType}</td>
                    <td>
                      <span className="status-badge">{item.status}</span>
                    </td>
                    <td>{item.phase}</td>
                    <td>{new Date(item.updatedAt).toLocaleDateString('sv-SE')}</td>
                  </tr>
                ))}
                {cases.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="meta">
                      Inga ärenden är kopplade till din verifierade identitet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
