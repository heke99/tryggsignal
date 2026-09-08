/**
 * Masterplan 44: the worker polls, claims, heartbeats, retries, archives on
 * success and dead-letters on exhaustion. No heavy work runs inside a user HTTP
 * request (masterplan 144).
 */
import { InvalidEnvelopeError, parseEnvelope, type JobEnvelope } from './envelope';
import { PermanentJobError } from './errors';
import { DEFAULT_RETRY_POLICY, nextRetry, type RetryPolicy } from './retry';
import type { QueueName } from './queues';

/** A message exactly as `config.read_jobs` returns it. */
export interface QueueMessage {
  readonly msgId: number;
  readonly readCount: number;
  readonly raw: unknown;
}

/**
 * Port over the `config.*` job functions, so the loop is testable without a
 * database and the worker never reaches into `pgmq.*` itself.
 */
export interface QueueClient {
  read(
    queue: QueueName,
    visibilityTimeoutSeconds: number,
    batchSize: number,
  ): Promise<readonly QueueMessage[]>;
  /** False when this idempotency key already completed — a redelivery. */
  claim(queue: QueueName, envelope: JobEnvelope): Promise<boolean>;
  /** Extends the visibility timeout while a long job is still running. */
  heartbeat(queue: QueueName, msgId: number, seconds: number): Promise<void>;
  complete(queue: QueueName, msgId: number, envelope: JobEnvelope): Promise<void>;
  /** Archives without recording the job as processed. */
  archiveOnly(queue: QueueName, msgId: number): Promise<void>;
  deadLetter(
    queue: QueueName,
    msgId: number,
    raw: unknown,
    attempts: number,
    reason: string,
  ): Promise<void>;
  retry(queue: QueueName, msgId: number, delayMs: number): Promise<void>;
}

export type JobHandler = (envelope: JobEnvelope) => Promise<void>;

export interface WorkerOptions {
  readonly visibilityTimeoutSeconds?: number;
  readonly batchSize?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly heartbeatIntervalMs?: number;
  readonly onError?: (error: unknown, envelope: JobEnvelope | null) => void;
  readonly onEvent?: (event: WorkerEvent) => void;
}

export interface WorkerEvent {
  readonly kind: 'PROCESSED' | 'DUPLICATE' | 'RETRIED' | 'DEAD_LETTERED' | 'INVALID';
  readonly queue: QueueName;
  readonly msgId: number;
  readonly jobType?: string;
  readonly reason?: string;
}

export interface RunSummary {
  readonly processed: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly skipped: number;
}

/**
 * Processes one batch. A caller loops over this; keeping the batch as the unit
 * makes both the tests and the shutdown path simple.
 */
export async function processBatch(
  queue: QueueName,
  client: QueueClient,
  handler: JobHandler,
  options: WorkerOptions = {},
): Promise<RunSummary> {
  const visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? 60;
  const batchSize = options.batchSize ?? 10;
  const retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? (visibilityTimeoutSeconds * 1000) / 3;

  const messages = await client.read(queue, visibilityTimeoutSeconds, batchSize);

  let processed = 0;
  let retried = 0;
  let deadLettered = 0;
  let skipped = 0;

  for (const message of messages) {
    let envelope: JobEnvelope;
    try {
      envelope = parseEnvelope(queue, message.raw);
    } catch (error) {
      // A malformed envelope can never become valid by retrying it.
      const reason = error instanceof InvalidEnvelopeError ? error.message : 'Invalid job envelope';
      await client.deadLetter(queue, message.msgId, message.raw, message.readCount, reason);
      options.onError?.(error, null);
      options.onEvent?.({ kind: 'INVALID', queue, msgId: message.msgId, reason });
      skipped += 1;
      continue;
    }

    // Masterplan 43: PGMQ is at-least-once, so a redelivery must not run the
    // side effects a second time. The ledger, not the handler, decides.
    if (!(await client.claim(queue, envelope))) {
      await client.archiveOnly(queue, message.msgId);
      options.onEvent?.({
        kind: 'DUPLICATE',
        queue,
        msgId: message.msgId,
        jobType: envelope.type,
      });
      skipped += 1;
      continue;
    }

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      heartbeat = setInterval(() => {
        void client
          .heartbeat(queue, message.msgId, visibilityTimeoutSeconds)
          .catch((error: unknown) => options.onError?.(error, envelope));
      }, heartbeatIntervalMs);

      await handler(envelope);
      await client.complete(queue, message.msgId, envelope);
      processed += 1;
      options.onEvent?.({
        kind: 'PROCESSED',
        queue,
        msgId: message.msgId,
        jobType: envelope.type,
      });
    } catch (error) {
      options.onError?.(error, envelope);
      // A permanent failure will fail identically on every attempt, so it skips
      // the retry schedule and becomes visible immediately.
      const decision =
        error instanceof PermanentJobError
          ? ({ kind: 'DEAD_LETTER', reason: 'Permanent failure' } as const)
          : nextRetry(message.readCount, retryPolicy);
      if (decision.kind === 'RETRY') {
        await client.retry(queue, message.msgId, decision.delayMs);
        retried += 1;
        options.onEvent?.({
          kind: 'RETRIED',
          queue,
          msgId: message.msgId,
          jobType: envelope.type,
          reason: errorMessage(error),
        });
      } else {
        await client.deadLetter(
          queue,
          message.msgId,
          message.raw,
          message.readCount,
          `${decision.reason}: ${errorMessage(error)}`,
        );
        deadLettered += 1;
        options.onEvent?.({
          kind: 'DEAD_LETTERED',
          queue,
          msgId: message.msgId,
          jobType: envelope.type,
          reason: decision.reason,
        });
      }
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }
  }

  return { processed, retried, deadLettered, skipped };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
