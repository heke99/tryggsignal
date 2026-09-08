import { currentTenant } from '@/lib/tenant/context';
import { loadControlTower, type ControlTowerRow } from '@/lib/data/workspace';

export const dynamic = 'force-dynamic';

/** Masterplan 95: a control tower is a set of work queues, not a chart gallery. */
function Queue({
  heading,
  rows,
  emptyLabel,
}: {
  heading: string;
  rows: readonly ControlTowerRow[];
  emptyLabel: string;
}) {
  return (
    <section aria-labelledby={`q-${heading}`} className="card">
      <h2 id={`q-${heading}`}>
        {heading} <span className="meta">({rows.length})</span>
      </h2>
      {rows.length === 0 ? (
        <p className="meta">{emptyLabel}</p>
      ) : (
        <table>
          <caption className="meta">{heading}</caption>
          <thead>
            <tr>
              <th scope="col">Ärende</th>
              <th scope="col">Rubrik</th>
              <th scope="col">Status</th>
              <th scope="col">Frist</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <a href={`/handlaggning/arenden/${row.id}`}>{row.case_number}</a>
                </td>
                <td>{row.title}</td>
                <td>{row.status}</td>
                <td>{row.statutory_due_at?.slice(0, 10) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function ControlTower() {
  const tenant = await currentTenant();
  const tower = await loadControlTower(tenant);

  return (
    <main id="innehall">
      <h1>Kontrolltorn</h1>
      {!tower.available && (
        <div className="card" role="status">
          <p>Operativ data kan inte visas ännu.</p>
          <p className="meta">{tower.reason}</p>
        </div>
      )}

      <div className="card">
        <p className="meta">
          Remisser över tid: {tower.overdueReferrals} · Misslyckade integrationsjobb:{' '}
          {tower.failedJobs}
        </p>
      </div>

      <Queue
        heading="Frister inom 5 dagar"
        rows={tower.dueSoon}
        emptyLabel="Inga frister förfaller inom fem dagar."
      />
      <Queue
        heading="Ofördelade ärenden"
        rows={tower.unassigned}
        emptyLabel="Alla ärenden är fördelade."
      />
      <Queue
        heading="Väntar på komplettering"
        rows={tower.awaitingCompletion}
        emptyLabel="Inga ärenden väntar på komplettering."
      />
    </main>
  );
}
