/** Private data-plane SQL boundary; not a browser or unscoped public RPC. */
import { canonicalJson } from '@tryggsignal/domain';
import { reconcile, type ReconciliationInput } from './reconciliation';

export interface MigrationSqlExecutor {
  query<TRow>(text: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

export interface StoredReconciliation {
  readonly reconciliationId: string;
  readonly result: 'GREEN' | 'RED';
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** The executor must already be bound to the resolved tenant's data plane.
 * Scope is checked again in PostgreSQL. The caller owns any wider transaction;
 * this receipt records an observation, not completion of the whole import.
 */
export async function recordMigrationReconciliation(
  sql: MigrationSqlExecutor,
  scope: { readonly batchId: string; readonly authorityId: string },
  input: ReconciliationInput,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<StoredReconciliation> {
  if (!UUID.test(scope.batchId) || !UUID.test(scope.authorityId)) {
    throw new TypeError('Reconciliation requires explicit batch and authority UUIDs');
  }
  // The lossless codec rejects sparse/accessor arrays before reconcile's reads.
  const snapshot = JSON.parse(canonicalJson(input)) as ReconciliationInput;
  const report = reconcile(snapshot);
  const counts = {
    source_case_count: snapshot.sourceCaseCount,
    target_case_count: snapshot.targetCaseCount,
    source_document_count: snapshot.sourceDocumentCount,
    target_document_count: snapshot.targetDocumentCount,
    missing_count: report.counts.missing,
    duplicate_count: report.counts.duplicates,
    hash_mismatch_count: report.counts.hashMismatches,
    broken_relation_count: report.counts.brokenRelations,
    unmapped_status_count: report.counts.unmappedStatuses,
    unmapped_classification_count: report.counts.unmappedClassifications,
    orphan_document_count: report.counts.orphanDocuments,
  };
  if (Object.values(counts).some((value) => value > 2_147_483_647)) {
    throw new RangeError('Persisted reconciliation counts must fit PostgreSQL integer columns');
  }
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new TypeError('Reconciliation detail must be a JSON object');
  }
  const { rows } = await sql.query<{ reconciliation_id: string; result: string }>(
    'select reconciliation_id, result from migration.record_reconciliation($1::uuid, $2::uuid, $3::jsonb, $4::jsonb)',
    [scope.batchId, scope.authorityId, canonicalJson(counts), canonicalJson(detail)],
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined || !UUID.test(row.reconciliation_id)) {
    throw new Error('Migration reconciliation RPC returned an invalid receipt');
  }
  if (row.result !== report.result) {
    throw new Error('Migration reconciliation result disagrees with the application contract');
  }
  return { reconciliationId: row.reconciliation_id, result: report.result };
}
