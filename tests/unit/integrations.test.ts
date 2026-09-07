import { describe, expect, it, vi } from 'vitest';
import {
  assertCapability,
  CapabilityNotSupportedError,
  decideDelivery,
  ExternalBlockedConnector,
  ExternalBlockedError,
  GenericRestConnector,
  idempotencyKey,
  resolveInboundChanges,
  type HttpClient,
} from '@tryggsignal/integrations';

const mapping = {
  externalId: 'id',
  caseNumber: 'arendenummer',
  title: 'rubrik',
  status: 'status',
  sourceVersion: 'version',
  itemsPath: 'data.items',
  nextCursorPath: 'data.next',
} as const;

function connector(http: HttpClient) {
  return new GenericRestConnector(
    {
      key: 'legacy-rest',
      baseUrl: 'https://legacy.example.invalid/api',
      caseMapping: mapping,
      capabilities: ['listCases', 'setStatus'],
      authorizationHeader: 'Bearer test-token',
    },
    http,
  );
}

describe('generic REST connector (masterplan 60/62)', () => {
  it('maps a source page to canonical cases and carries the cursor', async () => {
    const http = vi.fn<HttpClient>().mockResolvedValue({
      status: 200,
      body: {
        data: {
          items: [
            {
              id: '1',
              arendenummer: 'B-2026-1',
              rubrik: 'Nybyggnad',
              status: 'PAGAENDE',
              version: '7',
            },
            {
              id: '2',
              arendenummer: 'B-2026-2',
              rubrik: 'Tillbyggnad',
              status: 'AVSLUTAT',
              version: '3',
            },
          ],
          next: 'cursor-2',
        },
      },
    });

    const page = await connector(http).listCases(null);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      externalId: '1',
      caseNumber: 'B-2026-1',
      status: 'PAGAENDE',
      sourceVersion: '7',
    });
    expect(page.nextCursor).toBe('cursor-2');
  });

  it('drops records without a stable external id instead of inventing one', async () => {
    const http = vi.fn<HttpClient>().mockResolvedValue({
      status: 200,
      body: { data: { items: [{ arendenummer: 'B-2026-3', rubrik: 'Utan id', status: 'X' }] } },
    });
    const page = await connector(http).listCases(null);
    expect(page.items).toEqual([]);
  });

  it('reports denied access as EXTERNAL_BLOCKED rather than an empty result', async () => {
    const http = vi.fn<HttpClient>().mockResolvedValue({ status: 403, body: {} });
    await expect(connector(http).listCases(null)).rejects.toThrow(ExternalBlockedError);
  });

  it('treats a 409 on a keyed write as an already-applied write', async () => {
    const http = vi.fn<HttpClient>().mockResolvedValue({ status: 409, body: {} });
    const result = await connector(http).setStatus('1', 'CLOSED', 'key-1');
    expect(result).toMatchObject({ deduplicated: true, idempotencyKey: 'key-1' });
  });

  it('refuses a capability the connector does not declare', () => {
    const http = vi.fn<HttpClient>();
    expect(() => assertCapability(connector(http), 'createCase')).toThrow(
      CapabilityNotSupportedError,
    );
  });
});

describe('external-blocked connector slot (masterplan 134)', () => {
  it('fails loudly instead of returning fabricated data', async () => {
    const blocked = new ExternalBlockedConnector('sokigo-byggr', 'API access not granted');
    await expect(blocked.listCases()).rejects.toThrow(/EXTERNAL_BLOCKED/);
    await expect(blocked.healthCheck()).resolves.toMatchObject({ healthy: false });
  });
});

describe('idempotency (masterplan 66)', () => {
  it('produces a stable key for the same logical write', () => {
    const parts = {
      connectorInstanceId: 'ci-1',
      entityType: 'case',
      externalId: 'ext-9',
      operation: 'create',
      sourceVersion: '4',
    };
    expect(idempotencyKey(parts)).toBe(idempotencyKey({ ...parts }));
    expect(idempotencyKey(parts)).not.toBe(idempotencyKey({ ...parts, sourceVersion: '5' }));
  });

  it('skips a delivery that was already processed', () => {
    expect(decideDelivery(null)).toBe('PROCESS');
    expect(decideDelivery({ idempotencyKey: 'k', status: 'PROCESSED' })).toBe('SKIP_DUPLICATE');
    expect(decideDelivery({ idempotencyKey: 'k', status: 'FAILED' })).toBe('RETRY');
  });
});

describe('field ownership (masterplan 68)', () => {
  const ownership = { status: 'LEGACY', ai_summary: 'KOMMUN_OS', title: 'SHARED_MANUAL' } as const;

  it('applies only the fields the source system owns', () => {
    const decisions = resolveInboundChanges(
      [
        { field: 'status', localValue: 'IN_REVIEW', incomingValue: 'DECIDED' },
        { field: 'ai_summary', localValue: 'local summary', incomingValue: 'legacy summary' },
        { field: 'title', localValue: 'Vår titel', incomingValue: 'Legacy titel' },
        { field: 'status', localValue: 'DECIDED', incomingValue: 'DECIDED' },
      ],
      ownership,
    );
    expect(decisions[0]).toMatchObject({ action: 'APPLY', value: 'DECIDED' });
    expect(decisions[1]).toMatchObject({ action: 'IGNORE' });
    expect(decisions[2]).toMatchObject({ action: 'CONFLICT' });
    expect(decisions[3]).toMatchObject({ action: 'IGNORE', reason: 'No change' });
  });

  it('defaults to Tryggsignal ownership rather than overwriting silently', () => {
    const [decision] = resolveInboundChanges(
      [{ field: 'unknown_field', localValue: 'a', incomingValue: 'b' }],
      {},
    );
    expect(decision).toMatchObject({ action: 'IGNORE' });
  });
});
