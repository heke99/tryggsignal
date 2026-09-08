/** Masterplan 42: durable PGMQ queues. No unlogged queue for legally critical work. */

/**
 * These are PGMQ queue names, so they are plain SQL identifiers with
 * underscores. `tests/unit/worker-queues.test.ts` asserts the list against
 * `supabase/migrations/20260907130600_p10_queues_and_cron.sql`, because the two
 * silently drifted once: the worker used hyphens and would have polled ten
 * queues that do not exist.
 */
export const QUEUES = [
  'document_processing',
  'search_indexing',
  'ai_analysis',
  'integration_inbound',
  'integration_outbound',
  'notifications',
  'migration',
  'archive_generation',
  'report_generation',
  'reference_data_sync',
] as const;

export type QueueName = (typeof QUEUES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUES as readonly string[]).includes(value);
}

/** Queues whose loss would break a legal process must stay durable (logged). */
export const DURABLE_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>([
  'document_processing',
  'integration_inbound',
  'integration_outbound',
  'notifications',
  'migration',
  'archive_generation',
]);

/**
 * How often each queue is polled when it comes back empty. Work that a person is
 * waiting for is polled tightly; nightly bulk work is not, so an idle worker
 * does not hold a connection busy for nothing.
 */
export const QUEUE_IDLE_DELAY_MS: Readonly<Record<QueueName, number>> = {
  document_processing: 1_000,
  search_indexing: 1_000,
  ai_analysis: 5_000,
  integration_inbound: 2_000,
  integration_outbound: 2_000,
  notifications: 2_000,
  migration: 10_000,
  archive_generation: 10_000,
  report_generation: 15_000,
  reference_data_sync: 30_000,
};
