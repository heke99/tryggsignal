import 'server-only';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from './client';

export interface SupervisionRiskAssessment {
  readonly id: string;
  readonly score: number;
  readonly level: string;
  readonly reasons: unknown;
  readonly assessedBy: string;
  readonly assessedAt: string;
}

export interface SupervisionInspection {
  readonly id: string;
  readonly scheduledAt: string | null;
  readonly performedAt: string | null;
  readonly performedBy: string | null;
  readonly status: string;
  readonly result: string | null;
  readonly notes: string | null;
}

export interface SupervisionFinding {
  readonly id: string;
  readonly inspectionId: string | null;
  readonly severity: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly dueAt: string | null;
  readonly resolvedAt: string | null;
  readonly evidence: readonly {
    id: string;
    documentId: string | null;
    documentVersionId: string | null;
    note: string | null;
    capturedAt: string;
  }[];
}

export interface SupervisionAction {
  readonly id: string;
  readonly actionType: string;
  readonly description: string;
  readonly legalReference: string | null;
  readonly decisionId: string | null;
  readonly status: string;
  readonly dueAt: string | null;
  readonly completedAt: string | null;
  readonly outcome: string | null;
}

export interface SupervisionFollowup {
  readonly id: string;
  readonly actionId: string | null;
  readonly dueAt: string;
  readonly status: string;
  readonly note: string | null;
  readonly outcome: string | null;
  readonly completedAt: string | null;
}

export interface CaseSupervision {
  readonly id: string;
  readonly sourceType: string;
  readonly allegation: string | null;
  readonly status: string;
  readonly riskScore: number;
  readonly riskLevel: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closeReason: string | null;
  readonly riskHistory: readonly SupervisionRiskAssessment[];
  readonly inspections: readonly SupervisionInspection[];
  readonly findings: readonly SupervisionFinding[];
  readonly actions: readonly SupervisionAction[];
  readonly followups: readonly SupervisionFollowup[];
}

export async function loadCaseSupervision(
  context: TenantContext,
  caseId: string,
): Promise<CaseSupervision | null> {
  const session = await tenantClient(context);
  if (!session.authenticated) return null;

  const current = await session.client
    .schema('supervision')
    .from('cases')
    .select(
      'id, source_type, allegation, status, risk_score, risk_level, opened_at, closed_at, close_reason',
    )
    .eq('case_id', caseId)
    .maybeSingle<{
      id: string;
      source_type: string;
      allegation: string | null;
      status: string;
      risk_score: number;
      risk_level: string;
      opened_at: string;
      closed_at: string | null;
      close_reason: string | null;
    }>();

  if (current.data === null) return null;
  const supervision = current.data;

  const [riskResult, inspectionsResult, findingsResult, actionsResult, followupsResult] =
    await Promise.all([
      session.client
        .schema('supervision')
        .from('risk_assessments')
        .select('id, score, level, reasons, assessed_by, assessed_at')
        .eq('supervision_id', supervision.id)
        .order('assessed_at', { ascending: false }),
      session.client
        .schema('inspection')
        .from('inspections')
        .select('id, scheduled_at, performed_at, performed_by, status, result, notes')
        .eq('case_id', caseId)
        .eq('inspection_type', 'PBL_TILLSYN')
        .order('created_at', { ascending: false }),
      session.client
        .schema('inspection')
        .from('findings')
        .select(
          'id, inspection_id, severity, title, description, status, due_at, resolved_at, created_at',
        )
        .eq('case_id', caseId)
        .order('created_at', { ascending: false }),
      session.client
        .schema('supervision')
        .from('actions')
        .select(
          'id, action_type, description, legal_reference, decision_id, status, due_at, completed_at, outcome, created_at',
        )
        .eq('supervision_id', supervision.id)
        .order('created_at', { ascending: false }),
      session.client
        .schema('supervision')
        .from('followups')
        .select('id, action_id, due_at, status, note, outcome, completed_at, created_at')
        .eq('supervision_id', supervision.id)
        .order('due_at', { ascending: true }),
    ]);

  const findingRows = (findingsResult.data ?? []) as Array<{
    id: string;
    inspection_id: string | null;
    severity: string;
    title: string;
    description: string | null;
    status: string;
    due_at: string | null;
    resolved_at: string | null;
    created_at: string;
  }>;
  const findingIds = findingRows.map((finding) => finding.id);
  const evidenceRows =
    findingIds.length === 0
      ? []
      : ((
          await session.client
            .schema('inspection')
            .from('finding_evidence')
            .select('id, finding_id, document_id, document_version_id, note, captured_at')
            .in('finding_id', findingIds)
            .order('captured_at', { ascending: false })
        ).data ?? []);

  return {
    id: supervision.id,
    sourceType: supervision.source_type,
    allegation: supervision.allegation,
    status: supervision.status,
    riskScore: Number(supervision.risk_score),
    riskLevel: supervision.risk_level,
    openedAt: supervision.opened_at,
    closedAt: supervision.closed_at,
    closeReason: supervision.close_reason,
    riskHistory: (riskResult.data ?? []).map((row) => {
      const risk = row as {
        id: string;
        score: number;
        level: string;
        reasons: unknown;
        assessed_by: string;
        assessed_at: string;
      };
      return {
        id: risk.id,
        score: Number(risk.score),
        level: risk.level,
        reasons: risk.reasons,
        assessedBy: risk.assessed_by,
        assessedAt: risk.assessed_at,
      };
    }),
    inspections: (inspectionsResult.data ?? []).map((row) => {
      const inspection = row as {
        id: string;
        scheduled_at: string | null;
        performed_at: string | null;
        performed_by: string | null;
        status: string;
        result: string | null;
        notes: string | null;
      };
      return {
        id: inspection.id,
        scheduledAt: inspection.scheduled_at,
        performedAt: inspection.performed_at,
        performedBy: inspection.performed_by,
        status: inspection.status,
        result: inspection.result,
        notes: inspection.notes,
      };
    }),
    findings: findingRows.map((finding) => ({
      id: finding.id,
      inspectionId: finding.inspection_id,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      status: finding.status,
      dueAt: finding.due_at,
      resolvedAt: finding.resolved_at,
      evidence: evidenceRows
        .filter((row) => (row as { finding_id: string }).finding_id === finding.id)
        .map((row) => {
          const evidence = row as {
            id: string;
            document_id: string | null;
            document_version_id: string | null;
            note: string | null;
            captured_at: string;
          };
          return {
            id: evidence.id,
            documentId: evidence.document_id,
            documentVersionId: evidence.document_version_id,
            note: evidence.note,
            capturedAt: evidence.captured_at,
          };
        }),
    })),
    actions: (actionsResult.data ?? []).map((row) => {
      const action = row as {
        id: string;
        action_type: string;
        description: string;
        legal_reference: string | null;
        decision_id: string | null;
        status: string;
        due_at: string | null;
        completed_at: string | null;
        outcome: string | null;
      };
      return {
        id: action.id,
        actionType: action.action_type,
        description: action.description,
        legalReference: action.legal_reference,
        decisionId: action.decision_id,
        status: action.status,
        dueAt: action.due_at,
        completedAt: action.completed_at,
        outcome: action.outcome,
      };
    }),
    followups: (followupsResult.data ?? []).map((row) => {
      const followup = row as {
        id: string;
        action_id: string | null;
        due_at: string;
        status: string;
        note: string | null;
        outcome: string | null;
        completed_at: string | null;
      };
      return {
        id: followup.id,
        actionId: followup.action_id,
        dueAt: followup.due_at,
        status: followup.status,
        note: followup.note,
        outcome: followup.outcome,
        completedAt: followup.completed_at,
      };
    }),
  };
}

export interface SupervisionQueueRow {
  readonly supervisionId: string;
  readonly caseId: string;
  readonly caseNumber: string;
  readonly title: string;
  readonly status: string;
  readonly riskScore: number;
  readonly riskLevel: string;
  readonly openedAt: string;
}

export interface SupervisionQueue {
  readonly available: boolean;
  readonly reason?: string;
  readonly rows: readonly SupervisionQueueRow[];
}

export async function loadSupervisionQueue(context: TenantContext): Promise<SupervisionQueue> {
  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { available: false, reason: error.message, rows: [] };
    }
    throw error;
  }
  if (!session.authenticated) {
    return {
      available: false,
      reason: 'Ingen inloggad session på den här värden.',
      rows: [],
    };
  }

  const queueResult = await session.client
    .schema('supervision')
    .from('cases')
    .select('id, case_id, status, risk_score, risk_level, opened_at')
    .neq('status', 'CLOSED')
    .order('risk_score', { ascending: false })
    .order('opened_at', { ascending: true })
    .limit(100);

  const queueRows = (queueResult.data ?? []) as Array<{
    id: string;
    case_id: string;
    status: string;
    risk_score: number;
    risk_level: string;
    opened_at: string;
  }>;
  const caseIds = queueRows.map((row) => row.case_id);
  const cases =
    caseIds.length === 0
      ? []
      : ((
          await session.client
            .schema('core')
            .from('cases')
            .select('id, case_number, title')
            .in('id', caseIds)
        ).data ?? []);

  const caseById = new Map(
    (cases as Array<{ id: string; case_number: string; title: string }>).map(
      (caseRow) => [caseRow.id, caseRow] as const,
    ),
  );

  return {
    available: true,
    rows: queueRows.flatMap((row) => {
      const caseRow = caseById.get(row.case_id);
      if (caseRow === undefined) return [];
      return [
        {
          supervisionId: row.id,
          caseId: row.case_id,
          caseNumber: caseRow.case_number,
          title: caseRow.title,
          status: row.status,
          riskScore: Number(row.risk_score),
          riskLevel: row.risk_level,
          openedAt: row.opened_at,
        },
      ];
    }),
  };
}
