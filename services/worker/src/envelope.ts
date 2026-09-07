/** Masterplan 43: every job carries the same envelope. */
import type { QueueName } from './queues';

export interface JobEnvelope<TPayload = unknown> {
  readonly jobId: string;
  readonly type: QueueName;
  readonly tenantContext: string;
  readonly authorityContext: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly payload: TPayload;
  readonly attempt: number;
  readonly createdAt: string;
}

export class InvalidEnvelopeError extends Error {}

export function assertEnvelope(value: JobEnvelope): void {
  const missing = (
    ['jobId', 'type', 'tenantContext', 'correlationId', 'idempotencyKey'] as const
  ).filter((field) => value[field] == null || String(value[field]).length === 0);
  if (missing.length > 0) {
    throw new InvalidEnvelopeError(`Job envelope missing required fields: ${missing.join(', ')}`);
  }
}
