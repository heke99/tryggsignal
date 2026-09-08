import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { loadOvkQueue } from '@/lib/data/ovk';

export const dynamic = 'force-dynamic';

export default async function OvkQueuePage() {
  const tenant = await currentTenant();
  const queue = await loadOvkQueue(tenant);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">OVK</p>
          <h1>Tillsynskö</h1>
          <p>
            Objekt som är okända, snart förfallna, förfallna eller har öppna OVK-fynd. Regeln för
            kontrollintervall är versionerad data; kön prioriterar bara operativt.
          </p>
        </div>
        <Link className="button-secondary" href="/handlaggning">
          Till kontrolltornet
        </Link>
      </div>

      {!queue.available && (
        <div className="card" role="status">
          <p>{queue.reason ?? 'OVK-kön är inte tillgänglig.'}</p>
        </div>
      )}

      {queue.available && (
        <section className="card" aria-labelledby="ovk-queue-heading">
          <h2 id="ovk-queue-heading">Objekt att hantera ({queue.rows.length})</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Fastighet / byggnad</th>
                  <th scope="col">Objekt</th>
                  <th scope="col">Skyldighet</th>
                  <th scope="col">Nästa kontroll</th>
                  <th scope="col">Fynd</th>
                </tr>
              </thead>
              <tbody>
                {queue.rows.map((row) => (
                  <tr key={row.objectId}>
                    <td>
                      <span className="status-badge">{row.status}</span>
                      {row.riskScore !== null && (
                        <span className="meta"> · risk {row.riskScore}</span>
                      )}
                    </td>
                    <td>
                      {row.propertyDesignation ?? 'Fastighet saknas'}
                      {row.buildingDesignation === null ? '' : ' · ' + row.buildingDesignation}
                    </td>
                    <td>
                      {row.linkedCaseId === null ? (
                        (row.objectReference ?? 'OVK-objekt')
                      ) : (
                        <Link href={`/handlaggning/arenden/${row.linkedCaseId}#ovk`}>
                          {row.objectReference ?? 'Öppna OVK-ärende'}
                        </Link>
                      )}
                      {row.ventilationSystemType === null ? '' : ' · ' + row.ventilationSystemType}
                    </td>
                    <td>{row.obligationName}</td>
                    <td>{row.nextDueAt ?? 'Okänd'}</td>
                    <td>{row.openFindings}</td>
                  </tr>
                ))}
                {queue.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="meta">
                      Inga OVK-objekt kräver operativ hantering i din synliga scope.
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
