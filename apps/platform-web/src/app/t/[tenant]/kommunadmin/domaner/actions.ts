'use server';

import { redirect } from 'next/navigation';
import { requireTenantPermission } from '@/lib/auth/guard';
import { currentTenant } from '@/lib/tenant/context';
import {
  activateTenantCustomDomain,
  disableTenantCustomDomain,
  listTenantDomains,
  requestTenantCustomDomain,
  verifyTenantCustomDomain,
} from '@/lib/tenant/domains';

function value(formData: FormData, key: string, maxLength: number): string {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength);
}

function uuid(formData: FormData, key: string): string | null {
  const raw = value(formData, key, 64);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

async function authorized() {
  const context = await currentTenant();
  const { actorId } = await requireTenantPermission(
    context,
    'domain.manage',
    '/kommunadmin/domaner',
  );
  return { context, actorId };
}

export async function requestDomainAction(formData: FormData): Promise<void> {
  const { context, actorId } = await authorized();
  const hostname = value(formData, 'hostname', 253);
  if (hostname.length === 0) redirect('/kommunadmin/domaner?error=invalid');

  try {
    await requestTenantCustomDomain(context, actorId, hostname);
  } catch {
    redirect('/kommunadmin/domaner?error=request');
  }

  redirect('/kommunadmin/domaner?requested=1');
}

export async function verifyDomainAction(formData: FormData): Promise<void> {
  const { context, actorId } = await authorized();
  const domainId = uuid(formData, 'domainId');
  if (domainId === null) redirect('/kommunadmin/domaner?error=verify');

  const domains = await listTenantDomains(context);
  const domain = domains.find((candidate) => candidate.id === domainId);
  if (domain === undefined) redirect('/kommunadmin/domaner?error=verify');

  try {
    await verifyTenantCustomDomain(context, actorId, domain);
  } catch {
    redirect('/kommunadmin/domaner?error=verify');
  }

  redirect('/kommunadmin/domaner?verified=1');
}

export async function activateDomainAction(formData: FormData): Promise<void> {
  const { context, actorId } = await authorized();
  const domainId = uuid(formData, 'domainId');
  if (domainId === null) redirect('/kommunadmin/domaner?error=activate');

  try {
    await activateTenantCustomDomain(context, actorId, domainId);
  } catch {
    redirect('/kommunadmin/domaner?error=activate');
  }

  redirect('/kommunadmin/domaner?activated=1');
}

export async function disableDomainAction(formData: FormData): Promise<void> {
  const { context, actorId } = await authorized();
  const domainId = uuid(formData, 'domainId');
  const reason = value(formData, 'reason', 500);
  if (domainId === null || reason.length < 10) redirect('/kommunadmin/domaner?error=disable');

  const domains = await listTenantDomains(context);
  const domain = domains.find((candidate) => candidate.id === domainId);
  if (domain === undefined) redirect('/kommunadmin/domaner?error=disable');

  try {
    await disableTenantCustomDomain(context, actorId, domain, reason);
  } catch {
    redirect('/kommunadmin/domaner?error=disable');
  }

  redirect('/kommunadmin/domaner?disabled=1');
}
