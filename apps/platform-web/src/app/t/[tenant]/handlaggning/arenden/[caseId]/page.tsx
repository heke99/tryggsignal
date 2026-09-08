import Link from 'next/link';
import {
  advanceWorkflowAction,
  assignCaseAction,
  closeCaseAction,
  setWorkflowPauseAction,
} from '@/lib/data/actions';
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

const ERROR_MESSAGES: Record<string, string> = {
  validation: 'Åtgärden innehöll ogiltiga eller ofullständiga värden.',
  assign: 'Ärendet kunde inte fördelas. Kontrollera behörighet och vald mottagare.',
  transition:
    'Processen kunde inte flyttas. Övergången kan vara otillåten eller kräva högre behörighet.',
  workflow: 'Processens pausstatus kunde inte ändras.',
  close:
    'Ärendet kunde inte stängas. Aktiv process måste vara avslutad och du måste ha rätt behörighet.',
};

const SUCCESS_MESSAGES: Record<string, string> = {
  assigned: 'Fördelningen har sparats.',
  transition: 'Processen har flyttats och arbetsytan har uppdaterats.',
  paused: 'Processen är pausad. Lagstadgade frister ändras inte automatiskt.',
  resumed: 'Processen är återupptagen.',
  closed: 'Ärendet är stängt och redo för arkivsteget.',
};

export default async function CaseWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { caseId } = await params;
  const tenant = await currentTenant();
  const workspace = await loadCaseWorkspace(tenant, caseId);
  const query = await searchParams;

  if (workspace.header === null) {
    return (
      <main id="innehall">
        <h1>Ärende</h1>
        <div className="card" role="status">
          <p>{workspace.reason ?? 'Ärendet kunde inte visas.'}</p>
        </div>
      </main>
    );
  }

  const header = workspace.header;
  const assignedUser = workspace.assignees.find((user) => user.id === header.assigned_user_id);
  const assignedTeam = workspace.teams.find((team) => team.id === header.assigned_team_id);
  const errorMessage =
    query.error === undefined ? null : ERROR_MESSAGES[query.error] ?? ERROR_MESSAGES.validation;
  const successMessage =
    query.ok === undefined ? null : SUCCESS_MESSAGES[query.ok] ?? 'Åtgärden är genomförd.';

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Ärendearbetsyta</p>
          <h1>
            {header.case_number} — {header.title}
          </h1>
        </div>
        <Link className="button-secondary" href="/handlaggning">
          Till kontrolltornet
        </Link>
      </div>

      {errorMessage !== null && (
        <div className="notice notice-error" role="alert">
          {errorMessage}
        </div>
      )}
      {successMessage !== null && (
        <div className="notice notice-success" role="status">
          {successMessage}
        </div>
      )}

      <section id="översikt" aria-labelledby="h-overview" className="card">
        <h2 id="h-overview">Översikt</h2>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="status-badge">{header.status}</span>
            </dd>
          </div>
          <div>
            <dt>Fas</dt>
            <dd>{header.phase}</dd>
          </div>
          <div>
            <dt>Ansvarig</dt>
            <dd>{assignedUser?.display_name ?? assignedTeam?.name ?? 'Ofördelat'}</dd>
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
      </section>

      <nav aria-label="Ärendeflikar">
        <ul className="tabs">
          {TABS.map((tab) => (
            <li key={tab}>
              <a href={`#${tab.toLowerCase()}`}>{tab}</a>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-labelledby="h-assignment" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-assignment">Fördelning</h2>
            <p className="meta">
              Fördelning kräver separat <code>case.assign</code>-behörighet och verifieras i
              databasen.
            </p>
          </div>
        </div>
        <form action={assignCaseAction} className="form-grid compact-form">
          <input type="hidden" name="caseId" value={header.id} />

          <div className="form-field">
            <label htmlFor="assignedUserId">Ansvarig handläggare</label>
            <select
              id="assignedUserId"
              name="assignedUserId"
              defaultValue={header.assigned_user_id ?? ''}
            >
              <option value="">Ingen handläggare</option>
              {workspace.assignees.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.display_name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="assignedTeamId">Ansvarigt team</label>
            <select
              id="assignedTeamId"
              name="assignedTeamId"
              defaultValue={header.assigned_team_id ?? ''}
            >
              <option value="">Inget team</option>
              {workspace.teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field form-field-wide">
            <label htmlFor="assignmentReason">Orsak / kommentar</label>
            <input
              id="assignmentReason"
              name="reason"
              type="text"
              maxLength={500}
              placeholder="Exempel: Fördelas enligt teamets arbetskö"
            />
          </div>

          <div className="form-actions form-field-wide">
            <button type="submit">Spara fördelning</button>
          </div>
        </form>
      </section>

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

      <section id="process" aria-labelledby="h-process" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-process">Process</h2>
            {workspace.workflow !== null && (
              <p className="meta">
                Nuvarande tillstånd: <strong>{workspace.workflow.currentState}</strong> · runtime:{' '}
                {workspace.workflow.status}
              </p>
            )}
          </div>
        </div>

        {workspace.workflow === null ? (
          <p className="meta">
            Ärendet saknar en startad workflowinstans. Nya ärenden binds till en publicerad process
            redan vid skapandet.
          </p>
        ) : (
          <>
            {workspace.workflow.status === 'RUNNING' &&
              workspace.workflow.availableTransitions.length > 0 && (
                <div className="action-list" aria-label="Möjliga processövergångar">
                  {workspace.workflow.availableTransitions.map((target) => (
                    <form action={advanceWorkflowAction} className="action-row" key={target}>
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="instanceId" value={workspace.workflow?.id} />
                      <input type="hidden" name="targetState" value={target} />
                      <div>
                        <strong>Flytta till {target}</strong>
                        <label className="sr-only" htmlFor={`reason-${target}`}>
                          Orsak för övergång till {target}
                        </label>
                        <input
                          id={`reason-${target}`}
                          name="reason"
                          type="text"
                          maxLength={1000}
                          placeholder="Orsak / beslutsunderlag"
                        />
                      </div>
                      <button type="submit">Genomför</button>
                    </form>
                  ))}
                </div>
              )}

            {(workspace.workflow.status === 'RUNNING' ||
              workspace.workflow.status === 'PAUSED') && (
              <form action={setWorkflowPauseAction} className="inline-action">
                <input type="hidden" name="caseId" value={header.id} />
                <input type="hidden" name="instanceId" value={workspace.workflow.id} />
                <input
                  type="hidden"
                  name="paused"
                  value={workspace.workflow.status === 'RUNNING' ? 'true' : 'false'}
                />
                <label htmlFor="pauseReason">
                  {workspace.workflow.status === 'RUNNING'
                    ? 'Orsak till operativ paus'
                    : 'Orsak till återupptagande'}
                </label>
                <input id="pauseReason" name="reason" type="text" maxLength={1000} />
                <button type="submit" className="button-secondary">
                  {workspace.workflow.status === 'RUNNING' ? 'Pausa process' : 'Återuppta process'}
                </button>
              </form>
            )}

            <h3>Aktiva uppgifter</h3>
            <ul>
              {workspace.workflow.tasks.map((task) => (
                <li key={task.id}>
                  {task.title}{' '}
                  <span className="meta">
                    ({task.status}
                    {task.due_at === null ? '' : `, senast ${task.due_at.slice(0, 10)}`})
                  </span>
                </li>
              ))}
              {workspace.workflow.tasks.length === 0 && (
                <li className="meta">Inga öppna processuppgifter.</li>
              )}
            </ul>

            <h3>Processhistorik</h3>
            <ol>
              {workspace.workflow.transitions.map((transition) => (
                <li key={transition.id}>
                  {transition.occurred_at.slice(0, 16).replace('T', ' ')} —{' '}
                  {transition.from_state === null ? 'START' : transition.from_state} →{' '}
                  {transition.to_state}
                  {transition.reason === null ? '' : ` — ${transition.reason}`}
                </li>
              ))}
            </ol>
          </>
        )}

        <h3>Frister</h3>
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

      {workspace.workflow?.status === 'COMPLETED' &&
        header.status !== 'CLOSED' &&
        header.status !== 'ARCHIVED' && (
          <section id="beslut" aria-labelledby="h-close" className="card danger-zone">
            <h2 id="h-close">Avsluta ärende</h2>
            <p>
              Workflowen är avslutad. Stängning kräver <code>case.close</code> och sparar orsak i
              auditloggen.
            </p>
            <form action={closeCaseAction} className="inline-action">
              <input type="hidden" name="caseId" value={header.id} />
              <label htmlFor="closeReason">Orsak till stängning</label>
              <textarea id="closeReason" name="reason" rows={3} minLength={3} maxLength={1000} required />
              <button type="submit" className="button-danger">
                Stäng ärendet
              </button>
            </form>
          </section>
        )}

      <section id="revision" aria-labelledby="h-history" className="card">
        <h2 id="h-history">Statushistorik</h2>
        <ol>
          {workspace.history.map((event) => (
            <li key={event.id}>
              {event.changed_at.slice(0, 10)} — {event.to_status}
            </li>
          ))}
          {workspace.history.length === 0 && <li className="meta">Ingen statushistorik.</li>}
        </ol>
      </section>
    </main>
  );
}
