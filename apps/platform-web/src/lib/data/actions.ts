'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenant/context';
import { tenantClient } from '@/lib/data/client';
import { resolveTenantRuntime } from '@/lib/tenant/runtime';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_TYPES = new Set([
  'BYGGLOV',
  'ANMALAN',
  'FORHANDSBESKED',
  'RIVNINGSLOV',
  'MARKLOV',
  'PBL_TILLSYN',
  'OVK',
]);
const PRIORITIES = new Set(['LOW', 'NORMAL', 'HIGH', 'URGENT']);
const PARTY_TYPES = new Set(['PERSON', 'ORGANIZATION']);
const PARTY_RELATIONSHIPS = new Set([
  'APPLICANT',
  'REPRESENTATIVE',
  'PROPERTY_OWNER',
  'NEIGHBOUR',
  'CONTROL_RESPONSIBLE',
  'OTHER',
]);
const INFORMATION_CLASSES = new Set(['PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET']);
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;
const COMMUNICATION_CHANNELS = new Set([
  'EMAIL',
  'DIGITAL_POST',
  'SMS',
  'PORTAL',
  'API',
  'PHYSICAL_POST',
]);
const REFERRAL_POSITIONS = new Set(['NO_OBJECTION', 'OBJECTION', 'CONDITIONAL', 'NO_OPINION']);

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function uuid(value: string): string | null {
  return UUID.test(value) ? value : null;
}

function safeCaseId(formData: FormData): string | null {
  return uuid(field(formData, 'caseId'));
}

function detailPath(caseId: string): string {
  return `/handlaggning/arenden/${caseId}`;
}

async function authenticatedTenantSession() {
  const context = await currentTenant();
  const session = await tenantClient(context);
  if (!session.authenticated) {
    redirect('/login?error=session');
  }
  return { context, client: session.client };
}

/**
 * Phase G1: create a case through one database command that also binds and
 * starts the selected published workflow. The database remains the authorization
 * and transaction boundary; the form never sends a tenant id.
 */
export async function createCaseAction(formData: FormData): Promise<void> {
  const authorityId = uuid(field(formData, 'authorityId'));
  const departmentId = uuid(field(formData, 'departmentId'));
  const caseNumber = field(formData, 'caseNumber');
  const caseType = field(formData, 'caseType');
  const processType = field(formData, 'processType');
  const title = field(formData, 'title');
  const description = field(formData, 'description');
  const priority = field(formData, 'priority') || 'NORMAL';
  const templateKey = field(formData, 'templateKey');

  if (
    authorityId === null ||
    departmentId === null ||
    caseNumber.length < 2 ||
    caseNumber.length > 80 ||
    caseType.length < 2 ||
    caseType.length > 80 ||
    !PROCESS_TYPES.has(processType) ||
    title.length < 3 ||
    title.length > 240 ||
    description.length > 10_000 ||
    !PRIORITIES.has(priority) ||
    templateKey.length < 1 ||
    templateKey.length > 120
  ) {
    redirect('/handlaggning/arenden/nytt?error=validation');
  }

  const { client } = await authenticatedTenantSession();
  const { data, error } = await client.schema('core').rpc('create_case_for_user', {
    p_authority_id: authorityId,
    p_department_id: departmentId,
    p_case_number: caseNumber,
    p_case_type: caseType,
    p_process_type: processType,
    p_title: title,
    p_description: description || null,
    p_priority: priority,
    p_template_key: templateKey,
  });

  if (error !== null || typeof data !== 'string' || uuid(data) === null) {
    redirect('/handlaggning/arenden/nytt?error=create');
  }

  revalidatePath('/handlaggning');
  redirect(detailPath(data));
}

export async function assignCaseAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const assignedUserRaw = field(formData, 'assignedUserId');
  const assignedTeamRaw = field(formData, 'assignedTeamId');
  const assignedUserId = assignedUserRaw === '' ? null : uuid(assignedUserRaw);
  const assignedTeamId = assignedTeamRaw === '' ? null : uuid(assignedTeamRaw);
  const reason = field(formData, 'reason');

  if (
    caseId === null ||
    (assignedUserRaw !== '' && assignedUserId === null) ||
    (assignedTeamRaw !== '' && assignedTeamId === null) ||
    reason.length > 500
  ) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('assign_case_for_user', {
    p_case_id: caseId,
    p_assigned_user_id: assignedUserId,
    p_assigned_team_id: assignedTeamId,
    p_reason: reason || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=assign`);
  }

  revalidatePath('/handlaggning');
  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=assigned`);
}

export async function advanceWorkflowAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const instanceId = uuid(field(formData, 'instanceId'));
  const targetState = field(formData, 'targetState');
  const reason = field(formData, 'reason');

  if (
    caseId === null ||
    instanceId === null ||
    targetState.length < 1 ||
    targetState.length > 120 ||
    reason.length > 1_000
  ) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('workflow').rpc('advance_case_for_user', {
    p_instance_id: instanceId,
    p_to_state: targetState,
    p_reason: reason || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=transition`);
  }

  revalidatePath('/handlaggning');
  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=transition`);
}

export async function setWorkflowPauseAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const instanceId = uuid(field(formData, 'instanceId'));
  const pausedRaw = field(formData, 'paused');
  const reason = field(formData, 'reason');

  if (
    caseId === null ||
    instanceId === null ||
    !['true', 'false'].includes(pausedRaw) ||
    reason.length > 1_000
  ) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('workflow').rpc('set_pause_for_user', {
    p_instance_id: instanceId,
    p_paused: pausedRaw === 'true',
    p_reason: reason || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=workflow`);
  }

  revalidatePath('/handlaggning');
  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=${pausedRaw === 'true' ? 'paused' : 'resumed'}`);
}

export async function closeCaseAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const reason = field(formData, 'reason');

  if (caseId === null || reason.length < 3 || reason.length > 1_000) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('close_case_for_user', {
    p_case_id: caseId,
    p_reason: reason,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=close`);
  }

  revalidatePath('/handlaggning');
  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=closed`);
}

/** Phase G2: add a party through the parent case authorization boundary. */
export async function addCasePartyAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const partyType = field(formData, 'partyType');
  const displayName = field(formData, 'displayName');
  const relationship = field(formData, 'relationship');
  const organizationNumber = field(formData, 'organizationNumber');
  const personReference = field(formData, 'personReference');
  const contactEmail = field(formData, 'contactEmail');
  const contactPhone = field(formData, 'contactPhone');

  if (
    caseId === null ||
    !PARTY_TYPES.has(partyType) ||
    !PARTY_RELATIONSHIPS.has(relationship) ||
    displayName.length < 2 ||
    displayName.length > 200 ||
    organizationNumber.length > 50 ||
    personReference.length > 200 ||
    contactEmail.length > 320 ||
    contactPhone.length > 50
  ) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('add_case_party_for_user', {
    p_case_id: caseId,
    p_party_type: partyType,
    p_display_name: displayName,
    p_relationship: relationship,
    p_organization_number: organizationNumber || null,
    p_person_reference: personReference || null,
    p_contact_email: contactEmail || null,
    p_contact_phone: contactPhone || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=party`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=party-added#parter`);
}

export async function updateCasePartyRelationshipAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const casePartyId = uuid(field(formData, 'casePartyId'));
  const relationship = field(formData, 'relationship');

  if (caseId === null || casePartyId === null || !PARTY_RELATIONSHIPS.has(relationship)) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('update_case_party_relationship_for_user', {
    p_case_party_id: casePartyId,
    p_relationship: relationship,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=party-role#parter`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=party-role#parter`);
}

export async function updatePartyContactAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const partyId = uuid(field(formData, 'partyId'));
  const displayName = field(formData, 'displayName');
  const organizationNumber = field(formData, 'organizationNumber');
  const personReference = field(formData, 'personReference');
  const contactEmail = field(formData, 'contactEmail');
  const contactPhone = field(formData, 'contactPhone');

  if (
    caseId === null ||
    partyId === null ||
    displayName.length < 2 ||
    displayName.length > 200 ||
    organizationNumber.length > 50 ||
    personReference.length > 200 ||
    contactEmail.length > 320 ||
    contactPhone.length > 50
  ) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('update_party_contact_for_user', {
    p_case_id: caseId,
    p_party_id: partyId,
    p_display_name: displayName,
    p_organization_number: organizationNumber || null,
    p_person_reference: personReference || null,
    p_contact_email: contactEmail || null,
    p_contact_phone: contactPhone || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=party-contact#parter`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=party-contact#parter`);
}

/** Phase G3: link an existing canonical property to a case. */
export async function linkCasePropertyAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const propertyId = uuid(field(formData, 'propertyId'));
  const makePrimary = field(formData, 'makePrimary') === 'true';

  if (caseId === null || propertyId === null) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('link_property_to_case_for_user', {
    p_case_id: caseId,
    p_property_id: propertyId,
    p_make_primary: makePrimary,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=property-link#fastighet`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=property-linked#fastighet`);
}

export async function setPrimaryPropertyAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const propertyId = uuid(field(formData, 'propertyId'));

  if (caseId === null || propertyId === null) {
    redirect(
      caseId === null ? '/handlaggning?error=validation' : `${detailPath(caseId)}?error=validation`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('core').rpc('set_primary_property_for_user', {
    p_case_id: caseId,
    p_property_id: propertyId,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=property-primary#fastighet`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=property-primary#fastighet`);
}

export async function registerLocalPropertyAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const designation = field(formData, 'designation');
  const municipalityCode = field(formData, 'municipalityCode');
  const streetName = field(formData, 'streetName');
  const streetNumber = field(formData, 'streetNumber');
  const letter = field(formData, 'letter');
  const postalCode = field(formData, 'postalCode');
  const postalTown = field(formData, 'postalTown');
  const makePrimary = field(formData, 'makePrimary') !== 'false';

  if (
    caseId === null ||
    designation.length < 2 ||
    designation.length > 240 ||
    (municipalityCode !== '' && !/^[0-9]{4}$/.test(municipalityCode)) ||
    streetName.length > 240 ||
    streetNumber.length > 30 ||
    letter.length > 10 ||
    postalCode.length > 20 ||
    postalTown.length > 120
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#fastighet`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { data, error } = await client.schema('core').rpc('register_local_property_for_case_user', {
    p_case_id: caseId,
    p_designation: designation,
    p_municipality_code: municipalityCode || null,
    p_street_name: streetName || null,
    p_street_number: streetNumber || null,
    p_letter: letter || null,
    p_postal_code: postalCode || null,
    p_postal_town: postalTown || null,
    p_make_primary: makePrimary,
  });

  if (error !== null || typeof data !== 'string' || uuid(data) === null) {
    redirect(`${detailPath(caseId)}?error=property-register#fastighet`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=property-registered#fastighet`);
}

interface PrepareCaseDocumentInput {
  readonly caseId: string;
  readonly documentType: string;
  readonly title: string;
  readonly description: string;
  readonly informationClass: string;
  readonly secrecyLevel: number;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface PrepareDocumentVersionInput {
  readonly caseId: string;
  readonly documentId: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

interface PreparedDocumentUpload {
  readonly caseId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly version: number;
  readonly bucket: string;
  readonly path: string;
  readonly token: string;
  readonly supabaseUrl: string;
  readonly publishableKey: string;
}

interface PreparedUploadRpc {
  readonly document_id?: unknown;
  readonly document_version_id?: unknown;
  readonly version?: unknown;
  readonly bucket?: unknown;
  readonly path?: unknown;
}

function validUploadMetadata(
  originalFilename: string,
  mimeType: string,
  sizeBytes: number,
  sha256: string,
): boolean {
  return (
    originalFilename.length >= 1 &&
    originalFilename.length <= 255 &&
    mimeType.length >= 3 &&
    mimeType.length <= 200 &&
    Number.isInteger(sizeBytes) &&
    sizeBytes > 0 &&
    sizeBytes <= MAX_DOCUMENT_BYTES &&
    SHA256.test(sha256)
  );
}

function parsePreparedUpload(data: unknown): {
  documentId: string;
  documentVersionId: string;
  version: number;
  bucket: string;
  path: string;
} | null {
  if (typeof data !== 'object' || data === null) return null;
  const row = data as PreparedUploadRpc;
  if (
    typeof row.document_id !== 'string' ||
    uuid(row.document_id) === null ||
    typeof row.document_version_id !== 'string' ||
    uuid(row.document_version_id) === null ||
    typeof row.version !== 'number' ||
    !Number.isInteger(row.version) ||
    row.version < 1 ||
    row.bucket !== 'quarantine' ||
    typeof row.path !== 'string' ||
    row.path.length < 1
  ) {
    return null;
  }
  return {
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    version: row.version,
    bucket: row.bucket,
    path: row.path,
  };
}

async function signPreparedUpload(
  caseId: string,
  preparedData: unknown,
): Promise<PreparedDocumentUpload> {
  const prepared = parsePreparedUpload(preparedData);
  if (prepared === null) {
    throw new Error('Dokumentuppladdningen kunde inte förberedas.');
  }

  const { context, client } = await authenticatedTenantSession();
  const [runtime, signed] = await Promise.all([
    resolveTenantRuntime(context),
    client.storage.from(prepared.bucket).createSignedUploadUrl(prepared.path),
  ]);

  if (signed.error !== null || signed.data === null || typeof signed.data.token !== 'string') {
    await client.schema('documents').rpc('mark_document_upload_failed_for_user', {
      p_document_version_id: prepared.documentVersionId,
      p_reason: 'Signed upload URL could not be created',
    });
    throw new Error('En säker uppladdningsadress kunde inte skapas.');
  }

  return {
    caseId,
    ...prepared,
    token: signed.data.token,
    supabaseUrl: runtime.supabaseUrl,
    publishableKey: runtime.publishableKey,
  };
}

/**
 * G4: metadata-only server action. The File object itself is intentionally not
 * accepted here; large files go browser -> Supabase Storage using the signed
 * token returned after the database authorization succeeds.
 */
export async function prepareCaseDocumentUploadAction(
  input: PrepareCaseDocumentInput,
): Promise<PreparedDocumentUpload> {
  const caseId = uuid(input.caseId);
  const documentType = input.documentType.trim().toUpperCase();
  const title = input.title.trim();
  const description = input.description.trim();
  const informationClass = input.informationClass.trim().toUpperCase();
  const originalFilename = input.originalFilename.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  const sha256 = input.sha256.trim().toLowerCase();

  if (
    caseId === null ||
    documentType.length < 2 ||
    documentType.length > 80 ||
    title.length < 2 ||
    title.length > 240 ||
    description.length > 10_000 ||
    !INFORMATION_CLASSES.has(informationClass) ||
    !Number.isInteger(input.secrecyLevel) ||
    input.secrecyLevel < 0 ||
    input.secrecyLevel > 4 ||
    !validUploadMetadata(originalFilename, mimeType, input.sizeBytes, sha256)
  ) {
    throw new Error('Dokumentuppgifterna är ogiltiga.');
  }

  const { client } = await authenticatedTenantSession();
  const { data, error } = await client
    .schema('documents')
    .rpc('prepare_case_document_upload_for_user', {
      p_case_id: caseId,
      p_document_type: documentType,
      p_title: title,
      p_description: description || null,
      p_information_class: informationClass,
      p_secrecy_level: input.secrecyLevel,
      p_original_filename: originalFilename,
      p_mime_type: mimeType,
      p_size_bytes: input.sizeBytes,
      p_sha256: sha256,
    });

  if (error !== null) {
    throw new Error('Dokumentuppladdningen kunde inte auktoriseras.');
  }

  return signPreparedUpload(caseId, data);
}

export async function prepareDocumentVersionUploadAction(
  input: PrepareDocumentVersionInput,
): Promise<PreparedDocumentUpload> {
  const caseId = uuid(input.caseId);
  const documentId = uuid(input.documentId);
  const originalFilename = input.originalFilename.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  const sha256 = input.sha256.trim().toLowerCase();

  if (
    caseId === null ||
    documentId === null ||
    !validUploadMetadata(originalFilename, mimeType, input.sizeBytes, sha256)
  ) {
    throw new Error('Versionsuppgifterna är ogiltiga.');
  }

  const { client } = await authenticatedTenantSession();
  const { data, error } = await client
    .schema('documents')
    .rpc('prepare_new_version_upload_for_user', {
      p_document_id: documentId,
      p_original_filename: originalFilename,
      p_mime_type: mimeType,
      p_size_bytes: input.sizeBytes,
      p_sha256: sha256,
    });

  if (error !== null) {
    throw new Error('Den nya dokumentversionen kunde inte auktoriseras.');
  }

  return signPreparedUpload(caseId, data);
}

export async function confirmDocumentUploadAction(input: {
  readonly caseId: string;
  readonly documentVersionId: string;
}): Promise<void> {
  const caseId = uuid(input.caseId);
  const documentVersionId = uuid(input.documentVersionId);
  if (caseId === null || documentVersionId === null) {
    throw new Error('Dokumentversionen är ogiltig.');
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('documents').rpc('confirm_document_upload_for_user', {
    p_document_version_id: documentVersionId,
  });

  if (error !== null) {
    throw new Error('Filen laddades upp men kunde inte köas för säkerhetskontroll.');
  }

  revalidatePath(detailPath(caseId));
}

export async function markDocumentUploadFailedAction(input: {
  readonly documentVersionId: string;
  readonly reason: string;
}): Promise<void> {
  const documentVersionId = uuid(input.documentVersionId);
  const reason = input.reason.trim().slice(0, 1000);
  if (documentVersionId === null) return;

  const { client } = await authenticatedTenantSession();
  await client.schema('documents').rpc('mark_document_upload_failed_for_user', {
    p_document_version_id: documentVersionId,
    p_reason: reason || 'Upload failed',
  });
}

export async function retryDocumentConfirmationAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const documentVersionId = uuid(field(formData, 'documentVersionId'));
  if (caseId === null || documentVersionId === null) {
    redirect(
      caseId === null ? '/handlaggning' : `${detailPath(caseId)}?error=validation#handlingar`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('documents').rpc('confirm_document_upload_for_user', {
    p_document_version_id: documentVersionId,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=document-confirm#handlingar`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=document-confirmed#handlingar`);
}

export async function updateDocumentMetadataAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const documentId = uuid(field(formData, 'documentId'));
  const documentType = field(formData, 'documentType').toUpperCase();
  const title = field(formData, 'title');
  const description = field(formData, 'description');
  const informationClass = field(formData, 'informationClass').toUpperCase();
  const secrecyLevel = Number(field(formData, 'secrecyLevel'));

  if (
    caseId === null ||
    documentId === null ||
    documentType.length < 2 ||
    documentType.length > 80 ||
    title.length < 2 ||
    title.length > 240 ||
    description.length > 10_000 ||
    !INFORMATION_CLASSES.has(informationClass) ||
    !Number.isInteger(secrecyLevel) ||
    secrecyLevel < 0 ||
    secrecyLevel > 4
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#handlingar`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('documents').rpc('update_document_metadata_for_user', {
    p_document_id: documentId,
    p_document_type: documentType,
    p_title: title,
    p_description: description || null,
    p_information_class: informationClass,
    p_secrecy_level: secrecyLevel,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=document-metadata#handlingar`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=document-metadata#handlingar`);
}

export async function createDocumentDownloadUrlAction(input: {
  readonly caseId: string;
  readonly documentVersionId: string;
}): Promise<string> {
  const caseId = uuid(input.caseId);
  const documentVersionId = uuid(input.documentVersionId);
  if (caseId === null || documentVersionId === null) {
    throw new Error('Dokumentversionen är ogiltig.');
  }

  const { client } = await authenticatedTenantSession();
  const { data: version } = await client
    .schema('documents')
    .from('document_versions')
    .select('id, document_id, storage_bucket, storage_path, ingestion_status')
    .eq('id', documentVersionId)
    .maybeSingle<{
      id: string;
      document_id: string;
      storage_bucket: string;
      storage_path: string;
      ingestion_status: string;
    }>();

  if (version === null || version.ingestion_status !== 'CLEAN') {
    throw new Error('Dokumentversionen är inte tillgänglig för hämtning.');
  }

  const { data: document } = await client
    .schema('documents')
    .from('documents')
    .select('id, case_id')
    .eq('id', version.document_id)
    .eq('case_id', caseId)
    .maybeSingle<{ id: string; case_id: string | null }>();

  if (document === null) {
    throw new Error('Dokumentversionen är inte tillgänglig för hämtning.');
  }

  const { data, error } = await client.storage
    .from(version.storage_bucket)
    .createSignedUrl(version.storage_path, 120);

  if (error !== null || data === null) {
    throw new Error('En tidsbegränsad hämtningslänk kunde inte skapas.');
  }

  return data.signedUrl;
}

/** Phase G6: evaluate completeness using a published, sourced rule-set version. */
export async function evaluateCaseCompletenessAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const ruleSetVersionId = uuid(field(formData, 'ruleSetVersionId'));

  if (caseId === null || ruleSetVersionId === null) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#kompletthet`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('rules').rpc('evaluate_case_completeness_for_user', {
    p_case_id: caseId,
    p_rule_set_version_id: ruleSetVersionId,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=completeness#kompletthet`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=completeness#kompletthet`);
}

export async function reviewCaseCompletenessAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const assessmentId = uuid(field(formData, 'assessmentId'));
  const decision = field(formData, 'decision').toUpperCase();
  const note = field(formData, 'note');

  if (
    caseId === null ||
    assessmentId === null ||
    !['COMPLETE', 'INCOMPLETE'].includes(decision) ||
    note.length < 3 ||
    note.length > 4000
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#kompletthet`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('rules').rpc('review_case_completeness_for_user', {
    p_assessment_id: assessmentId,
    p_decision: decision,
    p_note: note,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=completeness-review#kompletthet`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=completeness-review#kompletthet`);
}

/** Phase G7: create a case-scoped referral through the command boundary. */
export async function createReferralAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const subject = field(formData, 'subject');
  const description = field(formData, 'description');
  const dueAtRaw = field(formData, 'dueAt');
  const dueAt = new Date(dueAtRaw);

  if (
    caseId === null ||
    subject.length < 2 ||
    subject.length > 300 ||
    description.length > 10_000 ||
    dueAtRaw === '' ||
    Number.isNaN(dueAt.getTime()) ||
    dueAt.getTime() <= Date.now()
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#remisser`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('referral').rpc('create_for_user', {
    p_case_id: caseId,
    p_subject: subject,
    p_description: description || null,
    p_due_at: dueAt.toISOString(),
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=referral-create#remisser`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=referral-created#remisser`);
}

export async function addReferralRecipientAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const referralId = uuid(field(formData, 'referralId'));
  const partyRaw = field(formData, 'partyId');
  const partyId = partyRaw === '' ? null : uuid(partyRaw);
  const organizationName = field(formData, 'organizationName');
  const contactAddress = field(formData, 'contactAddress');

  if (
    caseId === null ||
    referralId === null ||
    (partyRaw !== '' && partyId === null) ||
    organizationName.length > 300 ||
    contactAddress.length > 500 ||
    (partyId === null && (organizationName.length < 2 || contactAddress.length < 3))
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#remisser`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('referral').rpc('add_recipient_for_user', {
    p_referral_id: referralId,
    p_party_id: partyId,
    p_organization_name: organizationName || null,
    p_contact_address: contactAddress || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=referral-recipient#remisser`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=referral-recipient#remisser`);
}

export async function queueReferralDeliveryAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const recipientId = uuid(field(formData, 'recipientId'));
  const channel = field(formData, 'channel').toUpperCase();

  if (caseId === null || recipientId === null || !COMMUNICATION_CHANNELS.has(channel)) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#remisser`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('referral').rpc('queue_delivery_for_user', {
    p_recipient_id: recipientId,
    p_channel: channel,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=referral-queue#remisser`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=referral-queued#remisser`);
}

export async function recordReferralResponseAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const recipientId = uuid(field(formData, 'recipientId'));
  const position = field(formData, 'position').toUpperCase();
  const responseText = field(formData, 'responseText');
  const documentRaw = field(formData, 'documentId');
  const documentId = documentRaw === '' ? null : uuid(documentRaw);

  if (
    caseId === null ||
    recipientId === null ||
    !REFERRAL_POSITIONS.has(position) ||
    responseText.length > 20_000 ||
    (documentRaw !== '' && documentId === null) ||
    (responseText.length === 0 && documentId === null)
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#remisser`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('referral').rpc('record_response_for_user', {
    p_recipient_id: recipientId,
    p_response_text: responseText || null,
    p_position: position,
    p_document_id: documentId,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=referral-response#remisser`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=referral-response#remisser`);
}

export async function queueReferralFollowupAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const recipientId = uuid(field(formData, 'recipientId'));
  const channel = field(formData, 'channel').toUpperCase();

  if (caseId === null || recipientId === null || !COMMUNICATION_CHANNELS.has(channel)) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#remisser`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('referral').rpc('queue_followup_for_user', {
    p_recipient_id: recipientId,
    p_channel: channel,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=referral-followup#remisser`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=referral-followup#remisser`);
}


function nonEmptyLines(value: string, maxItems = 100): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Phase G8: create an empty decision shell attached to an authorized case. */
export async function createDecisionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionType = field(formData, 'decisionType');
  const decisionNumber = field(formData, 'decisionNumber');

  if (
    caseId === null ||
    decisionType.length < 2 ||
    decisionType.length > 120 ||
    decisionNumber.length > 120
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('create_for_user', {
    p_case_id: caseId,
    p_decision_type: decisionType,
    p_decision_number: decisionNumber || null,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-create#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-created#beslut`);
}

export async function addDecisionVersionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  const body = field(formData, 'body');
  const conditions = nonEmptyLines(field(formData, 'conditions')).map((text) => ({ text }));
  const legalReferences = nonEmptyLines(field(formData, 'legalReferences')).map((reference) => ({
    reference,
  }));
  const generatedBy = field(formData, 'generatedBy').toUpperCase();

  if (
    caseId === null ||
    decisionId === null ||
    body.length < 3 ||
    body.length > 100_000 ||
    conditions.some((item) => item.text.length > 2000) ||
    legalReferences.some((item) => item.reference.length > 2000) ||
    !['HUMAN', 'TEMPLATE'].includes(generatedBy)
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('add_version_for_user', {
    p_decision_id: decisionId,
    p_body: body,
    p_conditions: conditions,
    p_legal_references: legalReferences,
    p_generated_by: generatedBy,
  });

  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-version#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-version#beslut`);
}

export async function submitDecisionReviewAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  if (caseId === null || decisionId === null) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('submit_review_for_user', {
    p_decision_id: decisionId,
  });
  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-review#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-review#beslut`);
}

export async function approveDecisionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  if (caseId === null || decisionId === null) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('approve_for_user', {
    p_decision_id: decisionId,
  });
  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-approve#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-approved#beslut`);
}

export async function decideDecisionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  const delegationReference = field(formData, 'delegationReference');
  const appealRaw = field(formData, 'appealDeadlineAt');
  const appeal = appealRaw === '' ? null : new Date(appealRaw);

  if (
    caseId === null ||
    decisionId === null ||
    delegationReference.length < 2 ||
    delegationReference.length > 500 ||
    (appeal !== null && (Number.isNaN(appeal.getTime()) || appeal.getTime() <= Date.now()))
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('decide_for_user', {
    p_decision_id: decisionId,
    p_delegation_reference: delegationReference,
    p_appeal_deadline_at: appeal?.toISOString() ?? null,
  });
  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-decide#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-decided#beslut`);
}

export async function signDecisionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  const method = field(formData, 'method').toUpperCase();
  const providerReference = field(formData, 'providerReference');

  if (
    caseId === null ||
    decisionId === null ||
    !['MANUAL_ATTESTATION', 'BANKID', 'QUALIFIED_ELECTRONIC', 'OTHER'].includes(method) ||
    providerReference.length > 1000 ||
    (method !== 'MANUAL_ATTESTATION' && providerReference.length < 2)
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('sign_for_user', {
    p_decision_id: decisionId,
    p_method: method,
    p_provider_reference: providerReference || null,
    p_evidence: { source: 'case-workspace', recorded_at: new Date().toISOString() },
  });
  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-sign#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-signed#beslut`);
}

export async function issueDecisionAction(formData: FormData): Promise<void> {
  const caseId = safeCaseId(formData);
  const decisionId = uuid(field(formData, 'decisionId'));
  const recipientPartyId = uuid(field(formData, 'recipientPartyId'));
  const channel = field(formData, 'channel').toUpperCase();

  if (
    caseId === null ||
    decisionId === null ||
    recipientPartyId === null ||
    !COMMUNICATION_CHANNELS.has(channel)
  ) {
    redirect(
      caseId === null
        ? '/handlaggning?error=validation'
        : `${detailPath(caseId)}?error=validation#beslut`,
    );
  }

  const { client } = await authenticatedTenantSession();
  const { error } = await client.schema('decision').rpc('issue_for_user', {
    p_decision_id: decisionId,
    p_recipient_party_id: recipientPartyId,
    p_channel: channel,
  });
  if (error !== null) {
    redirect(`${detailPath(caseId)}?error=decision-issue#beslut`);
  }

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=decision-queued#beslut`);
}
