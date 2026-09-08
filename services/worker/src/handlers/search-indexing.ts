/**
 * Masterplan 111: the search index is maintained by the database. A case is
 * indexed by trigger on write; this job exists for the bulk path — a
 * reindex after a schema change, or a migration import that bypassed the
 * trigger.
 */
import { PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';

export async function handleSearchIndexing(envelope: JobEnvelope, sql: SqlExecutor): Promise<void> {
  const payload = envelope.payload as { case_id?: string };
  const caseId = payload.case_id;
  if (caseId === undefined) {
    throw new PermanentJobError('Payload has no case_id');
  }

  const { rows } = await sql.query<{ exists: boolean }>(
    'select exists(select 1 from core.cases where id = $1) as exists',
    [caseId],
  );
  if (rows[0]?.exists !== true) {
    throw new PermanentJobError(`Case ${caseId} no longer exists`);
  }

  // A no-op touch re-runs the index trigger, so the indexing rule lives in one
  // place rather than being duplicated here.
  await sql.query('update core.cases set updated_at = now() where id = $1', [caseId]);
}
