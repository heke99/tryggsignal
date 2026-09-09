/** Shared by Vitest and the offline review runner. Synthetic data only.
 * These are unit/contract tests, NOT a durable database migration or live SFTP test.
 */
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mapExternalCaseItems, sourceHash } from '../../packages/integrations/src/mapping';
import { idempotencyKey, inboundEventKey } from '../../packages/integrations/src/idempotency';
import {
  GenericFileConnector,
  GenericSftpConnector,
  GenericSqlReadConnector,
  GenericInboundWebhookConnector,
  type FileSource,
  type FilePage,
} from '../../packages/integrations/src/transport-adapters';
import {
  applyMapping,
  captureRaw,
  type MappingVersion,
} from '../../packages/migration-engine/src/pipeline';
import { reconcile } from '../../packages/migration-engine/src/reconciliation';

export interface RegressionCase {
  readonly name: string;
  readonly run: () => void | Promise<void>;
  readonly timeoutMs?: number;
}

const caseMapping = { externalId: 'id', caseNumber: 'number', title: 'title', status: 'status' };
const row = { id: 'case-1', number: 'TEST-1', title: 'Synthetic case', status: 'NEW' };
const healthCheck = async () => ({
  healthy: true,
  detail: 'synthetic',
  checkedAt: '2026-09-09T00:00:00Z',
});
function fileSource(page: FilePage, read: FileSource['read']): FileSource {
  return { healthCheck, list: async () => page, read };
}
function fileConnector(source: FileSource) {
  return new GenericFileConnector(
    { key: 'synthetic-file', format: 'JSON_ARRAY', caseMapping, capabilities: ['listCases'] },
    source,
  );
}
function webhook(eventType = 'case.changed') {
  return {
    connector: new GenericInboundWebhookConnector(
      { key: 'synthetic-hook', eventIdPath: 'id', eventTypePath: 'type' },
      async () => true,
    ),
    request: { headers: {}, body: { id: 'event-1', type: eventType } },
  };
}
function raw(payload: unknown) {
  return captureRaw({
    sourceSystem: 'SYNTHETIC_LEGACY',
    sourceVersion: 'fixture-v1',
    sourceObject: 'CASE',
    sourcePrimaryKey: 'case-1',
    rawPayload: payload,
    exportedAt: '2026-09-09T00:00:00Z',
  });
}
const lookupMapping: MappingVersion = {
  mappingKey: 'synthetic-case',
  version: 1,
  entityType: 'case',
  rules: [
    { kind: 'lookup', from: 'status', to: 'status', table: { P: 'IN_REVIEW' }, onMissing: 'ERROR' },
  ],
};
const cleanCounts = {
  sourceCaseCount: 2,
  targetCaseCount: 2,
  sourceDocumentCount: 3,
  targetDocumentCount: 3,
  missingIds: [],
  duplicateIds: [],
  hashMismatchIds: [],
  brokenRelationIds: [],
  unmappedStatuses: [],
  unmappedClassifications: [],
  orphanDocumentIds: [],
};

export const regressionCases: readonly RegressionCase[] = [
  {
    name: 'H: ordinary source mapping preserves identity and hash',
    run() {
      const items = mapExternalCaseItems([row], caseMapping);
      assert.equal(items[0]?.externalId, row.id);
      assert.equal(items[0]?.sourceHash, sourceHash(row));
      assert.equal(items[0]?.raw, row);
    },
  },
  {
    name: 'H: sparse source collections are rejected rather than skipped',
    run() {
      const items: unknown[] = new Array(2);
      items[1] = row;
      assert.throws(() => mapExternalCaseItems(items, caseMapping), /sparse|missing/i);
    },
  },
  {
    name: 'H: a sparse SQL page cannot advance a cursor',
    async run() {
      const rows: Record<string, unknown>[] = new Array(2);
      rows[1] = row;
      const connector = new GenericSqlReadConnector(
        {
          key: 'synthetic-sql',
          select: 'select id, number, title, status from fixture_view',
          caseMapping,
          capabilities: ['listCases'],
          pageSize: 2,
        },
        { healthCheck, query: async () => rows },
      );
      await assert.rejects(connector.listCases(null), /sparse|missing/i);
    },
  },
  {
    name: 'H: one 150000-row file does not overflow the argument stack',
    timeoutMs: 30_000,
    async run() {
      const count = 150_000;
      const text = JSON.stringify(
        Array.from({ length: count }, (_, i) => ({ ...row, id: String(i + 1) })),
      );
      const connector = fileConnector(
        fileSource({ items: [{ path: 'fixture.json' }], nextCursor: null }, async () => text),
      );
      const page = await connector.listCases(null);
      assert.equal(page.items.length, count);
      assert.equal(page.items[count - 1]?.externalId, String(count));
      assert.equal(page.nextCursor, null);
    },
  },
  {
    name: 'H: malformed file cursor fails before reading files',
    async run() {
      let reads = 0;
      const page = { items: [{ path: 'fixture.json' }] } as unknown as FilePage;
      const connector = fileConnector(
        fileSource(page, async () => {
          reads += 1;
          return '[]';
        }),
      );
      await assert.rejects(connector.listCases(null), /cursor|page/i);
      assert.equal(reads, 0);
    },
  },
  {
    name: 'H: a repeated file cursor fails instead of polling indefinitely',
    async run() {
      const connector = fileConnector(
        fileSource({ items: [], nextCursor: 'page-1' }, async () => '[]'),
      );
      await assert.rejects(connector.listCases('page-1'), /cursor|page/i);
    },
  },
  {
    name: 'H: all file entries are validated before the first file read',
    async run() {
      let reads = 0;
      const page = { items: [{ path: 'good.json' }, { path: '' }], nextCursor: null };
      const connector = fileConnector(
        fileSource(page, async () => {
          reads += 1;
          return '[]';
        }),
      );
      await assert.rejects(connector.listCases(null), /entry|path/i);
      assert.equal(reads, 0);
    },
  },
  {
    name: 'H: SFTP uses the same page validation',
    async run() {
      const connector = new GenericSftpConnector(
        {
          key: 'synthetic-sftp',
          remoteDirectory: '/export',
          format: 'JSON_ARRAY',
          caseMapping,
          capabilities: ['listCases'],
        },
        {
          healthCheck,
          list: async () => ({ items: [], nextCursor: 'same' }),
          read: async () => '[]',
        },
      );
      await assert.rejects(connector.listCases('same'), /cursor|page/i);
    },
  },
  {
    name: 'H: SFTP valid file transport contract is unchanged',
    async run() {
      const connector = new GenericSftpConnector(
        {
          key: 'synthetic-sftp',
          remoteDirectory: '/export',
          format: 'JSON_ARRAY',
          caseMapping,
          capabilities: ['listCases'],
        },
        {
          healthCheck,
          list: async () => ({ items: [{ path: '/export/one.json' }], nextCursor: null }),
          read: async (path) => {
            assert.equal(path, '/export/one.json');
            return JSON.stringify([row]);
          },
        },
      );
      assert.equal((await connector.listCases(null)).items[0]?.externalId, row.id);
    },
  },
  {
    name: 'H: CSV quoted multiline records remain intact',
    async run() {
      const connector = new GenericFileConnector(
        { key: 'synthetic-csv', format: 'CSV', caseMapping, capabilities: ['listCases'] },
        fileSource(
          { items: [{ path: 'one.csv' }], nextCursor: null },
          async () => 'id,number,title,status\r\n1,T-1,"line one\nline two",NEW\r\n',
        ),
      );
      assert.equal((await connector.listCases(null)).items[0]?.title, 'line one\nline two');
    },
  },
  ...['x', '😀'].map(
    (eventType): RegressionCase => ({
      name: `H: webhook rejects a one-character event type (${eventType}) before the RPC`,
      async run() {
        const { connector, request } = webhook(eventType);
        await assert.rejects(
          connector.receive('synthetic-instance', request),
          /identity|event type/i,
        );
      },
    }),
  ),
  {
    name: 'H: webhook rejects an array payload even with mapped numeric paths',
    async run() {
      const connector = new GenericInboundWebhookConnector(
        { key: 'synthetic-hook', eventIdPath: '0', eventTypePath: '1' },
        async () => true,
      );
      await assert.rejects(
        connector.receive('synthetic-instance', { headers: {}, body: ['event-1', 'case.changed'] }),
        /object|payload/i,
      );
    },
  },
  {
    name: 'H: valid event keys preserve the event:v1 codec',
    async run() {
      const { connector, request } = webhook();
      const event = await connector.receive('synthetic-instance', request);
      const encoded = JSON.stringify([
        'tryggsignal-inbound-event/v1',
        'synthetic-instance',
        'event-1',
        'case.changed',
      ]);
      assert.equal(
        event.idempotencyKey,
        'event:v1:' + createHash('sha256').update(encoded).digest('hex'),
      );
      assert.equal(
        event.idempotencyKey,
        inboundEventKey({
          connectorInstanceId: 'synthetic-instance',
          externalEventId: 'event-1',
          eventType: 'case.changed',
        }),
      );
      assert.equal(event.sourceHash, sourceHash(request.body));
    },
  },
  {
    name: 'H: legacy write idempotency remains byte-compatible',
    run() {
      assert.equal(
        idempotencyKey({
          connectorInstanceId: 'a',
          entityType: 'CASE',
          externalId: 'b',
          operation: 'CREATE',
        }),
        createHash('sha256').update('a|CASE|b|CREATE|').digest('hex'),
      );
    },
  },
  {
    name: 'H: raw signature bytes reach the verifier unchanged',
    async run() {
      const bytes = new TextEncoder().encode('{"id":"event-1", "type":"case.changed"}');
      const connector = new GenericInboundWebhookConnector(
        { key: 'synthetic-hook', eventIdPath: 'id', eventTypePath: 'type' },
        async (request) => {
          assert.equal(request.rawBody, bytes);
          return true;
        },
      );
      await connector.receive('synthetic-instance', {
        headers: {},
        body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        rawBody: bytes,
      });
    },
  },
  {
    name: 'H: invalid authentication does not produce a receipt',
    async run() {
      const connector = new GenericInboundWebhookConnector(
        { key: 'synthetic-hook', eventIdPath: 'id', eventTypePath: 'type' },
        async () => false,
      );
      await assert.rejects(
        connector.receive('synthetic-instance', webhook().request),
        /authentication failed/,
      );
    },
  },
  {
    name: 'I: inherited lookup entries are not source mapping rules',
    run() {
      const table = Object.create({ Z: 'CLOSED' }) as Record<string, string>;
      const result = applyMapping(raw({ status: 'Z' }), {
        ...lookupMapping,
        rules: [{ kind: 'lookup', from: 'status', to: 'status', table, onMissing: 'ERROR' }],
      });
      assert.equal(result.errors[0]?.code, 'UNMAPPED_VALUE');
      assert.equal(result.canonical['status'], undefined);
    },
  },
  {
    name: 'I: inherited source fields are not captured source data',
    run() {
      const payload = Object.create({ status: 'P' }) as Record<string, unknown>;
      const result = applyMapping(raw(payload), lookupMapping);
      assert.equal(result.errors[0]?.code, 'UNMAPPED_VALUE');
    },
  },
  {
    name: 'I: mapping cannot write prototype-reserved output fields',
    run() {
      assert.throws(
        () =>
          applyMapping(raw({ status: 'P' }), {
            ...lookupMapping,
            rules: [{ kind: 'constant', to: '__proto__', value: {} }],
          }),
        /target|field/i,
      );
    },
  },
  {
    name: 'I: valid mapping retains historical raw hash and provenance',
    run() {
      const payload = { status: 'P', title: 'Test' };
      const captured = raw(payload);
      const result = applyMapping(captured, lookupMapping);
      assert.equal(
        captured.sourceHash,
        createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      );
      assert.equal(result.canonical['status'], 'IN_REVIEW');
      assert.equal(result.canonical['source_system'], 'SYNTHETIC_LEGACY');
      assert.equal(result.canonical['source_record_id'], 'case-1');
      assert.equal(result.canonical['migration_mapping_version'], 1);
      assert.deepEqual(result.errors, []);
    },
  },
  ...[-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
    (count): RegressionCase => ({
      name: `I: invalid equal source/target counts are rejected (${String(count)})`,
      run() {
        assert.throws(
          () => reconcile({ ...cleanCounts, sourceCaseCount: count, targetCaseCount: count }),
          /count|integer/i,
        );
        assert.throws(
          () =>
            reconcile({ ...cleanCounts, sourceDocumentCount: count, targetDocumentCount: count }),
          /count|integer/i,
        );
      },
    }),
  ),
  {
    name: 'I: valid reconciliation remains GREEN and mismatched counts RED',
    run() {
      assert.equal(reconcile(cleanCounts).result, 'GREEN');
      assert.equal(reconcile({ ...cleanCounts, targetCaseCount: 1 }).result, 'RED');
      assert.equal(
        reconcile({ ...cleanCounts, orphanDocumentIds: ['doc-1'], unmappedStatuses: ['Z'] }).result,
        'RED',
      );
    },
  },
];
