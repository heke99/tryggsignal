/**
 * The worker process.
 *
 * Masterplan 44/144: heavy and slow work runs here, never inside a user's HTTP
 * request. One process serves one data plane; a municipality with its own
 * Supabase project gets its own worker, which is what keeps the tenant boundary
 * a deployment boundary rather than an `if` statement.
 *
 *   DATABASE_URL   required. The data plane this worker serves. Use a role that
 *                  may execute the `config.*` job functions — never the
 *                  service-role key, and never `anon`.
 *   WORKER_ID      optional. Defaults to the hostname, used in `config.worker_runs`.
 *   WORKER_QUEUES  optional. Comma-separated subset of queues, for running a
 *                  dedicated process for one heavy queue.
 *   WORKER_BATCH_SIZE, WORKER_VISIBILITY_SECONDS  optional tuning.
 */
import { hostname } from 'node:os';
import pg from 'pg';
import { PgmqQueueClient } from './pgmq-client';
import { routeJob } from './handlers';
import { runWorker } from './runner';
import { isQueueName, QUEUES, type QueueName } from './queues';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required. See .env.example.`);
  }
  return value;
}

function selectedQueues(): readonly QueueName[] {
  const raw = process.env['WORKER_QUEUES'];
  if (raw === undefined || raw.trim().length === 0) return QUEUES;

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !isQueueName(name));
  if (unknown.length > 0) {
    throw new Error(`WORKER_QUEUES names queues that do not exist: ${unknown.join(', ')}`);
  }
  return names as readonly QueueName[];
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = requiredEnv('DATABASE_URL');
  const workerId = process.env['WORKER_ID'] ?? hostname();
  const queues = selectedQueues();
  const batchSize = positiveInt('WORKER_BATCH_SIZE', 10);
  const visibilityTimeoutSeconds = positiveInt('WORKER_VISIBILITY_SECONDS', 60);

  const pool = new pg.Pool({
    connectionString,
    max: 4,
    application_name: `tryggsignal-worker/${workerId}`,
    // A worker that cannot reach the database should fail loudly and be
    // restarted, not queue connection attempts forever.
    connectionTimeoutMillis: 10_000,
  });

  const client = new PgmqQueueClient(pool);
  const handler = routeJob(pool);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    // Masterplan 44: shutdown is graceful. The in-flight batch finishes; nothing
    // is abandoned mid-job, and an unfinished message simply becomes visible
    // again when its timeout expires.
    log('info', 'shutdown requested, finishing the current batch', { signal });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  log('info', 'worker started', { workerId, queues: queues.join(','), batchSize });

  try {
    await runWorker(
      client,
      handler,
      {
        queues,
        batchSize,
        visibilityTimeoutSeconds,
        onEvent: (event) => {
          log(event.kind === 'PROCESSED' || event.kind === 'DUPLICATE' ? 'info' : 'warn', 'job', {
            ...event,
          });
        },
        onError: (error, envelope) => {
          log('error', 'job failed', {
            // Masterplan 86: an operational log carries identifiers, never
            // municipal content or personal data.
            jobId: envelope?.jobId ?? null,
            jobType: envelope?.type ?? null,
            correlationId: envelope?.correlationId ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        },
        onRound: (queue, summary) => {
          void client
            .startRun(workerId, queue)
            .then((runId) => client.finishRun(runId, summary))
            .catch((error: unknown) => {
              log('warn', 'could not record worker run', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
      },
      () => stopping,
    );
  } finally {
    await pool.end();
    log('info', 'worker stopped', { workerId });
  }
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: object = {}): void {
  const line = JSON.stringify({
    level,
    message,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

main().catch((error: unknown) => {
  log('error', 'worker crashed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
