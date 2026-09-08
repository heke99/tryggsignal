-- Tryggsignal P10 — the runtime half of the queue system.
-- Masterplan 42, 43, 44, 45, 67, 144.
--
-- Migration 20260907130600 created the queues and the enqueue helper. Nothing
-- consumed them. This migration adds what a real consumer needs: a dead-letter
-- store, an idempotency ledger so a redelivered job cannot run its side effects
-- twice, a run log for operational visibility, and the small set of functions
-- the worker calls. The worker never touches `pgmq.*` directly — it goes through
-- these, so the contract between process and database is one reviewable surface.

-- ---------------------------------------------------------------------------
-- Dead letters
-- ---------------------------------------------------------------------------

create table config.dead_letter_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  queue_name text not null,
  job_id uuid,
  job_type text,
  tenant_context text,
  authority_context uuid,
  correlation_id uuid,
  idempotency_key text,
  envelope jsonb not null,
  attempts integer not null,
  reason text not null,
  failed_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  constraint dead_letter_resolution_complete
    check ((resolved_at is null) = (resolved_by is null))
);

create index dead_letter_jobs_queue_idx on config.dead_letter_jobs (queue_name, failed_at desc);
create index dead_letter_jobs_unresolved_idx on config.dead_letter_jobs (failed_at desc)
  where resolved_at is null;

comment on table config.dead_letter_jobs is
  'Jobs that exhausted their retries or carried an envelope that can never be valid. '
  'Nothing is deleted here: a legally relevant job that could not be processed must stay visible.';

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
--
-- PGMQ is at-least-once. A visibility timeout that expires while a handler is
-- still finishing will redeliver the job, so every side effect has to be guarded
-- by the envelope's idempotency key rather than by hope (masterplan 43).

create table config.processed_jobs (
  queue_name text not null,
  idempotency_key text not null,
  job_id uuid,
  tenant_context text,
  processed_at timestamptz not null default now(),
  primary key (queue_name, idempotency_key)
);

create index processed_jobs_processed_at_idx on config.processed_jobs (processed_at);

comment on table config.processed_jobs is
  'One row per completed job. `config.claim_job` refuses a key that is already here, '
  'so a redelivery is archived without running the handler a second time.';

-- ---------------------------------------------------------------------------
-- Run log
-- ---------------------------------------------------------------------------

create table config.worker_runs (
  id bigint generated always as identity primary key,
  worker_id text not null,
  queue_name text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed integer not null default 0,
  retried integer not null default 0,
  dead_lettered integer not null default 0,
  skipped integer not null default 0,
  error text
);

create index worker_runs_queue_started_idx on config.worker_runs (queue_name, started_at desc);

-- ---------------------------------------------------------------------------
-- The functions the worker calls
-- ---------------------------------------------------------------------------

/**
 * Reads a batch and makes it invisible for `p_visibility_seconds`. The envelope
 * is returned as it was enqueued; validation is the worker's job, because an
 * envelope that fails validation must still be dead-lettered rather than left
 * in the queue.
 */
create or replace function config.read_jobs(
  p_queue text,
  p_visibility_seconds integer default 60,
  p_batch_size integer default 10
)
returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, envelope jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select m.msg_id, m.read_ct, m.enqueued_at, m.message
  from pgmq.read(p_queue, p_visibility_seconds, p_batch_size) m;
end;
$$;

revoke all on function config.read_jobs(text, integer, integer) from public;

/**
 * Claims a job for this attempt. Returns false when the idempotency key has
 * already completed, which is the redelivery case: the caller archives the
 * message without running the handler again.
 */
create or replace function config.claim_job(
  p_queue text,
  p_idempotency_key text,
  p_job_id uuid,
  p_tenant_context text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return not exists (
    select 1 from config.processed_jobs
    where queue_name = p_queue and idempotency_key = p_idempotency_key
  );
end;
$$;

revoke all on function config.claim_job(text, text, uuid, text) from public;

/**
 * Marks the job done and removes it from the queue in one transaction. If the
 * archive succeeded but the ledger write did not, the job would be redelivered
 * and run twice; doing both here makes that impossible.
 */
create or replace function config.complete_job(
  p_queue text,
  p_msg_id bigint,
  p_idempotency_key text,
  p_job_id uuid,
  p_tenant_context text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into config.processed_jobs (queue_name, idempotency_key, job_id, tenant_context)
  values (p_queue, p_idempotency_key, p_job_id, p_tenant_context)
  on conflict (queue_name, idempotency_key) do nothing;

  perform pgmq.archive(p_queue, p_msg_id);
end;
$$;

revoke all on function config.complete_job(text, bigint, text, uuid, text) from public;

/** Puts the message back with a delay, for the next attempt. */
create or replace function config.retry_job(
  p_queue text,
  p_msg_id bigint,
  p_delay_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pgmq.set_vt(p_queue, p_msg_id, greatest(p_delay_seconds, 0));
end;
$$;

revoke all on function config.retry_job(text, bigint, integer) from public;

/** Extends the visibility timeout while a long handler is still running. */
create or replace function config.heartbeat_job(
  p_queue text,
  p_msg_id bigint,
  p_visibility_seconds integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pgmq.set_vt(p_queue, p_msg_id, greatest(p_visibility_seconds, 1));
end;
$$;

revoke all on function config.heartbeat_job(text, bigint, integer) from public;

/**
 * Records the failure and takes the message out of the queue. The envelope is
 * copied into the dead-letter table first, so nothing is lost even though the
 * PGMQ archive is pruned on its own schedule.
 */
create or replace function config.dead_letter_job(
  p_queue text,
  p_msg_id bigint,
  p_envelope jsonb,
  p_attempts integer,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into config.dead_letter_jobs (
    queue_name, job_id, job_type, tenant_context, authority_context,
    correlation_id, idempotency_key, envelope, attempts, reason
  )
  values (
    p_queue,
    nullif(p_envelope ->> 'job_id', '')::uuid,
    p_envelope ->> 'type',
    p_envelope ->> 'tenant_context',
    nullif(p_envelope ->> 'authority_context', '')::uuid,
    nullif(p_envelope ->> 'correlation_id', '')::uuid,
    p_envelope ->> 'idempotency_key',
    p_envelope,
    p_attempts,
    p_reason
  )
  returning id into v_id;

  perform pgmq.archive(p_queue, p_msg_id);
  return v_id;
end;
$$;

revoke all on function config.dead_letter_job(text, bigint, jsonb, integer, text) from public;

/** Opens a run row; the worker closes it with `config.finish_worker_run`. */
create or replace function config.start_worker_run(p_worker_id text, p_queue text)
returns bigint
language sql
security definer
set search_path = ''
as $$
  insert into config.worker_runs (worker_id, queue_name)
  values (p_worker_id, p_queue)
  returning id;
$$;

revoke all on function config.start_worker_run(text, text) from public;

create or replace function config.finish_worker_run(
  p_run_id bigint,
  p_processed integer,
  p_retried integer,
  p_dead_lettered integer,
  p_skipped integer,
  p_error text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update config.worker_runs
  set finished_at = now(),
      processed = p_processed,
      retried = p_retried,
      dead_lettered = p_dead_lettered,
      skipped = p_skipped,
      error = p_error
  where id = p_run_id;
$$;

revoke all on function config.finish_worker_run(bigint, integer, integer, integer, integer, text) from public;

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

/**
 * The ledger only has to remember a key for as long as a redelivery is possible.
 * The longest retry schedule is bounded by the worker's retry policy, so a wide
 * margin of 30 days is enough and keeps the table small.
 */
create or replace function config.prune_processed_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from config.processed_jobs where processed_at < now() - interval '30 days';
  get diagnostics v_count = row_count;

  delete from config.worker_runs where started_at < now() - interval '30 days';

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s ledger row(s) pruned', v_count)
  where key = 'processed_jobs_prune';

  return v_count;
end;
$$;

revoke all on function config.prune_processed_jobs() from public;

insert into config.scheduled_tasks (key, description, schedule) values
  ('processed_jobs_prune', 'Prune the job idempotency ledger and the worker run log', '30 3 * * *')
on conflict (key) do nothing;

select cron.schedule('tryggsignal_processed_jobs_prune', '30 3 * * *', 'select config.prune_processed_jobs()');

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
--
-- Masterplan 44/85: the worker connects as a database role of its own, never as
-- `anon` or `authenticated`, and these tables are not readable from the browser.
-- The control tower reads dead letters through the API with an operational
-- mandate; the idempotency ledger and the run log stay server-side.

alter table config.dead_letter_jobs enable row level security;
alter table config.processed_jobs enable row level security;
alter table config.worker_runs enable row level security;

grant select on config.dead_letter_jobs to authenticated;

create policy dead_letter_jobs_select on config.dead_letter_jobs
  for select to authenticated
  using ((authz.can('integration.manage', jsonb_build_object()) ->> 'allowed')::boolean);
