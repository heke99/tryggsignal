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
    const fetchImpl = vi.fn(async () =>
      json(
        {
          id: 'abc123',
          name: 'tenant-a',
          organization_id: 'org-test',
          organization_slug: 'org-test',
        },
        201,
      ),
    );
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
    ).resolves.toMatchObject({
      ref: 'abc123',
      organizationId: 'org-test',
      organizationSlug: 'org-test',
    });

    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.supabase.com/v1/projects');
    expect(String(init.body)).toContain('organization_slug');
    expect(String(init.body)).toContain('region_selection');
  });

  it('reuses a deterministic existing project instead of creating a duplicate', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.supabase.com/v1/projects' && init?.method !== 'POST') {
        return json([
          {
            id: 'existing-ref',
            name: 'ts-tenant-a-1234',
            organization_id: 'org-test',
            organization_slug: 'org-test',
            status: 'ACTIVE_HEALTHY',
          },
        ]);
      }
      throw new Error('createProject should not be called when the deterministic project exists');
    });

    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      provider.ensureProject({
        name: 'ts-tenant-a-1234',
        organizationSlug: 'org-test',
        databasePassword: 'a-unique-database-password-with-more-than-32-characters',
        region: 'emea',
      }),
    ).resolves.toEqual({
      project: {
        ref: 'existing-ref',
        name: 'ts-tenant-a-1234',
        organizationId: 'org-test',
        organizationSlug: 'org-test',
        region: undefined,
        status: 'ACTIVE_HEALTHY',
      },
      created: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('creates the deterministic project only when discovery finds no match', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://api.supabase.com/v1/projects' && init?.method !== 'POST') {
        return json([]);
      }
      return json(
        {
          id: 'new-ref',
          name: 'ts-tenant-a-1234',
          organization_id: 'org-test',
          organization_slug: 'org-test',
        },
        201,
      );
    });

    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      provider.ensureProject({
        name: 'ts-tenant-a-1234',
        organizationSlug: 'org-test',
        databasePassword: 'a-unique-database-password-with-more-than-32-characters',
        region: 'emea',
      }),
    ).resolves.toMatchObject({ created: true, project: { ref: 'new-ref' } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses ambiguous duplicate provider projects', async () => {
    const fetchImpl = vi.fn(async () =>
      json([
        {
          id: 'ref-a',
          name: 'ts-tenant-a-1234',
          organization_slug: 'org-test',
        },
        {
          id: 'ref-b',
          name: 'ts-tenant-a-1234',
          organization_slug: 'org-test',
        },
      ]),
    );
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      provider.ensureProject({
        name: 'ts-tenant-a-1234',
        organizationSlug: 'org-test',
        databasePassword: 'a-unique-database-password-with-more-than-32-characters',
        region: 'emea',
      }),
    ).rejects.toThrow(/Multiple Supabase projects/);
  });

  it('exposes migrations, query and security-advisor endpoints through the provider boundary', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/advisors/security')) return json({ lints: [] });
      if (String(input).includes('/database/query')) return json([{ ok: true }]);
      return json({}, 201);
    });
    const provider = new SupabaseManagementProvider({
      accessToken: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await provider.applyMigration('abc123', 'base_schema', 'select 1;');
    await expect(provider.databaseQuery('abc123', 'select 1;')).resolves.toEqual([{ ok: true }]);
    await expect(provider.securityAdvisor('abc123')).resolves.toEqual({ lints: [] });

    expect(fetchImpl.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://api.supabase.com/v1/projects/abc123/database/migrations',
      'https://api.supabase.com/v1/projects/abc123/database/query',
      'https://api.supabase.com/v1/projects/abc123/advisors/security',
    ]);
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
