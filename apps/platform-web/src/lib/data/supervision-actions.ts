'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenant/context';
import { tenantClient } from '@/lib/data/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCES = new Set(['REPORT', 'OWN_INITIATIVE', 'INSPECTION', 'OTHER']);
const INSPECTION_RESULTS = new Set([
  'APPROVED',
  'APPROVED_WITH_REMARKS',
  'REJECTED',
  'NOT_APPLICABLE',
]);
const SEVERITIES = new Set(['INFO', 'REMARK', 'DEVIATION', 'SERIOUS']);
const ACTION_TYPES = new Set([
  'REQUEST_INFO',
  'INSPECTION',
  'COMMUNICATION',
  'ORDER',
  'PROHIBITION',
  'SANCTION_REVIEW',
  'OTHER',
]);

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function uuid(value: string): string | null {
  return UUID.test(value) ? value : null;
}

function casePath(caseId: string): string {
  return `/handlaggning/arenden/${caseId}`;
}

async function session() {
  const context = await currentTenant();
  const result = await tenantClient(context);
  if (!result.authenticated) redirect('/login?error=session');
  return result.client;
}

function validFuture(value: string): string | null {
  if (value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now()
    ? null
    : date.toISOString();
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export async function openSupervisionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const sourceType = field(formData, 'sourceType').toUpperCase();
  const allegation = field(formData, 'allegation');

  if (
    caseId === null ||
    !SOURCES.has(sourceType) ||
    allegation.length > 10_000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=supervision-open#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('open_for_user', {
    p_case_id: caseId,
    p_source_type: sourceType,
    p_allegation: allegation || null,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-open#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-opened#tillsyn`);
}

export async function assessSupervisionRiskAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const score = Number(field(formData, 'score'));
  const reasons = lines(field(formData, 'reasons')).map((reason) => ({ reason, source: 'HUMAN' }));

  if (
    caseId === null ||
    supervisionId === null ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100 ||
    reasons.some((item) => item.reason.length > 1000)
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('assess_risk_for_user', {
    p_supervision_id: supervisionId,
    p_score: score,
    p_reasons: reasons,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-risk#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-risk#tillsyn`);
}

export async function scheduleSupervisionInspectionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const scheduledAt = validFuture(field(formData, 'scheduledAt'));
  const propertyRaw = field(formData, 'propertyId');
  const buildingRaw = field(formData, 'buildingId');
  const propertyId = propertyRaw === '' ? null : uuid(propertyRaw);
  const buildingId = buildingRaw === '' ? null : uuid(buildingRaw);
  const notes = field(formData, 'notes');

  if (
    caseId === null ||
    supervisionId === null ||
    scheduledAt === null ||
    (propertyRaw !== '' && propertyId === null) ||
    (buildingRaw !== '' && buildingId === null) ||
    notes.length > 10_000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('schedule_inspection_for_user', {
    p_supervision_id: supervisionId,
    p_scheduled_at: scheduledAt,
    p_property_id: propertyId,
    p_building_id: buildingId,
    p_notes: notes || null,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-inspection#tillsyn`);

  revalidatePath(casePath(caseId));
  redirect(`${casePath(caseId)}?ok=supervision-inspection#tillsyn`);
}

export async function completeSupervisionInspectionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const inspectionId = uuid(field(formData, 'inspectionId'));
  const result = field(formData, 'result').toUpperCase();
  const notes = field(formData, 'notes');

  if (
    caseId === null ||
    inspectionId === null ||
    !INSPECTION_RESULTS.has(result) ||
    notes.length > 10_000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('complete_inspection_for_user', {
    p_inspection_id: inspectionId,
    p_result: result,
    p_notes: notes || null,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-inspection-complete#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-inspection-complete#tillsyn`);
}

export async function recordSupervisionFindingAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const inspectionRaw = field(formData, 'inspectionId');
  const inspectionId = inspectionRaw === '' ? null : uuid(inspectionRaw);
  const severity = field(formData, 'severity').toUpperCase();
  const title = field(formData, 'title');
  const description = field(formData, 'description');
  const dueRaw = field(formData, 'dueAt');
  const dueAt = dueRaw === '' ? null : validFuture(dueRaw);

  if (
    caseId === null ||
    supervisionId === null ||
    (inspectionRaw !== '' && inspectionId === null) ||
    !SEVERITIES.has(severity) ||
    title.length < 2 ||
    title.length > 300 ||
    description.length > 10_000 ||
    (dueRaw !== '' && dueAt === null)
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('record_finding_for_user', {
    p_supervision_id: supervisionId,
    p_inspection_id: inspectionId,
    p_severity: severity,
    p_title: title,
    p_description: description || null,
    p_rule_id: null,
    p_due_at: dueAt,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-finding#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-finding#tillsyn`);
}

export async function addSupervisionFindingEvidenceAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const findingId = uuid(field(formData, 'findingId'));
  const documentId = uuid(field(formData, 'documentId'));
  const documentVersionId = uuid(field(formData, 'documentVersionId'));
  const note = field(formData, 'note');

  if (
    caseId === null ||
    findingId === null ||
    documentId === null ||
    documentVersionId === null ||
    note.length > 4000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('add_finding_evidence_for_user', {
    p_finding_id: findingId,
    p_document_id: documentId,
    p_document_version_id: documentVersionId,
    p_note: note || null,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-evidence#tillsyn`);

  revalidatePath(casePath(caseId));
  redirect(`${casePath(caseId)}?ok=supervision-evidence#tillsyn`);
}

export async function resolveSupervisionFindingAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const findingId = uuid(field(formData, 'findingId'));
  const note = field(formData, 'note');

  if (caseId === null || findingId === null || note.length < 2 || note.length > 4000) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('resolve_finding_for_user', {
    p_finding_id: findingId,
    p_note: note,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-resolve#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-resolve#tillsyn`);
}

export async function createSupervisionActionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const actionType = field(formData, 'actionType').toUpperCase();
  const description = field(formData, 'description');
  const dueRaw = field(formData, 'dueAt');
  const dueAt = dueRaw === '' ? null : validFuture(dueRaw);
  const legalReference = field(formData, 'legalReference');
  const decisionRaw = field(formData, 'decisionId');
  const decisionId = decisionRaw === '' ? null : uuid(decisionRaw);

  if (
    caseId === null ||
    supervisionId === null ||
    !ACTION_TYPES.has(actionType) ||
    description.length < 2 ||
    description.length > 10_000 ||
    (dueRaw !== '' && dueAt === null) ||
    legalReference.length > 2000 ||
    (decisionRaw !== '' && decisionId === null)
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('create_action_for_user', {
    p_supervision_id: supervisionId,
    p_action_type: actionType,
    p_description: description,
    p_due_at: dueAt,
    p_legal_reference: legalReference || null,
    p_decision_id: decisionId,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-action#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-action#tillsyn`);
}

export async function completeSupervisionActionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const actionId = uuid(field(formData, 'actionId'));
  const outcome = field(formData, 'outcome');

  if (caseId === null || actionId === null || outcome.length < 2 || outcome.length > 4000) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('complete_action_for_user', {
    p_action_id: actionId,
    p_outcome: outcome,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-action-complete#tillsyn`);

  revalidatePath(casePath(caseId));
  redirect(`${casePath(caseId)}?ok=supervision-action-complete#tillsyn`);
}

export async function createSupervisionFollowupAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const actionRaw = field(formData, 'actionId');
  const actionId = actionRaw === '' ? null : uuid(actionRaw);
  const dueAt = validFuture(field(formData, 'dueAt'));
  const note = field(formData, 'note');

  if (
    caseId === null ||
    supervisionId === null ||
    (actionRaw !== '' && actionId === null) ||
    dueAt === null ||
    note.length > 4000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('create_followup_for_user', {
    p_supervision_id: supervisionId,
    p_action_id: actionId,
    p_due_at: dueAt,
    p_note: note || null,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-followup#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-followup#tillsyn`);
}

export async function completeSupervisionFollowupAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const followupId = uuid(field(formData, 'followupId'));
  const outcome = field(formData, 'outcome');

  if (caseId === null || followupId === null || outcome.length < 2 || outcome.length > 4000) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('complete_followup_for_user', {
    p_followup_id: followupId,
    p_outcome: outcome,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-followup-complete#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-followup-complete#tillsyn`);
}

export async function closeSupervisionAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const supervisionId = uuid(field(formData, 'supervisionId'));
  const reason = field(formData, 'reason');

  if (
    caseId === null ||
    supervisionId === null ||
    reason.length < 3 ||
    reason.length > 4000
  ) {
    redirect(caseId === null ? '/handlaggning/tillsyn?error=validation' : `${casePath(caseId)}?error=validation#tillsyn`);
  }

  const client = await session();
  const { error } = await client.schema('supervision').rpc('close_for_user', {
    p_supervision_id: supervisionId,
    p_reason: reason,
  });
  if (error !== null) redirect(`${casePath(caseId)}?error=supervision-close#tillsyn`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/tillsyn');
  redirect(`${casePath(caseId)}?ok=supervision-closed#tillsyn`);
}
