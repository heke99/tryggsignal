-- Tryggsignal P10 — durable queues and scheduled triggers.
-- Masterplan 42 (durable PGMQ queues), 43 (job envelope), 45 (cron only enqueues).
--
-- PGMQ queue names must be plain identifiers, so the logical names from the
-- masterplan are spelled with underscores here; `@tryggsignal/worker` uses the
-- same spelling so the two cannot drift.

do $$
declare
  queue_name text;
begin
  foreach queue_name in array array[
    'document_processing',
    'search_indexing',
    'ai_analysis',
    'integration_inbound',
    'integration_outbound',
    'notifications',
    'migration',
    'archive_generation',
    'report_generation',
    'reference_data_sync'
  ]
  loop
    -- pgmq.create() builds a logged (durable) queue; unlogged queues are never
    -- used for legally critical work (masterplan 42).
    perform pgmq.create(queue_name);
  end loop;
end
$$;

-- Enqueue helper that enforces the masterplan-43 envelope. Every job carries a
-- tenant context, correlation id and idempotency key or it is not accepted.
create or replace function config.enqueue_job(
  p_queue text,
  p_type text,
  p_tenant_context text,
  p_authority_context uuid,
  p_idempotency_key text,
  p_payload jsonb default '{}'::jsonb,
  p_correlation_id uuid default null,
  p_causation_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg_id bigint;
  v_envelope jsonb;
begin
  if p_tenant_context is null or length(p_tenant_context) = 0 then
    raise exception 'Job envelope requires a tenant context' using errcode = 'check_violation';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'Job envelope requires an idempotency key' using errcode = 'check_violation';
  end if;

  v_envelope := jsonb_build_object(
    'job_id', extensions.gen_random_uuid(),
    'type', p_type,
    'tenant_context', p_tenant_context,
    'authority_context', p_authority_context,
    'correlation_id', coalesce(p_correlation_id, extensions.gen_random_uuid()),
    'causation_id', p_causation_id,
    'idempotency_key', p_idempotency_key,
    'payload', p_payload,
    'attempt', 1,
    'created_at', now()
  );

  select pgmq.send(p_queue, v_envelope) into v_msg_id;
  return v_msg_id;
end;
$$;

revoke all on function config.enqueue_job(text, text, text, uuid, text, jsonb, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Scheduled work (masterplan 45): cron enqueues, it never processes.
-- ---------------------------------------------------------------------------

create table config.scheduled_tasks (
  key text primary key,
  description text not null,
  schedule text not null,
  last_run_at timestamptz,
  last_result text,
  enabled boolean not null default true
);

insert into config.scheduled_tasks (key, description, schedule) values
  ('deadline_sweep', 'Recalculate and flag statutory deadlines that are due or missed', '*/15 * * * *'),
  ('workflow_timer_sweep', 'Fire due workflow timers', '*/15 * * * *'),
  ('integration_retry_sweep', 'Re-enqueue failed integration events that are due for retry', '*/5 * * * *'),
  ('reference_data_sync', 'Refresh national reference sources according to their refresh policy', '0 3 * * *'),
  ('compliance_due_sweep', 'Recompute OVK and other obligation due dates', '0 4 * * *'),
  ('metrics_rollup', 'Compute operational and ROI metrics for the previous day', '0 5 * * *'),
  ('break_glass_expiry', 'Expire break-glass grants that have passed their window', '0 * * * *'),
  ('storage_reconciliation', 'Reconcile Storage objects against document versions', '0 2 * * *');

-- Masterplan 41: a deadline is flagged by data, and the heavy work is queued.
create or replace function workflow.sweep_deadlines()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  with newly_missed as (
    update workflow.deadlines d
    set status = 'MISSED'
    where d.status = 'RUNNING'
      and d.due_at < now()
    returning d.id, d.authority_id, d.case_id
  ),
  logged as (
    insert into workflow.deadline_events (deadline_id, authority_id, event_type, reason)
    select id, authority_id, 'MISSED', 'Passed due_at without being met'
    from newly_missed
    returning 1
  )
  select count(*) into v_count from logged;

  insert into reporting.roi_events (authority_id, case_id, event_type, detail)
  select d.authority_id, d.case_id, 'DEADLINE_MISSED',
         jsonb_build_object('deadline_key', d.deadline_key)
  from workflow.deadlines d
  where d.status = 'MISSED' and d.updated_at > now() - interval '1 hour';

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s deadline(s) marked missed', v_count)
  where key = 'deadline_sweep';

  return v_count;
end;
$$;

revoke all on function workflow.sweep_deadlines() from public;

create or replace function audit.expire_break_glass()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update audit.break_glass_requests
  set status = 'EXPIRED'
  where status = 'APPROVED' and expires_at is not null and expires_at < now();
  get diagnostics v_count = row_count;

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s grant(s) expired', v_count)
  where key = 'break_glass_expiry';

  return v_count;
end;
$$;

revoke all on function audit.expire_break_glass() from public;

-- Masterplan 67: failed integration events are retried with backoff, never dropped.
create or replace function integration.sweep_retries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_event record;
begin
  for v_event in
    select e.id, e.connector_instance_id, e.authority_id, e.idempotency_key, e.attempt
    from integration.integration_events e
    where e.status in ('RECEIVED', 'FAILED')
      and e.next_retry_at is not null
      and e.next_retry_at <= now()
      and e.attempt < 8
    limit 500
  loop
    perform config.enqueue_job(
      'integration_inbound',
      'integration_inbound',
      v_event.connector_instance_id::text,
      v_event.authority_id,
      v_event.idempotency_key,
      jsonb_build_object('integration_event_id', v_event.id)
    );
    update integration.integration_events
    set attempt = attempt + 1, next_retry_at = null
    where id = v_event.id;
    v_count := v_count + 1;
  end loop;

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s event(s) re-enqueued', v_count)
  where key = 'integration_retry_sweep';

  return v_count;
end;
$$;

revoke all on function integration.sweep_retries() from public;

create or replace function workflow.sweep_timers()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_timer record;
begin
  for v_timer in
    select t.id, t.instance_id, t.authority_id, t.timer_key
    from workflow.workflow_timers t
    where t.fired_at is null and t.cancelled_at is null and t.fires_at <= now()
    limit 500
  loop
    perform config.enqueue_job(
      'notifications',
      'workflow_timer',
      v_timer.instance_id::text,
      v_timer.authority_id,
      format('timer:%s', v_timer.id),
      jsonb_build_object('timer_id', v_timer.id, 'timer_key', v_timer.timer_key)
    );
    update workflow.workflow_timers set fired_at = now() where id = v_timer.id;
    v_count := v_count + 1;
  end loop;

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s timer(s) fired', v_count)
  where key = 'workflow_timer_sweep';

  return v_count;
end;
$$;

revoke all on function workflow.sweep_timers() from public;

select cron.schedule('tryggsignal_deadline_sweep', '*/15 * * * *', 'select workflow.sweep_deadlines()');
select cron.schedule('tryggsignal_workflow_timer_sweep', '*/15 * * * *', 'select workflow.sweep_timers()');
select cron.schedule('tryggsignal_integration_retry_sweep', '*/5 * * * *', 'select integration.sweep_retries()');
select cron.schedule('tryggsignal_break_glass_expiry', '0 * * * *', 'select audit.expire_break_glass()');

alter table config.scheduled_tasks enable row level security;
grant usage on schema config to authenticated;
grant select on config.scheduled_tasks to authenticated;

-- Operational visibility for the control tower; the schedule itself carries no
-- municipal content, but reading it still requires a signed-in session with an
-- integration or security mandate somewhere in the tenant.
create policy scheduled_tasks_select on config.scheduled_tasks
  for select to authenticated
  using (exists (select 1 from authz.role_assignments ra
                 where ra.user_id = (select authz.current_user_id())));
