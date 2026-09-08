-- Tryggsignal P39 — execution journal, retry, external block and rollback gate.
-- Synthetic runs are rolled back with the surrounding transaction.

begin;

create temporary table p39_steps_ids (k text primary key, v uuid) on commit drop;

do $$
declare
  v_tenant uuid;
  v_run uuid;
  v_created boolean;
begin
  select tenant_id, run_id, created
    into v_tenant, v_run, v_created
  from public.request_tenant_provisioning(
    'journal-kommun',
    'Journal kommun',
    'auth/journal/staff',
    'p39-journal-integration-0001',
    null
  );

  if not v_created then raise exception 'P39 journal: first request was not created'; end if;
  insert into p39_steps_ids values ('tenant', v_tenant), ('run', v_run);

  if (select count(*) from platform.tenant_provisioning_steps where run_id = v_run) <> 17 then
    raise exception 'P39 journal: canonical 17 provisioning steps were not seeded';
  end if;
  if exists (
    select 1 from platform.tenant_provisioning_steps
    where run_id = v_run and status <> 'PENDING'
  ) then
    raise exception 'P39 journal: a new step was not PENDING';
  end if;
end;
$$;

-- Rerun safety: same idempotency key returns same run and cannot duplicate steps.
do $$
declare
  v_run uuid;
  v_created boolean;
begin
  select run_id, created into v_run, v_created
  from public.request_tenant_provisioning(
    'journal-kommun',
    'Journal kommun',
    'auth/journal/staff',
    'p39-journal-integration-0001',
    null
  );

  if v_created then raise exception 'P39 journal: rerun created a new run'; end if;
  if v_run <> (select v from p39_steps_ids where k = 'run') then
    raise exception 'P39 journal: rerun changed run id';
  end if;
  if (select count(*) from platform.tenant_provisioning_steps where run_id = v_run) <> 17 then
    raise exception 'P39 journal: rerun duplicated steps';
  end if;
end;
$$;

-- Order is a hard gate.
do $$
declare v_blocked boolean := false;
begin
  perform platform.transition_provisioning_run(
    (select v from p39_steps_ids where k = 'run'),
    'RUNNING'
  );

  begin
    perform platform.transition_provisioning_step(
      (select v from p39_steps_ids where k = 'run'),
      'CREATE_SUPABASE_PROJECT',
      'RUNNING'
    );
  exception when check_violation then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'P39 journal: a later step started before prior steps succeeded';
  end if;
end;
$$;

-- First three checkpoints succeed.
do $$
declare
  v_run uuid := (select v from p39_steps_ids where k = 'run');
  v_key text;
begin
  foreach v_key in array array[
    'CREATE_TENANT',
    'RESERVE_SLUG',
    'CREATE_TENANT_DEPLOYMENT'
  ]
  loop
    perform platform.transition_provisioning_step(v_run, v_key, 'RUNNING');
    perform platform.transition_provisioning_step(v_run, v_key, 'SUCCEEDED');
  end loop;
end;
$$;

-- External project/cost approval is first-class, not a fake success.
do $$
declare
  v_run uuid := (select v from p39_steps_ids where k = 'run');
begin
  perform platform.transition_provisioning_step(v_run, 'CREATE_SUPABASE_PROJECT', 'RUNNING');
  perform platform.transition_provisioning_step(
    v_run,
    'CREATE_SUPABASE_PROJECT',
    'EXTERNAL_BLOCKED',
    'Supabase organization and project cost approval required'
  );
  perform platform.transition_provisioning_run(
    v_run,
    'EXTERNAL_BLOCKED',
    'Supabase organization and project cost approval required'
  );

  if (select status from platform.tenant_provisioning_steps
      where run_id = v_run and step_key = 'CREATE_SUPABASE_PROJECT') <> 'EXTERNAL_BLOCKED' then
    raise exception 'P39 journal: external block was not persisted';
  end if;
end;
$$;

-- Recovery retries only the blocked checkpoint and increments counters.
do $$
declare
  v_run uuid := (select v from p39_steps_ids where k = 'run');
  v_attempt integer;
begin
  perform platform.transition_provisioning_run(v_run, 'RUNNING');
  v_attempt := platform.transition_provisioning_step(
    v_run,
    'CREATE_SUPABASE_PROJECT',
    'RUNNING'
  );
  if v_attempt <> 2 then
    raise exception 'P39 journal: provider retry attempt %, expected 2', v_attempt;
  end if;
  perform platform.transition_provisioning_step(v_run, 'CREATE_SUPABASE_PROJECT', 'SUCCEEDED');

  if (select retry_count from platform.tenant_provisioning_runs where id = v_run) <> 1 then
    raise exception 'P39 journal: run retry_count was not incremented';
  end if;
end;
$$;

-- A run cannot claim success while later work remains.
do $$
declare
  v_run uuid := (select v from p39_steps_ids where k = 'run');
  v_blocked boolean := false;
begin
  begin
    perform platform.transition_provisioning_run(v_run, 'SUCCEEDED');
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'P39 journal: incomplete run claimed SUCCEEDED';
  end if;
end;
$$;

-- Finish all remaining steps in canonical order.
do $$
declare
  v_run uuid := (select v from p39_steps_ids where k = 'run');
  v_step record;
begin
  for v_step in
    select step_key
    from platform.tenant_provisioning_steps
    where run_id = v_run and status <> 'SUCCEEDED'
    order by step_order
  loop
    perform platform.transition_provisioning_step(v_run, v_step.step_key, 'RUNNING');
    perform platform.transition_provisioning_step(v_run, v_step.step_key, 'SUCCEEDED');
  end loop;

  perform platform.transition_provisioning_run(v_run, 'SUCCEEDED');

  if (select run_status from platform.tenant_provisioning_runs where id = v_run) <> 'SUCCEEDED' then
    raise exception 'P39 journal: completed run did not become SUCCEEDED';
  end if;
end;
$$;

-- Separate recovery run proves compensating rollback state is explicit.
do $$
declare
  v_run uuid;
begin
  select run_id into v_run
  from public.request_tenant_provisioning(
    'rollback-kommun',
    'Rollback kommun',
    'auth/rollback/staff',
    'p39-journal-rollback-0001',
    null
  );

  perform platform.transition_provisioning_run(v_run, 'RUNNING');
  perform platform.transition_provisioning_step(v_run, 'CREATE_TENANT', 'RUNNING');
  perform platform.transition_provisioning_step(v_run, 'CREATE_TENANT', 'SUCCEEDED');
  perform platform.transition_provisioning_step(v_run, 'CREATE_TENANT', 'ROLLED_BACK');
  perform platform.transition_provisioning_run(v_run, 'ROLLED_BACK');

  if (select run_status from platform.tenant_provisioning_runs where id = v_run) <> 'ROLLED_BACK' then
    raise exception 'P39 journal: rollback status was not persisted';
  end if;
end;
$$;

-- Journal is service-only.
do $$
begin
  if has_function_privilege('authenticated', 'public.list_provisioning_steps(uuid)', 'EXECUTE') then
    raise exception 'P39 journal: authenticated can read control-plane provisioning journal';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.transition_provisioning_step(uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'P39 journal: authenticated can transition provisioning steps';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.transition_provisioning_run(uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'P39 journal: authenticated can transition provisioning runs';
  end if;
  if not has_function_privilege('service_role', 'public.list_provisioning_steps(uuid)', 'EXECUTE') then
    raise exception 'P39 journal: service_role cannot read provisioning journal';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.transition_provisioning_step(uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'P39 journal: service_role cannot transition provisioning steps';
  end if;
end;
$$;

select 'P39 PROVISIONING EXECUTION JOURNAL: GREEN' as result;

rollback;
