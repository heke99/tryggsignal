import Link from 'next/link';
import { createCaseAction } from '@/lib/data/actions';
import { loadCaseCreationOptions } from '@/lib/data/workspace';
import { currentTenant } from '@/lib/tenant/context';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  validation: 'Kontrollera de obligatoriska fälten och försök igen.',
  create:
    'Ärendet kunde inte skapas. Kontrollera behörighet, ärendenummer och att vald workflowversion är publicerad för processen.',
};

export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const tenant = await currentTenant();
  const options = await loadCaseCreationOptions(tenant);
  const { error } = await searchParams;
  const message = error === undefined ? null : (ERROR_MESSAGES[error] ?? ERROR_MESSAGES.create);

  return (
    <main id="innehall">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Handläggning</p>
          <h1>Nytt ärende</h1>
          <p className="meta">
            Ärendet skapas i kommunens egen data plane och binds atomiskt till en publicerad,
            versionslåst process.
          </p>
        </div>
        <Link className="button-secondary" href="/handlaggning">
          Till kontrolltornet
        </Link>
      </div>

      {message !== null && (
        <div className="notice notice-error" role="alert">
          {message}
        </div>
      )}

      {!options.available ? (
        <div className="card" role="status">
          <p>Det går inte att skapa ärenden i den här miljön.</p>
          <p className="meta">{options.reason}</p>
        </div>
      ) : options.authorities.length === 0 || options.workflows.length === 0 ? (
        <div className="card" role="status">
          <p>Ingen tillgänglig myndighets-/processkonfiguration hittades.</p>
          <p className="meta">
            En aktiv nämnd, förvaltning och en publicerad workflowversion krävs innan ett ärende kan
            skapas.
          </p>
        </div>
      ) : (
        <form action={createCaseAction} className="card form-grid">
          <div className="form-field">
            <label htmlFor="authorityId">Nämnd / myndighet</label>
            <select id="authorityId" name="authorityId" required defaultValue="">
              <option value="" disabled>
                Välj nämnd
              </option>
              {options.authorities.map((authority) => (
                <option key={authority.id} value={authority.id}>
                  {authority.name}
                </option>
              ))}
            </select>
            <p className="field-help">
              Behörighet och datagräns verifieras på serversidan; formulärvärdet är aldrig
              authorization.
            </p>
          </div>

          <div className="form-field">
            <label htmlFor="departmentId">Förvaltning / avdelning</label>
            <select id="departmentId" name="departmentId" required defaultValue="">
              <option value="" disabled>
                Välj avdelning
              </option>
              {options.departments.map((department) => {
                const authority = options.authorities.find(
                  (candidate) => candidate.id === department.authority_id,
                );
                return (
                  <option key={department.id} value={department.id}>
                    {authority?.name ?? 'Nämnd'} — {department.name}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="templateKey">Process / workflow</label>
            <select id="templateKey" name="templateKey" required defaultValue="">
              <option value="" disabled>
                Välj process
              </option>
              {options.workflows.map((workflow) => {
                const authority = options.authorities.find(
                  (candidate) => candidate.id === workflow.authority_id,
                );
                return (
                  <option key={`${workflow.authority_id}:${workflow.key}`} value={workflow.key}>
                    {authority?.name ?? 'Nämnd'} — {workflow.name} ({workflow.process_type})
                  </option>
                );
              })}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="processType">Processtyp</label>
            <select id="processType" name="processType" required defaultValue="BYGGLOV">
              <option value="BYGGLOV">Bygglov</option>
              <option value="ANMALAN">Anmälan</option>
              <option value="FORHANDSBESKED">Förhandsbesked</option>
              <option value="RIVNINGSLOV">Rivningslov</option>
              <option value="MARKLOV">Marklov</option>
              <option value="PBL_TILLSYN">PBL-tillsyn</option>
              <option value="OVK">OVK</option>
            </select>
            <p className="field-help">
              Vald workflow måste vara publicerad för samma processtyp; databasen nekar mismatch.
            </p>
          </div>

          <div className="form-field">
            <label htmlFor="caseNumber">Ärendenummer</label>
            <input
              id="caseNumber"
              name="caseNumber"
              type="text"
              minLength={2}
              maxLength={80}
              required
              autoComplete="off"
              placeholder="BYGG-2026-00123"
            />
          </div>

          <div className="form-field">
            <label htmlFor="caseType">Ärendetyp</label>
            <input
              id="caseType"
              name="caseType"
              type="text"
              minLength={2}
              maxLength={80}
              required
              defaultValue="BYGGLOV"
            />
          </div>

          <div className="form-field form-field-wide">
            <label htmlFor="title">Rubrik</label>
            <input id="title" name="title" type="text" minLength={3} maxLength={240} required />
          </div>

          <div className="form-field form-field-wide">
            <label htmlFor="description">Beskrivning</label>
            <textarea id="description" name="description" rows={5} maxLength={10000} />
          </div>

          <div className="form-field">
            <label htmlFor="priority">Prioritet</label>
            <select id="priority" name="priority" defaultValue="NORMAL">
              <option value="LOW">Låg</option>
              <option value="NORMAL">Normal</option>
              <option value="HIGH">Hög</option>
              <option value="URGENT">Brådskande</option>
            </select>
          </div>

          <div className="form-actions form-field-wide">
            <button type="submit">Skapa ärende och starta process</button>
            <Link className="button-link" href="/handlaggning">
              Avbryt
            </Link>
          </div>
        </form>
      )}
    </main>
  );
}
