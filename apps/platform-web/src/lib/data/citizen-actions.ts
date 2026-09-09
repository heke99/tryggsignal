'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { currentTenant } from '@/lib/tenant/context';
import { tenantClient } from '@/lib/data/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELATIONSHIPS = new Set(['APPLICANT', 'REPRESENTATIVE']);

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

function uuid(value: string): string | null {
  return UUID.test(value) ? value : null;
}

function detailPath(caseId: string): string {
  return `/mina-sidor/arenden/${caseId}`;
}

async function citizenClient() {
  const context = await currentTenant();
  const session = await tenantClient(context);
  if (!session.authenticated) redirect('/login?returnTo=/mina-sidor&error=session');

  const { data: actorId, error: actorError } = await session.client
    .schema('authz')
    .rpc('current_user_id');
  if (actorError !== null || typeof actorId !== 'string' || actorId.length === 0) {
    redirect('/login?returnTo=/mina-sidor&error=session');
  }

  const { data: actor, error: userError } = await session.client
    .schema('identity')
    .from('users')
    .select('user_type, status')
    .eq('id', actorId)
    .maybeSingle<{ user_type: string; status: string }>();

  if (
    userError !== null ||
    actor === null ||
    actor.status !== 'ACTIVE' ||
    actor.user_type !== 'EXTERNAL'
  ) {
    redirect('/handlaggning');
  }

  return session.client;
}

export async function submitCitizenApplicationAction(formData: FormData): Promise<void> {
  const profileId = uuid(field(formData, 'profileId'));
  const title = field(formData, 'title');
  const description = field(formData, 'description');
  const contactPhone = field(formData, 'contactPhone');
  const relationship = field(formData, 'relationship').toUpperCase();

  if (
    profileId === null ||
    title.length < 3 ||
    title.length > 240 ||
    description.length > 10_000 ||
    contactPhone.length > 80 ||
    !RELATIONSHIPS.has(relationship)
  ) {
    redirect('/mina-sidor/ansokan?error=validation');
  }

  const client = await citizenClient();
  const result = await client
    .schema('core')
    .rpc('submit_citizen_application_for_user', {
      p_profile_id: profileId,
      p_title: title,
      p_description: description || null,
      p_contact_phone: contactPhone || null,
      p_relationship: relationship,
    })
    .maybeSingle<{ case_id: string; case_number: string }>();

  if (result.error !== null || result.data === null || uuid(result.data.case_id) === null) {
    redirect('/mina-sidor/ansokan?error=submit');
  }

  revalidatePath('/mina-sidor');
  revalidatePath('/mina-sidor/arenden');
  redirect(`${detailPath(result.data.case_id)}?ok=submitted`);
}

export async function sendCitizenMessageAction(formData: FormData): Promise<void> {
  const caseId = uuid(field(formData, 'caseId'));
  const subject = field(formData, 'subject');
  const body = field(formData, 'body');

  if (
    caseId === null ||
    subject.length < 2 ||
    subject.length > 300 ||
    body.length < 2 ||
    body.length > 20_000
  ) {
    redirect(caseId === null ? '/mina-sidor' : `${detailPath(caseId)}?error=message`);
  }

  const client = await citizenClient();
  const { error } = await client.schema('communication').rpc('send_portal_message_for_user', {
    p_case_id: caseId,
    p_subject: subject,
    p_body: body,
  });

  if (error !== null) redirect(`${detailPath(caseId)}?error=message`);

  revalidatePath(detailPath(caseId));
  redirect(`${detailPath(caseId)}?ok=message`);
}
