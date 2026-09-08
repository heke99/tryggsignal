-- Tryggsignal P39 — explicit provisioning execution journal.
-- Masterplan 192-194: every provisioning step is observable, ordered,
-- idempotent/retryable and can become EXTERNAL_BLOCKED without pretending
-- infrastructure succeeded.

alter table platform.tenant_provisioning_runs
  add column if not exists run_status text not null default 'PENDING'
    check (run_status in (
      'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK'
    )),
  add column if not exists started_at timestamptz,
  add column if not exists retry_count integer not null default 0 check (retry_count >= 0);

create table if not exists platform.tenant_provisioning_steps (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references platform.tenant_provisioning_runs (id) on delete cascade,
  step_key text not null check (step_key in (
    'CREATE_TENANT',
    'RESERVE_SLUG',
    'CREATE_TENANT_DEPLOYMENT',
    'CREATE_SUPABASE_PROJECT',
    'WAIT_UNTIL_READY',
    'APPLY_BASE_MIGRATIONS',
    'ENABLE_REQUIRED_EXTENSIONS',
    'APPLY_AUTHORIZATION',
    'SEED_SYSTEM_ROLES',
    'CREATE_BRANDING_DRAFT',
    'ENABLE_PLATFORM_DOMAIN',
    'CONFIGURE_AUTH',
    'RUN_HEALTH_CHECK',
    'RUN_SECURITY_SMOKE',
    'RUN_TENANT_ISOLATION',
    'MARK_CUSTOMER_TEST_READY',
    'PROMOTE'
  )),
  step_order smallint not null check (step_order between 1 and 17),
  status text not null default 'PENDING'
    check (status in (
      'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK'
    )),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (run_id, step_key),
  unique (run_id, step_order)
);

create index if not exists tenant_provisioning_steps_run_status_idx
  on platform.tenant_provisioning_steps (run_id, status, step_order);

alter table platform.tenant_provisioning_steps enable row level security;

comment on table platform.tenant_provisioning_steps is
  'Server-only P39 execution journal. No client grants/policies: provisioning infrastructure is controlled by service-role orchestration.';

create trigger tenant_provisioning_steps_set_updated_at
  before update on platform.tenant_provisioning_steps
  for each row execute function config.set_updated_at();

create or replace function platform.ensure_provisioning_steps(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not exists (
    select 1 from platform.tenant_provisioning_runs r where r.id = p_run_id
  ) then
    raise exception 'Unknown provisioning run %', p_run_id using errcode = 'no_data_found';
  end if;

  insert into platform.tenant_provisioning_steps (run_id, step_key, step_order)
  select p_run_id, x.step_key, x.step_order
  from (
    values
      ('CREATE_TENANT', 1),
      ('RESERVE_SLUG', 2),
      ('CREATE_TENANT_DEPLOYMENT', 3),
      ('CREATE_SUPABASE_PROJECT', 4),
      ('WAIT_UNTIL_READY', 5),
      ('APPLY_BASE_MIGRATIONS', 6),
      ('ENABLE_REQUIRED_EXTENSIONS', 7),
      ('APPLY_AUTHORIZATION', 8),
      ('SEED_SYSTEM_ROLES', 9),
      ('CREATE_BRANDING_DRAFT', 10),
      ('ENABLE_PLATFORM_DOMAIN', 11),
      ('CONFIGURE_AUTH', 12),
      ('RUN_HEALTH_CHECK', 13),
      ('RUN_SECURITY_SMOKE', 14),
      ('RUN_TENANT_ISOLATION', 15),
      ('MARK_CUSTOMER_TEST_READY', 16),
      ('PROMOTE', 17)
  ) as x(step_key, step_order)
  on conflict (run_id, step_key) do nothing;

  select count(*) into v_count
  from platform.tenant_provisioning_steps s
  where s.run_id = p_run_id;

  return v_count;
end;
$$;

revoke all on function platform.ensure_provisioning_steps(uuid)
  from public, anon, authenticated;

create or replace function platform.seed_provisioning_steps()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform platform.ensure_provisioning_steps(new.id);
  return new;
end;
$$;

revoke all on function platform.seed_provisioning_steps()
  from public, anon, authenticated;

create trigger tenant_provisioning_runs_seed_steps
  after insert on platform.tenant_provisioning_runs
  for each row execute function platform.seed_provisioning_steps();

-- Backfill any run created before this migration.
do $$
declare
  v_run uuid;
begin
  for v_run in select id from platform.tenant_provisioning_runs loop
    perform platform.ensure_provisioning_steps(v_run);
  end loop;
end;
$$;

create or replace function platform.transition_provisioning_step(
  p_run_id uuid,
  p_step_key text,
  p_to_status text,
  p_error text default null,
  p_metadata jsonb default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_step platform.tenant_provisioning_steps%rowtype;
  v_attempt integer;
begin
  select * into v_step
  from platform.tenant_provisioning_steps s
  where s.run_id = p_run_id and s.step_key = p_step_key
  for update;

  if not found then
    raise exception 'Unknown provisioning step % for run %', p_step_key, p_run_id
      using errcode = 'no_data_found';
  end if;

  if p_to_status not in (
    'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK'
  ) then
    raise exception 'Invalid provisioning step status %', p_to_status
      using errcode = 'check_violation';
  end if;

  if v_step.status = p_to_status then
    return v_step.attempt_count;
  end if;

  if p_to_status = 'RUNNING' then
    if v_step.status not in ('PENDING', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK') then
      raise exception 'Step % cannot start from %', p_step_key, v_step.status
        using errcode = 'raise_exception';
    end if;

    if exists (
      select 1
      from platform.tenant_provisioning_steps prior
      where prior.run_id = p_run_id
        and prior.step_order < v_step.step_order
        and prior.status <> 'SUCCEEDED'
    ) then
      raise exception 'Step % cannot start before all previous steps succeeded', p_step_key
        using errcode = 'check_violation';
    end if;

    update platform.tenant_provisioning_steps
    set status = 'RUNNING',
        attempt_count = attempt_count + 1,
        started_at = now(),
        completed_at = null,
        last_error = null,
        metadata = case when p_metadata is null then metadata else metadata || p_metadata end
    where id = v_step.id
    returning attempt_count into v_attempt;

    return v_attempt;
  end if;

  if p_to_status = 'SUCCEEDED' then
    if v_step.status <> 'RUNNING' then
      raise exception 'Step % can only succeed from RUNNING', p_step_key
        using errcode = 'raise_exception';
    end if;

    update platform.tenant_provisioning_steps
    set status = 'SUCCEEDED',
        completed_at = now(),
        last_error = null,
        metadata = case when p_metadata is null then metadata else metadata || p_metadata end
    where id = v_step.id
    returning attempt_count into v_attempt;

    return v_attempt;
  end if;

  if p_to_status in ('FAILED', 'EXTERNAL_BLOCKED') then
    if v_step.status <> 'RUNNING' then
      raise exception 'Step % can only fail/block from RUNNING', p_step_key
        using errcode = 'raise_exception';
    end if;
    if p_error is null or length(trim(p_error)) < 8 then
      raise exception 'Failed/blocked provisioning step requires diagnostic detail'
        using errcode = 'check_violation';
    end if;

    update platform.tenant_provisioning_steps
    set status = p_to_status,
        completed_at = now(),
        last_error = trim(p_error),
        metadata = case when p_metadata is null then metadata else metadata || p_metadata end
    where id = v_step.id
    returning attempt_count into v_attempt;

    return v_attempt;
  end if;

  if p_to_status = 'ROLLED_BACK' then
    if v_step.status not in ('SUCCEEDED', 'FAILED', 'EXTERNAL_BLOCKED') then
      raise exception 'Step % cannot roll back from %', p_step_key, v_step.status
        using errcode = 'raise_exception';
    end if;

    update platform.tenant_provisioning_steps
    set status = 'ROLLED_BACK',
        completed_at = now(),
        last_error = null,
        metadata = case when p_metadata is null then metadata else metadata || p_metadata end
    where id = v_step.id
    returning attempt_count into v_attempt;

    return v_attempt;
  end if;

  raise exception 'Direct reset to PENDING is not allowed'
    using errcode = 'raise_exception';
end;
$$;

revoke all on function platform.transition_provisioning_step(uuid, text, text, text, jsonb)
  from public, anon, authenticated;

create or replace function platform.transition_provisioning_run(
  p_run_id uuid,
  p_to_status text,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run platform.tenant_provisioning_runs%rowtype;
begin
  select * into v_run
  from platform.tenant_provisioning_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'Unknown provisioning run %', p_run_id using errcode = 'no_data_found';
  end if;

  if p_to_status not in (
    'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK'
  ) then
    raise exception 'Invalid provisioning run status %', p_to_status
      using errcode = 'check_violation';
  end if;

  if v_run.run_status = p_to_status then
    return v_run.run_status;
  end if;

  if p_to_status = 'RUNNING' then
    if v_run.run_status not in ('PENDING', 'FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK') then
      raise exception 'Provisioning run cannot start from %', v_run.run_status
        using errcode = 'raise_exception';
    end if;

    update platform.tenant_provisioning_runs
    set run_status = 'RUNNING',
        started_at = coalesce(started_at, now()),
        completed_at = null,
        last_error = null,
        retry_count = retry_count + case
          when v_run.run_status in ('FAILED', 'EXTERNAL_BLOCKED', 'ROLLED_BACK') then 1
          else 0
        end
    where id = p_run_id;

    return 'RUNNING';
  end if;

  if p_to_status = 'SUCCEEDED' then
    if v_run.run_status <> 'RUNNING' then
      raise exception 'Provisioning run can only succeed from RUNNING'
        using errcode = 'raise_exception';
    end if;
    if exists (
      select 1
      from platform.tenant_provisioning_steps s
      where s.run_id = p_run_id and s.status <> 'SUCCEEDED'
    ) then
      raise exception 'Provisioning run cannot succeed before every step succeeded'
        using errcode = 'check_violation';
    end if;

    update platform.tenant_provisioning_runs
    set run_status = 'SUCCEEDED', completed_at = now(), last_error = null
    where id = p_run_id;
    return 'SUCCEEDED';
  end if;

  if p_to_status in ('FAILED', 'EXTERNAL_BLOCKED') then
    if v_run.run_status <> 'RUNNING' then
      raise exception 'Provisioning run can only fail/block from RUNNING'
        using errcode = 'raise_exception';
    end if;
    if p_error is null or length(trim(p_error)) < 8 then
      raise exception 'Failed/blocked provisioning run requires diagnostic detail'
        using errcode = 'check_violation';
    end if;

    update platform.tenant_provisioning_runs
    set run_status = p_to_status, completed_at = now(), last_error = trim(p_error)
    where id = p_run_id;
    return p_to_status;
  end if;

  if p_to_status = 'ROLLED_BACK' then
    if v_run.run_status not in ('RUNNING', 'FAILED', 'EXTERNAL_BLOCKED') then
      raise exception 'Provisioning run cannot roll back from %', v_run.run_status
        using errcode = 'raise_exception';
    end if;

    update platform.tenant_provisioning_runs
    set run_status = 'ROLLED_BACK', completed_at = now(), last_error = null
    where id = p_run_id;
    return 'ROLLED_BACK';
  end if;

  raise exception 'Direct reset to PENDING is not allowed'
    using errcode = 'raise_exception';
end;
$$;

revoke all on function platform.transition_provisioning_run(uuid, text, text)
  from public, anon, authenticated;

create or replace function public.list_provisioning_steps(p_run_id uuid)
returns table (
  step_key text,
  step_order smallint,
  status text,
  attempt_count integer,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.step_key,
    s.step_order,
    s.status,
    s.attempt_count,
    s.started_at,
    s.completed_at,
    s.last_error,
    s.metadata
  from platform.tenant_provisioning_steps s
  where s.run_id = p_run_id
  order by s.step_order;
$$;

revoke all on function public.list_provisioning_steps(uuid)
  from public, anon, authenticated;
grant execute on function public.list_provisioning_steps(uuid) to service_role;


-- Service-role wrappers for the server orchestrator. The platform schema stays
-- unexposed to PostgREST clients.
create or replace function public.transition_provisioning_step(
  p_run_id uuid,
  p_step_key text,
  p_to_status text,
  p_error text default null,
  p_metadata jsonb default null
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select platform.transition_provisioning_step(
    p_run_id, p_step_key, p_to_status, p_error, p_metadata
  );
$$;

revoke all on function public.transition_provisioning_step(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.transition_provisioning_step(uuid, text, text, text, jsonb)
  to service_role;

create or replace function public.transition_provisioning_run(
  p_run_id uuid,
  p_to_status text,
  p_error text default null
)
returns text
language sql
security definer
set search_path = ''
as $$
  select platform.transition_provisioning_run(p_run_id, p_to_status, p_error);
$$;

revoke all on function public.transition_provisioning_run(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.transition_provisioning_run(uuid, text, text)
  to service_role;

-- Reruns may refresh metadata for the exact same data plane, but may never
-- silently rebind a municipality/environment to another Supabase project.
create or replace function public.register_tenant_data_plane(
  p_tenant_id uuid,
  p_environment text,
  p_project_ref text,
  p_region text,
  p_supabase_url text,
  p_publishable_key text,
  p_privileged_credential_reference text,
  p_schema_version text,
  p_health_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing platform.tenant_deployments%rowtype;
  v_id uuid;
begin
  if p_environment not in ('DEV', 'TEST', 'CUSTOMER_TEST', 'PRODUCTION') then
    raise exception 'Invalid deployment environment' using errcode = 'check_violation';
  end if;
  if p_health_status not in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE') then
    raise exception 'Invalid health status' using errcode = 'check_violation';
  end if;
  if p_project_ref is null or length(trim(p_project_ref)) < 8 then
    raise exception 'Supabase project ref is required' using errcode = 'check_violation';
  end if;
  if p_privileged_credential_reference is null
     or p_privileged_credential_reference ~* '^(eyJ|sb_secret|service_role)' then
    raise exception 'Only a privileged credential reference may be persisted'
      using errcode = 'check_violation';
  end if;

  select * into v_existing
  from platform.tenant_deployments d
  where d.tenant_id = p_tenant_id and d.environment = p_environment
  for update;

  if found then
    if v_existing.supabase_project_ref <> trim(p_project_ref) then
      raise exception 'Existing tenant deployment cannot be rebound to another Supabase project'
        using errcode = 'check_violation';
    end if;

    update platform.tenant_deployments
    set supabase_region = p_region,
        supabase_url = p_supabase_url,
        publishable_key = p_publishable_key,
        privileged_credential_reference = p_privileged_credential_reference,
        schema_version = p_schema_version,
        status = 'ACTIVE',
        health_status = p_health_status,
        last_health_check_at = now()
    where id = v_existing.id
    returning id into v_id;

    return v_id;
  end if;

  insert into platform.tenant_deployments (
    tenant_id, environment, supabase_project_ref, supabase_region, supabase_url,
    publishable_key, privileged_credential_reference, schema_version,
    status, health_status, last_health_check_at
  ) values (
    p_tenant_id, p_environment, trim(p_project_ref), p_region, p_supabase_url,
    p_publishable_key, p_privileged_credential_reference, p_schema_version,
    'ACTIVE', p_health_status, now()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_tenant_data_plane(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_tenant_data_plane(
  uuid, text, text, text, text, text, text, text, text
) to service_role;
