'use server';

import { redirect } from 'next/navigation';
import type { BrandingAssetKind, BrandingTokens } from '@tryggsignal/tenancy';
import { validateBranding } from '@tryggsignal/tenancy';
import { requireTenantPermission } from '@/lib/auth/guard';
import { currentTenant } from '@/lib/tenant/context';
import {
  publishTenantBranding,
  rollbackTenantBranding,
  saveTenantBrandingDraft,
  uploadTenantBrandingAsset,
} from '@/lib/tenant/branding';

function value(formData: FormData, key: string, maxLength: number): string {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength);
}

function optional(formData: FormData, key: string, maxLength: number): string | undefined {
  const raw = value(formData, key, maxLength);
  return raw.length === 0 ? undefined : raw;
}

function color(formData: FormData, key: string): string | undefined {
  return optional(formData, key, 7)?.toLowerCase();
}

function uuid(formData: FormData, key: string): string | null {
  const raw = value(formData, key, 64);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null;
}

function tokensFromForm(formData: FormData): BrandingTokens {
  const shortName = optional(formData, 'shortName', 60);
  const secondaryColor = color(formData, 'secondaryColor');
  const accentColor = color(formData, 'accentColor');
  const surfaceVariant = color(formData, 'surfaceVariant');
  const supportEmail = optional(formData, 'supportEmail', 254);
  const privacyUrl = optional(formData, 'privacyUrl', 500);
  const accessibilityStatementUrl = optional(formData, 'accessibilityStatementUrl', 500);
  const termsUrl = optional(formData, 'termsUrl', 500);
  const loginHeading = optional(formData, 'loginHeading', 160);
  const loginSubheading = optional(formData, 'loginSubheading', 280);

  return {
    displayName: value(formData, 'displayName', 120),
    primaryColor: color(formData, 'primaryColor') ?? '',
    locale: value(formData, 'locale', 16),
    showTryggsignalBranding: formData.get('showTryggsignalBranding') === 'on',
    ...(shortName === undefined ? {} : { shortName }),
    ...(secondaryColor === undefined ? {} : { secondaryColor }),
    ...(accentColor === undefined ? {} : { accentColor }),
    ...(surfaceVariant === undefined ? {} : { surfaceVariant }),
    ...(supportEmail === undefined ? {} : { supportEmail }),
    ...(privacyUrl === undefined ? {} : { privacyUrl }),
    ...(accessibilityStatementUrl === undefined ? {} : { accessibilityStatementUrl }),
    ...(termsUrl === undefined ? {} : { termsUrl }),
    ...(loginHeading === undefined ? {} : { loginHeading }),
    ...(loginSubheading === undefined ? {} : { loginSubheading }),
  };
}

export async function saveBrandingAction(formData: FormData): Promise<void> {
  const context = await currentTenant();
  const { actorId } = await requireTenantPermission(
    context,
    'branding.manage',
    '/kommunadmin/branding',
  );
  const tokens = tokensFromForm(formData);
  const validation = validateBranding(tokens);

  if (!validation.valid) {
    redirect('/kommunadmin/branding?error=validation');
  }

  try {
    await saveTenantBrandingDraft(context, actorId, tokens);
  } catch {
    redirect('/kommunadmin/branding?error=save');
  }

  redirect('/kommunadmin/branding?saved=1');
}

export async function publishBrandingAction(formData: FormData): Promise<void> {
  const context = await currentTenant();
  const { actorId } = await requireTenantPermission(
    context,
    'branding.manage',
    '/kommunadmin/branding',
  );
  const brandingId = uuid(formData, 'brandingId');
  if (brandingId === null) redirect('/kommunadmin/branding?error=publish');

  try {
    await publishTenantBranding(context, brandingId, actorId);
  } catch {
    redirect('/kommunadmin/branding?error=publish');
  }

  redirect('/kommunadmin/branding?published=1');
}

export async function rollbackBrandingAction(): Promise<void> {
  const context = await currentTenant();
  const { actorId } = await requireTenantPermission(
    context,
    'branding.manage',
    '/kommunadmin/branding',
  );

  try {
    await rollbackTenantBranding(context, actorId);
  } catch {
    redirect('/kommunadmin/branding?error=rollback');
  }

  redirect('/kommunadmin/branding?rolledBack=1');
}

export async function uploadBrandingAssetAction(formData: FormData): Promise<void> {
  const context = await currentTenant();
  const { actorId } = await requireTenantPermission(
    context,
    'branding.manage',
    '/kommunadmin/branding',
  );
  const brandingId = uuid(formData, 'brandingId');
  const kindRaw = value(formData, 'kind', 20);
  const kind: BrandingAssetKind | null =
    kindRaw === 'LOGO' || kindRaw === 'LOGO_DARK' || kindRaw === 'FAVICON' ? kindRaw : null;
  const file = formData.get('asset');

  if (brandingId === null || kind === null || !(file instanceof File) || file.size === 0) {
    redirect('/kommunadmin/branding?error=asset');
  }

  try {
    await uploadTenantBrandingAsset(context, brandingId, actorId, kind, file);
  } catch {
    redirect('/kommunadmin/branding?error=asset');
  }

  redirect('/kommunadmin/branding?asset=1');
}
