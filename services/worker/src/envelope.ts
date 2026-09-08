/** Masterplan 43: every job carries the same envelope. */
import { isQueueName, type QueueName } from './queues';

/**
 * The envelope as `config.enqueue_job` writes it. The database spells the fields
 * in snake_case; this module is the single place that translates, so no handler
 * has to know both spellings. The previous version of this file validated
 * camelCase keys that the database never writes, which meant every real job
 * would have been rejected as malformed.
 */
export interface JobEnvelope<TPayload = unknown> {
  readonly jobId: string;
  readonly type: string;
  readonly tenantContext: string;
  readonly authorityContext: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly attempt: number;
  readonly createdAt: string;
  /** The queue the message was read from, not part of the stored envelope. */
  readonly queue: QueueName;
}

export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvelopeError';
  }
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  const asString = String(value);
  return asString.length === 0 ? null : asString;
}

/**
 * Parses and validates in one step. A job whose envelope cannot be parsed can
 * never become valid by being retried, so the caller dead-letters it rather than
 * putting it back on the queue.
 */
export function parseEnvelope(queue: string, raw: unknown): JobEnvelope {
  if (!isQueueName(queue)) {
    throw new InvalidEnvelopeError(`Unknown queue: ${queue}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidEnvelopeError('Job envelope is not an object');
  }
  const record = raw as Record<string, unknown>;

  const jobId = text(record, 'job_id');
  const type = text(record, 'type');
  const tenantContext = text(record, 'tenant_context');
  const correlationId = text(record, 'correlation_id');
  const idempotencyKey = text(record, 'idempotency_key');

  const missing = Object.entries({
    job_id: jobId,
    type,
    tenant_context: tenantContext,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
  })
    .filter(([, value]) => value === null)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new InvalidEnvelopeError(`Job envelope missing required fields: ${missing.join(', ')}`);
  }

  const attemptValue = record['attempt'];
  const attempt = typeof attemptValue === 'number' ? attemptValue : Number(attemptValue ?? 1);
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new InvalidEnvelopeError('Job envelope has a non-positive attempt count');
  }

  const payload = record['payload'];
  if (payload !== undefined && (typeof payload !== 'object' || payload === null)) {
    throw new InvalidEnvelopeError('Job envelope payload must be an object');
  }

  return {
    jobId: jobId as string,
    type: type as string,
    tenantContext: tenantContext as string,
    authorityContext: text(record, 'authority_context'),
    correlationId: correlationId as string,
    causationId: text(record, 'causation_id'),
    idempotencyKey: idempotencyKey as string,
    payload: payload ?? {},
    attempt,
    createdAt: text(record, 'created_at') ?? new Date(0).toISOString(),
    queue,
  };
}
