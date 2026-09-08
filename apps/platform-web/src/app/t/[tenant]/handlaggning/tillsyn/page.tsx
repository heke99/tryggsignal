import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { loadSupervisionQueue } from '@/lib/data/supervision';

export const dynamic = 'force-dynamic';

export default async function SupervisionQueuePage() {
  const tenant = await currentTenant();
  const queue = await loadSupervisionQueue(tenant);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">PBL-tillsyn</p>
          <h1>Riskkö</h1>
          <p>
            Öppna tillsynsärenden prioriteras efter senaste dokumenterade riskbedömning. Riskscore
            är ett operativt prioriteringsstöd och ersätter aldrig juridisk bedömning.
          </p>
        </div>
        <Link className="button-secondary" href="/handlaggning">
          Till kontrolltornet
        </Link>
      </div>

      {!queue.available && (
        <div className="card" role="status">
          <p>{queue.reason ?? 'Tillsynskön är inte tillgänglig.'}</p>
        </div>
      )}

      {queue.available && (
        <section className="card" aria-labelledby="risk-queue-heading">
          <h2 id="risk-queue-heading">Öppna tillsynsärenden ({queue.rows.length})</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Risk</th>
                  <th scope="col">Ärende</th>
                  <th scope="col">Status</th>
                  <th scope="col">Öppnat</th>
                </tr>
              </thead>
              <tbody>
                {queue.rows.map((row) => (
                  <tr key={row.supervisionId}>
                    <td>
                      <strong>{row.riskScore.toFixed(0)}</strong>{' '}
                      <span className="status-badge">{row.riskLevel}</span>
                    </td>
                    <td>
                      <Link href={`/handlaggning/arenden/${row.caseId}#tillsyn`}>
                        {row.caseNumber} — {row.title}
                      </Link>
                    </td>
                    <td>
                      <span className="status-badge">{row.status}</span>
                    </td>
                    <td>{row.openedAt.slice(0, 10)}</td>
                  </tr>
                ))}
                {queue.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="meta">
                      Inga öppna PBL-tillsynsärenden i din behöriga scope.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
