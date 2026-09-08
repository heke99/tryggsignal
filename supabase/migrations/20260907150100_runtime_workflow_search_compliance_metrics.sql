-- Tryggsignal — the runtime that turns the P8/P11/P24/P26 schemas into working
-- features: workflow advancement, search indexing, OVK due dates and metrics.
-- Masterplan 39, 45, 46, 74, 91, 92.

-- ---------------------------------------------------------------------------
-- P11 Search indexing (masterplan 46/47)
--
-- The index is maintained by trigger rather than by a job, so a case can never
-- be findable before it exists or linger after it is archived. The function is
-- SECURITY DEFINER because search.entities has no client INSERT policy: the
-- index is written by the system, never by a user.
-- ---------------------------------------------------------------------------

create or replace function search.index_case()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into search.entities (
    authority_id, entity_type, entity_id, case_id, title, subtitle, body,
    information_class, security_scope, department_id
  )
  values (
    new.authority_id, 'CASE', new.id, new.id,
    new.case_number,
    new.title,
    concat_ws(' ',
      new.description,
      new.case_type,
      new.process_type,
      new.measure_type,
      new.external_case_number,
      (select p.designation from property.properties p where p.id = new.primary_property_id)
    ),
    new.information_class,
    'CASE_PARTIES',
    new.department_id
  )
  on conflict (entity_type, entity_id) do update
  set title = excluded.title,
      subtitle = excluded.subtitle,
      body = excluded.body,
      information_class = excluded.information_class,
      department_id = excluded.department_id;
  return new;
end;
$$;

revoke all on function search.index_case() from public;

create trigger cases_search_index
  after insert or update of case_number, title, description, information_class,
    department_id, primary_property_id, external_case_number
  on core.cases
  for each row execute function search.index_case();

-- ---------------------------------------------------------------------------
-- P8 Workflow runtime (masterplan 39)
--
-- The definition is data: {"initial": "...", "states": {"<state>": {"to": [...],
-- "tasks": [{"key": ..., "title": ...}], "timers": [{"key": ..., "days": n}]}}}
-- A transition that the version does not declare is refused, so an old case can
-- never be advanced by a rule that was introduced after it started.
-- ---------------------------------------------------------------------------

create or replace function workflow.start_instance(
  p_case_id uuid,
  p_template_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_version workflow.workflow_template_versions%rowtype;
  v_instance_id uuid;
begin
  select * into v_case from core.cases c where c.id = p_case_id;
  if not found then
    raise exception 'Unknown case %', p_case_id using errcode = 'no_data_found';
  end if;

  select v.* into v_version
  from workflow.workflow_template_versions v
  join workflow.workflow_templates t on t.id = v.template_id
  where t.authority_id = v_case.authority_id
    and t.key = p_template_key
    and v.published_at is not null
    and v.valid_from <= now()
    and (v.valid_to is null or v.valid_to > now())
  order by v.version desc
  limit 1;

  if not found then
    raise exception 'No published workflow version of "%" is in force for this authority', p_template_key
      using errcode = 'no_data_found';
  end if;

  insert into workflow.workflow_instances (
    authority_id, case_id, template_version_id, current_state
  )
  values (
    v_case.authority_id, p_case_id, v_version.id, v_version.definition->>'initial'
  )
  on conflict (case_id, template_version_id) do nothing
  returning id into v_instance_id;

  if v_instance_id is null then
    select id into v_instance_id from workflow.workflow_instances
    where case_id = p_case_id and template_version_id = v_version.id;
    return v_instance_id;
  end if;

  insert into workflow.workflow_transitions (instance_id, authority_id, to_state, trigger_type, reason)
  values (v_instance_id, v_case.authority_id, v_version.definition->>'initial', 'SYSTEM', 'Instance started');

  update core.cases set workflow_version_id = v_version.id where id = p_case_id;

  perform workflow.materialize_state(v_instance_id);
  return v_instance_id;
end;
$$;

revoke all on function workflow.start_instance(uuid, text) from public;

-- Creates the tasks and timers the current state declares. Idempotent: a task or
-- timer that already exists for the state is not created twice.
create or replace function workflow.materialize_state(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance workflow.workflow_instances%rowtype;
  v_definition jsonb;
  v_state jsonb;
  v_task jsonb;
  v_timer jsonb;
begin
  select * into v_instance from workflow.workflow_instances i where i.id = p_instance_id;
  select v.definition into v_definition
  from workflow.workflow_template_versions v where v.id = v_instance.template_version_id;

  v_state := v_definition->'states'->v_instance.current_state;
  if v_state is null then
    return;
  end if;

  for v_task in select * from jsonb_array_elements(coalesce(v_state->'tasks', '[]'::jsonb))
  loop
    insert into workflow.workflow_tasks (
      instance_id, authority_id, case_id, task_key, title, status
    )
    select p_instance_id, v_instance.authority_id, v_instance.case_id,
           v_task->>'key', v_task->>'title', 'OPEN'
    where not exists (
      select 1 from workflow.workflow_tasks t
      where t.instance_id = p_instance_id
        and t.task_key = v_task->>'key'
        and t.status in ('OPEN', 'IN_PROGRESS', 'BLOCKED')
    );
  end loop;

  for v_timer in select * from jsonb_array_elements(coalesce(v_state->'timers', '[]'::jsonb))
  loop
    insert into workflow.workflow_timers (instance_id, authority_id, timer_key, fires_at)
    select p_instance_id, v_instance.authority_id, v_timer->>'key',
           now() + ((v_timer->>'days')::integer * interval '1 day')
    where not exists (
      select 1 from workflow.workflow_timers t
      where t.instance_id = p_instance_id
        and t.timer_key = v_timer->>'key'
        and t.fired_at is null and t.cancelled_at is null
    );
  end loop;
end;
$$;

revoke all on function workflow.materialize_state(uuid) from public;

create or replace function workflow.advance(
  p_instance_id uuid,
  p_to_state text,
  p_reason text default null,
  p_trigger_type text default 'USER'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance workflow.workflow_instances%rowtype;
  v_definition jsonb;
  v_allowed jsonb;
  v_actor uuid := (select authz.current_user_id());
begin
  select * into v_instance from workflow.workflow_instances i where i.id = p_instance_id for update;
  if not found then
    raise exception 'Unknown workflow instance %', p_instance_id using errcode = 'no_data_found';
  end if;
  if v_instance.status <> 'RUNNING' then
    raise exception 'Workflow instance is % and cannot be advanced', v_instance.status
      using errcode = 'raise_exception';
  end if;

  -- Masterplan 18: the caller must be allowed to change this case, and the check
  -- happens here because this function runs as owner.
  if p_trigger_type = 'USER'
     and not authz.has_permission('case.update', v_instance.authority_id, null, null) then
    raise exception 'Not permitted to advance this case' using errcode = 'insufficient_privilege';
  end if;

  select v.definition into v_definition
  from workflow.workflow_template_versions v where v.id = v_instance.template_version_id;

  v_allowed := v_definition->'states'->v_instance.current_state->'to';
  if v_allowed is null or not (v_allowed ? p_to_state) then
    raise exception 'Transition % -> % is not declared by this workflow version',
      v_instance.current_state, p_to_state using errcode = 'raise_exception';
  end if;

  insert into workflow.workflow_transitions (
    instance_id, authority_id, from_state, to_state, triggered_by, trigger_type, reason
  )
  values (
    p_instance_id, v_instance.authority_id, v_instance.current_state, p_to_state,
    v_actor, p_trigger_type, p_reason
  );

  update workflow.workflow_instances
  set current_state = p_to_state,
      status = case when (v_definition->'states'->p_to_state->>'final')::boolean then 'COMPLETED' else status end,
      completed_at = case when (v_definition->'states'->p_to_state->>'final')::boolean then now() else completed_at end
  where id = p_instance_id;

  -- Timers belong to the state that declared them.
  update workflow.workflow_timers
  set cancelled_at = now()
  where instance_id = p_instance_id and fired_at is null and cancelled_at is null;

  perform workflow.materialize_state(p_instance_id);

  insert into reporting.roi_events (authority_id, case_id, event_type, phase, actor, detail)
  values (v_instance.authority_id, v_instance.case_id, 'PHASE_COMPLETED', v_instance.current_state,
          v_actor, jsonb_build_object('to_state', p_to_state, 'trigger', p_trigger_type));
end;
$$;

revoke all on function workflow.advance(uuid, text, text, text) from public;
grant execute on function workflow.advance(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- P24 OVK / compliance due dates (masterplan 74)
-- ---------------------------------------------------------------------------

create or replace function compliance.recompute_due_dates()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update compliance.compliance_objects o
  set next_due_at = case
        when o.last_performed_at is null then null
        else o.last_performed_at + (r.interval_months * interval '1 month')
      end,
      status = case
        when o.status = 'EXEMPT' then 'EXEMPT'
        when o.last_performed_at is null then 'UNKNOWN'
        when o.last_performed_at + (r.interval_months * interval '1 month') < current_date then 'OVERDUE'
        when o.last_performed_at + (r.interval_months * interval '1 month')
             < current_date + interval '90 days' then 'DUE'
        else 'COMPLIANT'
      end,
      -- A simple, explainable risk score: how far past due, capped. Anything
      -- cleverer belongs in the rule engine, not in a sweep.
      risk_score = case
        when o.last_performed_at is null then 50
        else least(100, greatest(0,
          extract(day from (current_date - (o.last_performed_at + (r.interval_months * interval '1 month'))))::numeric))
      end
  from compliance.obligation_rules r
  where r.obligation_id = o.obligation_id
    and r.valid_from <= current_date
    and (r.valid_to is null or r.valid_to > current_date);

  get diagnostics v_count = row_count;

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s compliance object(s) recomputed', v_count)
  where key = 'compliance_due_sweep';

  return v_count;
end;
$$;

revoke all on function compliance.recompute_due_dates() from public;

-- ---------------------------------------------------------------------------
-- P26 Operational and ROI metrics (masterplan 91, 92)
-- ---------------------------------------------------------------------------

create or replace function reporting.rollup_metrics(p_date date default (current_date - 1))
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
  insert into reporting.operational_metrics (authority_id, metric_key, metric_date, dimension, value)
  select a.id, m.metric_key, p_date, m.dimension, m.value
  from organization.authorities a
  cross join lateral (
    select 'cases_received' as metric_key, '{}'::jsonb as dimension,
           count(*)::numeric as value
    from core.cases c
    where c.authority_id = a.id and c.created_at::date = p_date
    union all
    select 'cases_decided', '{}'::jsonb, count(*)::numeric
    from core.cases c
    where c.authority_id = a.id and c.decided_at::date = p_date
    union all
    select 'backlog_open', '{}'::jsonb, count(*)::numeric
    from core.cases c
    where c.authority_id = a.id and c.status not in ('CLOSED', 'ARCHIVED', 'DRAFT')
    union all
    select 'deadlines_missed', '{}'::jsonb, count(*)::numeric
    from workflow.deadlines d
    where d.authority_id = a.id and d.status = 'MISSED' and d.updated_at::date = p_date
    union all
    -- Masterplan 92: median processing time, in days, for cases decided that day.
    select 'median_processing_days', '{}'::jsonb,
           coalesce(percentile_cont(0.5) within group (
             order by extract(epoch from (c.decided_at - c.registered_at)) / 86400
           ), 0)::numeric
    from core.cases c
    where c.authority_id = a.id and c.decided_at::date = p_date and c.registered_at is not null
    union all
    select 'ai_suggestions', '{}'::jsonb, count(*)::numeric
    from ai.findings f
    where f.authority_id = a.id and f.created_at::date = p_date
    union all
    select 'ai_accepted', '{}'::jsonb, count(*)::numeric
    from ai.reviews r
    where r.authority_id = a.id and r.decision = 'ACCEPTED' and r.reviewed_at::date = p_date
    union all
    select 'ai_rejected', '{}'::jsonb, count(*)::numeric
    from ai.reviews r
    where r.authority_id = a.id and r.decision = 'REJECTED' and r.reviewed_at::date = p_date
    union all
    select 'inspections_completed', '{}'::jsonb, count(*)::numeric
    from inspection.inspections i
    where i.authority_id = a.id and i.status = 'COMPLETED' and i.performed_at::date = p_date
  ) m
  on conflict (authority_id, metric_key, metric_date, dimension) do update
  set value = excluded.value, computed_at = now();

  get diagnostics v_count = row_count;

  update config.scheduled_tasks
  set last_run_at = now(), last_result = format('%s metric row(s) for %s', v_count, p_date)
  where key = 'metrics_rollup';

  return v_count;
end;
$$;

revoke all on function reporting.rollup_metrics(date) from public;

select cron.schedule('tryggsignal_compliance_due_sweep', '0 4 * * *',
                     'select compliance.recompute_due_dates()');
select cron.schedule('tryggsignal_metrics_rollup', '0 5 * * *',
                     'select reporting.rollup_metrics()');
