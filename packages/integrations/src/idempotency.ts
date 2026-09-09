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

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** H receipt identity uses a framed JSON tuple; a separator in a source
 * identifier cannot alias another event. Existing legacy write keys above
 * deliberately retain their format, so this change cannot replay old writes.
 * The prefix is the receipt-key codec version, not a mapping release.
 */
export function inboundEventKey(parts: {
  readonly connectorInstanceId: string;
  readonly externalEventId: string;
  readonly eventType: string;
}): string {
  const values = [parts.connectorInstanceId, parts.externalEventId, parts.eventType];
  const limits = [500, 500, 200];
  if (
    values.some(
      (value, index) =>
        !value.trim() ||
        value !== value.trim() ||
        value.length > (limits[index] ?? 0) ||
        hasControlCharacter(value),
    )
  ) {
    throw new Error('Inbound event identity contains invalid values');
  }
  const encoded = JSON.stringify(['tryggsignal-inbound-event/v1', ...values]);
  return 'event:v1:' + createHash('sha256').update(encoded).digest('hex');
}
