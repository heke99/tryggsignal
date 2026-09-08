import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  DURABLE_QUEUES,
  InvalidEnvelopeError,
  nextRetry,
  parseEnvelope,
  QUEUES,
} from '@tryggsignal/worker';

/** The envelope exactly as `config.enqueue_job` writes it. */
const raw = {
  job_id: '11111111-1111-4111-8111-111111111111',
  type: 'document_processing',
  tenant_context: 'tenant-mjolby',
  authority_context: '22222222-2222-4222-8222-222222222222',
  correlation_id: '33333333-3333-4333-8333-333333333333',
  causation_id: null,
  idempotency_key: 'doc-42-v1',
  payload: { document_id: 42 },
  attempt: 1,
  created_at: '2026-09-07T00:00:00Z',
};

describe('job envelope (masterplan 43)', () => {
  it('parses the snake_case envelope the database writes', () => {
    const envelope = parseEnvelope('document_processing', raw);
    expect(envelope).toMatchObject({
      jobId: raw.job_id,
      type: 'document_processing',
      tenantContext: 'tenant-mjolby',
      authorityContext: raw.authority_context,
      correlationId: raw.correlation_id,
      causationId: null,
      idempotencyKey: 'doc-42-v1',
      attempt: 1,
      queue: 'document_processing',
    });
  });

  it('rejects an envelope without tenant context or idempotency key', () => {
    expect(() => parseEnvelope('document_processing', { ...raw, tenant_context: '' })).toThrow(
      /tenant_context/,
    );
    expect(() => parseEnvelope('document_processing', { ...raw, idempotency_key: null })).toThrow(
      /idempotency_key/,
    );
  });

  it('rejects a queue name that does not exist', () => {
    expect(() => parseEnvelope('document-processing', raw)).toThrow(InvalidEnvelopeError);
  });

  it('rejects a payload that is not an object', () => {
    expect(() => parseEnvelope('document_processing', { ...raw, payload: 'oops' })).toThrow(
      /payload/,
    );
  });

  it('defaults a missing payload rather than failing the job', () => {
    const { payload, ...withoutPayload } = raw;
    expect(payload).toBeDefined();
    expect(parseEnvelope('document_processing', withoutPayload).payload).toEqual({});
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
    for (const queue of ['document_processing', 'integration_inbound', 'migration'] as const) {
      expect(DURABLE_QUEUES.has(queue)).toBe(true);
    }
    expect(QUEUES).toHaveLength(10);
  });
});
