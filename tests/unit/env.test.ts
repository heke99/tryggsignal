import { describe, expect, it } from 'vitest';
import { EnvValidationError, validateEnv, EnvSecretProvider } from '@tryggsignal/config';

const valid = {
  NEXT_PUBLIC_ROOT_DOMAIN: 'tryggsignal.se',
  CONTROL_PLANE_SUPABASE_URL: 'https://example.supabase.co',
  CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
  CONTROL_PLANE_SECRET_REFERENCE: 'control-plane/service-role',
  SIGN_IN_STATE_SECRET: 's'.repeat(48),
  RATE_LIMIT_KEY_SECRET: 'r'.repeat(48),
};

describe('validateEnv (masterplan 85)', () => {
  it('accepts a complete platform configuration', () => {
    expect(validateEnv(valid).NEXT_PUBLIC_ROOT_DOMAIN).toBe('tryggsignal.se');
  });

  it('reports missing required variables', () => {
    expect(() => validateEnv({ NEXT_PUBLIC_ROOT_DOMAIN: 'tryggsignal.se' })).toThrow(
      EnvValidationError,
    );
  });

  it('requires server-only tenant runtime and auth secrets', () => {
    const missing = {
      ...valid,
      CONTROL_PLANE_SECRET_REFERENCE: undefined,
      RATE_LIMIT_KEY_SECRET: undefined,
    };
    expect(() => validateEnv(missing)).toThrow(/CONTROL_PLANE_SECRET_REFERENCE/);
    expect(() => validateEnv(missing)).toThrow(/RATE_LIMIT_KEY_SECRET/);
  });

  it('refuses secrets exposed through NEXT_PUBLIC_*', () => {
    expect(() => validateEnv({ ...valid, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'x' })).toThrow(
      /SERVICE_ROLE/,
    );
  });
});

describe('EnvSecretProvider (masterplan 173)', () => {
  it('resolves secrets by reference', async () => {
    const provider = new EnvSecretProvider({ TS_SECRET_TENANT_MJOLBY_SERVICE: 'value' });
    await expect(provider.getSecret('tenant/mjolby/service')).resolves.toMatchObject({
      value: 'value',
    });
  });

  it('fails loudly for an unknown reference instead of returning a default', async () => {
    const provider = new EnvSecretProvider({});
    await expect(provider.getSecret('tenant/unknown/service')).rejects.toThrow(/No secret/);
  });
});
