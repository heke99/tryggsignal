import { describe, expect, it } from 'vitest';
import {
  assertEnvelope,
  DEFAULT_RETRY_POLICY,
  DURABLE_QUEUES,
  nextRetry,
  QUEUES,
  type JobEnvelope,
} from '@tryggsignal/worker';

const envelope: JobEnvelope = {
  jobId: 'job-1',
  type: 'document-processing',
  tenantContext: 'tenant-mjolby',
  authorityContext: 'authority-bygg',
  correlationId: 'corr-1',
  causationId: null,
  idempotencyKey: 'doc-42-v1',
  payload: {},
  attempt: 1,
  createdAt: '2026-09-07T00:00:00Z',
};

describe('job envelope (masterplan 43)', () => {
  it('accepts a complete envelope', () => {
    expect(() => assertEnvelope(envelope)).not.toThrow();
  });

  it('rejects an envelope without tenant context or idempotency key', () => {
    expect(() => assertEnvelope({ ...envelope, tenantContext: '' })).toThrow(/tenantContext/);
    expect(() => assertEnvelope({ ...envelope, idempotencyKey: '' })).toThrow(/idempotencyKey/);
  });
});

describe('retry policy (masterplan 67)', () => {
  it('backs off exponentially and stays under the cap', () => {
    const first = nextRetry(1, DEFAULT_RETRY_POLICY, 0);
    const second = nextRetry(2, DEFAULT_RETRY_POLICY, 0);
    expect(first).toMatchObject({ kind: 'RETRY', nextAttempt: 2 });
    if (first.kind === 'RETRY' && second.kind === 'RETRY') {
      expect(second.delayMs).toBeGreaterThan(first.delayMs);
      expect(second.delayMs).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
    }
    const late = nextRetry(7, DEFAULT_RETRY_POLICY, 1);
    if (late.kind === 'RETRY') {
      expect(late.delayMs).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
    }
  });

  it('dead-letters instead of retrying forever', () => {
    expect(nextRetry(DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY)).toMatchObject({
      kind: 'DEAD_LETTER',
    });
  });
});

describe('queue catalog (masterplan 42)', () => {
  it('keeps legally critical queues durable', () => {
    for (const queue of ['document-processing', 'integration-inbound', 'migration'] as const) {
      expect(DURABLE_QUEUES.has(queue)).toBe(true);
    }
    expect(QUEUES).toHaveLength(10);
  });
});
