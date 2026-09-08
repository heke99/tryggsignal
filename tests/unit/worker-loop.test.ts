import { describe, expect, it, vi } from 'vitest';
import {
  PermanentJobError,
  processBatch,
  runWorker,
  type QueueClient,
  type QueueMessage,
} from '@tryggsignal/worker';

const raw = (overrides: Record<string, unknown> = {}) => ({
  job_id: '11111111-1111-4111-8111-111111111111',
  type: 'document_processing',
  tenant_context: 'tenant-1',
  authority_context: '22222222-2222-4222-8222-222222222222',
  correlation_id: '33333333-3333-4333-8333-333333333333',
  causation_id: null,
  idempotency_key: 'doc-1',
  payload: {},
  attempt: 1,
  created_at: '2026-09-07T00:00:00Z',
  ...overrides,
});

function client(messages: readonly QueueMessage[], claimed = true) {
  return {
    read: vi.fn().mockResolvedValue(messages),
    claim: vi.fn().mockResolvedValue(claimed),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    archiveOnly: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
  } satisfies QueueClient & Record<string, unknown>;
}

describe('worker batch (masterplan 43/44/67)', () => {
  it('completes a message after a successful handler', async () => {
    const queue = client([{ msgId: 1, readCount: 1, raw: raw() }]);
    const summary = await processBatch('document_processing', queue, async () => {}, {});
    expect(summary).toMatchObject({ processed: 1, retried: 0, deadLettered: 0, skipped: 0 });
    expect(queue.complete).toHaveBeenCalledWith(
      'document_processing',
      1,
      expect.objectContaining({ idempotencyKey: 'doc-1' }),
    );
  });

  it('archives a redelivered job without running the handler again', async () => {
    const queue = client([{ msgId: 9, readCount: 2, raw: raw() }], false);
    const handler = vi.fn();
    const summary = await processBatch('document_processing', queue, handler, {});
    expect(handler).not.toHaveBeenCalled();
    expect(queue.archiveOnly).toHaveBeenCalledWith('document_processing', 9);
    expect(queue.complete).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it('retries a transient failure instead of losing it', async () => {
    const queue = client([{ msgId: 2, readCount: 1, raw: raw() }]);
    const summary = await processBatch(
      'document_processing',
      queue,
      async () => {
        throw new Error('transient');
      },
      { onError: () => {} },
    );
    expect(summary.retried).toBe(1);
    expect(queue.retry).toHaveBeenCalled();
    expect(queue.deadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters after the attempt budget is spent', async () => {
    const queue = client([{ msgId: 3, readCount: 8, raw: raw() }]);
    const summary = await processBatch(
      'document_processing',
      queue,
      async () => {
        throw new Error('still failing');
      },
      { onError: () => {} },
    );
    expect(summary.deadLettered).toBe(1);
    expect(queue.deadLetter).toHaveBeenCalledWith(
      'document_processing',
      3,
      expect.anything(),
      8,
      expect.stringContaining('Exhausted'),
    );
  });

  it('dead-letters a permanent failure on the first attempt', async () => {
    const queue = client([{ msgId: 7, readCount: 1, raw: raw() }]);
    const summary = await processBatch(
      'document_processing',
      queue,
      async () => {
        throw new PermanentJobError('the row is gone');
      },
      { onError: () => {} },
    );
    expect(summary.deadLettered).toBe(1);
    expect(queue.retry).not.toHaveBeenCalled();
  });

  it('dead-letters a malformed envelope without calling the handler', async () => {
    const queue = client([{ msgId: 4, readCount: 1, raw: raw({ idempotency_key: '' }) }]);
    const handler = vi.fn();
    const summary = await processBatch('document_processing', queue, handler, {
      onError: () => {},
    });
    expect(summary.skipped).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(queue.claim).not.toHaveBeenCalled();
    expect(queue.deadLetter).toHaveBeenCalledWith(
      'document_processing',
      4,
      expect.anything(),
      1,
      expect.stringContaining('idempotency_key'),
    );
  });

  it('heartbeats a long-running job so its lease does not expire', async () => {
    vi.useFakeTimers();
    const queue = client([{ msgId: 5, readCount: 1, raw: raw() }]);
    const run = processBatch(
      'document_processing',
      queue,
      () => new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      { visibilityTimeoutSeconds: 3, heartbeatIntervalMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    vi.useRealTimers();
    expect(queue.heartbeat).toHaveBeenCalled();
  });
});

describe('worker runner (masterplan 44)', () => {
  it('polls every queue and stops when asked', async () => {
    const queue = client([]);
    const totals = await runWorker(queue, async () => {}, {
      queues: ['notifications', 'search_indexing'],
      maxRounds: 2,
      sleep: async () => {},
    });
    expect(totals.rounds).toBe(2);
    expect(queue.read).toHaveBeenCalledTimes(4);
  });

  it('stops between queues once shutdown is requested', async () => {
    const queue = client([]);
    let stop = false;
    const totals = await runWorker(
      queue,
      async () => {},
      { queues: ['notifications', 'search_indexing'], sleep: async () => {} },
      () => {
        const current = stop;
        stop = true;
        return current;
      },
    );
    expect(totals.rounds).toBeLessThanOrEqual(1);
  });
});
