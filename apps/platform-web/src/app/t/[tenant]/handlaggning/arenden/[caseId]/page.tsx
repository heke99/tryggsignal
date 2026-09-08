import Link from 'next/link';
import {
  addCasePartyAction,
  advanceWorkflowAction,
  assignCaseAction,
  closeCaseAction,
  linkCasePropertyAction,
  registerLocalPropertyAction,
  setPrimaryPropertyAction,
  setWorkflowPauseAction,
  updateCasePartyRelationshipAction,
  updatePartyContactAction,
} from '@/lib/data/actions';
import { currentTenant } from '@/lib/tenant/context';
import { loadCaseWorkspace, searchPropertyCandidates } from '@/lib/data/workspace';

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
  party: 'Parten kunde inte läggas till. Kontrollera uppgifter och behörighet.',
  'party-role': 'Partens roll i ärendet kunde inte ändras.',
  'party-contact':
    'Kontaktuppgifterna kunde inte ändras. En delad part kräver behörighet till samtliga länkade ärenden.',
  'property-link': 'Fastigheten kunde inte kopplas till ärendet.',
  'property-primary': 'Primär fastighet kunde inte ändras.',
  'property-register':
    'Den lokala fastigheten kunde inte registreras. Kontrollera beteckning, adress och behörighet.',
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
  const assignedUser = workspace.assignees.find((user) => user.id === header.assigned_user_id);
  const assignedTeam = workspace.teams.find((team) => team.id === header.assigned_team_id);
  const errorMessage =
    query.error === undefined ? null : (ERROR_MESSAGES[query.error] ?? ERROR_MESSAGES.validation);
  const successMessage =
    query.ok === undefined ? null : (SUCCESS_MESSAGES[query.ok] ?? 'Åtgärden är genomförd.');

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
