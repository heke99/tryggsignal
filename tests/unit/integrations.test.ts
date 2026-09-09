import { describe, expect, it, vi } from 'vitest';
import {
  assertCapability,
  CapabilityNotSupportedError,
  decideDelivery,
  ExternalBlockedConnector,
  ExternalBlockedError,
  GenericFileConnector,
  GenericInboundWebhookConnector,
  GenericRestConnector,
  GenericSftpConnector,
  GenericSoapConnectorSlot,
  GenericSqlReadConnector,
  idempotencyKey,
  mapExternalCase,
  reconcileCases,
  resolveInboundChanges,
  sourceHash,
  type FileSource,
  type HttpClient,
  type SftpClient,
  type SqlReadClient,
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

  it('rejects a configuration that claims an unimplemented REST capability', () => {
    const http = vi.fn<HttpClient>();
    expect(
      () =>
        new GenericRestConnector(
          {
            key: 'lying-rest',
            baseUrl: 'https://legacy.example.invalid/api',
            caseMapping: mapping,
            capabilities: ['createCase'],
          },
          http,
        ),
    ).toThrow(/does not implement declared capabilities/);
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

const genericMapping = {
  externalId: 'id',
  caseNumber: 'case_number',
  title: 'title',
  status: 'status',
  sourceVersion: 'version',
  sourceUpdatedAt: 'updated_at',
  mappingVersion: 'h-1',
} as const;

const healthy = {
  healthy: true,
  detail: 'ok',
  checkedAt: '2026-09-09T08:00:00.000Z',
} as const;

describe('Phase H generic file connector', () => {
  it('maps JSONL files through the canonical mapping contract', async () => {
    const source: FileSource = {
      healthCheck: vi.fn().mockResolvedValue(healthy),
      list: vi.fn().mockResolvedValue({
        items: [{ path: '/export/cases.jsonl' }],
        nextCursor: 'file-cursor-2',
      }),
      read: vi.fn().mockResolvedValue(
        [
          JSON.stringify({
            id: 'f-1',
            case_number: 'F-2026-1',
            title: 'Filärende',
            status: 'OPEN',
            version: '7',
            updated_at: '2026-09-09T07:00:00Z',
          }),
          JSON.stringify({
            id: 'f-2',
            case_number: 'F-2026-2',
            title: 'Filärende två',
            status: 'CLOSED',
            version: '3',
            updated_at: '2026-09-09T07:30:00Z',
          }),
        ].join('\n'),
      ),
    };

    const adapter = new GenericFileConnector(
      {
        key: 'file-import',
        format: 'JSONL',
        caseMapping: genericMapping,
        capabilities: ['listCases'],
      },
      source,
    );

    await expect(adapter.healthCheck()).resolves.toMatchObject({ healthy: true });
    const page = await adapter.listCases(null);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      externalId: 'f-1',
      caseNumber: 'F-2026-1',
      mappingVersion: 'h-1',
    });
    expect(page.items[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.nextCursor).toBe('file-cursor-2');
  });

  it('parses CSV without transport-specific field assumptions', async () => {
    const source: FileSource = {
      healthCheck: vi.fn().mockResolvedValue(healthy),
      list: vi.fn().mockResolvedValue({
        items: [{ path: '/export/cases.csv' }],
        nextCursor: null,
      }),
      read: vi
        .fn()
        .mockResolvedValue(
          'id,case_number,title,status,version,updated_at\ncsv-1,C-1,"Bygglov, centrum",OPEN,1,2026-09-09',
        ),
    };
    const adapter = new GenericFileConnector(
      {
        key: 'csv-import',
        format: 'CSV',
        caseMapping: genericMapping,
        capabilities: ['listCases'],
      },
      source,
    );

    const page = await adapter.listCases(null);
    expect(page.items[0]).toMatchObject({
      externalId: 'csv-1',
      title: 'Bygglov, centrum',
    });
  });

  it('rejects a capability that the file transport does not implement', () => {
    const source: FileSource = {
      healthCheck: vi.fn(),
      list: vi.fn(),
      read: vi.fn(),
    };
    expect(
      () =>
        new GenericFileConnector(
          {
            key: 'bad-file',
            format: 'JSON_ARRAY',
            caseMapping: genericMapping,
            capabilities: ['setStatus'],
          },
          source,
        ),
    ).toThrow(/only listCases/);
  });
});

describe('Phase H generic SFTP connector', () => {
  it('uses the same file mapping contract over an injected SFTP transport', async () => {
    const client: SftpClient = {
      healthCheck: vi.fn().mockResolvedValue(healthy),
      list: vi.fn().mockResolvedValue({
        items: [{ path: '/inbox/cases.json' }],
        nextCursor: null,
      }),
      read: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            id: 'sftp-1',
            case_number: 'SFTP-1',
            title: 'SFTP ärende',
            status: 'OPEN',
            version: '1',
            updated_at: '2026-09-09',
          },
        ]),
      ),
    };
    const adapter = new GenericSftpConnector(
      {
        key: 'legacy-sftp',
        remoteDirectory: '/inbox',
        format: 'JSON_ARRAY',
        caseMapping: genericMapping,
        capabilities: ['listCases'],
      },
      client,
    );

    const page = await adapter.listCases(null);
    expect(client.list).toHaveBeenCalledWith('/inbox', null);
    expect(page.items[0]).toMatchObject({
      externalId: 'sftp-1',
      caseNumber: 'SFTP-1',
      mappingVersion: 'h-1',
    });
  });

  it('rejects SFTP paths that escape the configured remote directory', async () => {
    const client: SftpClient = {
      healthCheck: vi.fn().mockResolvedValue(healthy),
      list: vi.fn().mockResolvedValue({
        items: [{ path: '/other-tenant/cases.json' }],
        nextCursor: null,
      }),
      read: vi.fn(),
    };
    const adapter = new GenericSftpConnector(
      {
        key: 'legacy-sftp',
        remoteDirectory: '/inbox',
        format: 'JSON_ARRAY',
        caseMapping: genericMapping,
        capabilities: ['listCases'],
      },
      client,
    );

    await expect(adapter.listCases(null)).rejects.toThrow(/outside the configured remote directory/);
    expect(client.read).not.toHaveBeenCalled();
  });
});

describe('Phase H generic SQL-read connector', () => {
  it('pages a single read-only SELECT and maps rows canonically', async () => {
    const query = vi
      .fn<SqlReadClient['query']>()
      .mockResolvedValueOnce([
        {
          id: 'sql-1',
          case_number: 'SQL-1',
          title: 'SQL ett',
          status: 'OPEN',
          version: '1',
          updated_at: '2026-09-09',
        },
        {
          id: 'sql-2',
          case_number: 'SQL-2',
          title: 'SQL två',
          status: 'OPEN',
          version: '1',
          updated_at: '2026-09-09',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'sql-3',
          case_number: 'SQL-3',
          title: 'SQL tre',
          status: 'CLOSED',
          version: '2',
          updated_at: '2026-09-09',
        },
      ]);
    const client: SqlReadClient = {
      healthCheck: vi.fn().mockResolvedValue(healthy),
      query,
    };
    const adapter = new GenericSqlReadConnector(
      {
        key: 'legacy-sql',
        select: 'select id, case_number, title, status, version, updated_at from legacy_cases',
        caseMapping: genericMapping,
        capabilities: ['listCases'],
        pageSize: 2,
      },
      client,
    );

    const first = await adapter.listCases(null);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^select \* from \(select /i),
      [2, 0],
    );

    const second = await adapter.listCases(first.nextCursor);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects mutating SQL instead of relying on database permissions alone', () => {
    const client: SqlReadClient = {
      healthCheck: vi.fn(),
      query: vi.fn(),
    };
    expect(
      () =>
        new GenericSqlReadConnector(
          {
            key: 'unsafe-sql',
            select: "update cases set status = 'CLOSED' returning *",
            caseMapping: genericMapping,
            capabilities: ['listCases'],
          },
          client,
        ),
    ).toThrow(/only a SELECT/);
  });
});

describe('Phase H SOAP slot and inbound webhook', () => {
  it('keeps SOAP capability external-blocked until a verified WSDL contract exists', async () => {
    const soap = new GenericSoapConnectorSlot({ key: 'generic-soap' });
    await expect(soap.healthCheck()).resolves.toMatchObject({ healthy: false });
    await expect(soap.listCases()).rejects.toThrow(ExternalBlockedError);
  });

  it('verifies webhook auth and produces stable idempotent provenance', async () => {
    const adapter = new GenericInboundWebhookConnector(
      {
        key: 'generic-webhook',
        eventIdPath: 'event.id',
        eventTypePath: 'event.type',
        mappingVersion: 'webhook-2',
      },
      vi.fn().mockResolvedValue(true),
    );
    const request = {
      headers: { 'x-signature': 'fixture' },
      body: {
        event: { id: 'evt-42', type: 'case.changed' },
        case: { id: 'legacy-42', status: 'OPEN' },
      },
    };

    const first = await adapter.receive('connector-instance-1', request);
    const second = await adapter.receive('connector-instance-1', request);

    expect(first).toMatchObject({
      externalEventId: 'evt-42',
      eventType: 'case.changed',
      mappingVersion: 'webhook-2',
    });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.sourceHash).toBe(second.sourceHash);
  });

  it('fails closed when webhook authentication fails', async () => {
    const adapter = new GenericInboundWebhookConnector(
      {
        key: 'generic-webhook',
        eventIdPath: 'id',
        eventTypePath: 'type',
      },
      vi.fn().mockResolvedValue(false),
    );
    await expect(
      adapter.receive('connector-instance-1', {
        headers: {},
        body: { id: '1', type: 'changed' },
      }),
    ).rejects.toThrow(ExternalBlockedError);
  });
});

describe('Phase H provenance and reconciliation', () => {
  it('hashes equivalent object payloads deterministically', () => {
    expect(sourceHash({ b: 2, a: 1 })).toBe(sourceHash({ a: 1, b: 2 }));
  });

  it('returns GREEN only when tracked provenance matches the source exactly', () => {
    const source = [
      mapExternalCase(
        {
          id: 'r-1',
          case_number: 'R-1',
          title: 'Reconcile',
          status: 'OPEN',
          version: '9',
          updated_at: '2026-09-09',
        },
        genericMapping,
      ),
    ].filter((item): item is NonNullable<typeof item> => item !== null);

    const result = reconcileCases(
      source,
      source.map((item) => ({
        externalId: item.externalId,
        sourceHash: item.sourceHash,
        sourceVersion: item.sourceVersion,
        mappingVersion: item.mappingVersion,
        internalId: '00000000-0000-4000-8000-000000000001',
      })),
    );
    expect(result).toMatchObject({
      result: 'GREEN',
      unchangedCount: 1,
      duplicateSourceCount: 0,
    });
  });

  it('marks duplicate source identity RED instead of importing twice', () => {
    const item = mapExternalCase(
      {
        id: 'dup-1',
        case_number: 'DUP-1',
        title: 'Duplicate',
        status: 'OPEN',
        version: '1',
        updated_at: '2026-09-09',
      },
      genericMapping,
    );
    if (item === null) throw new Error('fixture did not map');

    const result = reconcileCases([item, item], []);
    expect(result).toMatchObject({
      result: 'RED',
      duplicateSourceCount: 1,
    });
  });
});
