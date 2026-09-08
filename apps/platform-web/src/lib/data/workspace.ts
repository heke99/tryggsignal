import 'server-only';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from './client';

/**
 * Read models for the staff surfaces. Every query is scoped by RLS in the tenant
 * data plane; nothing here adds or removes an access filter of its own.
 */

export interface ControlTowerRow {
  readonly id: string;
  readonly case_number: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly statutory_due_at: string | null;
  readonly assigned_user_id: string | null;
}

export interface ControlTower {
  readonly available: boolean;
  readonly reason?: string;
  readonly dueSoon: readonly ControlTowerRow[];
  readonly unassigned: readonly ControlTowerRow[];
  readonly awaitingCompletion: readonly ControlTowerRow[];
  readonly overdueReferrals: number;
  readonly failedJobs: number;
}

const EMPTY: ControlTower = {
  available: false,
  dueSoon: [],
  unassigned: [],
  awaitingCompletion: [],
  overdueReferrals: 0,
  failedJobs: 0,
};

const CASE_COLUMNS = 'id, case_number, title, status, phase, statutory_due_at, assigned_user_id';

/** Masterplan 95: the dashboard is operational — queues to act on, not graphs. */
export async function loadControlTower(context: TenantContext): Promise<ControlTower> {
  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { ...EMPTY, reason: error.message };
    }
    throw error;
  }

  if (!session.authenticated) {
    return { ...EMPTY, reason: 'Ingen inloggad session på den här värden.' };
  }

  const db = session.client.schema('core');
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString();

  const [dueSoon, unassigned, awaitingCompletion] = await Promise.all([
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .lte('statutory_due_at', inFiveDays)
      .not('status', 'in', '("CLOSED","ARCHIVED")')
      .order('statutory_due_at', { ascending: true })
      .limit(25),
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .is('assigned_user_id', null)
      .not('status', 'in', '("CLOSED","ARCHIVED")')
      .order('created_at', { ascending: true })
      .limit(25),
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .eq('status', 'AWAITING_COMPLETION')
      .order('statutory_due_at', { ascending: true })
      .limit(25),
  ]);

  const rows = (result: { data: unknown }): readonly ControlTowerRow[] =>
    Array.isArray(result.data) ? (result.data as ControlTowerRow[]) : [];

  const [referrals, failedJobs] = await Promise.all([
    session.client
      .schema('referral')
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .lt('due_at', new Date().toISOString())
      .in('status', ['SENT', 'PARTIALLY_ANSWERED', 'OVERDUE']),
    session.client
      .schema('integration')
      .from('sync_jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['FAILED', 'DEAD_LETTER']),
  ]);

  return {
    available: true,
    dueSoon: rows(dueSoon),
    unassigned: rows(unassigned),
    awaitingCompletion: rows(awaitingCompletion),
    overdueReferrals: referrals.count ?? 0,
    failedJobs: failedJobs.count ?? 0,
  };
}

export interface CaseHeader {
  readonly id: string;
  readonly authority_id: string;
  readonly department_id: string | null;
  readonly case_number: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly information_class: string;
  readonly statutory_due_at: string | null;
  readonly effective_due_at: string | null;
  readonly system_of_record: string;
  readonly assigned_user_id: string | null;
  readonly assigned_team_id: string | null;
  readonly primary_property_id: string | null;
}

export interface CaseWorkflow {
  readonly id: string;
  readonly currentState: string;
  readonly status: string;
  readonly availableTransitions: readonly string[];
  readonly tasks: readonly {
    id: string;
    title: string;
    status: string;
    due_at: string | null;
  }[];
  readonly transitions: readonly {
    id: number;
    from_state: string | null;
    to_state: string;
    occurred_at: string;
    reason: string | null;
  }[];
}

export interface StaffOption {
  readonly id: string;
  readonly display_name: string;
}

export interface TeamOption {
  readonly id: string;
  readonly name: string;
}

export interface CaseParty {
  readonly relation_id: string;
  readonly party_id: string;
  readonly party_type: 'PERSON' | 'ORGANIZATION';
  readonly display_name: string;
  readonly relationship: string;
  readonly organization_number: string | null;
  readonly person_reference: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
  readonly identity_link_verified: boolean;
}

interface CasePartyRelationRow {
  readonly id: string;
  readonly party_id: string;
  readonly relationship: string;
  readonly identity_user_id: string | null;
  readonly verified_at: string | null;
}

interface PartyRow {
  readonly id: string;
  readonly party_type: 'PERSON' | 'ORGANIZATION';
  readonly display_name: string;
  readonly organization_number: string | null;
  readonly person_reference: string | null;
  readonly contact_email: string | null;
  readonly contact_phone: string | null;
}

export interface CaseProperty {
  readonly property_id: string;
  readonly designation: string;
  readonly municipality_code: string | null;
  readonly source: string;
  readonly source_version: string | null;
  readonly is_primary: boolean;
  readonly identifiers: readonly {
    id: string;
    identifier_type: string;
    value: string;
    source: string;
  }[];
  readonly addresses: readonly {
    id: string;
    street_name: string;
    street_number: string | null;
    letter: string | null;
    postal_code: string | null;
    postal_town: string | null;
    source: string;
  }[];
  readonly buildings: readonly {
    id: string;
    building_designation: string | null;
    building_purpose: string | null;
    year_built: number | null;
    gross_floor_area: number | null;
    floors: number | null;
    source: string;
  }[];
}

export interface PropertyCandidate {
  readonly id: string;
  readonly designation: string;
  readonly municipality_code: string | null;
  readonly source: string;
  readonly address: string | null;
}

interface CasePropertyLinkRow {
  readonly property_id: string;
  readonly is_primary: boolean;
}

interface PropertyRow {
  readonly id: string;
  readonly designation: string;
  readonly municipality_code: string | null;
  readonly source: string;
  readonly source_version: string | null;
}

export interface CaseDocumentVersion {
  readonly id: string;
  readonly version: number;
  readonly sha256: string;
  readonly mime_type: string;
  readonly detected_mime_type: string | null;
  readonly size_bytes: number;
  readonly original_filename: string | null;
  readonly ingestion_status: string;
  readonly rejection_reason: string | null;
  readonly scanner_provider: string | null;
  readonly scanner_version: string | null;
  readonly signature_version: string | null;
  readonly scan_started_at: string | null;
  readonly scanned_at: string | null;
  readonly scan_result: string | null;
  readonly threat_name: string | null;
  readonly upload_confirmed_at: string | null;
  readonly processing_enqueued_at: string | null;
  readonly created_at: string;
}

export interface CaseDocument {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly document_type: string;
  readonly information_class: string;
  readonly secrecy_level: number;
  readonly current_version: number;
  readonly versions: readonly CaseDocumentVersion[];
}

interface CaseDocumentRow {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly document_type: string;
  readonly information_class: string;
  readonly secrecy_level: number;
  readonly current_version: number;
}

export interface CaseWorkspace {
  readonly available: boolean;
  readonly reason?: string;
  readonly header: CaseHeader | null;
  readonly documents: readonly CaseDocument[];
  readonly deadlines: readonly { id: string; name: string; due_at: string; status: string }[];
  readonly history: readonly { id: number; to_status: string; changed_at: string }[];
  readonly workflow: CaseWorkflow | null;
  readonly assignees: readonly StaffOption[];
  readonly teams: readonly TeamOption[];
  readonly parties: readonly CaseParty[];
  readonly properties: readonly CaseProperty[];
}

interface WorkflowDefinition {
  readonly states?: Record<string, { readonly to?: readonly string[] }>;
}

function transitionTargets(definition: unknown, currentState: string): readonly string[] {
  if (typeof definition !== 'object' || definition === null) return [];
  const states = (definition as WorkflowDefinition).states;
  const state = states?.[currentState];
  return Array.isArray(state?.to)
    ? state.to.filter((value): value is string => typeof value === 'string')
    : [];
}

export async function loadCaseWorkspace(
  context: TenantContext,
  caseId: string,
): Promise<CaseWorkspace> {
  const empty: CaseWorkspace = {
    available: false,
    header: null,
    documents: [],
    deadlines: [],
    history: [],
    workflow: null,
    assignees: [],
    teams: [],
    parties: [],
    properties: [],
  };

  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError)
      return { ...empty, reason: error.message };
    throw error;
  }
  if (!session.authenticated) {
    return { ...empty, reason: 'Ingen inloggad session på den här värden.' };
  }

  const { data: header } = await session.client
    .schema('core')
    .from('cases')
    .select(
      'id, authority_id, department_id, case_number, title, status, phase, information_class, statutory_due_at, effective_due_at, system_of_record, assigned_user_id, assigned_team_id, primary_property_id',
    )
    .eq('id', caseId)
    .maybeSingle<CaseHeader>();

  // An unreadable case is indistinguishable from a missing one by design: RLS
  // filters it out, and the UI must not confirm that it exists.
  if (header === null) {
    return {
      ...empty,
      available: true,
      reason: 'Ärendet finns inte eller är inte tillgängligt för dig.',
    };
  }

  const [
    documents,
    deadlines,
    history,
    workflowInstance,
    memberships,
    teams,
    partyRelations,
    propertyLinks,
  ] = await Promise.all([
    session.client
      .schema('documents')
      .from('documents')
      .select(
        'id, title, description, document_type, information_class, secrecy_level, current_version',
      )
      .eq('case_id', caseId)
      .order('created_at', { ascending: false })
      .limit(50),
    session.client
      .schema('workflow')
      .from('deadlines')
      .select('id, name, due_at, status')
      .eq('case_id', caseId)
      .order('due_at', { ascending: true }),
    session.client
      .schema('core')
      .from('case_status_history')
      .select('id, to_status, changed_at')
      .eq('case_id', caseId)
      .order('changed_at', { ascending: false })
      .limit(20),
    session.client
      .schema('workflow')
      .from('workflow_instances')
      .select('id, current_state, status, template_version_id, started_at')
      .eq('case_id', caseId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        current_state: string;
        status: string;
        template_version_id: string;
        started_at: string;
      }>(),
    session.client
      .schema('identity')
      .from('user_memberships')
      .select('user_id')
      .eq('authority_id', header.authority_id),
    session.client
      .schema('organization')
      .from('teams')
      .select('id, name')
      .eq('authority_id', header.authority_id)
      .eq('is_active', true)
      .order('name', { ascending: true }),
    session.client
      .schema('core')
      .from('case_parties')
      .select('id, party_id, relationship, identity_user_id, verified_at')
      .eq('case_id', caseId)
      .order('created_at', { ascending: true }),
    session.client
      .schema('core')
      .from('case_properties')
      .select('property_id, is_primary')
      .eq('case_id', caseId)
      .order('is_primary', { ascending: false }),
  ]);

  const userIds = Array.from(
    new Set(
      (memberships.data ?? [])
        .map((membership) => String((membership as { user_id: string }).user_id))
        .filter(Boolean),
    ),
  );

  const assignees =
    userIds.length === 0
      ? []
      : ((
          await session.client
            .schema('identity')
            .from('users')
            .select('id, display_name')
            .in('id', userIds)
            .eq('status', 'ACTIVE')
            .order('display_name', { ascending: true })
        ).data ?? []);

  const relationRows = (partyRelations.data ?? []) as CasePartyRelationRow[];
  const partyIds = Array.from(new Set(relationRows.map((relation) => relation.party_id)));
  const partyRows =
    partyIds.length === 0
      ? []
      : (((
          await session.client
            .schema('core')
            .from('parties')
            .select(
              'id, party_type, display_name, organization_number, person_reference, contact_email, contact_phone',
            )
            .in('id', partyIds)
            .order('display_name', { ascending: true })
        ).data ?? []) as PartyRow[]);

  const partyById = new Map(partyRows.map((party) => [party.id, party] as const));
  const parties: CaseParty[] = relationRows.flatMap((relation) => {
    const party = partyById.get(relation.party_id);
    if (party === undefined) return [];
    return [
      {
        relation_id: relation.id,
        party_id: party.id,
        party_type: party.party_type,
        display_name: party.display_name,
        relationship: relation.relationship,
        organization_number: party.organization_number,
        person_reference: party.person_reference,
        contact_email: party.contact_email,
        contact_phone: party.contact_phone,
        identity_link_verified: relation.identity_user_id !== null && relation.verified_at !== null,
      },
    ];
  });

  const propertyLinkRows = (propertyLinks.data ?? []) as CasePropertyLinkRow[];
  const linkedPropertyIds = propertyLinkRows.map((link) => link.property_id);
  const [linkedPropertiesResult, identifiersResult, addressesResult, buildingsResult] =
    linkedPropertyIds.length === 0
      ? [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]
      : await Promise.all([
          session.client
            .schema('property')
            .from('properties')
            .select('id, designation, municipality_code, source, source_version')
            .in('id', linkedPropertyIds),
          session.client
            .schema('property')
            .from('property_identifiers')
            .select('id, property_id, identifier_type, value, source')
            .in('property_id', linkedPropertyIds)
            .eq('is_current', true)
            .order('identifier_type', { ascending: true }),
          session.client
            .schema('property')
            .from('addresses')
            .select(
              'id, property_id, street_name, street_number, letter, postal_code, postal_town, source',
            )
            .in('property_id', linkedPropertyIds)
            .order('street_name', { ascending: true }),
          session.client
            .schema('property')
            .from('buildings')
            .select(
              'id, property_id, building_designation, building_purpose, year_built, gross_floor_area, floors, source',
            )
            .in('property_id', linkedPropertyIds)
            .order('building_designation', { ascending: true }),
        ]);

  const linkedPropertyById = new Map(
    ((linkedPropertiesResult.data ?? []) as PropertyRow[]).map((property) => [
      property.id,
      property,
    ]),
  );
  const identifiers = (identifiersResult.data ?? []) as Array<
    CaseProperty['identifiers'][number] & {
      property_id: string;
    }
  >;
  const addresses = (addressesResult.data ?? []) as Array<
    CaseProperty['addresses'][number] & {
      property_id: string;
    }
  >;
  const buildings = (buildingsResult.data ?? []) as Array<
    CaseProperty['buildings'][number] & {
      property_id: string;
    }
  >;

  const properties: CaseProperty[] = propertyLinkRows.flatMap((link) => {
    const property = linkedPropertyById.get(link.property_id);
    if (property === undefined) return [];

    return [
      {
        property_id: property.id,
        designation: property.designation,
        municipality_code: property.municipality_code,
        source: property.source,
        source_version: property.source_version,
        is_primary: link.is_primary,
        identifiers: identifiers
          .filter((identifier) => identifier.property_id === property.id)
          .map((identifier) => ({
            id: identifier.id,
            identifier_type: identifier.identifier_type,
            value: identifier.value,
            source: identifier.source,
          })),
        addresses: addresses
          .filter((address) => address.property_id === property.id)
          .map((address) => ({
            id: address.id,
            street_name: address.street_name,
            street_number: address.street_number,
            letter: address.letter,
            postal_code: address.postal_code,
            postal_town: address.postal_town,
            source: address.source,
          })),
        buildings: buildings
          .filter((building) => building.property_id === property.id)
          .map((building) => ({
            id: building.id,
            building_designation: building.building_designation,
            building_purpose: building.building_purpose,
            year_built: building.year_built,
            gross_floor_area: building.gross_floor_area,
            floors: building.floors,
            source: building.source,
          })),
      },
    ];
  });

  const documentRows = (documents.data ?? []) as CaseDocumentRow[];
  const documentIds = documentRows.map((document) => document.id);
  const versionRows =
    documentIds.length === 0
      ? []
      : ((
          await session.client
            .schema('documents')
            .from('document_versions')
            .select(
              'id, document_id, version, sha256, mime_type, detected_mime_type, size_bytes, original_filename, ingestion_status, rejection_reason, scanner_provider, scanner_version, signature_version, scan_started_at, scanned_at, scan_result, threat_name, upload_confirmed_at, processing_enqueued_at, created_at',
            )
            .in('document_id', documentIds)
            .order('version', { ascending: false })
        ).data ?? []);

  const documentsWithVersions: CaseDocument[] = documentRows.map((document) => ({
    ...document,
    versions: versionRows
      .filter((version) => (version as { document_id: string }).document_id === document.id)
      .map((version) => {
        const row = version as CaseDocumentVersion & { document_id: string };
        return {
          id: row.id,
          version: row.version,
          sha256: row.sha256,
          mime_type: row.mime_type,
          detected_mime_type: row.detected_mime_type,
          size_bytes: Number(row.size_bytes),
          original_filename: row.original_filename,
          ingestion_status: row.ingestion_status,
          rejection_reason: row.rejection_reason,
          scanner_provider: row.scanner_provider,
          scanner_version: row.scanner_version,
          signature_version: row.signature_version,
          scan_started_at: row.scan_started_at,
          scanned_at: row.scanned_at,
          scan_result: row.scan_result,
          threat_name: row.threat_name,
          upload_confirmed_at: row.upload_confirmed_at,
          processing_enqueued_at: row.processing_enqueued_at,
          created_at: row.created_at,
        };
      }),
  }));

  let workflow: CaseWorkflow | null = null;

  if (workflowInstance.data !== null) {
    const instance = workflowInstance.data;
    const [version, tasks, transitions] = await Promise.all([
      session.client
        .schema('workflow')
        .from('workflow_template_versions')
        .select('definition')
        .eq('id', instance.template_version_id)
        .maybeSingle<{ definition: unknown }>(),
      session.client
        .schema('workflow')
        .from('workflow_tasks')
        .select('id, title, status, due_at')
        .eq('instance_id', instance.id)
        .in('status', ['OPEN', 'IN_PROGRESS', 'BLOCKED'])
        .order('created_at', { ascending: true }),
      session.client
        .schema('workflow')
        .from('workflow_transitions')
        .select('id, from_state, to_state, occurred_at, reason')
        .eq('instance_id', instance.id)
        .order('occurred_at', { ascending: false })
        .limit(20),
    ]);

    workflow = {
      id: instance.id,
      currentState: instance.current_state,
      status: instance.status,
      availableTransitions:
        instance.status === 'RUNNING'
          ? transitionTargets(version.data?.definition, instance.current_state)
          : [],
      tasks: (tasks.data ?? []) as CaseWorkflow['tasks'],
      transitions: (transitions.data ?? []) as CaseWorkflow['transitions'],
    };
  }

  return {
    available: true,
    header,
    documents: documentsWithVersions,
    deadlines: (deadlines.data ?? []) as CaseWorkspace['deadlines'],
    history: (history.data ?? []) as CaseWorkspace['history'],
    workflow,
    assignees: assignees as StaffOption[],
    teams: (teams.data ?? []) as TeamOption[],
    parties,
    properties,
  };
}

export interface CompletenessProfile {
  readonly versionId: string;
  readonly ruleSetId: string;
  readonly key: string;
  readonly name: string;
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface CompletenessEvidence {
  readonly rule_id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly value: string | null;
  readonly result: 'PASS' | 'FAIL' | 'HUMAN_REVIEW';
  readonly matched_count: number;
  readonly legal_reference: string | null;
  readonly sources: readonly {
    source_type: string;
    reference: string;
    url: string | null;
  }[];
}

export interface CaseCompleteness {
  readonly profiles: readonly CompletenessProfile[];
  readonly current: {
    id: string;
    ruleSetVersionId: string;
    result: 'COMPLETE' | 'INCOMPLETE' | 'HUMAN_REVIEW';
    evidence: readonly CompletenessEvidence[];
    missingItems: readonly {
      rule_id: string;
      key: string;
      label: string;
      reason: string;
    }[];
    evaluatedAt: string;
    review: {
      decision: 'COMPLETE' | 'INCOMPLETE';
      note: string;
      reviewedAt: string;
    } | null;
  } | null;
}

function asArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry),
      )
    : [];
}

export async function loadCaseCompleteness(
  context: TenantContext,
  caseId: string,
  authorityId: string,
): Promise<CaseCompleteness> {
  const session = await tenantClient(context);
  if (!session.authenticated) return { profiles: [], current: null };

  const today = new Date().toISOString().slice(0, 10);
  const ruleSets = await session.client
    .schema('rules')
    .from('rule_sets')
    .select('id, key, name, authority_id')
    .eq('domain', 'COMPLETENESS')
    .or(`authority_id.is.null,authority_id.eq.${authorityId}`)
    .order('name', { ascending: true });

  const ruleSetRows = (ruleSets.data ?? []) as Array<{
    id: string;
    key: string;
    name: string;
    authority_id: string | null;
  }>;
  const ruleSetIds = ruleSetRows.map((row) => row.id);

  const versions =
    ruleSetIds.length === 0
      ? []
      : ((
          await session.client
            .schema('rules')
            .from('rule_set_versions')
            .select('id, rule_set_id, version, valid_from, valid_to, published_at')
            .in('rule_set_id', ruleSetIds)
            .not('published_at', 'is', null)
            .lte('valid_from', today)
            .or(`valid_to.is.null,valid_to.gt.${today}`)
            .order('version', { ascending: false })
        ).data ?? []);

  const setById = new Map(ruleSetRows.map((row) => [row.id, row] as const));
  const profiles: CompletenessProfile[] = versions.flatMap((version) => {
    const row = version as {
      id: string;
      rule_set_id: string;
      version: number;
      valid_from: string;
      valid_to: string | null;
    };
    const set = setById.get(row.rule_set_id);
    if (set === undefined) return [];
    return [
      {
        versionId: row.id,
        ruleSetId: set.id,
        key: set.key,
        name: set.name,
        version: row.version,
        validFrom: row.valid_from,
        validTo: row.valid_to,
      },
    ];
  });

  const assessment = await session.client
    .schema('rules')
    .from('completeness_assessments')
    .select('id, rule_set_version_id, result, evidence, missing_items, evaluated_at')
    .eq('case_id', caseId)
    .is('superseded_at', null)
    .order('evaluated_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string;
      rule_set_version_id: string;
      result: 'COMPLETE' | 'INCOMPLETE' | 'HUMAN_REVIEW';
      evidence: unknown;
      missing_items: unknown;
      evaluated_at: string;
    }>();

  if (assessment.data === null) return { profiles, current: null };

  const review = await session.client
    .schema('rules')
    .from('completeness_reviews')
    .select('decision, note, reviewed_at')
    .eq('assessment_id', assessment.data.id)
    .maybeSingle<{
      decision: 'COMPLETE' | 'INCOMPLETE';
      note: string;
      reviewed_at: string;
    }>();

  const evidence = asArray(assessment.data.evidence).map((entry) => ({
    rule_id: String(entry['rule_id'] ?? ''),
    key: String(entry['key'] ?? ''),
    name: String(entry['name'] ?? ''),
    kind: String(entry['kind'] ?? ''),
    value: entry['value'] === null || entry['value'] === undefined ? null : String(entry['value']),
    result:
      entry['result'] === 'PASS' || entry['result'] === 'FAIL' ? entry['result'] : 'HUMAN_REVIEW',
    matched_count: Number(entry['matched_count'] ?? 0),
    legal_reference:
      entry['legal_reference'] === null || entry['legal_reference'] === undefined
        ? null
        : String(entry['legal_reference']),
    sources: asArray(entry['sources']).map((source) => ({
      source_type: String(source['source_type'] ?? ''),
      reference: String(source['reference'] ?? ''),
      url: source['url'] === null || source['url'] === undefined ? null : String(source['url']),
    })),
  })) satisfies CompletenessEvidence[];

  const missingItems = asArray(assessment.data.missing_items).map((entry) => ({
    rule_id: String(entry['rule_id'] ?? ''),
    key: String(entry['key'] ?? ''),
    label: String(entry['label'] ?? ''),
    reason: String(entry['reason'] ?? ''),
  }));

  return {
    profiles,
    current: {
      id: assessment.data.id,
      ruleSetVersionId: assessment.data.rule_set_version_id,
      result: assessment.data.result,
      evidence,
      missingItems,
      evaluatedAt: assessment.data.evaluated_at,
      review:
        review.data === null
          ? null
          : {
              decision: review.data.decision,
              note: review.data.note,
              reviewedAt: review.data.reviewed_at,
            },
    },
  };
}

export interface CaseCreationOptions {
  readonly available: boolean;
  readonly reason?: string;
  readonly authorities: readonly { id: string; name: string }[];
  readonly departments: readonly { id: string; authority_id: string; name: string }[];
  readonly workflows: readonly {
    authority_id: string;
    key: string;
    name: string;
    process_type: string;
  }[];
}

export async function loadCaseCreationOptions(
  context: TenantContext,
): Promise<CaseCreationOptions> {
  const empty: CaseCreationOptions = {
    available: false,
    authorities: [],
    departments: [],
    workflows: [],
  };

  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { ...empty, reason: error.message };
    }
    throw error;
  }

  if (!session.authenticated) {
    return { ...empty, reason: 'Ingen inloggad session på den här värden.' };
  }

  const [authorities, departments, templates, versions] = await Promise.all([
    session.client
      .schema('organization')
      .from('authorities')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
    session.client
      .schema('organization')
      .from('departments')
      .select('id, authority_id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
    session.client
      .schema('workflow')
      .from('workflow_templates')
      .select('id, authority_id, key, name, process_type')
      .order('name', { ascending: true }),
    session.client
      .schema('workflow')
      .from('workflow_template_versions')
      .select('template_id, valid_from, valid_to, published_at'),
  ]);

  const now = Date.now();
  const activeTemplateIds = new Set(
    (versions.data ?? [])
      .filter((row) => {
        const version = row as {
          template_id: string;
          valid_from: string;
          valid_to: string | null;
          published_at: string | null;
        };
        return (
          version.published_at !== null &&
          Date.parse(version.valid_from) <= now &&
          (version.valid_to === null || Date.parse(version.valid_to) > now)
        );
      })
      .map((row) => String((row as { template_id: string }).template_id)),
  );

  return {
    available: true,
    authorities: (authorities.data ?? []) as CaseCreationOptions['authorities'],
    departments: (departments.data ?? []) as CaseCreationOptions['departments'],
    workflows: (templates.data ?? [])
      .filter((template) => activeTemplateIds.has(String((template as { id: string }).id)))
      .map((template) => {
        const row = template as {
          authority_id: string;
          key: string;
          name: string;
          process_type: string;
        };
        return {
          authority_id: row.authority_id,
          key: row.key,
          name: row.name,
          process_type: row.process_type,
        };
      }),
  };
}

function normalizePropertySearch(value: string): string {
  return value
    .trim()
    .replace(/[%_*,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

/**
 * G3 property lookup. The case is resolved through RLS first; candidates are
 * then restricted to the same authority. No search result can cross a tenant
 * or authority boundary.
 */
export async function searchPropertyCandidates(
  context: TenantContext,
  caseId: string,
  query: string,
): Promise<readonly PropertyCandidate[]> {
  const normalized = normalizePropertySearch(query);
  if (normalized.length < 2) return [];

  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) return [];
    throw error;
  }
  if (!session.authenticated) return [];

  const { data: caseRow } = await session.client
    .schema('core')
    .from('cases')
    .select('id, authority_id')
    .eq('id', caseId)
    .maybeSingle<{ id: string; authority_id: string }>();

  if (caseRow === null) return [];

  const term = `%${normalized}%`;
  const [designationMatches, identifierMatches, addressMatches] = await Promise.all([
    session.client
      .schema('property')
      .from('properties')
      .select('id')
      .eq('authority_id', caseRow.authority_id)
      .ilike('designation', term)
      .limit(20),
    session.client
      .schema('property')
      .from('property_identifiers')
      .select('property_id')
      .eq('authority_id', caseRow.authority_id)
      .ilike('value', term)
      .limit(20),
    session.client
      .schema('property')
      .from('addresses')
      .select('property_id')
      .eq('authority_id', caseRow.authority_id)
      .ilike('street_name', term)
      .limit(20),
  ]);

  const ids = Array.from(
    new Set([
      ...(designationMatches.data ?? []).map((row) => String((row as { id: string }).id)),
      ...(identifierMatches.data ?? []).map((row) =>
        String((row as { property_id: string }).property_id),
      ),
      ...(addressMatches.data ?? [])
        .map((row) => (row as { property_id: string | null }).property_id)
        .filter((id): id is string => typeof id === 'string'),
    ]),
  ).slice(0, 30);

  if (ids.length === 0) return [];

  const [propertyRows, addressRows] = await Promise.all([
    session.client
      .schema('property')
      .from('properties')
      .select('id, designation, municipality_code, source')
      .eq('authority_id', caseRow.authority_id)
      .in('id', ids)
      .order('designation', { ascending: true }),
    session.client
      .schema('property')
      .from('addresses')
      .select('property_id, street_name, street_number, letter, postal_code, postal_town')
      .eq('authority_id', caseRow.authority_id)
      .in('property_id', ids)
      .order('street_name', { ascending: true }),
  ]);

  const firstAddress = new Map<string, string>();
  for (const row of addressRows.data ?? []) {
    const address = row as {
      property_id: string | null;
      street_name: string;
      street_number: string | null;
      letter: string | null;
      postal_code: string | null;
      postal_town: string | null;
    };
    if (address.property_id === null || firstAddress.has(address.property_id)) continue;
    firstAddress.set(
      address.property_id,
      [
        address.street_name,
        `${address.street_number ?? ''}${address.letter ?? ''}`.trim(),
        address.postal_code,
        address.postal_town,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  return (propertyRows.data ?? []).map((row) => {
    const property = row as {
      id: string;
      designation: string;
      municipality_code: string | null;
      source: string;
    };
    return {
      ...property,
      address: firstAddress.get(property.id) ?? null,
    };
  });
}
