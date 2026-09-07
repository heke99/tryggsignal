/**
 * Masterplan 173: SecretProvider abstraction. Per-tenant credentials are looked
 * up by reference so hundreds of municipality credentials never become
 * hard-coded environment constants, and the backing store stays replaceable.
 */

export interface SecretRecord {
  readonly reference: string;
  readonly value: string;
  readonly version: string;
  readonly rotatedAt: string | null;
}

export interface SecretProvider {
  getSecret(reference: string): Promise<SecretRecord>;
  rotateSecret(reference: string): Promise<SecretRecord>;
  healthCheck(): Promise<{ readonly healthy: boolean; readonly detail: string }>;
}

export class SecretNotFoundError extends Error {
  constructor(reference: string) {
    super(`No secret registered for reference "${reference}"`);
    this.name = 'SecretNotFoundError';
  }
}

/**
 * Pilot-scale implementation backed by process environment, addressed by
 * reference rather than by hard-coded variable name. Rotation is delegated to
 * the platform, so it reports NOT_SUPPORTED rather than pretending to rotate.
 */
export class EnvSecretProvider implements SecretProvider {
  constructor(
    private readonly source: Readonly<Record<string, string | undefined>>,
    private readonly prefix = 'TS_SECRET_',
  ) {}

  private key(reference: string): string {
    return this.prefix + reference.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  }

  async getSecret(reference: string): Promise<SecretRecord> {
    const value = this.source[this.key(reference)];
    if (value === undefined || value === '') throw new SecretNotFoundError(reference);
    return { reference, value, version: 'env', rotatedAt: null };
  }

  async rotateSecret(reference: string): Promise<SecretRecord> {
    throw new Error(
      `Rotation of "${reference}" is not supported by EnvSecretProvider; rotate in the platform secret store.`,
    );
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: 'EnvSecretProvider ready' };
  }
}
