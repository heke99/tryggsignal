'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenant/context';
import { tenantClient } from '@/lib/data/client';

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
