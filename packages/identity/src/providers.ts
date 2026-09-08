/**
 * Masterplan 15, 116, 178: identity is per tenant and provider-neutral.
 *
 * Staff sign in through Microsoft Entra ID (the primary integration path);
 * external parties through an identity broker with a Sweden Connect adapter.
 * SAML is the path that exists today. OIDC against Sweden Connect must NOT be
 * enabled in production before the official connection is actually available and
 * tested (masterplan 15), so the adapter refuses to run in production.
 */

export const IDENTITY_PROVIDER_KINDS = [
  'SUPABASE_PASSWORD',
  'ENTRA_ID',
  'SAML',
  'OIDC',
  'SWEDEN_CONNECT',
] as const;

export type IdentityProviderKind = (typeof IDENTITY_PROVIDER_KINDS)[number];

export type AudienceKind = 'STAFF' | 'EXTERNAL';

export interface TenantAuthConfiguration {
  readonly reference: string;
  readonly tenantId: string;
  readonly audience: AudienceKind;
  readonly kind: IdentityProviderKind;
  readonly displayName: string;
  /** Entra tenant id, SAML entity id, OIDC issuer — whatever the kind needs. */
  readonly issuer: string | null;
  readonly metadataUrl: string | null;
  /** SecretProvider reference for the client secret or signing key. */
  readonly credentialReference: string | null;
  readonly enabled: boolean;
  /** Email domains allowed to use this configuration, lowercase, no leading '@'. */
  readonly allowedEmailDomains: readonly string[];
}

export class IdentityProviderUnavailableError extends Error {
  constructor(
    readonly kind: IdentityProviderKind,
    readonly reason: string,
  ) {
    super(`Identity provider ${kind} is unavailable: ${reason}`);
    this.name = 'IdentityProviderUnavailableError';
  }
}

export interface AuthorizationRequest {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string | null;
}

export interface VerifiedIdentity {
  readonly externalSubject: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly providerKind: IdentityProviderKind;
  readonly audience: AudienceKind;
}

export type Environment = 'DEV' | 'TEST' | 'PRODUCTION';

/**
 * Chooses the configuration for a sign-in attempt. A configuration that is
 * disabled, wrong-audience, or not permitted in this environment is never
 * silently replaced by another one.
 */
export function selectAuthConfiguration(
  configurations: readonly TenantAuthConfiguration[],
  options: {
    readonly tenantId: string;
    readonly audience: AudienceKind;
    readonly environment: Environment;
    readonly email?: string | null;
  },
): TenantAuthConfiguration {
  const candidates = configurations.filter(
    (config) =>
      config.tenantId === options.tenantId &&
      config.audience === options.audience &&
      config.enabled,
  );

  if (candidates.length === 0) {
    throw new IdentityProviderUnavailableError(
      'SUPABASE_PASSWORD',
      `No enabled ${options.audience} identity configuration for this tenant.`,
    );
  }

  const domain = options.email?.split('@')[1]?.toLowerCase() ?? null;
  const byDomain =
    domain === null
      ? undefined
      : candidates.find((config) => config.allowedEmailDomains.includes(domain));

  const chosen = byDomain ?? candidates[0]!;

  assertUsableInEnvironment(chosen, options.environment);
  return chosen;
}

/** Masterplan 15: the Sweden Connect production guard, expressed as code. */
export function assertUsableInEnvironment(
  config: TenantAuthConfiguration,
  environment: Environment,
): void {
  if (config.kind === 'SWEDEN_CONNECT' && environment === 'PRODUCTION') {
    throw new IdentityProviderUnavailableError(
      'SWEDEN_CONNECT',
      'Sweden Connect may not be enabled in production before the official connection is available and tested.',
    );
  }
  if (
    (config.kind === 'ENTRA_ID' || config.kind === 'SAML' || config.kind === 'OIDC') &&
    config.credentialReference === null
  ) {
    throw new IdentityProviderUnavailableError(
      config.kind,
      'EXTERNAL_BLOCKED: no credential reference is registered for this configuration.',
    );
  }
}
