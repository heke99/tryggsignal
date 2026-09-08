/**
 * The `QueueClient` implementation that talks to a real data plane.
 *
 * Every statement goes through the `config.*` functions added in
 * `20260908090000_p10_worker_runtime.sql`. The worker holds no direct grant on
 * `pgmq.*`, so the queue contract is one reviewable surface rather than SQL
 * scattered through the process (masterplan 44).
 */
import type { JobEnvelope } from './envelope';
import type { QueueClient, QueueMessage } from './handler';
import type { QueueName } from './queues';

/** The subset of a `pg` pool the client needs, so `pg` stays an implementation detail. */
export interface SqlExecutor {
  query<TRow>(text: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
}

interface ReadRow {
  msg_id: string | number;
  read_ct: number;
  envelope: unknown;
}

export class PgmqQueueClient implements QueueClient {
  constructor(private readonly sql: SqlExecutor) {}

  async read(
    queue: QueueName,
    visibilityTimeoutSeconds: number,
    batchSize: number,
  ): Promise<readonly QueueMessage[]> {
    const { rows } = await this.sql.query<ReadRow>(
      'select msg_id, read_ct, envelope from config.read_jobs($1, $2, $3)',
      [queue, visibilityTimeoutSeconds, batchSize],
    );
    return rows.map((row) => ({
      msgId: Number(row.msg_id),
      readCount: Number(row.read_ct),
      raw: row.envelope,
    }));
  }

  async claim(queue: QueueName, envelope: JobEnvelope): Promise<boolean> {
    const { rows } = await this.sql.query<{ claim_job: boolean }>(
      'select config.claim_job($1, $2, $3, $4) as claim_job',
      [queue, envelope.idempotencyKey, envelope.jobId, envelope.tenantContext],
    );
    return rows[0]?.claim_job === true;
  }

  async heartbeat(queue: QueueName, msgId: number, seconds: number): Promise<void> {
    await this.sql.query('select config.heartbeat_job($1, $2, $3)', [queue, msgId, seconds]);
  }

  async complete(queue: QueueName, msgId: number, envelope: JobEnvelope): Promise<void> {
    await this.sql.query('select config.complete_job($1, $2, $3, $4, $5)', [
      queue,
      msgId,
      envelope.idempotencyKey,
      envelope.jobId,
      envelope.tenantContext,
    ]);
  }

  async archiveOnly(queue: QueueName, msgId: number): Promise<void> {
    await this.sql.query('select pgmq.archive($1, $2::bigint)', [queue, msgId]);
  }

  async deadLetter(
    queue: QueueName,
    msgId: number,
    raw: unknown,
    attempts: number,
    reason: string,
  ): Promise<void> {
    await this.sql.query('select config.dead_letter_job($1, $2, $3::jsonb, $4, $5)', [
      queue,
      msgId,
      JSON.stringify(raw ?? {}),
      attempts,
      reason,
    ]);
  }

  async retry(queue: QueueName, msgId: number, delayMs: number): Promise<void> {
    await this.sql.query('select config.retry_job($1, $2, $3)', [
      queue,
      msgId,
      Math.ceil(delayMs / 1000),
    ]);
  }

  async startRun(workerId: string, queue: QueueName): Promise<number> {
    const { rows } = await this.sql.query<{ start_worker_run: string | number }>(
      'select config.start_worker_run($1, $2) as start_worker_run',
      [workerId, queue],
    );
    return Number(rows[0]?.start_worker_run);
  }

  async finishRun(
    runId: number,
    summary: { processed: number; retried: number; deadLettered: number; skipped: number },
    error?: string,
  ): Promise<void> {
    await this.sql.query('select config.finish_worker_run($1, $2, $3, $4, $5, $6)', [
      runId,
      summary.processed,
      summary.retried,
      summary.deadLettered,
      summary.skipped,
      error ?? null,
    ]);
  }
}
