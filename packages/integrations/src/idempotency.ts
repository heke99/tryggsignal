/**
 * Masterplan 66: distributed integrations are at-least-once. A duplicate
 * delivery must never create a duplicate case.
 */
import { createHash } from 'node:crypto';

export function idempotencyKey(parts: {
  readonly connectorInstanceId: string;
  readonly entityType: string;
  readonly externalId: string;
  readonly operation: string;
  /** Include when the same external id may legitimately change over time. */
  readonly sourceVersion?: string | null;
}): string {
  const canonical = [
    parts.connectorInstanceId,
    parts.entityType,
    parts.externalId,
    parts.operation,
    parts.sourceVersion ?? '',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

export interface DeliveryRecord {
  readonly idempotencyKey: string;
  readonly status: 'RECEIVED' | 'PROCESSED' | 'DUPLICATE' | 'FAILED' | 'DEAD_LETTER';
}

export type DeliveryDecision = 'PROCESS' | 'SKIP_DUPLICATE' | 'RETRY';

export function decideDelivery(existing: DeliveryRecord | null): DeliveryDecision {
  if (existing === null) return 'PROCESS';
  if (existing.status === 'PROCESSED' || existing.status === 'DUPLICATE') return 'SKIP_DUPLICATE';
  return 'RETRY';
}
