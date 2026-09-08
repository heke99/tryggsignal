/**
 * The polling loop around `processBatch`. Kept separate from `main.ts` so it can
 * be driven by a test with a fake clock and a fake client.
 */
import { processBatch, type QueueClient, type JobHandler, type WorkerOptions } from './handler';
import { QUEUE_IDLE_DELAY_MS, QUEUES, type QueueName } from './queues';

export interface RunnerOptions extends WorkerOptions {
  readonly queues?: readonly QueueName[];
  /** Stops after this many polling rounds. Used by the smoke run; unset means forever. */
  readonly maxRounds?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRound?: (queue: QueueName, summary: RoundSummary) => void;
}

export interface RoundSummary {
  readonly processed: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly skipped: number;
}

export interface RunnerTotals extends RoundSummary {
  readonly rounds: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls every queue in turn. A queue that returned work is polled again straight
 * away; only a fully idle round sleeps, and it sleeps for the shortest idle
 * delay among the queues so an urgent queue is never held back by a nightly one.
 */
export async function runWorker(
  client: QueueClient,
  handler: JobHandler,
  options: RunnerOptions = {},
  shouldStop: () => boolean = () => false,
): Promise<RunnerTotals> {
  const queues = options.queues ?? QUEUES;
  const sleep = options.sleep ?? defaultSleep;

  let rounds = 0;
  let processed = 0;
  let retried = 0;
  let deadLettered = 0;
  let skipped = 0;

  while (!shouldStop() && (options.maxRounds === undefined || rounds < options.maxRounds)) {
    rounds += 1;
    let didWork = false;

    for (const queue of queues) {
      if (shouldStop()) break;
      const summary = await processBatch(queue, client, handler, options);
      processed += summary.processed;
      retried += summary.retried;
      deadLettered += summary.deadLettered;
      skipped += summary.skipped;
      if (summary.processed + summary.retried + summary.deadLettered + summary.skipped > 0) {
        didWork = true;
        options.onRound?.(queue, summary);
      }
    }

    if (!didWork && !shouldStop()) {
      const idle = Math.min(...queues.map((queue) => QUEUE_IDLE_DELAY_MS[queue]));
      await sleep(idle);
    }
  }

  return { rounds, processed, retried, deadLettered, skipped };
}
