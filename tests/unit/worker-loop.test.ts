import { describe, expect, it, vi } from 'vitest';
import { processBatch, type JobEnvelope, type QueueClient, type QueueMessage } from '@tryggsignal/worker';

const envelope = (overrides: Partial<JobEnvelope> = {}): JobEnvelope => ({
  jobId: 'job-1',
  type: 'document_processing',
  tenantContext: 'tenant-1',
  authorityContext: 'auth-1',
  correlationId: 'corr-1',
  causationId: null,
  idempotencyKey: 'doc-1',
  payload: {},
  attempt: 1,
  createdAt: '2026-09-07T00:00:00Z',
  ...overrides,
});

function client(messages: readonly QueueMessage[]) {
  return {
    read: vi.fn().mockResolvedValue(messages),
    setVisibilityTimeout: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    delay: vi.fn().mockResolvedValue(undefined),
  } satisfies QueueClient & Record<string, unknown>;
}

describe('worker batch (masterplan 44/67)', () => {
  it('archives a message after a successful handler', async () => {
    const queue = client([{ msgId: 1, readCount: 1, envelope: envelope() }]);
    const summary = await processBatch('document_processing', queue, async () => {}, {});
    expect(summary).toMatchObject({ processed: 1, retried: 0, deadLettered: 0 });
    expect(queue.archive).toHaveBeenCalledWith('document_processing', 1);
  });

  it('delays a failed message instead of losing it', async () => {
    const queue = client([{ msgId: 2, readCount: 1, envelope: envelope() }]);
    const summary = await processBatch(
      'document_processing',
      queue,
      async () => {
        throw new Error('transient');
      },
      { onError: () => {} },
    );
    expect(summary.retried).toBe(1);
    expect(queue.delay).toHaveBeenCalled();
    expect(queue.deadLetter).not.toHaveBeenCalled();
  });

  it('dead-letters after the attempt budget is spent', async () => {
    const queue = client([{ msgId: 3, readCount: 8, envelope: envelope() }]);
    const summary = await processBatch(
      'document_processing',
      queue,
      async () => {
        throw new Error('still failing');
      },
      { onError: () => {} },
    );
    expect(summary.deadLettered).toBe(1);
    expect(queue.deadLetter).toHaveBeenCalledWith('document_processing', 3, expect.stringContaining('Exhausted'));
  });

  it('dead-letters a malformed envelope without calling the handler', async () => {
    const queue = client([
      { msgId: 4, readCount: 1, envelope: envelope({ idempotencyKey: '' }) },
    ]);
    const handler = vi.fn();
    const summary = await processBatch('document_processing', queue, handler, { onError: () => {} });
    expect(summary.skipped).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(queue.deadLetter).toHaveBeenCalledWith('document_processing', 4, 'Invalid job envelope');
  });

  it('heartbeats a long-running job so its lease does not expire', async () => {
    vi.useFakeTimers();
    const queue = client([{ msgId: 5, readCount: 1, envelope: envelope() }]);
    const run = processBatch(
      'document_processing',
      queue,
      () => new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      { visibilityTimeoutSeconds: 3, heartbeatIntervalMs: 1_000 },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    vi.useRealTimers();
    expect(queue.setVisibilityTimeout).toHaveBeenCalled();
  });
});
