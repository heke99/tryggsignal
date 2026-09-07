import { currentTenant } from '@/lib/tenant/context';
import { loadCaseWorkspace } from '@/lib/data/workspace';

export const dynamic = 'force-dynamic';

/** Masterplan 94: one workspace per case, with the tabs a caseworker needs. */
const TABS = [
  'Översikt',
  'Handlingar',
  'Parter',
  'Fastighet',
  'Process',
  'Meddelanden',
  'Remisser',
  'Beslut',
  'Inspektioner',
  'AI',
  'Revision',
] as const;

export default async function CaseWorkspacePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  const tenant = await currentTenant();
  const workspace = await loadCaseWorkspace(tenant, caseId);

  if (workspace.header === null) {
    return (
      <main>
        <h1>Ärende</h1>
        <div className="card" role="status">
          <p>{workspace.reason ?? 'Ärendet kunde inte visas.'}</p>
        </div>
      </main>
    );
  }

  const header = workspace.header;

  return (
    <main>
      <h1>
        {header.case_number} — {header.title}
      </h1>

      <dl className="card">
        <div>
          <dt>Status</dt>
          <dd>{header.status}</dd>
        </div>
        <div>
          <dt>Fas</dt>
          <dd>{header.phase}</dd>
        </div>
        <div>
          <dt>Informationsklass</dt>
          <dd>{header.information_class}</dd>
        </div>
        <div>
          <dt>Lagstadgad frist</dt>
          <dd>{header.statutory_due_at?.slice(0, 10) ?? '—'}</dd>
        </div>
        <div>
          <dt>System of record</dt>
          <dd>{header.system_of_record}</dd>
        </div>
      </dl>

      <nav aria-label="Ärendeflikar">
        <ul className="tabs">
          {TABS.map((tab) => (
            <li key={tab}>
              <a href={`#${tab.toLowerCase()}`}>{tab}</a>
            </li>
          ))}
        </ul>
      </nav>

      <section id="handlingar" aria-labelledby="h-documents" className="card">
        <h2 id="h-documents">Handlingar ({workspace.documents.length})</h2>
        <ul>
          {workspace.documents.map((doc) => (
            <li key={doc.id}>
              {doc.title}{' '}
              <span className="meta">
                ({doc.document_type}, v{doc.current_version})
              </span>
            </li>
          ))}
          {workspace.documents.length === 0 && <li className="meta">Inga handlingar.</li>}
        </ul>
      </section>

      <section id="process" aria-labelledby="h-deadlines" className="card">
        <h2 id="h-deadlines">Frister</h2>
        <ul>
          {workspace.deadlines.map((deadline) => (
            <li key={deadline.id}>
              {deadline.name}: {deadline.due_at.slice(0, 10)}{' '}
              <span className="meta">({deadline.status})</span>
            </li>
          ))}
          {workspace.deadlines.length === 0 && <li className="meta">Inga registrerade frister.</li>}
        </ul>
      </section>

      <section id="revision" aria-labelledby="h-history" className="card">
        <h2 id="h-history">Statushistorik</h2>
        <ol>
          {workspace.history.map((event) => (
            <li key={event.id}>
              {event.changed_at.slice(0, 10)} — {event.to_status}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
