import { describe, expect, it, vi } from 'vitest';
import { SupabaseManagementProvider } from '@tryggsignal/integrations';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('P39 Supabase management provider', () => {
  it('creates a project through the documented platforms endpoint', async () => {
    const fetchImpl = vi.fn(async () => json({ ref: 'abc123', name: 'tenant-a' }, 201));
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      provider.createProject({
        name: 'tenant-a',
        organizationSlug: 'org-test',
        databasePassword: 'a-unique-database-password-with-more-than-32-characters',
        region: 'emea',
      }),
    ).resolves.toMatchObject({ ref: 'abc123' });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.supabase.com/v1/projects');
    expect(String(init.body)).toContain('organization_slug');
    expect(String(init.body)).toContain('region_selection');
  });

  it('refuses weak/reused-looking database password inputs before provider IO', async () => {
    const fetchImpl = vi.fn();
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      provider.createProject({
        name: 'tenant-a',
        organizationSlug: 'org-test',
        databasePassword: 'short',
        region: 'emea',
      }),
    ).rejects.toThrow(/high-entropy/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires every reported service to be ACTIVE_HEALTHY', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        { name: 'db', status: 'ACTIVE_HEALTHY' },
        { name: 'auth', status: 'ACTIVE_HEALTHY' },
      ]),
    );
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(provider.isHealthy('abc123')).resolves.toBe(true);
  });

  it('selects only an active modern publishable API key', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        { type: 'publishable', api_key: 'sb_publishable_disabled', disabled: true },
        { type: 'publishable', api_key: 'sb_publishable_live', disabled: false },
      ]),
    );
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(provider.publishableKey('abc123')).resolves.toBe('sb_publishable_live');
  });
});
