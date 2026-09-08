import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  inspectBrandingImage,
  type BrandingAssetKind,
  type BrandingTokens,
  type BrandingValidation,
  validateBranding,
} from '@tryggsignal/tenancy';
import type { TenantContext } from '@tryggsignal/tenancy';
import { controlPlaneServerClient } from '@/lib/tenant/runtime';

const BRANDING_BUCKET = 'branding-assets';

interface BrandingRow {
  branding_id: string;
  version: number;
  status?: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  contrast_validation_status?: 'NOT_VALIDATED' | 'PASSED' | 'FAILED';
  display_name: string;
  short_name: string | null;
  primary_color: string;
  secondary_color: string | null;
  accent_color: string | null;
  surface_variant: string | null;
  support_email: string | null;
  privacy_url: string | null;
  accessibility_statement_url: string | null;
  terms_url: string | null;
  login_heading: string | null;
  login_subheading: string | null;
  show_tryggsignal_branding: boolean;
  locale: string;
  logo_path: string | null;
  logo_dark_path: string | null;
  favicon_path: string | null;
  published_at?: string | null;
  supersedes_id?: string | null;
}

export interface TenantBrandingView extends BrandingTokens {
  readonly id: string | null;
  readonly version: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';
  readonly contrastValidationStatus: 'NOT_VALIDATED' | 'PASSED' | 'FAILED';
  readonly logoUrl?: string | undefined;
  readonly logoDarkUrl?: string | undefined;
  readonly faviconUrl?: string | undefined;
  readonly publishedAt?: string | null | undefined;
  readonly supersedesId?: string | null | undefined;
}

export class BrandingRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandingRuntimeError';
  }
}

function publicAssetUrl(client: SupabaseClient, path: string | null): string | undefined {
  if (path === null) return undefined;
  return client.storage.from(BRANDING_BUCKET).getPublicUrl(path).data.publicUrl;
}

function rowToView(client: SupabaseClient, row: BrandingRow): TenantBrandingView {
  const shortName = row.short_name ?? undefined;
  const secondaryColor = row.secondary_color ?? undefined;
  const accentColor = row.accent_color ?? undefined;
  const surfaceVariant = row.surface_variant ?? undefined;
  const supportEmail = row.support_email ?? undefined;
  const privacyUrl = row.privacy_url ?? undefined;
  const accessibilityStatementUrl = row.accessibility_statement_url ?? undefined;
  const termsUrl = row.terms_url ?? undefined;
  const loginHeading = row.login_heading ?? undefined;
  const loginSubheading = row.login_subheading ?? undefined;
  const logoUrl = publicAssetUrl(client, row.logo_path);
  const logoDarkUrl = publicAssetUrl(client, row.logo_dark_path);
  const faviconUrl = publicAssetUrl(client, row.favicon_path);

  return {
    id: row.branding_id,
    version: row.version,
    status: row.status ?? 'PUBLISHED',
    contrastValidationStatus: row.contrast_validation_status ?? 'PASSED',
    displayName: row.display_name,
    primaryColor: row.primary_color,
    locale: row.locale,
    showTryggsignalBranding: row.show_tryggsignal_branding,
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
    ...(logoUrl === undefined ? {} : { logoUrl }),
    ...(logoDarkUrl === undefined ? {} : { logoDarkUrl }),
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
    ...('published_at' in row ? { publishedAt: row.published_at ?? null } : {}),
    ...('supersedes_id' in row ? { supersedesId: row.supersedes_id ?? null } : {}),
  };
}

export function defaultTenantBranding(context: TenantContext): TenantBrandingView {
  return {
    id: null,
    version: context.brandingVersion,
    status: 'PUBLISHED',
    contrastValidationStatus: 'PASSED',
    displayName: context.tenantSlug,
    primaryColor: '#14532d',
    secondaryColor: '#1f2937',
    accentColor: '#b45309',
    surfaceVariant: '#f8fafc',
    locale: 'sv-SE',
    showTryggsignalBranding: true,
  };
}

/**
 * Runtime reads are pinned to the branding version embedded in the verified
 * tenant context. A stale or cross-tenant version can never silently resolve to
 * another municipality's profile.
 */
export async function resolvePublishedBranding(
  context: TenantContext,
): Promise<TenantBrandingView> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client
    .rpc('resolve_tenant_branding', {
      p_tenant_id: context.tenantId,
      p_version: context.brandingVersion,
    })
    .maybeSingle<BrandingRow>();

  if (error !== null) {
    throw new BrandingRuntimeError(`Could not resolve tenant branding: ${error.message}`);
  }

  return data === null ? defaultTenantBranding(context) : rowToView(client, data);
}

export async function listTenantBrandingVersions(
  context: TenantContext,
): Promise<readonly TenantBrandingView[]> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client.rpc('list_tenant_branding_versions', {
    p_tenant_id: context.tenantId,
  });

  if (error !== null || !Array.isArray(data)) {
    throw new BrandingRuntimeError(error?.message ?? 'Could not list tenant branding versions.');
  }

  return (data as BrandingRow[]).map((row) => rowToView(client, row));
}

export async function saveTenantBrandingDraft(
  context: TenantContext,
  actorId: string,
  tokens: BrandingTokens,
): Promise<{ readonly brandingId: string; readonly validation: BrandingValidation }> {
  const validation = validateBranding(tokens);
  const client = await controlPlaneServerClient();
  const { data, error } = await client.rpc('save_tenant_branding_draft', {
    p_tenant_id: context.tenantId,
    p_actor: actorId,
    p_display_name: tokens.displayName,
    p_short_name: tokens.shortName ?? null,
    p_primary_color: tokens.primaryColor,
    p_secondary_color: tokens.secondaryColor ?? null,
    p_accent_color: tokens.accentColor ?? null,
    p_surface_variant: tokens.surfaceVariant ?? null,
    p_support_email: tokens.supportEmail ?? null,
    p_privacy_url: tokens.privacyUrl ?? null,
    p_accessibility_statement_url: tokens.accessibilityStatementUrl ?? null,
    p_terms_url: tokens.termsUrl ?? null,
    p_login_heading: tokens.loginHeading ?? null,
    p_login_subheading: tokens.loginSubheading ?? null,
    p_show_tryggsignal_branding: tokens.showTryggsignalBranding,
    p_locale: tokens.locale,
    p_contrast_passed: validation.valid,
  });

  if (error !== null || typeof data !== 'string') {
    throw new BrandingRuntimeError(error?.message ?? 'Could not save branding draft.');
  }

  return { brandingId: data, validation };
}

export async function publishTenantBranding(
  context: TenantContext,
  brandingId: string,
  actorId: string,
): Promise<number> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client.rpc('publish_tenant_branding', {
    p_tenant_id: context.tenantId,
    p_branding_id: brandingId,
    p_actor: actorId,
  });

  if (error !== null || typeof data !== 'number') {
    throw new BrandingRuntimeError(error?.message ?? 'Could not publish branding.');
  }
  return data;
}

export async function rollbackTenantBranding(
  context: TenantContext,
  actorId: string,
): Promise<number> {
  const client = await controlPlaneServerClient();
  const { data, error } = await client.rpc('rollback_tenant_branding', {
    p_tenant_id: context.tenantId,
    p_actor: actorId,
  });

  if (error !== null || typeof data !== 'number') {
    throw new BrandingRuntimeError(error?.message ?? 'Could not roll back branding.');
  }
  return data;
}

export async function uploadTenantBrandingAsset(
  context: TenantContext,
  brandingId: string,
  actorId: string,
  kind: BrandingAssetKind,
  file: File,
): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = inspectBrandingImage(bytes);

  if (file.type.length > 0 && file.type !== info.mimeType) {
    throw new BrandingRuntimeError('Browser MIME type does not match the uploaded image bytes.');
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const path = `${context.tenantId}/${brandingId}/${kind.toLowerCase()}-${randomUUID()}.${info.extension}`;
  const client = await controlPlaneServerClient();

  const { error: uploadError } = await client.storage.from(BRANDING_BUCKET).upload(path, bytes, {
    contentType: info.mimeType,
    cacheControl: '31536000',
    upsert: false,
  });
  if (uploadError !== null) {
    throw new BrandingRuntimeError(`Could not upload branding asset: ${uploadError.message}`);
  }

  const { data: assetId, error: registerError } = await client.rpc('register_branding_asset', {
    p_tenant_id: context.tenantId,
    p_actor: actorId,
    p_asset_kind: kind,
    p_object_path: path,
    p_sha256: sha256,
    p_mime_type: info.mimeType,
    p_width: info.width,
    p_height: info.height,
    p_size_bytes: bytes.byteLength,
  });

  if (registerError !== null || typeof assetId !== 'string') {
    await client.storage.from(BRANDING_BUCKET).remove([path]);
    throw new BrandingRuntimeError(registerError?.message ?? 'Could not register branding asset.');
  }

  const { error: attachError } = await client.rpc('set_tenant_branding_asset', {
    p_tenant_id: context.tenantId,
    p_branding_id: brandingId,
    p_asset_kind: kind,
    p_asset_id: assetId,
    p_actor: actorId,
  });

  if (attachError !== null) {
    await Promise.all([
      client.storage.from(BRANDING_BUCKET).remove([path]),
      client.rpc('discard_branding_asset', {
        p_tenant_id: context.tenantId,
        p_asset_id: assetId,
      }),
    ]);
    throw new BrandingRuntimeError(`Could not attach branding asset: ${attachError.message}`);
  }
}
