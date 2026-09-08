import Link from 'next/link';
import { currentTenant } from '@/lib/tenant/context';
import { loadCitizenCaseDetail } from '@/lib/data/citizen';
import { sendCitizenMessageAction } from '@/lib/data/citizen-actions';
import { CitizenDocumentUploadForm } from './CitizenDocumentUploadForm';
import { CitizenDocumentDownloadButton } from './CitizenDocumentDownloadButton';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  message: 'Meddelandet kunde inte skickas. Kontrollera innehållet och försök igen.',
};

const SUCCESS_MESSAGES: Record<string, string> = {
  submitted: 'Ansökan är mottagen och ett ärende har skapats.',
  message: 'Meddelandet har skickats till ärendet.',
};

function jsonSummary(value: unknown): string | null {
  if (Array.isArray(value) && value.length === 0) return null;
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export default async function CitizenCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const [{ caseId }, query, tenant] = await Promise.all([
    params,
    searchParams,
    currentTenant(),
  ]);
  const detail = await loadCitizenCaseDetail(tenant, caseId);

  if (!detail.available || detail.header === null) {
    return (
      <main id="innehall">
        <div className="page-heading">
          <h1>Ärende</h1>
          <Link className="button-secondary" href="/mina-sidor/arenden">
            Till dina ärenden
          </Link>
        </div>
        <div className="card" role="status">
          <p>{detail.reason ?? 'Ärendet är inte tillgängligt.'}</p>
        </div>
      </main>
    );
  }

  const header = detail.header;
  const errorMessage =
    query.error === undefined
      ? null
      : (ERROR_MESSAGES[query.error] ?? 'Åtgärden kunde inte genomföras.');
  const successMessage =
    query.ok === undefined
      ? null
      : (SUCCESS_MESSAGES[query.ok] ?? 'Åtgärden är genomförd.');

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Mina sidor · Ärende</p>
          <h1>
            {header.caseNumber} — {header.title}
          </h1>
          <p>
            {header.processType} · <span className="status-badge">{header.status}</span> ·{' '}
            {header.phase}
          </p>
        </div>
        <Link className="button-secondary" href="/mina-sidor/arenden">
          Till dina ärenden
        </Link>
      </div>

      {errorMessage !== null ? (
        <div className="notice notice-error" role="alert">
          {errorMessage}
        </div>
      ) : null}
      {successMessage !== null ? (
        <div className="notice notice-success" role="status">
          {successMessage}
        </div>
      ) : null}

      <section className="card" aria-labelledby="citizen-status-heading">
        <h2 id="citizen-status-heading">Status</h2>
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{header.status}</dd>
          </div>
          <div>
            <dt>Fas</dt>
            <dd>{header.phase}</dd>
          </div>
          <div>
            <dt>Din relation</dt>
            <dd>{detail.relationship ?? 'Verifierad part'}</dd>
          </div>
          <div>
            <dt>Senast uppdaterat</dt>
            <dd>{new Date(header.updatedAt).toLocaleString('sv-SE')}</dd>
          </div>
        </dl>

        <h3>Händelser</h3>
        <ol>
          {detail.history.map((event, index) => (
            <li key={`${event.changedAt}-${index}`}>
              <strong>{event.toStatus}</strong> · {event.toPhase} ·{' '}
              {new Date(event.changedAt).toLocaleString('sv-SE')}
            </li>
          ))}
        </ol>
      </section>

      <section className="card" aria-labelledby="citizen-documents-heading">
        <h2 id="citizen-documents-heading">Handlingar</h2>
        <p className="meta">
          Du ser dina egna uppladdningar och handlingar som kommunen uttryckligen har gjort
          tillgängliga i Mina sidor. Endast säkerhetskontrollerade versioner kan hämtas.
        </p>

        <div className="entity-list">
          {detail.documents.map((document) => (
            <article className="entity-item" key={document.id}>
              <div className="entity-heading">
                <div>
                  <h3>{document.title}</h3>
                  <p className="meta">
                    {document.documentType}
                    {document.description === null ? '' : ' · ' + document.description}
                  </p>
                </div>
              </div>

              <ul>
                {document.versions.map((version) => (
                  <li key={version.id}>
                    Version {version.version} ·{' '}
                    <span className="status-badge">{version.ingestionStatus}</span>
                    {version.originalFilename === null ? '' : ' · ' + version.originalFilename}{' '}
                    {version.ingestionStatus === 'CLEAN' ? (
                      <CitizenDocumentDownloadButton
                        caseId={header.id}
                        documentVersionId={version.id}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {detail.documents.length === 0 ? (
            <p className="meta">Inga handlingar är tillgängliga ännu.</p>
          ) : null}
        </div>

        {(detail.relationship === 'APPLICANT' || detail.relationship === 'REPRESENTATIVE') &&
        header.status !== 'ARCHIVED' ? (
          <details className="create-panel">
            <summary>Skicka komplettering</summary>
            <CitizenDocumentUploadForm caseId={header.id} />
          </details>
        ) : null}
      </section>

      <section className="card" aria-labelledby="citizen-messages-heading">
        <h2 id="citizen-messages-heading">Meddelanden</h2>
        <div className="entity-list">
          {detail.messages.map((message) => (
            <article className="entity-item" key={message.id}>
              <div className="entity-heading">
                <div>
                  <h3>{message.subject ?? 'Meddelande'}</h3>
                  <p className="meta">
                    {message.direction === 'OUTBOUND' ? 'Från kommunen' : 'Från dig'} ·{' '}
                    {new Date(message.createdAt).toLocaleString('sv-SE')}
                  </p>
                </div>
              </div>
              {message.body !== null ? <p>{message.body}</p> : null}
            </article>
          ))}
          {detail.messages.length === 0 ? (
            <p className="meta">Inga portalmeddelanden i ärendet ännu.</p>
          ) : null}
        </div>

        {(detail.relationship === 'APPLICANT' || detail.relationship === 'REPRESENTATIVE') &&
        header.status !== 'ARCHIVED' ? (
          <details className="create-panel">
            <summary>Skicka meddelande</summary>
            <form action={sendCitizenMessageAction} className="form-grid compact-form">
              <input type="hidden" name="caseId" value={header.id} />
              <div className="form-field form-field-wide">
                <label htmlFor="citizen-message-subject">Ämne</label>
                <input
                  id="citizen-message-subject"
                  name="subject"
                  type="text"
                  minLength={2}
                  maxLength={300}
                  required
                />
              </div>
              <div className="form-field form-field-wide">
                <label htmlFor="citizen-message-body">Meddelande</label>
                <textarea
                  id="citizen-message-body"
                  name="body"
                  rows={5}
                  minLength={2}
                  maxLength={20000}
                  required
                />
              </div>
              <div className="form-actions form-field-wide">
                <button type="submit">Skicka meddelande</button>
              </div>
            </form>
          </details>
        ) : null}
      </section>

      <section className="card" aria-labelledby="citizen-decisions-heading">
        <h2 id="citizen-decisions-heading">Beslut</h2>
        <div className="entity-list">
          {detail.decisions.map((decision) => {
            const conditions = jsonSummary(decision.conditions);
            const legalReferences = jsonSummary(decision.legalReferences);
            return (
              <article className="entity-item" key={decision.id}>
                <div className="entity-heading">
                  <div>
                    <h3>
                      {decision.decisionType}
                      {decision.decisionNumber === null ? '' : ' · ' + decision.decisionNumber}
                    </h3>
                    <p className="meta">
                      <span className="status-badge">{decision.status}</span>
                      {decision.decidedAt === null
                        ? ''
                        : ' · ' + new Date(decision.decidedAt).toLocaleString('sv-SE')}
                    </p>
                  </div>
                </div>
                {decision.body !== null ? <p>{decision.body}</p> : null}
                {conditions !== null ? <p className="meta">Villkor: {conditions}</p> : null}
                {legalReferences !== null ? (
                  <p className="meta">Rättsliga referenser: {legalReferences}</p>
                ) : null}
                {decision.appealDeadlineAt !== null ? (
                  <p className="meta">
                    Överklagandefrist: {new Date(decision.appealDeadlineAt).toLocaleString('sv-SE')}
                  </p>
                ) : null}
              </article>
            );
          })}
          {detail.decisions.length === 0 ? (
            <p className="meta">Inget slutligt beslut är tillgängligt ännu.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
