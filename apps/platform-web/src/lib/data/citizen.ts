import 'server-only';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from './client';

export interface CitizenCaseListRow {
  readonly id: string;
  readonly caseNumber: string;
  readonly title: string;
  readonly processType: string;
  readonly status: string;
  readonly phase: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

export interface CitizenCaseList {
  readonly available: boolean;
  readonly reason?: string;
  readonly rows: readonly CitizenCaseListRow[];
}

export interface CitizenApplicationProfile {
  readonly id: string;
  readonly processType: string;
  readonly displayName: string;
  readonly description: string | null;
}

export interface CitizenCaseDocumentVersion {
  readonly id: string;
  readonly version: number;
  readonly ingestionStatus: string;
  readonly originalFilename: string | null;
  readonly createdAt: string;
}

export interface CitizenCaseDocument {
  readonly id: string;
  readonly documentType: string;
  readonly title: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly portalVisible: boolean;
  readonly versions: readonly CitizenCaseDocumentVersion[];
}

export interface CitizenCaseMessage {
  readonly id: string;
  readonly direction: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly createdAt: string;
}

export interface CitizenCaseDecision {
  readonly id: string;
  readonly decisionType: string;
  readonly decisionNumber: string | null;
  readonly status: string;
  readonly decidedAt: string | null;
  readonly appealDeadlineAt: string | null;
  readonly body: string | null;
  readonly conditions: unknown;
  readonly legalReferences: unknown;
}

export interface CitizenCaseDetail {
  readonly available: boolean;
  readonly reason?: string;
  readonly header: CitizenCaseListRow | null;
  readonly relationship: string | null;
  readonly history: readonly {
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly fromPhase: string | null;
    readonly toPhase: string;
    readonly changedAt: string;
  }[];
  readonly documents: readonly CitizenCaseDocument[];
  readonly messages: readonly CitizenCaseMessage[];
  readonly decisions: readonly CitizenCaseDecision[];
}

async function authenticatedClient(context: TenantContext) {
  const session = await tenantClient(context);
  return session.authenticated ? session.client : null;
}

export async function loadCitizenCases(context: TenantContext): Promise<CitizenCaseList> {
  let client;
  try {
    client = await authenticatedClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { available: false, reason: error.message, rows: [] };
    }
    throw error;
  }

  if (client === null) {
    return {
      available: false,
      reason: 'Ingen aktiv Mina sidor-session.',
      rows: [],
    };
  }

  const result = await client
    .schema('core')
    .from('cases')
    .select(
      'id, case_number, title, process_type, status, phase, created_at, updated_at, decided_at',
    )
    .order('updated_at', { ascending: false })
    .limit(200);

  if (result.error !== null) {
    return {
      available: false,
      reason: 'Dina ärenden kunde inte hämtas.',
      rows: [],
    };
  }

  return {
    available: true,
    rows: (
      (result.data ?? []) as Array<{
        id: string;
        case_number: string;
        title: string;
        process_type: string;
        status: string;
        phase: string;
        created_at: string;
        updated_at: string;
        decided_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      caseNumber: row.case_number,
      title: row.title,
      processType: row.process_type,
      status: row.status,
      phase: row.phase,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at,
    })),
  };
}

export async function loadCitizenApplicationProfiles(
  context: TenantContext,
): Promise<readonly CitizenApplicationProfile[]> {
  const client = await authenticatedClient(context);
  if (client === null) return [];

  const result = await client
    .schema('config')
    .from('citizen_application_profiles')
    .select('id, process_type, display_name, description')
    .eq('enabled', true)
    .order('display_name', { ascending: true });

  if (result.error !== null) return [];

  return (
    (result.data ?? []) as Array<{
      id: string;
      process_type: string;
      display_name: string;
      description: string | null;
    }>
  ).map((row) => ({
    id: row.id,
    processType: row.process_type,
    displayName: row.display_name,
    description: row.description,
  }));
}

export async function loadCitizenCaseDetail(
  context: TenantContext,
  caseId: string,
): Promise<CitizenCaseDetail> {
  const empty: CitizenCaseDetail = {
    available: false,
    header: null,
    relationship: null,
    history: [],
    documents: [],
    messages: [],
    decisions: [],
  };

  const client = await authenticatedClient(context);
  if (client === null) return { ...empty, reason: 'Ingen aktiv Mina sidor-session.' };

  const caseResult = await client
    .schema('core')
    .from('cases')
    .select(
      'id, case_number, title, process_type, status, phase, created_at, updated_at, decided_at',
    )
    .eq('id', caseId)
    .maybeSingle<{
      id: string;
      case_number: string;
      title: string;
      process_type: string;
      status: string;
      phase: string;
      created_at: string;
      updated_at: string;
      decided_at: string | null;
    }>();

  if (caseResult.error !== null || caseResult.data === null) {
    return { ...empty, reason: 'Ärendet är inte tillgängligt.' };
  }

  const [partyResult, historyResult, documentsResult, messagesResult, decisionsResult] =
    await Promise.all([
      client
        .schema('core')
        .from('case_parties')
        .select('relationship')
        .eq('case_id', caseId)
        .not('verified_at', 'is', null)
        .limit(1)
        .maybeSingle<{ relationship: string }>(),
      client
        .schema('core')
        .from('case_status_history')
        .select('from_status, to_status, from_phase, to_phase, changed_at')
        .eq('case_id', caseId)
        .order('changed_at', { ascending: true }),
      client
        .schema('documents')
        .from('documents')
        .select('id, document_type, title, description, created_at, portal_visible')
        .eq('case_id', caseId)
        .order('created_at', { ascending: false }),
      client
        .schema('communication')
        .from('messages')
        .select('id, direction, subject, body, created_at')
        .eq('case_id', caseId)
        .order('created_at', { ascending: false }),
      client
        .schema('decision')
        .from('decisions')
        .select(
          'id, decision_type, decision_number, status, current_version, decided_at, appeal_deadline_at',
        )
        .eq('case_id', caseId)
        .order('decided_at', { ascending: false }),
    ]);

  const documentRows = (documentsResult.data ?? []) as Array<{
    id: string;
    document_type: string;
    title: string;
    description: string | null;
    created_at: string;
    portal_visible: boolean;
  }>;
  const documentIds = documentRows.map((row) => row.id);
  const versionsResult =
    documentIds.length === 0
      ? { data: [] }
      : await client
          .schema('documents')
          .from('document_versions')
          .select('id, document_id, version, ingestion_status, original_filename, created_at')
          .in('document_id', documentIds)
          .order('version', { ascending: false });

  const decisionRows = (decisionsResult.data ?? []) as Array<{
    id: string;
    decision_type: string;
    decision_number: string | null;
    status: string;
    current_version: number;
    decided_at: string | null;
    appeal_deadline_at: string | null;
  }>;
  const decisionIds = decisionRows.map((row) => row.id);
  const decisionVersionsResult =
    decisionIds.length === 0
      ? { data: [] }
      : await client
          .schema('decision')
          .from('decision_versions')
          .select('decision_id, version, body, conditions, legal_references')
          .in('decision_id', decisionIds)
          .order('version', { ascending: false });

  const versionRows = (versionsResult.data ?? []) as Array<{
    id: string;
    document_id: string;
    version: number;
    ingestion_status: string;
    original_filename: string | null;
    created_at: string;
  }>;
  const decisionVersionRows = (decisionVersionsResult.data ?? []) as Array<{
    decision_id: string;
    version: number;
    body: string;
    conditions: unknown;
    legal_references: unknown;
  }>;

  const header = caseResult.data;
  return {
    available: true,
    header: {
      id: header.id,
      caseNumber: header.case_number,
      title: header.title,
      processType: header.process_type,
      status: header.status,
      phase: header.phase,
      createdAt: header.created_at,
      updatedAt: header.updated_at,
      decidedAt: header.decided_at,
    },
    relationship: partyResult.data?.relationship ?? null,
    history: (
      (historyResult.data ?? []) as Array<{
        from_status: string | null;
        to_status: string;
        from_phase: string | null;
        to_phase: string;
        changed_at: string;
      }>
    ).map((row) => ({
      fromStatus: row.from_status,
      toStatus: row.to_status,
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      changedAt: row.changed_at,
    })),
    documents: documentRows.map((document) => ({
      id: document.id,
      documentType: document.document_type,
      title: document.title,
      description: document.description,
      createdAt: document.created_at,
      portalVisible: document.portal_visible,
      versions: versionRows
        .filter((version) => version.document_id === document.id)
        .map((version) => ({
          id: version.id,
          version: version.version,
          ingestionStatus: version.ingestion_status,
          originalFilename: version.original_filename,
          createdAt: version.created_at,
        })),
    })),
    messages: (
      (messagesResult.data ?? []) as Array<{
        id: string;
        direction: string;
        subject: string | null;
        body: string | null;
        created_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      direction: row.direction,
      subject: row.subject,
      body: row.body,
      createdAt: row.created_at,
    })),
    decisions: decisionRows.map((decision) => {
      const version = decisionVersionRows.find(
        (candidate) =>
          candidate.decision_id === decision.id && candidate.version === decision.current_version,
      );
      return {
        id: decision.id,
        decisionType: decision.decision_type,
        decisionNumber: decision.decision_number,
        status: decision.status,
        decidedAt: decision.decided_at,
        appealDeadlineAt: decision.appeal_deadline_at,
        body: version?.body ?? null,
        conditions: version?.conditions ?? [],
        legalReferences: version?.legal_references ?? [],
      };
    }),
  };
}
