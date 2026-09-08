'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenant/context';
import { tenantClient } from '@/lib/data/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROTOCOL_RESULTS = new Set(['APPROVED', 'APPROVED_WITH_REMARKS', 'NOT_APPROVED']);
const SEVERITIES = new Set(['INFO', 'REMARK', 'DEVIATION', 'SERIOUS']);

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function uuid(value: string): string | null {
  return UUID.test(value) ? value : null;
}

function casePath(caseId: string): string {
  return `/handlaggning/arenden/${caseId}`;
}

async function client() {
  const context = await currentTenant();
  const session = await tenantClient(context);
  if (!session.authenticated) redirect('/login?error=session');
  return session.client;
}

export async function linkOvkObjectAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const propertyId = uuid(field(formData, 'propertyId'));
  const buildingRaw = field(formData, 'buildingId');
  const buildingId = buildingRaw === '' ? null : uuid(buildingRaw);
  const obligationId = uuid(field(formData, 'obligationId'));
  const objectReference = field(formData, 'objectReference');
  const ventilationSystemType = field(formData, 'ventilationSystemType');
  const lastPerformedRaw = field(formData, 'lastPerformedAt');
  const lastPerformedAt = lastPerformedRaw === '' ? null : lastPerformedRaw;

  if (
    caseId === null ||
    propertyId === null ||
    obligationId === null ||
    (buildingRaw !== '' && buildingId === null) ||
    objectReference.length < 1 ||
    objectReference.length > 300 ||
    ventilationSystemType.length > 300 ||
    (lastPerformedAt !== null &&
      (Number.isNaN(Date.parse(lastPerformedAt)) || Date.parse(lastPerformedAt) > Date.now()))
  ) {
    redirect(
      caseId === null
        ? '/handlaggning/ovk?error=validation'
        : `${casePath(caseId)}?error=ovk-object#ovk`,
    );
  }

  const db = await client();
  const { error } = await db.schema('compliance').rpc('link_ovk_object_for_user', {
    p_case_id: caseId,
    p_property_id: propertyId,
    p_building_id: buildingId,
    p_obligation_id: obligationId,
    p_object_reference: objectReference,
    p_ventilation_system_type: ventilationSystemType || null,
    p_last_performed_at: lastPerformedAt,
  });

  if (error !== null) redirect(`${casePath(caseId)}?error=ovk-object#ovk`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/ovk');
  redirect(`${casePath(caseId)}?ok=ovk-object#ovk`);
}

export async function recordOvkProtocolAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const objectId = uuid(field(formData, 'objectId'));
  const performedAt = field(formData, 'performedAt');
  const result = field(formData, 'result').toUpperCase();
  const documentVersionId = uuid(field(formData, 'documentVersionId'));
  const inspectorName = field(formData, 'inspectorName');
  const inspectorOrganization = field(formData, 'inspectorOrganization');
  const notes = field(formData, 'notes');

  if (
    caseId === null ||
    objectId === null ||
    documentVersionId === null ||
    !PROTOCOL_RESULTS.has(result) ||
    performedAt.length !== 10 ||
    Number.isNaN(Date.parse(performedAt)) ||
    Date.parse(performedAt) > Date.now() ||
    inspectorName.length > 300 ||
    inspectorOrganization.length > 300 ||
    notes.length > 10_000
  ) {
    redirect(
      caseId === null
        ? '/handlaggning/ovk?error=validation'
        : `${casePath(caseId)}?error=ovk-protocol#ovk`,
    );
  }

  const db = await client();
  const version = await db
    .schema('documents')
    .from('document_versions')
    .select('document_id')
    .eq('id', documentVersionId)
    .eq('ingestion_status', 'CLEAN')
    .maybeSingle<{ document_id: string }>();

  if (version.data === null) {
    redirect(`${casePath(caseId)}?error=ovk-protocol#ovk`);
  }

  const { error } = await db.schema('compliance').rpc('record_ovk_protocol_for_user', {
    p_case_id: caseId,
    p_compliance_object_id: objectId,
    p_performed_at: performedAt,
    p_result: result,
    p_document_id: version.data.document_id,
    p_document_version_id: documentVersionId,
    p_inspector_name: inspectorName || null,
    p_inspector_organization: inspectorOrganization || null,
    p_notes: notes || null,
  });

  if (error !== null) redirect(`${casePath(caseId)}?error=ovk-protocol#ovk`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/ovk');
  redirect(`${casePath(caseId)}?ok=ovk-protocol#ovk`);
}

export async function recordOvkFindingAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const objectId = uuid(field(formData, 'objectId'));
  const protocolRaw = field(formData, 'protocolId');
  const protocolId = protocolRaw === '' ? null : uuid(protocolRaw);
  const findingType = field(formData, 'findingType');
  const description = field(formData, 'description');
  const severity = field(formData, 'severity').toUpperCase();
  const dueRaw = field(formData, 'dueAt');
  const dueAt = dueRaw === '' ? null : new Date(dueRaw);

  if (
    caseId === null ||
    objectId === null ||
    (protocolRaw !== '' && protocolId === null) ||
    findingType.length < 2 ||
    findingType.length > 200 ||
    description.length < 2 ||
    description.length > 10_000 ||
    !SEVERITIES.has(severity) ||
    (dueAt !== null && (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= Date.now()))
  ) {
    redirect(
      caseId === null
        ? '/handlaggning/ovk?error=validation'
        : `${casePath(caseId)}?error=ovk-finding#ovk`,
    );
  }

  const db = await client();
  const { error } = await db.schema('compliance').rpc('record_ovk_finding_for_user', {
    p_case_id: caseId,
    p_compliance_object_id: objectId,
    p_protocol_id: protocolId,
    p_finding_type: findingType,
    p_description: description,
    p_severity: severity,
    p_due_at: dueAt?.toISOString() ?? null,
  });

  if (error !== null) redirect(`${casePath(caseId)}?error=ovk-finding#ovk`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/ovk');
  redirect(`${casePath(caseId)}?ok=ovk-finding#ovk`);
}

export async function resolveOvkFindingAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const findingId = uuid(field(formData, 'findingId'));
  const resolutionNote = field(formData, 'resolutionNote');

  if (
    caseId === null ||
    findingId === null ||
    resolutionNote.length < 2 ||
    resolutionNote.length > 4000
  ) {
    redirect(
      caseId === null
        ? '/handlaggning/ovk?error=validation'
        : `${casePath(caseId)}?error=ovk-resolve#ovk`,
    );
  }

  const db = await client();
  const { error } = await db.schema('compliance').rpc('resolve_ovk_finding_for_user', {
    p_case_id: caseId,
    p_finding_id: findingId,
    p_resolution_note: resolutionNote,
  });

  if (error !== null) redirect(`${casePath(caseId)}?error=ovk-resolve#ovk`);

  revalidatePath(casePath(caseId));
  revalidatePath('/handlaggning/ovk');
  redirect(`${casePath(caseId)}?ok=ovk-resolve#ovk`);
}
