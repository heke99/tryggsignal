import { describe, expect, it } from 'vitest';
import { EnvValidationError, validateEnv, EnvSecretProvider } from '@tryggsignal/config';

const valid = {
  NEXT_PUBLIC_ROOT_DOMAIN: 'tryggsignal.se',
  CONTROL_PLANE_SUPABASE_URL: 'https://example.supabase.co',
  CONTROL_PLANE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
};

describe('validateEnv (masterplan 85)', () => {
  it('accepts a complete configuration', () => {
    expect(validateEnv(valid).NEXT_PUBLIC_ROOT_DOMAIN).toBe('tryggsignal.se');
  });

  it('reports missing required variables', () => {
    expect(() => validateEnv({ NEXT_PUBLIC_ROOT_DOMAIN: 'tryggsignal.se' })).toThrow(
      EnvValidationError,
    );
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
