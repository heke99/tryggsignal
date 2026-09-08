import Link from 'next/link';
import {
  addCasePartyAction,
  addDecisionVersionAction,
  addReferralRecipientAction,
  advanceWorkflowAction,
  approveDecisionAction,
  assignCaseAction,
  closeCaseAction,
  createDecisionAction,
  createReferralAction,
  evaluateCaseCompletenessAction,
  linkCasePropertyAction,
  decideDecisionAction,
  issueDecisionAction,
  queueReferralDeliveryAction,
  queueReferralFollowupAction,
  recordReferralResponseAction,
  registerLocalPropertyAction,
  retryDocumentConfirmationAction,
  reviewCaseCompletenessAction,
  signDecisionAction,
  setPrimaryPropertyAction,
  setWorkflowPauseAction,
  submitDecisionReviewAction,
  updateCasePartyRelationshipAction,
  updateDocumentMetadataAction,
  updatePartyContactAction,
} from '@/lib/data/actions';
import {
  addSupervisionFindingEvidenceAction,
  assessSupervisionRiskAction,
  closeSupervisionAction,
  completeSupervisionActionAction,
  completeSupervisionFollowupAction,
  completeSupervisionInspectionAction,
  createSupervisionActionAction,
  createSupervisionFollowupAction,
  openSupervisionAction,
  recordSupervisionFindingAction,
  resolveSupervisionFindingAction,
  scheduleSupervisionInspectionAction,
} from '@/lib/data/supervision-actions';
import { loadCaseSupervision } from '@/lib/data/supervision';
import {
  linkOvkObjectAction,
  recordOvkFindingAction,
  recordOvkProtocolAction,
  resolveOvkFindingAction,
} from '@/lib/data/ovk-actions';
import { loadCaseOvk } from '@/lib/data/ovk';

import { DocumentDownloadButton } from './DocumentDownloadButton';
import { DocumentVersionUploadForm, NewDocumentUploadForm } from './DocumentUploadForm';
import { currentTenant } from '@/lib/tenant/context';
import {
  loadCaseCompleteness,
  loadCaseDecisions,
  loadCaseReferrals,
  loadCaseWorkspace,
  searchPropertyCandidates,
} from '@/lib/data/workspace';

export const dynamic = 'force-dynamic';

/** Masterplan 94: one workspace per case, with the tabs a caseworker needs. */
const TABS = [
  'Översikt',
  'Handlingar',
  'Parter',
  'Fastighet',
  'Kompletthet',
  'Process',
  'Meddelanden',
  'Remisser',
  'Beslut',
  'Inspektioner',
  'OVK',
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
  party: 'Parten kunde inte läggas till. Kontrollera uppgifter och behörighet.',
  'party-role': 'Partens roll i ärendet kunde inte ändras.',
  'party-contact':
    'Kontaktuppgifterna kunde inte ändras. En delad part kräver behörighet till samtliga länkade ärenden.',
  'property-link': 'Fastigheten kunde inte kopplas till ärendet.',
  'property-primary': 'Primär fastighet kunde inte ändras.',
  'property-register':
    'Den lokala fastigheten kunde inte registreras. Kontrollera beteckning, adress och behörighet.',
  'document-confirm': 'Filen finns inte i Storage eller kunde inte köas för säkerhetskontroll.',
  'document-metadata':
    'Dokumentets klassificering kunde inte uppdateras. Kontrollera behörighet och värden.',
  completeness:
    'Kompletthetsbedömningen kunde inte genomföras. Kontrollera profil, källor och behörighet.',
  'completeness-review': 'Den mänskliga kompletthetsgranskningen kunde inte sparas.',
  'referral-create': 'Remissen kunde inte skapas.',
  'referral-recipient': 'Remissmottagaren kunde inte läggas till.',
  'referral-queue': 'Leveransen kunde inte köas. Kontrollera kanal och mottagaradress.',
  'referral-response': 'Remissvaret kunde inte registreras.',
  'referral-followup': 'Uppföljningen kunde inte köas.',
  'decision-create': 'Beslutet kunde inte skapas.',
  'decision-version': 'Beslutsversionen kunde inte sparas.',
  'decision-review': 'Beslutet kunde inte skickas till granskning.',
  'decision-approve': 'Beslutet kunde inte godkännas. Kontrollera beslutsbehörighet.',
  'decision-decide': 'Det slutliga beslutet kunde inte registreras.',
  'decision-sign': 'Signeringsbeviset kunde inte registreras.',
  'decision-issue': 'Beslutet kunde inte köas för expediering.',
  'supervision-open': 'PBL-tillsynen kunde inte öppnas.',
  'supervision-risk': 'Riskbedömningen kunde inte sparas.',
  'supervision-inspection': 'Tillsynsinspektionen kunde inte schemaläggas.',
  'supervision-inspection-complete': 'Inspektionen kunde inte slutföras. Behörig inspektör krävs.',
  'supervision-finding': 'Iakttagelsen kunde inte registreras.',
  'supervision-evidence': 'Evidensen kunde inte kopplas till iakttagelsen.',
  'supervision-resolve': 'Iakttagelsen kunde inte markeras som löst.',
  'supervision-action': 'Tillsynsåtgärden kunde inte skapas.',
  'supervision-action-complete': 'Tillsynsåtgärden kunde inte slutföras.',
  'supervision-followup': 'Uppföljningen kunde inte skapas.',
  'supervision-followup-complete': 'Uppföljningen kunde inte slutföras.',
  'supervision-close': 'Tillsynen kunde inte stängas. Öppet arbete kan återstå.',
  'ovk-object': 'OVK-objektet kunde inte registreras eller länkas.',
  'ovk-protocol': 'OVK-protokollet kunde inte registreras. Kontrollera att dokumentversionen är CLEAN.',
  'ovk-finding': 'OVK-fyndet kunde inte registreras.',
  'ovk-resolve': 'OVK-fyndet kunde inte markeras som löst.',
};

const SUCCESS_MESSAGES: Record<string, string> = {
  assigned: 'Fördelningen har sparats.',
  transition: 'Processen har flyttats och arbetsytan har uppdaterats.',
  paused: 'Processen är pausad. Lagstadgade frister ändras inte automatiskt.',
  resumed: 'Processen är återupptagen.',
  closed: 'Ärendet är stängt och redo för arkivsteget.',
  'party-added': 'Parten har lagts till i ärendet.',
  'party-role': 'Partens roll i ärendet har uppdaterats.',
  'party-contact': 'Partens kontaktuppgifter har uppdaterats.',
  'property-linked': 'Fastigheten har kopplats till ärendet.',
  'property-primary': 'Primär fastighet har uppdaterats.',
  'property-registered': 'Den provisoriska lokala fastigheten har registrerats och kopplats.',
  'document-confirmed': 'Filen är bekräftad och köad för säkerhetskontroll.',
  'document-metadata': 'Dokumentets metadata och informationsklass har uppdaterats.',
  completeness: 'Kompletthetsbedömningen har körts och sparats med evidens.',
  'completeness-review': 'Den mänskliga kompletthetsgranskningen har sparats.',
  'referral-created': 'Remissen har skapats.',
  'referral-recipient': 'Remissmottagaren har lagts till.',
  'referral-queued': 'Leveransen är köad. Den markeras inte som skickad förrän provider bekräftar.',
  'referral-response': 'Remissvaret har registrerats.',
  'referral-followup': 'Uppföljningen är köad.',
  'decision-created': 'Beslutsutkastet har skapats.',
  'decision-version': 'En ny beslutsversion har sparats.',
  'decision-review': 'Beslutet är skickat till granskning.',
  'decision-approved': 'Beslutet har godkänts av behörig beslutsfattare.',
  'decision-decided': 'Det slutliga mänskliga beslutet har registrerats.',
  'decision-signed': 'Signeringsbeviset har registrerats.',
  'decision-queued': 'Expedieringen är köad och blir inte SENT förrän provider bekräftar.',
  'supervision-opened': 'PBL-tillsynen har öppnats.',
  'supervision-risk': 'Riskbedömningen har sparats.',
  'supervision-inspection': 'Tillsynsinspektionen har schemalagts.',
  'supervision-inspection-complete': 'Inspektionen har slutförts.',
  'supervision-finding': 'Iakttagelsen har registrerats.',
  'supervision-evidence': 'Evidensen har kopplats till iakttagelsen.',
  'supervision-resolve': 'Iakttagelsen är markerad som löst.',
  'supervision-action': 'Tillsynsåtgärden har skapats.',
  'supervision-action-complete': 'Tillsynsåtgärden har slutförts.',
  'supervision-followup': 'Uppföljningen har skapats.',
  'supervision-followup-complete': 'Uppföljningen har slutförts.',
  'supervision-closed': 'PBL-tillsynen har stängts.',
  'ovk-object': 'OVK-objektet har registrerats och länkas till ärendet.',
  'ovk-protocol': 'OVK-protokollet har registrerats och nästa kontroll har räknats om.',
  'ovk-finding': 'OVK-fyndet har registrerats i tillsynskön.',
  'ovk-resolve': 'OVK-fyndet är markerat som löst.',
};

export default async function CaseWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ error?: string; ok?: string; propertyQuery?: string }>;
}) {
  const { caseId } = await params;
  const query = await searchParams;
  const tenant = await currentTenant();
  const workspace = await loadCaseWorkspace(tenant, caseId);
  const propertyQuery = (query.propertyQuery ?? '').trim().slice(0, 80);
  const propertyCandidates =
    workspace.header === null || propertyQuery.length < 2
      ? []
      : await searchPropertyCandidates(tenant, caseId, propertyQuery);

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
  const [completeness, referrals, decisions, supervision, ovk] = await Promise.all([
    loadCaseCompleteness(tenant, caseId, header.authority_id),
    loadCaseReferrals(tenant, caseId),
    loadCaseDecisions(tenant, caseId),
    loadCaseSupervision(tenant, caseId),
    loadCaseOvk(tenant, caseId),
  ]);
  const assignedUser = workspace.assignees.find((user) => user.id === header.assigned_user_id);
  const assignedTeam = workspace.teams.find((team) => team.id === header.assigned_team_id);
  const errorMessage =
    query.error === undefined ? null : (ERROR_MESSAGES[query.error] ?? ERROR_MESSAGES.validation);
  const successMessage =
    query.ok === undefined ? null : (SUCCESS_MESSAGES[query.ok] ?? 'Åtgärden är genomförd.');
  const cleanDocumentVersions = workspace.documents.flatMap((document) =>
    document.versions
      .filter((version) => version.ingestion_status === 'CLEAN')
      .map((version) => ({
        documentId: document.id,
        documentTitle: document.title,
        versionId: version.id,
        version: version.version,
      })),
  );
  const finalDecisions = decisions.filter((decision) => decision.status === 'DECIDED');

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

      <section id="parter" aria-labelledby="h-parties" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-parties">Parter ({workspace.parties.length})</h2>
            <p className="meta">
              Sökande, fastighetsägare, ombud och andra roller hör till ärendet. Ändringar
              auktoriseras mot ärendet i databasen och auditloggas.
            </p>
          </div>
        </div>

        <div className="entity-list">
          {workspace.parties.map((party) => (
            <article className="entity-item" key={party.relation_id}>
              <div className="entity-heading">
                <div>
                  <h3>{party.display_name}</h3>
                  <p className="meta">
                    {party.party_type === 'PERSON' ? 'Person' : 'Organisation'} ·{' '}
                    {party.relationship}
                    {party.identity_link_verified ? ' · verifierad portalidentitet' : ''}
                  </p>
                </div>
              </div>

              <dl className="compact-details">
                <div>
                  <dt>E-post</dt>
                  <dd>{party.contact_email ?? '—'}</dd>
                </div>
                <div>
                  <dt>Telefon</dt>
                  <dd>{party.contact_phone ?? '—'}</dd>
                </div>
                {party.party_type === 'ORGANIZATION' && (
                  <div>
                    <dt>Organisationsnummer</dt>
                    <dd>{party.organization_number ?? '—'}</dd>
                  </div>
                )}
                {party.party_type === 'PERSON' && party.person_reference !== null && (
                  <div>
                    <dt>Personreferens</dt>
                    <dd>{party.person_reference}</dd>
                  </div>
                )}
              </dl>

              <form action={updateCasePartyRelationshipAction} className="inline-action">
                <input type="hidden" name="caseId" value={header.id} />
                <input type="hidden" name="casePartyId" value={party.relation_id} />
                <label htmlFor={`relationship-${party.relation_id}`}>Roll i ärendet</label>
                <select
                  id={`relationship-${party.relation_id}`}
                  name="relationship"
                  defaultValue={party.relationship}
                >
                  <option value="APPLICANT">Sökande</option>
                  <option value="PROPERTY_OWNER">Fastighetsägare</option>
                  <option value="REPRESENTATIVE">Ombud</option>
                  <option value="NEIGHBOUR">Sakägare / granne</option>
                  <option value="CONTROL_RESPONSIBLE">Kontrollansvarig</option>
                  <option value="OTHER">Annan</option>
                </select>
                <button type="submit" className="button-secondary">
                  Uppdatera roll
                </button>
              </form>

              <details>
                <summary>Redigera kontaktuppgifter</summary>
                <form action={updatePartyContactAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="partyId" value={party.party_id} />

                  <div className="form-field form-field-wide">
                    <label htmlFor={`party-name-${party.party_id}`}>Namn</label>
                    <input
                      id={`party-name-${party.party_id}`}
                      name="displayName"
                      type="text"
                      minLength={2}
                      maxLength={200}
                      defaultValue={party.display_name}
                      required
                    />
                  </div>

                  <div className="form-field">
                    <label htmlFor={`party-email-${party.party_id}`}>E-post</label>
                    <input
                      id={`party-email-${party.party_id}`}
                      name="contactEmail"
                      type="email"
                      maxLength={320}
                      defaultValue={party.contact_email ?? ''}
                    />
                  </div>

                  <div className="form-field">
                    <label htmlFor={`party-phone-${party.party_id}`}>Telefon</label>
                    <input
                      id={`party-phone-${party.party_id}`}
                      name="contactPhone"
                      type="tel"
                      maxLength={50}
                      defaultValue={party.contact_phone ?? ''}
                    />
                  </div>

                  {party.party_type === 'ORGANIZATION' ? (
                    <div className="form-field form-field-wide">
                      <label htmlFor={`party-org-${party.party_id}`}>Organisationsnummer</label>
                      <input
                        id={`party-org-${party.party_id}`}
                        name="organizationNumber"
                        type="text"
                        maxLength={50}
                        defaultValue={party.organization_number ?? ''}
                      />
                      <input type="hidden" name="personReference" value="" />
                    </div>
                  ) : (
                    <div className="form-field form-field-wide">
                      <label htmlFor={`party-person-ref-${party.party_id}`}>Personreferens</label>
                      <input
                        id={`party-person-ref-${party.party_id}`}
                        name="personReference"
                        type="text"
                        maxLength={200}
                        defaultValue={party.person_reference ?? ''}
                      />
                      <input type="hidden" name="organizationNumber" value="" />
                      <p className="field-help">
                        Använd en säker extern referens. Personnummer ska inte lagras i detta fält.
                      </p>
                    </div>
                  )}

                  <div className="form-actions form-field-wide">
                    <button type="submit">Spara kontaktuppgifter</button>
                  </div>
                </form>
              </details>
            </article>
          ))}
          {workspace.parties.length === 0 && <p className="meta">Inga parter registrerade.</p>}
        </div>

        <details className="create-panel">
          <summary>Lägg till part</summary>
          <form action={addCasePartyAction} className="form-grid compact-form">
            <input type="hidden" name="caseId" value={header.id} />

            <div className="form-field">
              <label htmlFor="newPartyType">Typ</label>
              <select id="newPartyType" name="partyType" defaultValue="PERSON">
                <option value="PERSON">Person</option>
                <option value="ORGANIZATION">Organisation</option>
              </select>
            </div>

            <div className="form-field">
              <label htmlFor="newPartyRelationship">Roll i ärendet</label>
              <select id="newPartyRelationship" name="relationship" defaultValue="APPLICANT">
                <option value="APPLICANT">Sökande</option>
                <option value="PROPERTY_OWNER">Fastighetsägare</option>
                <option value="REPRESENTATIVE">Ombud</option>
                <option value="NEIGHBOUR">Sakägare / granne</option>
                <option value="CONTROL_RESPONSIBLE">Kontrollansvarig</option>
                <option value="OTHER">Annan</option>
              </select>
            </div>

            <div className="form-field form-field-wide">
              <label htmlFor="newPartyName">Namn</label>
              <input
                id="newPartyName"
                name="displayName"
                type="text"
                minLength={2}
                maxLength={200}
                required
              />
            </div>

            <div className="form-field">
              <label htmlFor="newPartyEmail">E-post</label>
              <input id="newPartyEmail" name="contactEmail" type="email" maxLength={320} />
            </div>

            <div className="form-field">
              <label htmlFor="newPartyPhone">Telefon</label>
              <input id="newPartyPhone" name="contactPhone" type="tel" maxLength={50} />
            </div>

            <div className="form-field">
              <label htmlFor="newPartyOrg">Organisationsnummer</label>
              <input id="newPartyOrg" name="organizationNumber" type="text" maxLength={50} />
              <p className="field-help">Används endast när typen är Organisation.</p>
            </div>

            <div className="form-field">
              <label htmlFor="newPartyPersonRef">Personreferens</label>
              <input id="newPartyPersonRef" name="personReference" type="text" maxLength={200} />
              <p className="field-help">Används endast för Person. Personnummer lagras inte här.</p>
            </div>

            <div className="form-actions form-field-wide">
              <button type="submit">Lägg till part</button>
            </div>
          </form>
        </details>
      </section>

      <section id="fastighet" aria-labelledby="h-property" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-property">Fastighet ({workspace.properties.length})</h2>
            <p className="meta">
              Fastighetsgrafens källdata är läsbar men skrivskyddad. Här kopplar handläggaren
              befintliga objekt till ärendet eller registrerar en tydligt provisorisk LOCAL-post.
            </p>
          </div>
        </div>

        <div className="entity-list">
          {workspace.properties.map((property) => (
            <article className="entity-item" key={property.property_id}>
              <div className="entity-heading">
                <div>
                  <h3>
                    {property.designation}{' '}
                    {property.is_primary && <span className="status-badge">Primär</span>}
                  </h3>
                  <p className="meta">
                    Källa: {property.source}
                    {property.source_version === null
                      ? ''
                      : ` · version ${property.source_version}`}
                    {property.municipality_code === null
                      ? ''
                      : ` · kommunkod ${property.municipality_code}`}
                  </p>
                </div>
              </div>

              {property.addresses.length > 0 && (
                <>
                  <h4>Adresser</h4>
                  <ul>
                    {property.addresses.map((address) => (
                      <li key={address.id}>
                        {address.street_name}{' '}
                        {`${address.street_number ?? ''}${address.letter ?? ''}`.trim()}{' '}
                        {[address.postal_code, address.postal_town].filter(Boolean).join(' ')}
                        <span className="meta"> · {address.source}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {property.identifiers.length > 0 && (
                <>
                  <h4>Identifierare</h4>
                  <ul>
                    {property.identifiers.map((identifier) => (
                      <li key={identifier.id}>
                        {identifier.identifier_type}: {identifier.value}
                        <span className="meta"> · {identifier.source}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {property.buildings.length > 0 && (
                <>
                  <h4>Byggnader</h4>
                  <ul>
                    {property.buildings.map((building) => (
                      <li key={building.id}>
                        {building.building_designation ?? 'Byggnad'}
                        {building.building_purpose === null
                          ? ''
                          : ` · ${building.building_purpose}`}
                        {building.year_built === null ? '' : ` · byggår ${building.year_built}`}
                        {building.gross_floor_area === null
                          ? ''
                          : ` · ${building.gross_floor_area} m² BTA`}
                        {building.floors === null ? '' : ` · ${building.floors} vån.`}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {!property.is_primary && (
                <form action={setPrimaryPropertyAction} className="inline-action">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="propertyId" value={property.property_id} />
                  <button type="submit" className="button-secondary">
                    Gör till primär fastighet
                  </button>
                </form>
              )}
            </article>
          ))}
          {workspace.properties.length === 0 && (
            <p className="meta">Ingen fastighet är ännu kopplad till ärendet.</p>
          )}
        </div>

        <details className="create-panel" open={propertyQuery.length >= 2}>
          <summary>Sök och koppla befintlig fastighet</summary>
          <form method="get" className="inline-action">
            <label htmlFor="propertyQuery">Fastighetsbeteckning eller gatunamn</label>
            <input
              id="propertyQuery"
              name="propertyQuery"
              type="search"
              minLength={2}
              maxLength={80}
              defaultValue={propertyQuery}
              placeholder="Exempel: STOCKHOLM 1:23 eller Testgatan"
            />
            <button type="submit" className="button-secondary">
              Sök
            </button>
          </form>

          {propertyQuery.length >= 2 && (
            <div aria-live="polite">
              <h3>Sökresultat ({propertyCandidates.length})</h3>
              <div className="entity-list">
                {propertyCandidates.map((candidate) => (
                  <div className="action-row" key={candidate.id}>
                    <div>
                      <strong>{candidate.designation}</strong>
                      <p className="meta">
                        {candidate.address ?? 'Adress saknas'} · källa {candidate.source}
                        {candidate.municipality_code === null
                          ? ''
                          : ` · kommunkod ${candidate.municipality_code}`}
                      </p>
                    </div>
                    <form action={linkCasePropertyAction}>
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="propertyId" value={candidate.id} />
                      <input
                        type="hidden"
                        name="makePrimary"
                        value={workspace.properties.length === 0 ? 'true' : 'false'}
                      />
                      <button type="submit">Koppla</button>
                    </form>
                  </div>
                ))}
                {propertyCandidates.length === 0 && (
                  <p className="meta">Ingen matchande fastighet hittades i fastighetsgrafen.</p>
                )}
              </div>
            </div>
          )}
        </details>

        <details className="create-panel">
          <summary>Registrera provisorisk lokal fastighet</summary>
          <p className="meta">
            Använd bara detta när fastigheten ännu saknas i integrerad källdata. Posten märks
            LOCAL/provisional och ersätter aldrig en auktoritativ källa.
          </p>
          <form action={registerLocalPropertyAction} className="form-grid compact-form">
            <input type="hidden" name="caseId" value={header.id} />

            <div className="form-field form-field-wide">
              <label htmlFor="designation">Fastighetsbeteckning</label>
              <input
                id="designation"
                name="designation"
                type="text"
                minLength={2}
                maxLength={240}
                required
              />
            </div>

            <div className="form-field">
              <label htmlFor="municipalityCode">Kommunkod</label>
              <input
                id="municipalityCode"
                name="municipalityCode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                placeholder="0180"
              />
            </div>

            <div className="form-field">
              <label htmlFor="streetName">Gata</label>
              <input id="streetName" name="streetName" type="text" maxLength={240} />
            </div>

            <div className="form-field">
              <label htmlFor="streetNumber">Nummer</label>
              <input id="streetNumber" name="streetNumber" type="text" maxLength={30} />
            </div>

            <div className="form-field">
              <label htmlFor="letter">Bokstav</label>
              <input id="letter" name="letter" type="text" maxLength={10} />
            </div>

            <div className="form-field">
              <label htmlFor="postalCode">Postnummer</label>
              <input id="postalCode" name="postalCode" type="text" maxLength={20} />
            </div>

            <div className="form-field">
              <label htmlFor="postalTown">Postort</label>
              <input id="postalTown" name="postalTown" type="text" maxLength={120} />
            </div>

            <div className="form-field">
              <label htmlFor="makePrimary">Primär fastighet</label>
              <select id="makePrimary" name="makePrimary" defaultValue="true">
                <option value="true">Ja</option>
                <option value="false">Nej</option>
              </select>
            </div>

            <div className="form-actions form-field-wide">
              <button type="submit">Registrera och koppla</button>
            </div>
          </form>
        </details>
      </section>

      <section id="handlingar" aria-labelledby="h-documents" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-documents">Handlingar ({workspace.documents.length})</h2>
            <p className="meta">
              Filer går direkt till privat quarantine. De blir inte nedladdningsbara förrän hash,
              storlek, filsignatur och malwarekontroll har passerat.
            </p>
          </div>
        </div>

        <div className="entity-list">
          {workspace.documents.map((doc) => {
            const latest = doc.versions[0] ?? null;
            return (
              <article className="entity-item" key={doc.id}>
                <div className="entity-heading">
                  <div>
                    <h3>{doc.title}</h3>
                    <p className="meta">
                      {doc.document_type} · {doc.information_class} · sekretessnivå{' '}
                      {doc.secrecy_level} · aktuell version {doc.current_version}
                    </p>
                  </div>
                </div>

                {doc.description !== null && <p>{doc.description}</p>}

                <details>
                  <summary>Redigera dokumentmetadata</summary>
                  <form action={updateDocumentMetadataAction} className="form-grid compact-form">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="documentId" value={doc.id} />

                    <div className="form-field">
                      <label htmlFor={`doc-type-${doc.id}`}>Handlingstyp</label>
                      <input
                        id={`doc-type-${doc.id}`}
                        name="documentType"
                        type="text"
                        minLength={2}
                        maxLength={80}
                        defaultValue={doc.document_type}
                        required
                      />
                    </div>

                    <div className="form-field">
                      <label htmlFor={`doc-title-${doc.id}`}>Titel</label>
                      <input
                        id={`doc-title-${doc.id}`}
                        name="title"
                        type="text"
                        minLength={2}
                        maxLength={240}
                        defaultValue={doc.title}
                        required
                      />
                    </div>

                    <div className="form-field">
                      <label htmlFor={`doc-class-${doc.id}`}>Informationsklass</label>
                      <select
                        id={`doc-class-${doc.id}`}
                        name="informationClass"
                        defaultValue={doc.information_class}
                      >
                        <option value="PUBLIC">Publik</option>
                        <option value="INTERNAL">Intern</option>
                        <option value="RESTRICTED">Begränsad</option>
                        <option value="SECRET">Sekretess</option>
                      </select>
                    </div>

                    <div className="form-field">
                      <label htmlFor={`doc-secrecy-${doc.id}`}>Sekretessnivå</label>
                      <select
                        id={`doc-secrecy-${doc.id}`}
                        name="secrecyLevel"
                        defaultValue={String(doc.secrecy_level)}
                      >
                        <option value="0">0 — ingen</option>
                        <option value="1">1</option>
                        <option value="2">2</option>
                        <option value="3">3</option>
                        <option value="4">4 — hög</option>
                      </select>
                    </div>

                    <div className="form-field form-field-wide">
                      <label htmlFor={`doc-description-${doc.id}`}>Beskrivning</label>
                      <textarea
                        id={`doc-description-${doc.id}`}
                        name="description"
                        rows={3}
                        maxLength={10000}
                        defaultValue={doc.description ?? ''}
                      />
                    </div>

                    <div className="form-actions form-field-wide">
                      <button type="submit" className="button-secondary">
                        Spara metadata
                      </button>
                    </div>
                  </form>
                </details>

                <h4>Versioner</h4>
                <ol className="document-version-list">
                  {doc.versions.map((version) => (
                    <li key={version.id} className="document-version">
                      <div>
                        <strong>
                          v{version.version} · {version.original_filename ?? 'fil'}
                        </strong>{' '}
                        <span className="status-badge">{version.ingestion_status}</span>
                        <p className="meta">
                          {(version.size_bytes / 1024).toFixed(1)} KiB · deklarerad MIME{' '}
                          {version.mime_type}
                          {version.detected_mime_type === null
                            ? ''
                            : ` · detekterad ${version.detected_mime_type}`}
                        </p>
                        <p className="meta document-hash">SHA-256: {version.sha256}</p>
                        {version.scanner_provider !== null && (
                          <p className="meta">
                            Scanner: {version.scanner_provider}
                            {version.scanner_version === null ? '' : ` ${version.scanner_version}`}
                            {version.signature_version === null
                              ? ''
                              : ` · signatur ${version.signature_version}`}
                            {version.scanned_at === null
                              ? ''
                              : ` · ${version.scanned_at.slice(0, 16).replace('T', ' ')}`}
                          </p>
                        )}
                        {version.threat_name !== null && (
                          <p className="notice notice-error" role="alert">
                            Blockerad malwareträff: {version.threat_name}
                          </p>
                        )}
                        {version.rejection_reason !== null && (
                          <p className="meta">{version.rejection_reason}</p>
                        )}
                      </div>

                      <div className="document-version-actions">
                        {version.ingestion_status === 'CLEAN' && (
                          <DocumentDownloadButton
                            caseId={header.id}
                            documentVersionId={version.id}
                          />
                        )}
                        {version.ingestion_status === 'QUARANTINED' &&
                          version.upload_confirmed_at === null && (
                            <form action={retryDocumentConfirmationAction}>
                              <input type="hidden" name="caseId" value={header.id} />
                              <input type="hidden" name="documentVersionId" value={version.id} />
                              <button type="submit" className="button-secondary">
                                Bekräfta uppladdning igen
                              </button>
                            </form>
                          )}
                      </div>
                    </li>
                  ))}
                  {doc.versions.length === 0 && (
                    <li className="meta">Ingen filversion registrerad.</li>
                  )}
                </ol>

                {latest?.ingestion_status !== 'REJECTED' && (
                  <DocumentVersionUploadForm caseId={header.id} documentId={doc.id} />
                )}
              </article>
            );
          })}
          {workspace.documents.length === 0 && <p className="meta">Inga handlingar.</p>}
        </div>

        <details className="create-panel">
          <summary>Ladda upp ny handling</summary>
          <NewDocumentUploadForm caseId={header.id} />
        </details>

        <p className="meta">
          Om malware-scannern inte är konfigurerad stannar filen säkert i quarantine. Systemet
          öppnar aldrig en fil genom fail-open.
        </p>
      </section>

      <section id="kompletthet" aria-labelledby="h-completeness" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-completeness">Kompletthet</h2>
            <p className="meta">
              Bedömningen körs deterministiskt mot en publicerad och giltig regelversion. Varje
              regel måste ha en registrerad källa; okända villkor går till mänsklig granskning.
            </p>
          </div>
        </div>

        <form action={evaluateCaseCompletenessAction} className="inline-action">
          <input type="hidden" name="caseId" value={header.id} />
          <label htmlFor="ruleSetVersionId">Kompletthetsprofil</label>
          <select id="ruleSetVersionId" name="ruleSetVersionId" required defaultValue="">
            <option value="" disabled>
              Välj publicerad profil
            </option>
            {completeness.profiles.map((profile) => (
              <option value={profile.versionId} key={profile.versionId}>
                {profile.name} · v{profile.version} · från {profile.validFrom}
              </option>
            ))}
          </select>
          <button type="submit" disabled={completeness.profiles.length === 0}>
            Kör bedömning
          </button>
        </form>

        {completeness.profiles.length === 0 && (
          <p className="notice" role="status">
            Ingen publicerad och giltig completenessprofil finns för denna myndighet. Systemet
            gissar inte krav.
          </p>
        )}

        {completeness.current === null ? (
          <p className="meta">Ingen kompletthetsbedömning har ännu sparats.</p>
        ) : (
          <div className="completeness-result">
            <h3>
              Aktuellt resultat <span className="status-badge">{completeness.current.result}</span>
            </h3>
            <p className="meta">
              Bedömd {completeness.current.evaluatedAt.slice(0, 16).replace('T', ' ')} ·
              regelversion {completeness.current.ruleSetVersionId}
            </p>

            {completeness.current.review !== null && (
              <div className="notice">
                <strong>Mänsklig resolution: {completeness.current.review.decision}</strong>
                <p>{completeness.current.review.note}</p>
                <p className="meta">
                  {completeness.current.review.reviewedAt.slice(0, 16).replace('T', ' ')}
                </p>
              </div>
            )}

            {completeness.current.missingItems.length > 0 && (
              <>
                <h4>Saknas / kräver granskning</h4>
                <ul>
                  {completeness.current.missingItems.map((item) => (
                    <li key={item.rule_id}>
                      <strong>{item.label}</strong> <span className="meta">({item.reason})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h4>Evidens och källor</h4>
            <div className="entity-list">
              {completeness.current.evidence.map((item) => (
                <article className="entity-item" key={item.rule_id}>
                  <div className="entity-heading">
                    <div>
                      <strong>{item.name}</strong>{' '}
                      <span className="status-badge">{item.result}</span>
                      <p className="meta">
                        {item.kind}
                        {item.value === null ? '' : ' · ' + item.value} · träffar{' '}
                        {item.matched_count}
                      </p>
                    </div>
                  </div>
                  {item.legal_reference !== null && (
                    <p className="meta">Referens: {item.legal_reference}</p>
                  )}
                  <ul>
                    {item.sources.map((source, index) => (
                      <li key={item.rule_id + '-' + index}>
                        {source.source_type}: {source.reference}
                        {source.url === null ? '' : ' · ' + source.url}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>

            {completeness.current.result === 'HUMAN_REVIEW' &&
              completeness.current.review === null && (
                <details className="create-panel" open>
                  <summary>Genomför mänsklig granskning</summary>
                  <form action={reviewCaseCompletenessAction} className="form-grid compact-form">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="assessmentId" value={completeness.current.id} />
                    <div className="form-field">
                      <label htmlFor="completenessDecision">Bedömning</label>
                      <select id="completenessDecision" name="decision" defaultValue="INCOMPLETE">
                        <option value="COMPLETE">Complete</option>
                        <option value="INCOMPLETE">Incomplete</option>
                      </select>
                    </div>
                    <div className="form-field form-field-wide">
                      <label htmlFor="completenessNote">Motivering</label>
                      <textarea
                        id="completenessNote"
                        name="note"
                        rows={4}
                        minLength={3}
                        maxLength={4000}
                        required
                      />
                    </div>
                    <div className="form-actions form-field-wide">
                      <button type="submit">Spara mänsklig granskning</button>
                    </div>
                  </form>
                </details>
              )}
          </div>
        )}
      </section>

      <section id="remisser" aria-labelledby="h-referrals" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-referrals">Remisser och kommunikation ({referrals.length})</h2>
            <p className="meta">
              Köad leverans är inte samma sak som skickad. Status SENT sätts först när
              worker/provider har bekräftat utskicket.
            </p>
          </div>
        </div>

        <details className="create-panel">
          <summary>Skapa remiss</summary>
          <form action={createReferralAction} className="form-grid compact-form">
            <input type="hidden" name="caseId" value={header.id} />
            <div className="form-field form-field-wide">
              <label htmlFor="referralSubject">Ämne</label>
              <input
                id="referralSubject"
                name="subject"
                type="text"
                minLength={2}
                maxLength={300}
                required
              />
            </div>
            <div className="form-field form-field-wide">
              <label htmlFor="referralDescription">Beskrivning / fråga</label>
              <textarea id="referralDescription" name="description" rows={4} maxLength={10000} />
            </div>
            <div className="form-field">
              <label htmlFor="referralDueAt">Svar senast</label>
              <input id="referralDueAt" name="dueAt" type="datetime-local" required />
            </div>
            <div className="form-actions form-field-wide">
              <button type="submit">Skapa remiss</button>
            </div>
          </form>
        </details>

        <div className="entity-list">
          {referrals.map((referral) => (
            <article className="entity-item" key={referral.id}>
              <div className="entity-heading">
                <div>
                  <h3>
                    {referral.subject} <span className="status-badge">{referral.status}</span>
                  </h3>
                  <p className="meta">
                    Svar senast {referral.dueAt.slice(0, 16).replace('T', ' ')}
                    {referral.queuedAt === null
                      ? ''
                      : ' · köad ' + referral.queuedAt.slice(0, 16).replace('T', ' ')}
                    {referral.sentAt === null
                      ? ''
                      : ' · skickad ' + referral.sentAt.slice(0, 16).replace('T', ' ')}
                  </p>
                </div>
              </div>

              {referral.description !== null && <p>{referral.description}</p>}

              <h4>Mottagare ({referral.recipients.length})</h4>
              <div className="entity-list">
                {referral.recipients.map((recipient) => (
                  <div className="entity-item" key={recipient.id}>
                    <div className="entity-heading">
                      <div>
                        <strong>{recipient.displayName}</strong>{' '}
                        <span className="status-badge">{recipient.status}</span>
                        {recipient.contactAddress !== null && (
                          <p className="meta">{recipient.contactAddress}</p>
                        )}
                        {recipient.delivery !== null && (
                          <p className="meta">
                            Leverans: {recipient.delivery.channel} · {recipient.delivery.status}
                            {recipient.delivery.externalReference === null
                              ? ''
                              : ' · ref ' + recipient.delivery.externalReference}
                          </p>
                        )}
                        {recipient.delivery?.failedReason !== null &&
                          recipient.delivery?.failedReason !== undefined && (
                            <p className="notice notice-error" role="alert">
                              Leveransfel: {recipient.delivery.failedReason}
                            </p>
                          )}
                      </div>
                    </div>

                    {recipient.status === 'PENDING' && (
                      <form action={queueReferralDeliveryAction} className="inline-action">
                        <input type="hidden" name="caseId" value={header.id} />
                        <input type="hidden" name="recipientId" value={recipient.id} />
                        <label htmlFor={'referral-channel-' + recipient.id}>Kanal</label>
                        <select
                          id={'referral-channel-' + recipient.id}
                          name="channel"
                          defaultValue="EMAIL"
                        >
                          <option value="EMAIL">E-post</option>
                          <option value="DIGITAL_POST">Digital post</option>
                          <option value="SMS">SMS</option>
                          <option value="PORTAL">Portal</option>
                          <option value="PHYSICAL_POST">Fysisk post</option>
                        </select>
                        <button type="submit">Köa utskick</button>
                      </form>
                    )}

                    {recipient.status === 'QUEUED' && (
                      <p className="notice" role="status">
                        Utskicket väntar på extern provider/worker och räknas ännu inte som skickat.
                      </p>
                    )}

                    {recipient.response !== null ? (
                      <div className="notice">
                        <strong>Svar: {recipient.response.position ?? 'utan position'}</strong>
                        {recipient.response.responseText !== null && (
                          <p>{recipient.response.responseText}</p>
                        )}
                        <p className="meta">
                          Mottaget {recipient.response.receivedAt.slice(0, 16).replace('T', ' ')}
                        </p>
                      </div>
                    ) : (
                      (recipient.status === 'SENT' || recipient.status === 'NO_RESPONSE') && (
                        <details>
                          <summary>Registrera svar</summary>
                          <form
                            action={recordReferralResponseAction}
                            className="form-grid compact-form"
                          >
                            <input type="hidden" name="caseId" value={header.id} />
                            <input type="hidden" name="recipientId" value={recipient.id} />
                            <div className="form-field">
                              <label htmlFor={'referral-position-' + recipient.id}>Position</label>
                              <select
                                id={'referral-position-' + recipient.id}
                                name="position"
                                defaultValue="NO_OPINION"
                              >
                                <option value="NO_OBJECTION">Ingen erinran</option>
                                <option value="OBJECTION">Invändning</option>
                                <option value="CONDITIONAL">Villkorat svar</option>
                                <option value="NO_OPINION">Ingen ståndpunkt</option>
                              </select>
                            </div>
                            <div className="form-field">
                              <label htmlFor={'referral-document-' + recipient.id}>
                                Svarshandling
                              </label>
                              <select
                                id={'referral-document-' + recipient.id}
                                name="documentId"
                                defaultValue=""
                              >
                                <option value="">Ingen bifogad handling</option>
                                {workspace.documents
                                  .filter(
                                    (document) =>
                                      document.versions[0]?.ingestion_status === 'CLEAN',
                                  )
                                  .map((document) => (
                                    <option key={document.id} value={document.id}>
                                      {document.title}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div className="form-field form-field-wide">
                              <label htmlFor={'referral-response-' + recipient.id}>Svarstext</label>
                              <textarea
                                id={'referral-response-' + recipient.id}
                                name="responseText"
                                rows={4}
                                maxLength={20000}
                              />
                            </div>
                            <div className="form-actions form-field-wide">
                              <button type="submit">Registrera svar</button>
                            </div>
                          </form>
                        </details>
                      )
                    )}

                    {(recipient.status === 'SENT' || recipient.status === 'NO_RESPONSE') &&
                      recipient.response === null && (
                        <form action={queueReferralFollowupAction} className="inline-action">
                          <input type="hidden" name="caseId" value={header.id} />
                          <input type="hidden" name="recipientId" value={recipient.id} />
                          <label htmlFor={'followup-channel-' + recipient.id}>
                            Uppföljningskanal
                          </label>
                          <select
                            id={'followup-channel-' + recipient.id}
                            name="channel"
                            defaultValue={recipient.delivery?.channel ?? 'EMAIL'}
                          >
                            <option value="EMAIL">E-post</option>
                            <option value="DIGITAL_POST">Digital post</option>
                            <option value="SMS">SMS</option>
                            <option value="PORTAL">Portal</option>
                            <option value="PHYSICAL_POST">Fysisk post</option>
                          </select>
                          <button type="submit" className="button-secondary">
                            Köa uppföljning
                          </button>
                        </form>
                      )}
                  </div>
                ))}
                {referral.recipients.length === 0 && (
                  <p className="meta">Ingen mottagare har lagts till.</p>
                )}
              </div>

              {referral.sentAt === null && (
                <details className="create-panel">
                  <summary>Lägg till mottagare</summary>
                  <form action={addReferralRecipientAction} className="form-grid compact-form">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="referralId" value={referral.id} />
                    <div className="form-field">
                      <label htmlFor={'referral-party-' + referral.id}>
                        Befintlig part i ärendet
                      </label>
                      <select id={'referral-party-' + referral.id} name="partyId" defaultValue="">
                        <option value="">Extern organisation</option>
                        {workspace.parties.map((party) => (
                          <option key={party.party_id} value={party.party_id}>
                            {party.display_name} · {party.relationship}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-field">
                      <label htmlFor={'referral-org-' + referral.id}>Extern organisation</label>
                      <input
                        id={'referral-org-' + referral.id}
                        name="organizationName"
                        type="text"
                        maxLength={300}
                      />
                    </div>
                    <div className="form-field form-field-wide">
                      <label htmlFor={'referral-address-' + referral.id}>Kontaktadress</label>
                      <input
                        id={'referral-address-' + referral.id}
                        name="contactAddress"
                        type="text"
                        maxLength={500}
                        placeholder="E-post, digital adress eller postadress"
                      />
                    </div>
                    <div className="form-actions form-field-wide">
                      <button type="submit">Lägg till mottagare</button>
                    </div>
                  </form>
                </details>
              )}

              {referral.status === 'OVERDUE' && (
                <p className="notice notice-error" role="alert">
                  Svarstiden har passerat. Mottagare utan svar är markerade NO_RESPONSE och kan
                  följas upp.
                </p>
              )}
            </article>
          ))}
          {referrals.length === 0 && <p className="meta">Inga remisser registrerade.</p>}
        </div>

        <p className="meta">
          Extern leveransprovider är fortfarande en separat produktionsaktivering (EB-09).
          Domänstatusen förblir QUEUED tills en riktig leveranshändelse bekräftas.
        </p>
      </section>

      <section id="beslut" aria-labelledby="h-decisions" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-decisions">Beslut ({decisions.length})</h2>
            <p className="meta">
              Utkast, granskning, godkännande, slutligt mänskligt beslut, signeringsbevis och
              expediering är separata steg. AI-utkast kan aldrig själv bli ett slutligt beslut.
            </p>
          </div>
        </div>

        <details className="create-panel">
          <summary>Skapa beslutsutkast</summary>
          <form action={createDecisionAction} className="form-grid compact-form">
            <input type="hidden" name="caseId" value={header.id} />
            <div className="form-field">
              <label htmlFor="decisionType">Beslutstyp</label>
              <input
                id="decisionType"
                name="decisionType"
                type="text"
                minLength={2}
                maxLength={120}
                placeholder="Exempel: BYGGLOV_BESLUT"
                required
              />
            </div>
            <div className="form-field">
              <label htmlFor="decisionNumber">Beslutsnummer</label>
              <input id="decisionNumber" name="decisionNumber" type="text" maxLength={120} />
            </div>
            <div className="form-actions form-field-wide">
              <button type="submit">Skapa utkast</button>
            </div>
          </form>
        </details>

        <div className="entity-list">
          {decisions.map((decision) => {
            const currentVersion =
              decision.versions.find((version) => version.version === decision.currentVersion) ??
              null;

            return (
              <article className="entity-item" key={decision.id}>
                <div className="entity-heading">
                  <div>
                    <h3>
                      {decision.decisionNumber ?? decision.decisionType}{' '}
                      <span className="status-badge">{decision.status}</span>
                    </h3>
                    <p className="meta">
                      {decision.decisionType} · aktuell version {decision.currentVersion}
                      {decision.approvedAt === null
                        ? ''
                        : ' · godkänd ' + decision.approvedAt.slice(0, 16).replace('T', ' ')}
                      {decision.decidedAt === null
                        ? ''
                        : ' · beslutad ' + decision.decidedAt.slice(0, 16).replace('T', ' ')}
                      {decision.issuedAt === null
                        ? ''
                        : ' · expedierad ' + decision.issuedAt.slice(0, 16).replace('T', ' ')}
                    </p>
                  </div>
                </div>

                {currentVersion !== null && (
                  <div className="notice">
                    <strong>
                      Version {currentVersion.version} · {currentVersion.generatedBy}
                    </strong>
                    <p>{currentVersion.body}</p>
                    <p className="meta">
                      Villkor: {JSON.stringify(currentVersion.conditions)} · Rättsliga referenser:{' '}
                      {JSON.stringify(currentVersion.legalReferences)}
                    </p>
                  </div>
                )}

                {(decision.status === 'DRAFT' || decision.status === 'REVIEW') && (
                  <details className="create-panel" open={decision.currentVersion === 0}>
                    <summary>
                      {decision.currentVersion === 0
                        ? 'Skapa första beslutsversion'
                        : 'Skapa ny beslutsversion'}
                    </summary>
                    <form action={addDecisionVersionAction} className="form-grid compact-form">
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="decisionId" value={decision.id} />
                      <div className="form-field form-field-wide">
                        <label htmlFor={'decision-body-' + decision.id}>Beslutstext</label>
                        <textarea
                          id={'decision-body-' + decision.id}
                          name="body"
                          rows={8}
                          minLength={3}
                          maxLength={100000}
                          required
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={'decision-conditions-' + decision.id}>
                          Villkor — ett per rad
                        </label>
                        <textarea
                          id={'decision-conditions-' + decision.id}
                          name="conditions"
                          rows={4}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={'decision-refs-' + decision.id}>
                          Rättsliga referenser — en per rad
                        </label>
                        <textarea
                          id={'decision-refs-' + decision.id}
                          name="legalReferences"
                          rows={4}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={'decision-origin-' + decision.id}>Ursprung</label>
                        <select
                          id={'decision-origin-' + decision.id}
                          name="generatedBy"
                          defaultValue="HUMAN"
                        >
                          <option value="HUMAN">Människa</option>
                          <option value="TEMPLATE">Mall</option>
                        </select>
                      </div>
                      <div className="form-actions form-field-wide">
                        <button type="submit">Spara ny version</button>
                      </div>
                    </form>
                  </details>
                )}

                {decision.status === 'DRAFT' && decision.currentVersion > 0 && (
                  <form action={submitDecisionReviewAction} className="inline-action">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="decisionId" value={decision.id} />
                    <button type="submit">Skicka till granskning</button>
                  </form>
                )}

                {decision.status === 'REVIEW' && (
                  <form action={approveDecisionAction} className="inline-action">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="decisionId" value={decision.id} />
                    <button type="submit">Godkänn beslut</button>
                    <span className="meta">Kräver decision.approve.</span>
                  </form>
                )}

                {decision.status === 'APPROVED' && (
                  <form action={decideDecisionAction} className="form-grid compact-form">
                    <input type="hidden" name="caseId" value={header.id} />
                    <input type="hidden" name="decisionId" value={decision.id} />
                    <div className="form-field form-field-wide">
                      <label htmlFor={'delegation-' + decision.id}>
                        Delegations-/behörighetsreferens
                      </label>
                      <input
                        id={'delegation-' + decision.id}
                        name="delegationReference"
                        type="text"
                        minLength={2}
                        maxLength={500}
                        required
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor={'appeal-' + decision.id}>Överklagandefrist</label>
                      <input
                        id={'appeal-' + decision.id}
                        name="appealDeadlineAt"
                        type="datetime-local"
                      />
                    </div>
                    <div className="form-actions form-field-wide">
                      <button type="submit">Registrera slutligt beslut</button>
                    </div>
                  </form>
                )}

                {decision.status === 'DECIDED' && decision.signature === null && (
                  <details className="create-panel" open>
                    <summary>Registrera signeringsbevis</summary>
                    <p className="meta">
                      MANUAL_ATTESTATION är en intern attestering. BankID/QES/annan extern metod får
                      bara registreras när en verklig providerreferens finns.
                    </p>
                    <form action={signDecisionAction} className="form-grid compact-form">
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="decisionId" value={decision.id} />
                      <div className="form-field">
                        <label htmlFor={'signature-method-' + decision.id}>Metod</label>
                        <select
                          id={'signature-method-' + decision.id}
                          name="method"
                          defaultValue="MANUAL_ATTESTATION"
                        >
                          <option value="MANUAL_ATTESTATION">Intern attestering</option>
                          <option value="BANKID">BankID — kräver providerreferens</option>
                          <option value="QUALIFIED_ELECTRONIC">
                            Kvalificerad e-signatur — kräver providerreferens
                          </option>
                          <option value="OTHER">Annan — kräver providerreferens</option>
                        </select>
                      </div>
                      <div className="form-field">
                        <label htmlFor={'signature-ref-' + decision.id}>Providerreferens</label>
                        <input
                          id={'signature-ref-' + decision.id}
                          name="providerReference"
                          type="text"
                          maxLength={1000}
                        />
                      </div>
                      <div className="form-actions form-field-wide">
                        <button type="submit">Registrera signeringsbevis</button>
                      </div>
                    </form>
                  </details>
                )}

                {decision.signature !== null && (
                  <div className="notice">
                    <strong>Signerad/attesterad: {decision.signature.method}</strong>
                    <p className="meta">
                      {decision.signature.signedAt.slice(0, 16).replace('T', ' ')}
                      {decision.signature.providerReference === null
                        ? ''
                        : ' · providerref ' + decision.signature.providerReference}
                    </p>
                  </div>
                )}

                {decision.status === 'DECIDED' && decision.signature !== null && (
                  <details className="create-panel">
                    <summary>Expediera beslut</summary>
                    <form action={issueDecisionAction} className="inline-action">
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="decisionId" value={decision.id} />
                      <label htmlFor={'decision-recipient-' + decision.id}>Mottagare</label>
                      <select
                        id={'decision-recipient-' + decision.id}
                        name="recipientPartyId"
                        defaultValue=""
                        required
                      >
                        <option value="" disabled>
                          Välj part
                        </option>
                        {workspace.parties.map((party) => (
                          <option key={party.party_id} value={party.party_id}>
                            {party.display_name} · {party.relationship}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={'decision-channel-' + decision.id}>Kanal</label>
                      <select
                        id={'decision-channel-' + decision.id}
                        name="channel"
                        defaultValue="EMAIL"
                      >
                        <option value="EMAIL">E-post</option>
                        <option value="DIGITAL_POST">Digital post</option>
                        <option value="SMS">SMS</option>
                        <option value="PORTAL">Portal</option>
                        <option value="PHYSICAL_POST">Fysisk post</option>
                      </select>
                      <button type="submit">Köa expediering</button>
                    </form>
                  </details>
                )}

                {decision.issuances.length > 0 && (
                  <>
                    <h4>Expedieringar</h4>
                    <ul>
                      {decision.issuances.map((issuance) => {
                        const party = workspace.parties.find(
                          (candidate) => candidate.party_id === issuance.recipientPartyId,
                        );
                        return (
                          <li key={issuance.id}>
                            {party?.display_name ?? issuance.recipientPartyId} ·{' '}
                            <span className="status-badge">{issuance.status}</span> · köad{' '}
                            {issuance.queuedAt.slice(0, 16).replace('T', ' ')}
                            {issuance.issuedAt === null
                              ? ''
                              : ' · skickad ' + issuance.issuedAt.slice(0, 16).replace('T', ' ')}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                <details>
                  <summary>Versionshistorik ({decision.versions.length})</summary>
                  <ol>
                    {decision.versions.map((version) => (
                      <li key={version.id}>
                        v{version.version} · {version.generatedBy} ·{' '}
                        {version.createdAt.slice(0, 16).replace('T', ' ')}
                      </li>
                    ))}
                  </ol>
                </details>
              </article>
            );
          })}
          {decisions.length === 0 && <p className="meta">Inga beslut registrerade.</p>}
        </div>
      </section>

      <section id="tillsyn" aria-labelledby="h-supervision" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-supervision">PBL-tillsyn</h2>
            <p className="meta">
              Risk är operativ prioritering. Juridiska krav, förelägganden och förbud kräver spårbar
              regel-/beslutsgrund och fattas aldrig av AI.
            </p>
          </div>
          <Link className="button-secondary" href="/handlaggning/tillsyn">
            Öppna riskkön
          </Link>
        </div>

        {header.process_type !== 'PBL_TILLSYN' ? (
          <p className="meta">Det här ärendet är inte klassificerat som PBL_TILLSYN.</p>
        ) : supervision === null ? (
          <form action={openSupervisionAction} className="form-grid compact-form">
            <input type="hidden" name="caseId" value={header.id} />
            <div className="form-field">
              <label htmlFor="supervisionSource">Startorsak</label>
              <select id="supervisionSource" name="sourceType" defaultValue="REPORT">
                <option value="REPORT">Anmälan/uppgift</option>
                <option value="OWN_INITIATIVE">Eget initiativ</option>
                <option value="INSPECTION">Inspektionsfynd</option>
                <option value="OTHER">Annan</option>
              </select>
            </div>
            <div className="form-field form-field-wide">
              <label htmlFor="supervisionAllegation">Uppgift / frågeställning</label>
              <textarea id="supervisionAllegation" name="allegation" rows={4} maxLength={10000} />
            </div>
            <div className="form-actions form-field-wide">
              <button type="submit">Öppna PBL-tillsyn</button>
            </div>
          </form>
        ) : (
          <>
            <div className="notice">
              <strong>
                {supervision.status} · risk {supervision.riskScore.toFixed(0)}{' '}
                {supervision.riskLevel}
              </strong>
              <p className="meta">
                Källa {supervision.sourceType} · öppnad{' '}
                {supervision.openedAt.slice(0, 16).replace('T', ' ')}
              </p>
              {supervision.allegation !== null && <p>{supervision.allegation}</p>}
            </div>

            {supervision.status !== 'CLOSED' && (
              <details className="create-panel">
                <summary>Ny riskbedömning</summary>
                <form action={assessSupervisionRiskAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <div className="form-field">
                    <label htmlFor="supervisionRiskScore">Riskscore 0–100</label>
                    <input
                      id="supervisionRiskScore"
                      name="score"
                      type="number"
                      min={0}
                      max={100}
                      step="0.01"
                      defaultValue={String(supervision.riskScore)}
                      required
                    />
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="supervisionRiskReasons">Skäl — ett per rad</label>
                    <textarea
                      id="supervisionRiskReasons"
                      name="reasons"
                      rows={4}
                      maxLength={10000}
                    />
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Spara riskbedömning</button>
                  </div>
                </form>
              </details>
            )}

            {supervision.riskHistory.length > 0 && (
              <details>
                <summary>Riskhistorik ({supervision.riskHistory.length})</summary>
                <ol>
                  {supervision.riskHistory.map((risk) => (
                    <li key={risk.id}>
                      {risk.assessedAt.slice(0, 16).replace('T', ' ')} — {risk.score}{' '}
                      <span className="status-badge">{risk.level}</span> ·{' '}
                      {JSON.stringify(risk.reasons)}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            {supervision.status !== 'CLOSED' && (
              <details className="create-panel">
                <summary>Schemalägg tillsynsinspektion</summary>
                <form
                  action={scheduleSupervisionInspectionAction}
                  className="form-grid compact-form"
                >
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <div className="form-field">
                    <label htmlFor="supervisionInspectionAt">Tid</label>
                    <input
                      id="supervisionInspectionAt"
                      name="scheduledAt"
                      type="datetime-local"
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="supervisionProperty">Fastighet</label>
                    <select id="supervisionProperty" name="propertyId" defaultValue="">
                      <option value="">Ingen specifik</option>
                      {workspace.properties.map((property) => (
                        <option key={property.property_id} value={property.property_id}>
                          {property.designation}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="supervisionBuilding">Byggnad</label>
                    <select id="supervisionBuilding" name="buildingId" defaultValue="">
                      <option value="">Ingen specifik</option>
                      {workspace.properties.flatMap((property) =>
                        property.buildings.map((building) => (
                          <option key={building.id} value={building.id}>
                            {property.designation} ·{' '}
                            {building.building_designation ??
                              building.building_purpose ??
                              'Byggnad'}
                          </option>
                        )),
                      )}
                    </select>
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="supervisionInspectionNotes">Anteckning</label>
                    <textarea
                      id="supervisionInspectionNotes"
                      name="notes"
                      rows={3}
                      maxLength={10000}
                    />
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Schemalägg inspektion</button>
                  </div>
                </form>
              </details>
            )}

            <h3>Inspektioner ({supervision.inspections.length})</h3>
            <div className="entity-list">
              {supervision.inspections.map((inspection) => (
                <article className="entity-item" key={inspection.id}>
                  <strong>
                    {inspection.status}
                    {inspection.result === null ? '' : ' · ' + inspection.result}
                  </strong>
                  <p className="meta">
                    {inspection.scheduledAt === null
                      ? 'Ingen planerad tid'
                      : 'Planerad ' + inspection.scheduledAt.slice(0, 16).replace('T', ' ')}
                    {inspection.performedAt === null
                      ? ''
                      : ' · utförd ' + inspection.performedAt.slice(0, 16).replace('T', ' ')}
                  </p>
                  {inspection.notes !== null && <p>{inspection.notes}</p>}

                  {(inspection.status === 'PLANNED' || inspection.status === 'IN_PROGRESS') && (
                    <details>
                      <summary>Slutför inspektion</summary>
                      <form
                        action={completeSupervisionInspectionAction}
                        className="form-grid compact-form"
                      >
                        <input type="hidden" name="caseId" value={header.id} />
                        <input type="hidden" name="inspectionId" value={inspection.id} />
                        <div className="form-field">
                          <label htmlFor={'inspection-result-' + inspection.id}>Resultat</label>
                          <select
                            id={'inspection-result-' + inspection.id}
                            name="result"
                            defaultValue="APPROVED_WITH_REMARKS"
                          >
                            <option value="APPROVED">Godkänd</option>
                            <option value="APPROVED_WITH_REMARKS">Godkänd med anmärkning</option>
                            <option value="REJECTED">Avvikelse</option>
                            <option value="NOT_APPLICABLE">Ej tillämplig</option>
                          </select>
                        </div>
                        <div className="form-field form-field-wide">
                          <label htmlFor={'inspection-notes-' + inspection.id}>Anteckning</label>
                          <textarea
                            id={'inspection-notes-' + inspection.id}
                            name="notes"
                            rows={3}
                            maxLength={10000}
                          />
                        </div>
                        <div className="form-actions form-field-wide">
                          <button type="submit">Slutför som behörig inspektör</button>
                        </div>
                      </form>
                    </details>
                  )}
                </article>
              ))}
              {supervision.inspections.length === 0 && (
                <p className="meta">Inga tillsynsinspektioner.</p>
              )}
            </div>

            {supervision.status !== 'CLOSED' && (
              <details className="create-panel">
                <summary>Registrera iakttagelse / finding</summary>
                <form action={recordSupervisionFindingAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <div className="form-field">
                    <label htmlFor="findingInspection">Inspektion</label>
                    <select id="findingInspection" name="inspectionId" defaultValue="">
                      <option value="">Inte kopplad till inspektion</option>
                      {supervision.inspections.map((inspection) => (
                        <option key={inspection.id} value={inspection.id}>
                          {inspection.scheduledAt?.slice(0, 10) ?? inspection.id} ·{' '}
                          {inspection.status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="findingSeverity">Allvar</label>
                    <select id="findingSeverity" name="severity" defaultValue="REMARK">
                      <option value="INFO">Info</option>
                      <option value="REMARK">Anmärkning</option>
                      <option value="DEVIATION">Avvikelse</option>
                      <option value="SERIOUS">Allvarlig</option>
                    </select>
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="findingTitle">Rubrik</label>
                    <input
                      id="findingTitle"
                      name="title"
                      type="text"
                      minLength={2}
                      maxLength={300}
                      required
                    />
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="findingDescription">Beskrivning</label>
                    <textarea
                      id="findingDescription"
                      name="description"
                      rows={4}
                      maxLength={10000}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="findingDueAt">Åtgärd senast</label>
                    <input id="findingDueAt" name="dueAt" type="datetime-local" />
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Registrera finding</button>
                  </div>
                </form>
              </details>
            )}

            <h3>Findings ({supervision.findings.length})</h3>
            <div className="entity-list">
              {supervision.findings.map((finding) => (
                <article className="entity-item" key={finding.id}>
                  <div className="entity-heading">
                    <div>
                      <strong>{finding.title}</strong>{' '}
                      <span className="status-badge">{finding.severity}</span>{' '}
                      <span className="status-badge">{finding.status}</span>
                      {finding.dueAt !== null && (
                        <p className="meta">
                          Senast {finding.dueAt.slice(0, 16).replace('T', ' ')}
                        </p>
                      )}
                    </div>
                  </div>
                  {finding.description !== null && <p>{finding.description}</p>}
                  {finding.evidence.length > 0 && (
                    <ul>
                      {finding.evidence.map((evidence) => (
                        <li key={evidence.id}>
                          Evidens {evidence.documentVersionId ?? evidence.id}
                          {evidence.note === null ? '' : ' · ' + evidence.note}
                        </li>
                      ))}
                    </ul>
                  )}

                  {finding.status !== 'RESOLVED' && finding.status !== 'CLOSED' && (
                    <>
                      {cleanDocumentVersions.length > 0 && (
                        <details>
                          <summary>Koppla CLEAN dokumentevidens</summary>
                          <form
                            action={addSupervisionFindingEvidenceAction}
                            className="form-grid compact-form"
                          >
                            <input type="hidden" name="caseId" value={header.id} />
                            <input type="hidden" name="findingId" value={finding.id} />
                            <div className="form-field">
                              <label htmlFor={'evidence-document-' + finding.id}>Dokument</label>
                              <select
                                id={'evidence-document-' + finding.id}
                                name="documentId"
                                defaultValue=""
                                required
                              >
                                <option value="" disabled>
                                  Välj dokument
                                </option>
                                {workspace.documents
                                  .filter((document) =>
                                    document.versions.some(
                                      (version) => version.ingestion_status === 'CLEAN',
                                    ),
                                  )
                                  .map((document) => (
                                    <option key={document.id} value={document.id}>
                                      {document.title}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div className="form-field">
                              <label htmlFor={'evidence-version-' + finding.id}>Version</label>
                              <select
                                id={'evidence-version-' + finding.id}
                                name="documentVersionId"
                                defaultValue=""
                                required
                              >
                                <option value="" disabled>
                                  Välj CLEAN version
                                </option>
                                {cleanDocumentVersions.map((version) => (
                                  <option key={version.versionId} value={version.versionId}>
                                    {version.documentTitle} · v{version.version}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="form-field form-field-wide">
                              <label htmlFor={'evidence-note-' + finding.id}>Notering</label>
                              <input
                                id={'evidence-note-' + finding.id}
                                name="note"
                                type="text"
                                maxLength={4000}
                              />
                            </div>
                            <div className="form-actions form-field-wide">
                              <button type="submit" className="button-secondary">
                                Koppla evidens
                              </button>
                            </div>
                          </form>
                        </details>
                      )}

                      <form action={resolveSupervisionFindingAction} className="inline-action">
                        <input type="hidden" name="caseId" value={header.id} />
                        <input type="hidden" name="findingId" value={finding.id} />
                        <label htmlFor={'resolve-finding-' + finding.id}>Resolution</label>
                        <input
                          id={'resolve-finding-' + finding.id}
                          name="note"
                          type="text"
                          minLength={2}
                          maxLength={4000}
                          required
                        />
                        <button type="submit" className="button-secondary">
                          Markera löst
                        </button>
                      </form>
                    </>
                  )}
                </article>
              ))}
              {supervision.findings.length === 0 && <p className="meta">Inga findings.</p>}
            </div>

            {supervision.status !== 'CLOSED' && (
              <details className="create-panel">
                <summary>Skapa tillsynsåtgärd</summary>
                <form action={createSupervisionActionAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <div className="form-field">
                    <label htmlFor="supervisionActionType">Typ</label>
                    <select
                      id="supervisionActionType"
                      name="actionType"
                      defaultValue="REQUEST_INFO"
                    >
                      <option value="REQUEST_INFO">Begär uppgifter</option>
                      <option value="INSPECTION">Inspektion</option>
                      <option value="COMMUNICATION">Kommunicering</option>
                      <option value="ORDER">Föreläggande</option>
                      <option value="PROHIBITION">Förbud</option>
                      <option value="SANCTION_REVIEW">Sanktionsprövning</option>
                      <option value="OTHER">Annan</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="supervisionActionDue">Senast</label>
                    <input id="supervisionActionDue" name="dueAt" type="datetime-local" />
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="supervisionActionDescription">Beskrivning</label>
                    <textarea
                      id="supervisionActionDescription"
                      name="description"
                      rows={4}
                      minLength={2}
                      maxLength={10000}
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="supervisionLegalReference">Rättslig referens</label>
                    <input
                      id="supervisionLegalReference"
                      name="legalReference"
                      type="text"
                      maxLength={2000}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="supervisionDecision">Slutligt beslut</label>
                    <select id="supervisionDecision" name="decisionId" defaultValue="">
                      <option value="">Inget</option>
                      {finalDecisions.map((decision) => (
                        <option key={decision.id} value={decision.id}>
                          {decision.decisionNumber ?? decision.decisionType}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Skapa åtgärd</button>
                  </div>
                </form>
              </details>
            )}

            <h3>Åtgärder ({supervision.actions.length})</h3>
            <div className="entity-list">
              {supervision.actions.map((action) => (
                <article className="entity-item" key={action.id}>
                  <strong>
                    {action.actionType} <span className="status-badge">{action.status}</span>
                  </strong>
                  <p>{action.description}</p>
                  {action.legalReference !== null && (
                    <p className="meta">Rättslig referens: {action.legalReference}</p>
                  )}
                  {action.dueAt !== null && (
                    <p className="meta">Senast {action.dueAt.slice(0, 16).replace('T', ' ')}</p>
                  )}
                  {action.outcome !== null && <p className="meta">Utfall: {action.outcome}</p>}

                  {(action.status === 'PLANNED' || action.status === 'ACTIVE') && (
                    <form action={completeSupervisionActionAction} className="inline-action">
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="actionId" value={action.id} />
                      <label htmlFor={'action-outcome-' + action.id}>Utfall</label>
                      <input
                        id={'action-outcome-' + action.id}
                        name="outcome"
                        type="text"
                        minLength={2}
                        maxLength={4000}
                        required
                      />
                      <button type="submit" className="button-secondary">
                        Slutför åtgärd
                      </button>
                    </form>
                  )}
                </article>
              ))}
              {supervision.actions.length === 0 && <p className="meta">Inga åtgärder.</p>}
            </div>

            {supervision.status !== 'CLOSED' && (
              <details className="create-panel">
                <summary>Skapa uppföljning</summary>
                <form action={createSupervisionFollowupAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <div className="form-field">
                    <label htmlFor="followupAction">Kopplad åtgärd</label>
                    <select id="followupAction" name="actionId" defaultValue="">
                      <option value="">Ingen</option>
                      {supervision.actions.map((action) => (
                        <option key={action.id} value={action.id}>
                          {action.actionType} · {action.description.slice(0, 80)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="followupDueAt">Följ upp senast</label>
                    <input id="followupDueAt" name="dueAt" type="datetime-local" required />
                  </div>
                  <div className="form-field form-field-wide">
                    <label htmlFor="followupNote">Notering</label>
                    <textarea id="followupNote" name="note" rows={3} maxLength={4000} />
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Skapa uppföljning</button>
                  </div>
                </form>
              </details>
            )}

            <h3>Uppföljningar ({supervision.followups.length})</h3>
            <div className="entity-list">
              {supervision.followups.map((followup) => (
                <article className="entity-item" key={followup.id}>
                  <strong>
                    {followup.dueAt.slice(0, 16).replace('T', ' ')}{' '}
                    <span className="status-badge">{followup.status}</span>
                  </strong>
                  {followup.note !== null && <p>{followup.note}</p>}
                  {followup.outcome !== null && <p className="meta">Utfall: {followup.outcome}</p>}
                  {(followup.status === 'OPEN' || followup.status === 'OVERDUE') && (
                    <form action={completeSupervisionFollowupAction} className="inline-action">
                      <input type="hidden" name="caseId" value={header.id} />
                      <input type="hidden" name="followupId" value={followup.id} />
                      <label htmlFor={'followup-outcome-' + followup.id}>Utfall</label>
                      <input
                        id={'followup-outcome-' + followup.id}
                        name="outcome"
                        type="text"
                        minLength={2}
                        maxLength={4000}
                        required
                      />
                      <button type="submit" className="button-secondary">
                        Slutför uppföljning
                      </button>
                    </form>
                  )}
                </article>
              ))}
              {supervision.followups.length === 0 && <p className="meta">Inga uppföljningar.</p>}
            </div>

            {supervision.status !== 'CLOSED' ? (
              <details className="create-panel">
                <summary>Stäng PBL-tillsyn</summary>
                <p className="meta">
                  Databasen stoppar stängning om öppna findings, åtgärder eller uppföljningar finns.
                </p>
                <form action={closeSupervisionAction} className="inline-action">
                  <input type="hidden" name="caseId" value={header.id} />
                  <input type="hidden" name="supervisionId" value={supervision.id} />
                  <label htmlFor="supervisionCloseReason">Motivering</label>
                  <input
                    id="supervisionCloseReason"
                    name="reason"
                    type="text"
                    minLength={3}
                    maxLength={4000}
                    required
                  />
                  <button type="submit">Stäng tillsyn</button>
                </form>
              </details>
            ) : (
              <div className="notice">
                <strong>Tillsynen är stängd.</strong>
                {supervision.closeReason !== null && <p>{supervision.closeReason}</p>}
              </div>
            )}
          </>
        )}
      </section>

      <section id="ovk" aria-labelledby="h-ovk" className="card">
        <div className="section-heading">
          <div>
            <h2 id="h-ovk">OVK</h2>
            <p className="meta">
              Objekt, versionerad skyldighet, nästa kontroll, CLEAN protokoll och fynd hanteras
              separat. Ett underkänt protokoll kan aldrig bli COMPLIANT enbart på grund av datum.
            </p>
          </div>
          <Link className="button-secondary" href="/handlaggning/ovk">
            Öppna OVK-kön
          </Link>
        </div>

        {header.process_type !== 'OVK' ? (
          <p className="meta">Det här ärendet är inte klassificerat som OVK.</p>
        ) : (
          <>
            <details className="create-panel" open={ovk.objects.length === 0}>
              <summary>Registrera eller länka OVK-objekt</summary>
              {workspace.properties.length === 0 || ovk.obligations.length === 0 ? (
                <p className="meta">
                  Ärendet behöver minst en kopplad fastighet och en aktiv versionerad
                  OVK-skyldighet innan objekt kan registreras.
                </p>
              ) : (
                <form action={linkOvkObjectAction} className="form-grid compact-form">
                  <input type="hidden" name="caseId" value={header.id} />
                  <div className="form-field">
                    <label htmlFor="ovkProperty">Fastighet</label>
                    <select id="ovkProperty" name="propertyId" defaultValue="" required>
                      <option value="" disabled>
                        Välj fastighet
                      </option>
                      {workspace.properties.map((property) => (
                        <option key={property.property_id} value={property.property_id}>
                          {property.designation}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="ovkBuilding">Byggnad</label>
                    <select id="ovkBuilding" name="buildingId" defaultValue="">
                      <option value="">Fastighetsnivå</option>
                      {workspace.properties.flatMap((property) =>
                        property.buildings.map((building) => (
                          <option key={building.id} value={building.id}>
                            {property.designation} ·{' '}
                            {building.building_designation ?? building.building_purpose ?? 'Byggnad'}
                          </option>
                        )),
                      )}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="ovkObligation">Skyldighet</label>
                    <select id="ovkObligation" name="obligationId" defaultValue="" required>
                      <option value="" disabled>
                        Välj skyldighet
                      </option>
                      {ovk.obligations.map((obligation) => (
                        <option key={obligation.id} value={obligation.id}>
                          {obligation.name} · {obligation.intervalMonths} mån
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor="ovkObjectReference">Objektreferens</label>
                    <input
                      id="ovkObjectReference"
                      name="objectReference"
                      type="text"
                      minLength={1}
                      maxLength={300}
                      placeholder="Exempel: FTX-1"
                      required
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="ovkSystemType">Ventilationssystem</label>
                    <input
                      id="ovkSystemType"
                      name="ventilationSystemType"
                      type="text"
                      maxLength={300}
                      placeholder="FTX"
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="ovkLastPerformed">Senast utförd kontroll</label>
                    <input id="ovkLastPerformed" name="lastPerformedAt" type="date" />
                  </div>
                  <div className="form-actions form-field-wide">
                    <button type="submit">Registrera OVK-objekt</button>
                  </div>
                </form>
              )}
            </details>

            <div className="entity-list">
              {ovk.objects.map((object) => {
                const property = workspace.properties.find(
                  (candidate) => candidate.property_id === object.propertyId,
                );
                const building = workspace.properties
                  .flatMap((candidate) => candidate.buildings)
                  .find((candidate) => candidate.id === object.buildingId);
                const obligation = ovk.obligations.find(
                  (candidate) => candidate.id === object.obligationId,
                );

                return (
                  <article className="entity-item" key={object.id}>
                    <div className="entity-heading">
                      <div>
                        <h3>
                          {object.objectReference ?? 'OVK-objekt'}{' '}
                          <span className="status-badge">{object.status}</span>
                        </h3>
                        <p className="meta">
                          {property?.designation ?? 'Fastighet saknas'}
                          {building === undefined
                            ? ''
                            : ' · ' +
                              (building.building_designation ??
                                building.building_purpose ??
                                'Byggnad')}
                          {object.ventilationSystemType === null
                            ? ''
                            : ' · ' + object.ventilationSystemType}
                        </p>
                        <p className="meta">
                          {obligation?.name ?? 'OVK'} · nästa kontroll{' '}
                          {object.nextDueAt ?? 'okänd'} · risk {object.riskScore ?? '—'}
                          {object.lastProtocolResult === null
                            ? ''
                            : ' · senaste protokoll ' + object.lastProtocolResult}
                        </p>
                        {obligation?.legalReference !== null &&
                          obligation?.legalReference !== undefined && (
                            <p className="meta">
                              Rättslig källa: {obligation.legalReference}
                            </p>
                          )}
                      </div>
                    </div>

                    <h4>Protokoll ({object.protocols.length})</h4>
                    {object.protocols.length > 0 && (
                      <ol>
                        {object.protocols.map((protocol) => (
                          <li key={protocol.id}>
                            {protocol.performedAt} ·{' '}
                            <span className="status-badge">{protocol.result}</span>
                            {protocol.inspectorName === null
                              ? ''
                              : ' · ' + protocol.inspectorName}
                          </li>
                        ))}
                      </ol>
                    )}

                    <details className="create-panel">
                      <summary>Registrera OVK-protokoll</summary>
                      {cleanDocumentVersions.length === 0 ? (
                        <p className="meta">
                          Ladda först upp protokollet under Handlingar och invänta att
                          säkerhetskontrollen ger status CLEAN.
                        </p>
                      ) : (
                        <form action={recordOvkProtocolAction} className="form-grid compact-form">
                          <input type="hidden" name="caseId" value={header.id} />
                          <input type="hidden" name="objectId" value={object.id} />
                          <div className="form-field">
                            <label htmlFor={'ovk-performed-' + object.id}>Kontrolldatum</label>
                            <input
                              id={'ovk-performed-' + object.id}
                              name="performedAt"
                              type="date"
                              required
                            />
                          </div>
                          <div className="form-field">
                            <label htmlFor={'ovk-result-' + object.id}>Resultat</label>
                            <select
                              id={'ovk-result-' + object.id}
                              name="result"
                              defaultValue="APPROVED"
                            >
                              <option value="APPROVED">Godkänd</option>
                              <option value="APPROVED_WITH_REMARKS">
                                Godkänd med anmärkningar
                              </option>
                              <option value="NOT_APPROVED">Inte godkänd</option>
                            </select>
                          </div>
                          <div className="form-field form-field-wide">
                            <label htmlFor={'ovk-document-' + object.id}>
                              CLEAN protokollversion
                            </label>
                            <select
                              id={'ovk-document-' + object.id}
                              name="documentVersionId"
                              defaultValue=""
                              required
                            >
                              <option value="" disabled>
                                Välj säkerhetskontrollerad version
                              </option>
                              {cleanDocumentVersions.map((version) => (
                                <option key={version.versionId} value={version.versionId}>
                                  {version.documentTitle} · v{version.version}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="form-field">
                            <label htmlFor={'ovk-inspector-' + object.id}>Kontrollant</label>
                            <input
                              id={'ovk-inspector-' + object.id}
                              name="inspectorName"
                              type="text"
                              maxLength={300}
                            />
                          </div>
                          <div className="form-field">
                            <label htmlFor={'ovk-inspector-org-' + object.id}>
                              Kontrollorganisation
                            </label>
                            <input
                              id={'ovk-inspector-org-' + object.id}
                              name="inspectorOrganization"
                              type="text"
                              maxLength={300}
                            />
                          </div>
                          <div className="form-field form-field-wide">
                            <label htmlFor={'ovk-notes-' + object.id}>Notering</label>
                            <textarea
                              id={'ovk-notes-' + object.id}
                              name="notes"
                              rows={3}
                              maxLength={10000}
                            />
                          </div>
                          <div className="form-actions form-field-wide">
                            <button type="submit">Registrera protokoll</button>
                          </div>
                        </form>
                      )}
                    </details>

                    <h4>OVK-fynd ({object.findings.length})</h4>
                    <div className="entity-list">
                      {object.findings.map((finding) => (
                        <article className="entity-item" key={finding.id}>
                          <strong>
                            {finding.findingType}{' '}
                            <span className="status-badge">{finding.severity}</span>{' '}
                            <span className="status-badge">{finding.status}</span>
                          </strong>
                          {finding.description !== null && <p>{finding.description}</p>}
                          {finding.dueAt !== null && (
                            <p className="meta">
                              Följ upp senast {finding.dueAt.slice(0, 16).replace('T', ' ')}
                            </p>
                          )}
                          {finding.resolutionNote !== null && (
                            <p className="meta">Resolution: {finding.resolutionNote}</p>
                          )}
                          {(finding.status === 'OPEN' ||
                            finding.status === 'ACTION_REQUIRED') && (
                            <form action={resolveOvkFindingAction} className="inline-action">
                              <input type="hidden" name="caseId" value={header.id} />
                              <input type="hidden" name="findingId" value={finding.id} />
                              <label htmlFor={'ovk-resolution-' + finding.id}>Resolution</label>
                              <input
                                id={'ovk-resolution-' + finding.id}
                                name="resolutionNote"
                                type="text"
                                minLength={2}
                                maxLength={4000}
                                required
                              />
                              <button type="submit" className="button-secondary">
                                Markera löst
                              </button>
                            </form>
                          )}
                        </article>
                      ))}
                      {object.findings.length === 0 && <p className="meta">Inga OVK-fynd.</p>}
                    </div>

                    <details className="create-panel">
                      <summary>Registrera OVK-fynd</summary>
                      <form action={recordOvkFindingAction} className="form-grid compact-form">
                        <input type="hidden" name="caseId" value={header.id} />
                        <input type="hidden" name="objectId" value={object.id} />
                        <div className="form-field">
                          <label htmlFor={'ovk-finding-protocol-' + object.id}>Protokoll</label>
                          <select
                            id={'ovk-finding-protocol-' + object.id}
                            name="protocolId"
                            defaultValue=""
                          >
                            <option value="">Inget specifikt protokoll</option>
                            {object.protocols.map((protocol) => (
                              <option key={protocol.id} value={protocol.id}>
                                {protocol.performedAt} · {protocol.result}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="form-field">
                          <label htmlFor={'ovk-finding-type-' + object.id}>Typ</label>
                          <input
                            id={'ovk-finding-type-' + object.id}
                            name="findingType"
                            type="text"
                            minLength={2}
                            maxLength={200}
                            placeholder="LUFTFLODE"
                            required
                          />
                        </div>
                        <div className="form-field">
                          <label htmlFor={'ovk-finding-severity-' + object.id}>Allvar</label>
                          <select
                            id={'ovk-finding-severity-' + object.id}
                            name="severity"
                            defaultValue="REMARK"
                          >
                            <option value="INFO">Info</option>
                            <option value="REMARK">Anmärkning</option>
                            <option value="DEVIATION">Avvikelse</option>
                            <option value="SERIOUS">Allvarlig</option>
                          </select>
                        </div>
                        <div className="form-field">
                          <label htmlFor={'ovk-finding-due-' + object.id}>Följ upp senast</label>
                          <input
                            id={'ovk-finding-due-' + object.id}
                            name="dueAt"
                            type="datetime-local"
                          />
                        </div>
                        <div className="form-field form-field-wide">
                          <label htmlFor={'ovk-finding-description-' + object.id}>
                            Beskrivning
                          </label>
                          <textarea
                            id={'ovk-finding-description-' + object.id}
                            name="description"
                            rows={4}
                            minLength={2}
                            maxLength={10000}
                            required
                          />
                        </div>
                        <div className="form-actions form-field-wide">
                          <button type="submit">Registrera fynd</button>
                        </div>
                      </form>
                    </details>
                  </article>
                );
              })}
              {ovk.objects.length === 0 && (
                <p className="meta">Inga OVK-objekt är länkade till ärendet ännu.</p>
              )}
            </div>
          </>
        )}
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
              <textarea
                id="closeReason"
                name="reason"
                rows={3}
                minLength={3}
                maxLength={1000}
                required
              />
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
