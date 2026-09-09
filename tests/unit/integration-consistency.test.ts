import { describe, expect, it, vi } from 'vitest';
import {
  GenericFileConnector,
  GenericInboundWebhookConnector,
  inboundEventKey,
  GenericSqlReadConnector,
  mapExternalCase,
  mapExternalCaseItems,
  readPath,
  reconcileCases,
  sourceHash,
  type SqlReadClient,
} from '@tryggsignal/integrations';
import { handleIntegrationInbound } from '../../services/worker/src/handlers/integration-inbound';
import { ExternalBlockedError, PermanentJobError } from '../../services/worker/src/errors';
import type { JobEnvelope } from '../../services/worker/src/envelope';
import type { SqlExecutor } from '../../services/worker/src/pgmq-client';

const mapping = {
  externalId: 'id',
  caseNumber: 'number',
  title: 'title',
  status: 'status',
  mappingVersion: '1',
};
const source = { id: 'source-1', number: 'CASE-1', title: 'Synthetic', status: 'OPEN' };
function canonical() {
  const item = mapExternalCase(source, mapping);
  if (item === null) throw new Error('Invalid test fixture');
  return item;
}

describe('H canonical provenance invariants', () => {
  it('uses stable key ordering at every level and preserves array order', () => {
    expect(sourceHash({ b: { z: 2, a: 1 }, a: 0 })).toBe(sourceHash({ a: 0, b: { a: 1, z: 2 } }));
    expect(sourceHash([1, 2])).not.toBe(sourceHash([2, 1]));
    expect(sourceHash({ ä: 1, z: 2 })).toBe(sourceHash({ z: 2, ä: 1 }));
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    1n,
    new Date(),
    { value: undefined },
    [undefined],
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects payloads that JSON would discard, round or coerce: %s', (value) =>
    expect(() => sourceHash(value)).toThrow(),
  );
  it('rejects cycles instead of recursing forever', () => {
    const value: Record<string, unknown> = {};
    value['cycle'] = value;
    expect(() => sourceHash(value)).toThrow(/cycle/);
  });
  it('never maps an inherited identity', () => {
    const item: unknown = Object.create({ id: 'inherited', number: 'hidden' });
    expect(readPath(item, 'id')).toBeUndefined();
    expect(mapExternalCase(item, mapping)).toBeNull();
    expect(readPath({ constructor: { id: 'bad' } }, 'constructor.id')).toBeUndefined();
  });
  it('rejects malformed collections and missing identities before checkpoint advance', () => {
    expect(() => mapExternalCaseItems({}, mapping)).toThrow(/array/);
    expect(() => mapExternalCaseItems([source, { number: 'missing-id' }], mapping)).toThrow(
      /row 1/,
    );
    expect(() => mapExternalCaseItems([{ ...source, id: ' ' }], mapping)).toThrow();
    expect(mapExternalCaseItems([], mapping)).toEqual([]);
  });
  it('requires explicit nonblank mapping versions', () => {
    expect(() => mapExternalCase(source, { ...mapping, mappingVersion: ' ' })).toThrow();
  });
});

describe('H complete-snapshot reconciliation', () => {
  const tracked = () => ({
    externalId: source.id,
    sourceHash: canonical().sourceHash,
    sourceVersion: null,
    mappingVersion: '1',
    internalId: '00000000-0000-4000-8000-000000000001',
  });
  it('rejects duplicate tracked identities rather than hiding them in a Map', () => {
    expect(() => reconcileCases([canonical()], [tracked(), tracked()])).toThrow(/unique/);
  });
  it('does not treat an empty canonical link as a valid import', () => {
    expect(reconcileCases([canonical()], [{ ...tracked(), internalId: '' }])).toMatchObject({
      result: 'RED',
      missingInternalCount: 1,
    });
  });
  it('partitions every row exactly as the SQL RPC contract requires', () => {
    const extra = { ...canonical(), externalId: 'new' };
    const removed = { ...tracked(), externalId: 'removed' };
    const result = reconcileCases([canonical(), canonical(), extra], [tracked(), removed]);
    expect(result.sourceCount).toBe(
      result.newCount + result.changedCount + result.unchangedCount + result.duplicateSourceCount,
    );
    expect(result.recordedCount).toBe(
      result.changedCount + result.unchangedCount + result.missingSourceCount,
    );
    expect(result.missingInternalCount).toBeLessThanOrEqual(
      result.changedCount + result.unchangedCount,
    );
    expect(result.result).toBe('RED');
  });
});

describe('H SQL page integrity', () => {
  function adapter(pageSize = 100) {
    const query = vi.fn<SqlReadClient['query']>().mockResolvedValue([source]);
    return {
      query,
      connector: new GenericSqlReadConnector(
        {
          key: 'fixture',
          select: 'select id, number, title, status from approved_view',
          caseMapping: mapping,
          capabilities: ['listCases'],
          pageSize,
        },
        { query, healthCheck: vi.fn() },
      ),
    };
  }
  it.each(['2junk', '1.5', '-1', '1e3', ' ', '9007199254740992'])(
    'rejects malformed cursor %s',
    async (cursor) => {
      const { connector, query } = adapter();
      await expect(connector.listCases(cursor)).rejects.toThrow(/cursor/);
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([NaN, Infinity, 0, -1, 1.5, 1001])('rejects invalid page size %s', (size) => {
    expect(() => adapter(size)).toThrow(/page size/i);
  });
  it('uses deterministic external-id ordering with parameterized pagination', async () => {
    const { connector, query } = adapter();
    await connector.listCases(null);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('order by tryggsignal_source."id"'),
      [100, 0],
    );
  });
});

describe('H webhook identity', () => {
  it('keeps logical event identity stable across mapping releases', async () => {
    const make = (mappingVersion: string) =>
      new GenericInboundWebhookConnector(
        {
          key: 'fixture',
          eventIdPath: 'id',
          eventTypePath: 'type',
          mappingVersion,
        },
        async () => true,
      );
    const request = { headers: {}, body: { id: 'evt-1', type: 'case.changed' } };
    const first = await make('1').receive('connector-1', request);
    const remapped = await make('2').receive('connector-1', request);
    expect(first.idempotencyKey).toBe(remapped.idempotencyKey);
    expect(first.mappingVersion).not.toBe(remapped.mappingVersion);
  });
});

function envelope(): JobEnvelope {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    type: 'integration_inbound',
    tenantContext: '22222222-2222-4222-8222-222222222222',
    authorityContext: '33333333-3333-4333-8333-333333333333',
    correlationId: '44444444-4444-4444-8444-444444444444',
    causationId: null,
    idempotencyKey: 'integration-1',
    payload: { integration_event_id: 1 },
    attempt: 1,
    createdAt: '2026-09-09T00:00:00Z',
    queue: 'integration_inbound',
  };
}
function database(status = 'RECEIVED') {
  const statements: string[] = [];
  const row = {
    id: '1',
    status,
    authority_id: envelope().authorityContext,
    connector_instance_id: envelope().tenantContext,
    attempt: 0,
  };
  const sql: SqlExecutor = {
    async query<TRow>(statement: string) {
      statements.push(statement);
      return { rows: [row] as TRow[] };
    },
  };
  return { sql, statements };
}

describe('H inbound canonical acknowledgement', () => {
  it('does not fabricate PROCESSED when no verified apply adapter exists', async () => {
    const { sql, statements } = database();
    await expect(handleIntegrationInbound(envelope(), sql)).rejects.toThrow(ExternalBlockedError);
    expect(statements).toHaveLength(1);
    expect(statements.every((statement) => /^select\b/i.test(statement))).toBe(true);
  });
  it('validates authority as well as connector before even accepting a replay', async () => {
    const { sql } = database('PROCESSED');
    await expect(
      handleIntegrationInbound({ ...envelope(), authorityContext: null }, sql),
    ).rejects.toThrow(PermanentJobError);
    await expect(
      handleIntegrationInbound({ ...envelope(), authorityContext: 'another-authority' }, sql),
    ).rejects.toThrow(/scope/);
  });
  it('acknowledges an already applied in-scope event without rewriting it', async () => {
    const { sql, statements } = database('PROCESSED');
    await expect(handleIntegrationInbound(envelope(), sql)).resolves.toBeUndefined();
    expect(statements).toHaveLength(1);
  });
  it('rejects rounded or oversized bigint ids before SQL', async () => {
    const { sql, statements } = database();
    await expect(
      handleIntegrationInbound(
        { ...envelope(), payload: { integration_event_id: '9223372036854775808' } },
        sql,
      ),
    ).rejects.toThrow(/valid/);
    expect(statements).toEqual([]);
  });
});

describe('H unambiguous event identity and CSV record boundaries', () => {
  it('frames event identity so separators cannot alias distinct inputs', () => {
    expect(
      inboundEventKey({ connectorInstanceId: 'one', externalEventId: 'a|b', eventType: 'cd' }),
    ).not.toBe(
      inboundEventKey({ connectorInstanceId: 'one', externalEventId: 'a', eventType: 'b|cd' }),
    );
    expect(
      inboundEventKey({
        connectorInstanceId: 'one',
        externalEventId: 'event',
        eventType: 'changed',
      }),
    ).toMatch(/^event:v1:[a-f0-9]{64}$/);
  });
  it('rejects identities that the database would trim into another identity', () => {
    expect(() =>
      inboundEventKey({
        connectorInstanceId: 'one',
        externalEventId: 'event ',
        eventType: 'changed',
      }),
    ).toThrow(/identity/);
  });
  function csv(text: string) {
    return new GenericFileConnector(
      { key: 'csv', format: 'CSV', caseMapping: mapping, capabilities: ['listCases'] },
      {
        healthCheck: vi.fn(),
        list: async () => ({ items: [{ path: 'fixture.csv' }], nextCursor: null }),
        read: async () => text,
      },
    );
  }
  it('preserves CRLF, delimiters and escaped quotes inside a quoted field', async () => {
    const adapter = csv('id,number,title,status\r\n1,C-1,"Line one\r\nLine ""two"", end",OPEN\r\n');
    const result = await adapter.listCases(null);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe('Line one\r\nLine "two", end');
  });
  it.each([
    'id,number,title,status\n1,C-1,"never closed,OPEN',
    'id,number,title,status\n1,C-1,"closed"junk,OPEN',
  ])('rejects malformed CSV rather than changing data: %s', async (text) => {
    await expect(csv(text).listCases(null)).rejects.toThrow(/CSV/);
  });
});
