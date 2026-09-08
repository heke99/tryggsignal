import { describe, expect, it, vi } from 'vitest';
import { VercelDomainProvider } from '@tryggsignal/integrations';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('P37 Vercel domain provider', () => {
  it('adds a domain and preserves provider verification instructions', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        name: 'bygg.example.se',
        verified: false,
        verification: [
          {
            type: 'TXT',
            domain: '_vercel.bygg.example.se',
            value: 'vc-domain-verify=abc',
            reason: 'ownership',
          },
        ],
      }),
    );

    const provider = new VercelDomainProvider({
      token: 'test-token',
      teamId: 'team_test',
      projectId: 'prj_test',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await provider.add('bygg.example.se');
    expect(result.verified).toBe(false);
    expect(result.verification).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/v10/projects/prj_test/domains');
  });

  it('reports verified DNS + valid HTTPS as ready TLS', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://bygg.example.se/')) return new Response(null, { status: 404 });
      if (url.includes('/config')) return json({ misconfigured: false });
      return json({ name: 'bygg.example.se', verified: true, verification: [] });
    });

    const provider = new VercelDomainProvider({
      token: 'test-token',
      teamId: 'team_test',
      projectId: 'prj_test',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(provider.inspect('bygg.example.se')).resolves.toMatchObject({
      verified: true,
      dnsStatus: 'OK',
      tlsStatus: 'ISSUED',
    });
  });

  it('never treats provider verification as enough when DNS is misconfigured', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/config')) return json({ misconfigured: true });
      return json({ name: 'bygg.example.se', verified: true, verification: [] });
    });

    const provider = new VercelDomainProvider({
      token: 'test-token',
      teamId: 'team_test',
      projectId: 'prj_test',
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(provider.inspect('bygg.example.se')).resolves.toMatchObject({
      verified: true,
      dnsStatus: 'MISCONFIGURED',
      tlsStatus: 'PENDING',
    });
  });
});
