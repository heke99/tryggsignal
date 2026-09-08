# Runbook — the worker process

Masterplan 42, 43, 44, 45, 67, 144.

## What it is

`services/worker` is a long-running Node process that consumes the PGMQ queues in one
data plane. Cron only ever enqueues (masterplan 45); nothing in the database processes a
job. Without a worker running, jobs accumulate and no notification, no integration event
and no report is ever produced.

**One worker per data plane.** A municipality with its own Supabase project gets its own
worker process. That is what keeps the tenant boundary a deployment boundary rather than
a conditional in the code.

## Running it

```
DATABASE_URL='postgresql://<role>:<password>@<host>:5432/postgres' \
WORKER_ID=worker-mjolby-1 \
pnpm --filter @tryggsignal/worker start
```

| Variable                    | Required | Meaning                                                                                                                         |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | yes      | The data plane. Use a role that may execute the `config.*` job functions. Never the service-role key, never `anon`.             |
| `WORKER_ID`                 | no       | Identifier in `config.worker_runs`. Defaults to the hostname.                                                                   |
| `WORKER_QUEUES`             | no       | Comma-separated subset, for a dedicated process for one heavy queue. Unknown names fail at startup rather than polling nothing. |
| `WORKER_BATCH_SIZE`         | no       | Default 10.                                                                                                                     |
| `WORKER_VISIBILITY_SECONDS` | no       | Default 60. A job that regularly runs longer needs this raised, or its lease expires mid-run and it is redelivered.             |

Shutdown is graceful: `SIGTERM` and `SIGINT` let the current batch finish. A message that
was never completed becomes visible again when its lease expires, so nothing is lost by
killing a worker.

## How a job is processed

1. `config.read_jobs` takes a batch and hides it for the visibility timeout.
2. The envelope is parsed. A malformed envelope is dead-lettered immediately — no retry
   can make it valid.
3. `config.claim_job` checks the idempotency ledger. PGMQ is at-least-once, so a
   redelivery of a job that already completed is archived **without** running the handler
   again. This is the only thing standing between a redelivery and a duplicate decision,
   duplicate notification or duplicate integration write.
4. The handler runs, with a heartbeat extending the lease every third of the timeout.
5. `config.complete_job` writes the ledger row and archives the message in one transaction.
6. A transient failure is retried with exponential backoff and full jitter, up to 8
   attempts. A `PermanentJobError` skips the schedule and is dead-lettered on the first
   failure.

## Dead letters

```sql
select queue_name, job_type, reason, attempts, failed_at
from config.dead_letter_jobs
where resolved_at is null
order by failed_at desc;
```

Nothing is deleted from this table: a legally relevant job that could not be processed has
to stay visible. Reasons beginning `EXTERNAL_BLOCKED (…)` are jobs whose supplier does not
exist yet — see `docs/blockers.md`. They are not failures of the system; they are the
system refusing to pretend.

To replay one after the dependency exists, re-enqueue it from its stored envelope:

```sql
select config.enqueue_job(
  queue_name,
  envelope ->> 'type',
  envelope ->> 'tenant_context',
  nullif(envelope ->> 'authority_context', '')::uuid,
  -- a new key: the old one is in the ledger and would be refused as a duplicate
  (envelope ->> 'idempotency_key') || ':replay1',
  envelope -> 'payload'
)
from config.dead_letter_jobs where id = '<id>';

update config.dead_letter_jobs
set resolved_at = now(), resolved_by = '<user id>', resolution_note = 'replayed'
where id = '<id>';
```

## Monitoring

```sql
-- queue depth
select queue_name, queue_length, oldest_msg_age_sec from pgmq.metrics_all() order by 2 desc;

-- did a worker run recently, and what did it do
select worker_id, queue_name, started_at, processed, retried, dead_lettered, error
from config.worker_runs order by started_at desc limit 20;
```

A growing `queue_length` with no recent `worker_runs` row means no worker is running. A
growing `oldest_msg_age_sec` with recent runs means a handler is failing and retrying.

## Verifying the queue runtime

`tests/integration/worker_runtime.sql` exercises every call the worker makes against a
real database — enqueue, read, invisibility, claim, complete, redelivery refusal, retry,
heartbeat, dead-letter and the run log:

```
psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/worker_runtime.sql
```

It cleans up after itself; the queue functions commit through PGMQ and cannot be rolled
back with the rest of a transaction.
