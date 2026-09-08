import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { loadCitizenCases } from '@/lib/data/citizen';

export const dynamic = 'force-dynamic';

export default async function CitizenPortalPage() {
  const tenant = await currentTenant();
  const cases = await loadCitizenCases(tenant);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mina sidor</p>
          <h1>Dina ärenden</h1>
          <p>Följ status, se handlingar som kommunen delat och skicka kompletteringar.</p>
        </div>
        <Link className="button-primary" href="/mina-sidor/ansokan">
          Ny ansökan
        </Link>
      </div>

      {!cases.available ? (
        <div className="card" role="status">
          <p>{cases.reason ?? 'Dina ärenden kunde inte visas.'}</p>
        </div>
      ) : (
        <>
          <section className="card" aria-labelledby="citizen-overview-heading">
            <h2 id="citizen-overview-heading">Översikt</h2>
            <p>
              Du har <strong>{cases.rows.length}</strong> synligt ärende
              {cases.rows.length === 1 ? '' : 'n'} i den här kommunen.
            </p>
            <p className="meta">
              Åtkomsten styrs av din verifierade relation till varje ärende och kommunens data
              plane. Ett ärende i en annan kommun visas inte här.
            </p>
          </section>

          <section className="card" aria-labelledby="citizen-recent-heading">
            <div className="section-heading">
              <h2 id="citizen-recent-heading">Senast uppdaterade</h2>
              <Link href="/mina-sidor/arenden">Visa alla</Link>
            </div>
            <div className="entity-list">
              {cases.rows.slice(0, 5).map((item) => (
                <article className="entity-item" key={item.id}>
                  <div className="entity-heading">
                    <div>
                      <h3>
                        <Link href={`/mina-sidor/arenden/${item.id}`}>
                          {item.caseNumber} — {item.title}
                        </Link>
                      </h3>
                      <p className="meta">
                        {item.processType} · <span className="status-badge">{item.status}</span> ·{' '}
                        {item.phase}
                      </p>
                    </div>
                  </div>
                </article>
              ))}
              {cases.rows.length === 0 ? (
                <p className="meta">Du har inga ärenden i den här kommunen ännu.</p>
              ) : null}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
