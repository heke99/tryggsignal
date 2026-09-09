import { describe, expect, it, vi } from 'vitest';
import {
  recordMigrationReconciliation,
  type MigrationSqlExecutor,
} from '@tryggsignal/migration-engine';
import { mapExternalCase, sourceHash } from '@tryggsignal/integrations';

const scope = {
  batchId: '00000000-0000-4000-8000-000000000001',
  authorityId: '00000000-0000-4000-8000-000000000002',
};
const receiptId = '00000000-0000-4000-8000-000000000003';
const clean = {
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
function executor(rows: unknown[] = [{ reconciliation_id: receiptId, result: 'GREEN' }]) {
  const query = vi.fn(async () => ({ rows }));
  return { query, sql: { query } as unknown as MigrationSqlExecutor };
}

describe('migration reconciliation SQL contract', () => {
  it('uses a scoped parameterized private RPC and only sends counters, not a claimed result', async () => {
    const { query, sql } = executor();
    expect(await recordMigrationReconciliation(sql, scope, clean)).toEqual({
      reconciliationId: receiptId,
      result: 'GREEN',
    });
    expect(query).toHaveBeenCalledWith(
      'select reconciliation_id, result from migration.record_reconciliation($1::uuid, $2::uuid, $3::jsonb, $4::jsonb)',
      [scope.batchId, scope.authorityId, expect.any(String), '{}'],
    );
    const args = query.mock.calls[0] as unknown as [string, unknown[]];
    const counters = JSON.parse(args[1][2] as string) as Record<string, unknown>;
    expect(Object.keys(counters)).toHaveLength(11);
    expect(counters).not.toHaveProperty('result');
    expect(counters['source_case_count']).toBe(2);
  });
  it('persists a genuine RED observation without marking the import complete', async () => {
    const { sql } = executor([{ reconciliation_id: receiptId, result: 'RED' }]);
    expect(
      (await recordMigrationReconciliation(sql, scope, { ...clean, missingIds: ['missing-1'] }))
        .result,
    ).toBe('RED');
  });
  it.each([-1, 1.5, NaN, Infinity, 2_147_483_648])(
    'rejects non-persistable count %s before SQL',
    async (value) => {
      const { query, sql } = executor();
      await expect(
        recordMigrationReconciliation(sql, scope, {
          ...clean,
          sourceCaseCount: value,
          targetCaseCount: value,
        }),
      ).rejects.toThrow();
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('rejects a missing slot in finding arrays, not merely its array length', async () => {
    const { query, sql } = executor();
    await expect(
      recordMigrationReconciliation(sql, scope, { ...clean, missingIds: new Array<string>(1) }),
    ).rejects.toThrow(/sparse/);
    expect(query).not.toHaveBeenCalled();
  });
  it('requires an explicit authority, never deriving it from arbitrary request content', async () => {
    const { query, sql } = executor();
    await expect(
      recordMigrationReconciliation(sql, { ...scope, authorityId: 'unknown' }, clean),
    ).rejects.toThrow(/UUID/);
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [] },
    { rows: [{ reconciliation_id: 'invalid', result: 'GREEN' }] },
    { rows: [{ reconciliation_id: receiptId, result: 'RED' }] },
  ])('rejects malformed or contradictory database receipts %#', async ({ rows }) => {
    const { sql } = executor(rows);
    await expect(recordMigrationReconciliation(sql, scope, clean)).rejects.toThrow();
  });
  it('rejects non-object diagnostic detail before SQL', async () => {
    const { query, sql } = executor();
    await expect(recordMigrationReconciliation(sql, scope, clean, [] as never)).rejects.toThrow(
      /object/,
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('integration RAW snapshot compatibility', () => {
  it('detaches nested original values while retaining established H checksum bytes', () => {
    const input = { id: 'source-1', number: 'CASE-1', nested: { value: 1 } };
    const expectedHash = sourceHash(input);
    const mapped = mapExternalCase(input, {
      externalId: 'id',
      caseNumber: 'number',
      title: 'number',
      status: 'status',
    });
    input.nested.value = 2;
    expect(mapped?.sourceHash).toBe(expectedHash);
    expect(sourceHash(mapped?.raw)).toBe(expectedHash);
    expect(mapped?.raw).not.toBe(input);
    expect(Object.isFrozen((mapped?.raw as typeof input).nested)).toBe(true);
  });
});
