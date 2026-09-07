/**
 * Masterplan 44: the worker polls, claims, heartbeats, retries, archives on
 * success and dead-letters on exhaustion. No heavy work runs inside a user HTTP
 * request (masterplan 144).
 */
import { assertEnvelope, type JobEnvelope } from './envelope';
import { DEFAULT_RETRY_POLICY, nextRetry, type RetryPolicy } from './retry';
import type { QueueName } from './queues';

export interface QueueMessage {
  readonly msgId: number;
  readonly readCount: number;
  readonly envelope: JobEnvelope;
}

/** Port over PGMQ, so the loop is testable without a database. */
export interface QueueClient {
  read(
    queue: QueueName,
    visibilityTimeoutSeconds: number,
    batchSize: number,
  ): Promise<readonly QueueMessage[]>;
  /** Extends the visibility timeout while a long job is still running. */
  setVisibilityTimeout(queue: QueueName, msgId: number, seconds: number): Promise<void>;
  archive(queue: QueueName, msgId: number): Promise<void>;
  deadLetter(queue: QueueName, msgId: number, reason: string): Promise<void>;
  delay(queue: QueueName, msgId: number, delayMs: number): Promise<void>;
}

export type JobHandler = (envelope: JobEnvelope) => Promise<void>;

export interface WorkerOptions {
  readonly visibilityTimeoutSeconds?: number;
  readonly batchSize?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly heartbeatIntervalMs?: number;
  readonly onError?: (error: unknown, envelope: JobEnvelope | null) => void;
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
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      assertEnvelope(message.envelope);
    } catch (error) {
      // A malformed envelope can never become valid by retrying it.
      await client.deadLetter(queue, message.msgId, 'Invalid job envelope');
      options.onError?.(error, null);
      skipped += 1;
      continue;
    }

    try {
      heartbeat = setInterval(() => {
        void client
          .setVisibilityTimeout(queue, message.msgId, visibilityTimeoutSeconds)
          .catch((error: unknown) => options.onError?.(error, message.envelope));
      }, heartbeatIntervalMs);

      await handler(message.envelope);
      await client.archive(queue, message.msgId);
      processed += 1;
    } catch (error) {
      options.onError?.(error, message.envelope);
      const decision = nextRetry(message.readCount, retryPolicy);
      if (decision.kind === 'RETRY') {
        await client.delay(queue, message.msgId, decision.delayMs);
        retried += 1;
      } else {
        await client.deadLetter(queue, message.msgId, decision.reason);
        deadLettered += 1;
      }
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }
  }

  return { processed, retried, deadLettered, skipped };
}
