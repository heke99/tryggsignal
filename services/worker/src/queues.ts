/** Masterplan 42: durable PGMQ queues. No unlogged queue for legally critical work. */

export const QUEUES = [
  'document-processing',
  'search-indexing',
  'ai-analysis',
  'integration-inbound',
  'integration-outbound',
  'notifications',
  'migration',
  'archive-generation',
  'report-generation',
  'reference-data-sync',
] as const;

export type QueueName = (typeof QUEUES)[number];

/** Queues whose loss would break a legal process must stay durable (logged). */
export const DURABLE_QUEUES: ReadonlySet<QueueName> = new Set<QueueName>([
  'document-processing',
  'integration-inbound',
  'integration-outbound',
  'notifications',
  'migration',
  'archive-generation',
]);
