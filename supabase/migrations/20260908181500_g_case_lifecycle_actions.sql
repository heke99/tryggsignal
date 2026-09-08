-- Tryggsignal Phase G1/G5 — canonical operational case lifecycle actions.
-- Masterplan G1 (case management) + G5 (workflow workspace).
--
-- The UI must never mutate workflow internals directly. Existing workflow.advance()
-- remains the owner-level primitive used by tests/system code, while authenticated
-- callers get narrow wrappers with explicit authorization, tenant/authority checks,
-- audit, and optional case-status/phase projection from the versioned workflow data.

-- ---------------------------------------------------------------------------
-- Tighten ordinary case UPDATE to the same ABAC decision used by SELECT.
-- This closes a subtle gap where case.update could mutate a secrecy-classified
-- case that authz.can() would not let the caller read.
-- ---------------------------------------------------------------------------

drop policy if exists cases_update on core.cases;

create policy cases_update on core.cases
  for update to authenticated
  using (
    (authz.can('case.update', jsonb_build_object(
      'authority_id', authority_id,
      'department_id', department_id,
      'assigned_user_id', assigned_user_id,
      'assigned_team_id', assigned_team_id,
      'information_class', information_class
    )) ->> 'allowed')::boolean
  )
  with check (
    (authz.can('case.update', jsonb_build_object(
      'authority_id', authority_id,
      'department_id', department_id,
      'assigned_user_id', assigned_user_id,
      'assigned_team_id', assigned_team_id,
      'information_class', information_class
    )) ->> 'allowed')::boolean
  );

-- Direct table UPDATE must not be a back door around the more specific
-- case.assign / case.close / decision.approve permissions. Owner/system SQL with
-- no Auth JWT is left alone; Data API writes still pass RLS before reaching here.
create or replace function core.enforce_case_lifecycle_permissions()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_permission text;
  v_decision jsonb;
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.assigned_user_id is distinct from old.assigned_user_id
     or new.assigned_team_id is distinct from old.assigned_team_id then
    v_decision := authz.can('case.assign', jsonb_build_object(
      'authority_id', old.authority_id,
      'department_id', old.department_id,
      'assigned_user_id', old.assigned_user_id,
      'assigned_team_id', old.assigned_team_id,
      'information_class', old.information_class
    ));
    if not coalesce((v_decision->>'allowed')::boolean, false) then
      raise exception 'Not permitted to assign this case' using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status is distinct from old.status then
    v_permission := case
      when new.status = 'DECIDED' then 'decision.approve'
      when new.status in ('CLOSED', 'ARCHIVED') then 'case.close'
      else 'case.update'
    end;

    v_decision := authz.can(v_permission, jsonb_build_object(
      'authority_id', old.authority_id,
      'department_id', old.department_id,
      'assigned_user_id', old.assigned_user_id,
      'assigned_team_id', old.assigned_team_id,
      'information_class', old.information_class
    ));
    if not coalesce((v_decision->>'allowed')::boolean, false) then
      raise exception 'Not permitted to change case status to %', new.status
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function core.enforce_case_lifecycle_permissions() from public;

drop trigger if exists cases_lifecycle_permission_guard on core.cases;
create trigger cases_lifecycle_permission_guard
  before update of status, assigned_user_id, assigned_team_id on core.cases
  for each row execute function core.enforce_case_lifecycle_permissions();

-- ---------------------------------------------------------------------------
-- Internal projection helper. A workflow version may declare presentation-level
-- canonical state metadata:
--   {"case_status":"IN_REVIEW","case_phase":"REVIEW"}
-- This is versioned data, not hard-coded legal process logic.
-- ---------------------------------------------------------------------------

create or replace function workflow.apply_case_projection(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case_id uuid;
  v_state text;
  v_definition jsonb;
  v_projection jsonb;
  v_status text;
  v_phase text;
begin
  select i.case_id, i.current_state, v.definition
    into v_case_id, v_state, v_definition
  from workflow.workflow_instances i
  join workflow.workflow_template_versions v on v.id = i.template_version_id
  where i.id = p_instance_id;

  if not found then
    raise exception 'Unknown workflow instance %', p_instance_id using errcode = 'no_data_found';
  end if;

  v_projection := v_definition->'states'->v_state;
  v_status := nullif(v_projection->>'case_status', '');
  v_phase := nullif(v_projection->>'case_phase', '');

  if v_status is null and v_phase is null then
    return;
  end if;

  update core.cases
  set status = coalesce(v_status, status),
      phase = coalesce(v_phase, phase),
      registered_at = case
        when v_status = 'REGISTERED' and registered_at is null then now()
        else registered_at
      end,
      complete_at = case
        when v_status in ('IN_REVIEW', 'AWAITING_DECISION', 'DECIDED') and complete_at is null
          then now()
        else complete_at
      end,
      decided_at = case
        when v_status = 'DECIDED' and decided_at is null then now()
        else decided_at
      end,
      closed_at = case
        when v_status = 'CLOSED' and closed_at is null then now()
        else closed_at
      end,
      updated_by = (select authz.current_user_id())
  where id = v_case_id;
end;
$$;

revoke all on function workflow.apply_case_projection(uuid) from public;
revoke all on function workflow.apply_case_projection(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Start/advance wrappers for authenticated staff.
-- ---------------------------------------------------------------------------

create or replace function workflow.start_instance_for_user(
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
  v_decision jsonb;
  v_instance uuid;
  v_initial_status text;
begin
  select * into v_case from core.cases c where c.id = p_case_id;
  if not found then
    raise exception 'Unknown case %', p_case_id using errcode = 'no_data_found';
  end if;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to start workflow for this case'
      using errcode = 'insufficient_privilege';
  end if;

  v_instance := workflow.start_instance(p_case_id, p_template_key);

  select nullif(v.definition->'states'->i.current_state->>'case_status', '')
    into v_initial_status
  from workflow.workflow_instances i
  join workflow.workflow_template_versions v on v.id = i.template_version_id
  where i.id = v_instance;

  if v_initial_status in ('DECIDED', 'CLOSED', 'ARCHIVED') then
    raise exception 'A workflow may not start in consequential case status %', v_initial_status
      using errcode = 'raise_exception';
  end if;

  perform workflow.apply_case_projection(v_instance);
  perform audit.record(
    'case.workflow.started', 'case', p_case_id, v_case.authority_id,
    format('Workflow template %s started', p_template_key)
  );
  return v_instance;
end;
$$;

revoke all on function workflow.start_instance_for_user(uuid, text) from public;
revoke all on function workflow.start_instance_for_user(uuid, text) from anon;
grant execute on function workflow.start_instance_for_user(uuid, text) to authenticated;

create or replace function workflow.advance_case_for_user(
  p_instance_id uuid,
  p_to_state text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance workflow.workflow_instances%rowtype;
  v_case core.cases%rowtype;
  v_definition jsonb;
  v_target jsonb;
  v_target_status text;
  v_extra_permission text;
  v_decision jsonb;
begin
  select * into v_instance
  from workflow.workflow_instances i
  where i.id = p_instance_id;

  if not found then
    raise exception 'Unknown workflow instance %', p_instance_id using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_instance.case_id;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to advance this case' using errcode = 'insufficient_privilege';
  end if;

  select v.definition into v_definition
  from workflow.workflow_template_versions v
  where v.id = v_instance.template_version_id;

  v_target := v_definition->'states'->p_to_state;
  v_target_status := nullif(v_target->>'case_status', '');

  v_extra_permission := case
    when v_target_status = 'DECIDED' then 'decision.approve'
    when v_target_status in ('CLOSED', 'ARCHIVED') then 'case.close'
    else null
  end;

  if v_extra_permission is not null then
    v_decision := authz.can(v_extra_permission, jsonb_build_object(
      'authority_id', v_case.authority_id,
      'department_id', v_case.department_id,
      'assigned_user_id', v_case.assigned_user_id,
      'assigned_team_id', v_case.assigned_team_id,
      'information_class', v_case.information_class
    ));
    if not coalesce((v_decision->>'allowed')::boolean, false) then
      raise exception 'Transition to % requires %', p_to_state, v_extra_permission
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  perform workflow.advance(p_instance_id, p_to_state, nullif(trim(p_reason), ''), 'USER');
  perform workflow.apply_case_projection(p_instance_id);
  perform audit.record(
    'case.workflow.advanced', 'case', v_case.id, v_case.authority_id,
    coalesce(nullif(trim(p_reason), ''), format('Advanced to %s', p_to_state))
  );
end;
$$;

revoke all on function workflow.advance_case_for_user(uuid, text, text) from public;
revoke all on function workflow.advance_case_for_user(uuid, text, text) from anon;
grant execute on function workflow.advance_case_for_user(uuid, text, text) to authenticated;

-- The raw owner-level primitive lacks the full authz.can()/projection gate. Keep
-- it private to internal database code and tests.
revoke execute on function workflow.advance(uuid, text, text, text) from authenticated;

-- P8 originally checked USER transitions with authority-only case.update scope.
-- That rejects a legitimate department-scoped caseworker. Keep the primitive
-- private, but make its internal USER check identical to the case ABAC boundary
-- so wrapper and primitive cannot drift.
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
as $
declare
  v_instance workflow.workflow_instances%rowtype;
  v_case core.cases%rowtype;
  v_definition jsonb;
  v_allowed jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_decision jsonb;
begin
  select * into v_instance
  from workflow.workflow_instances i
  where i.id = p_instance_id
  for update;

  if not found then
    raise exception 'Unknown workflow instance %', p_instance_id using errcode = 'no_data_found';
  end if;
  if v_instance.status <> 'RUNNING' then
    raise exception 'Workflow instance is % and cannot be advanced', v_instance.status
      using errcode = 'raise_exception';
  end if;

  select * into v_case from core.cases c where c.id = v_instance.case_id;

  if p_trigger_type = 'USER' then
    v_decision := authz.can('case.update', jsonb_build_object(
      'authority_id', v_case.authority_id,
      'department_id', v_case.department_id,
      'assigned_user_id', v_case.assigned_user_id,
      'assigned_team_id', v_case.assigned_team_id,
      'information_class', v_case.information_class
    ));
    if not coalesce((v_decision->>'allowed')::boolean, false) then
      raise exception 'Not permitted to advance this case'
        using errcode = 'insufficient_privilege';
    end if;
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
      status = case
        when coalesce((v_definition->'states'->p_to_state->>'final')::boolean, false)
          then 'COMPLETED'
        else status
      end,
      completed_at = case
        when coalesce((v_definition->'states'->p_to_state->>'final')::boolean, false)
          then now()
        else completed_at
      end
  where id = p_instance_id;

  update workflow.workflow_timers
  set cancelled_at = now()
  where instance_id = p_instance_id
    and fired_at is null
    and cancelled_at is null;

  perform workflow.materialize_state(p_instance_id);

  insert into reporting.roi_events (
    authority_id, case_id, event_type, phase, actor, detail
  )
  values (
    v_instance.authority_id, v_instance.case_id, 'PHASE_COMPLETED',
    v_instance.current_state, v_actor,
    jsonb_build_object('to_state', p_to_state, 'trigger', p_trigger_type)
  );
end;
$;

revoke all on function workflow.advance(uuid, text, text, text) from public;
revoke all on function workflow.advance(uuid, text, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Pause/resume. Statutory deadlines are deliberately NOT changed here: legal
-- deadline suspension is a separate, explainable rule and must never be inferred
-- from an operational workflow pause.
-- ---------------------------------------------------------------------------

create or replace function workflow.set_pause_for_user(
  p_instance_id uuid,
  p_paused boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance workflow.workflow_instances%rowtype;
  v_case core.cases%rowtype;
  v_decision jsonb;
begin
  select * into v_instance
  from workflow.workflow_instances i
  where i.id = p_instance_id
  for update;

  if not found then
    raise exception 'Unknown workflow instance %', p_instance_id using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_instance.case_id;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to pause/resume this case'
      using errcode = 'insufficient_privilege';
  end if;

  if p_paused then
    if v_instance.status <> 'RUNNING' then
      raise exception 'Only a RUNNING workflow can be paused' using errcode = 'raise_exception';
    end if;
    update workflow.workflow_instances
    set status = 'PAUSED', paused_at = now(), updated_at = now()
    where id = p_instance_id;
  else
    if v_instance.status <> 'PAUSED' then
      raise exception 'Only a PAUSED workflow can be resumed' using errcode = 'raise_exception';
    end if;
    update workflow.workflow_instances
    set status = 'RUNNING', resumed_at = now(), updated_at = now()
    where id = p_instance_id;
  end if;

  perform audit.record(
    case when p_paused then 'case.workflow.paused' else 'case.workflow.resumed' end,
    'case', v_case.id, v_case.authority_id, nullif(trim(p_reason), '')
  );
end;
$$;

revoke all on function workflow.set_pause_for_user(uuid, boolean, text) from public;
revoke all on function workflow.set_pause_for_user(uuid, boolean, text) from anon;
grant execute on function workflow.set_pause_for_user(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Assignment history and closure.
-- ---------------------------------------------------------------------------

create or replace function core.assign_case_for_user(
  p_case_id uuid,
  p_assigned_user_id uuid default null,
  p_assigned_team_id uuid default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_actor uuid := (select authz.current_user_id());
  v_decision jsonb;
begin
  select * into v_case from core.cases c where c.id = p_case_id for update;
  if not found then
    raise exception 'Unknown case %', p_case_id using errcode = 'no_data_found';
  end if;

  v_decision := authz.can('case.assign', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to assign this case' using errcode = 'insufficient_privilege';
  end if;

  if p_assigned_user_id is not null and not exists (
    select 1
    from identity.users u
    join identity.user_memberships m on m.user_id = u.id
    where u.id = p_assigned_user_id
      and u.status = 'ACTIVE'
      and m.authority_id = v_case.authority_id
  ) then
    raise exception 'Assignee is not an active member of the case authority'
      using errcode = 'foreign_key_violation';
  end if;

  if p_assigned_team_id is not null and not exists (
    select 1 from organization.teams t
    where t.id = p_assigned_team_id
      and t.authority_id = v_case.authority_id
      and t.is_active
  ) then
    raise exception 'Assigned team does not belong to the case authority'
      using errcode = 'foreign_key_violation';
  end if;

  update core.case_assignments
  set unassigned_at = now()
  where case_id = p_case_id and unassigned_at is null;

  if p_assigned_user_id is not null or p_assigned_team_id is not null then
    insert into core.case_assignments (
      case_id, authority_id, assigned_user_id, assigned_team_id, assigned_by
    )
    values (
      p_case_id, v_case.authority_id, p_assigned_user_id, p_assigned_team_id, v_actor
    );
  end if;

  update core.cases
  set assigned_user_id = p_assigned_user_id,
      assigned_team_id = p_assigned_team_id,
      updated_by = v_actor
  where id = p_case_id;

  perform audit.record(
    'case.assignment.changed', 'case', p_case_id, v_case.authority_id,
    nullif(trim(p_reason), '')
  );
end;
$$;

revoke all on function core.assign_case_for_user(uuid, uuid, uuid, text) from public;
revoke all on function core.assign_case_for_user(uuid, uuid, uuid, text) from anon;
grant execute on function core.assign_case_for_user(uuid, uuid, uuid, text) to authenticated;

create or replace function core.close_case_for_user(
  p_case_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_actor uuid := (select authz.current_user_id());
  v_decision jsonb;
begin
  select * into v_case from core.cases c where c.id = p_case_id for update;
  if not found then
    raise exception 'Unknown case %', p_case_id using errcode = 'no_data_found';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A closure reason is required' using errcode = 'check_violation';
  end if;

  v_decision := authz.can('case.close', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to close this case' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from workflow.workflow_instances i
    where i.case_id = p_case_id and i.status in ('RUNNING', 'PAUSED')
  ) then
    raise exception 'The active workflow must complete before the case can close'
      using errcode = 'raise_exception';
  end if;

  update core.cases
  set status = 'CLOSED',
      phase = 'ARCHIVE',
      closed_at = coalesce(closed_at, now()),
      updated_by = v_actor
  where id = p_case_id;

  perform audit.record(
    'case.closed', 'case', p_case_id, v_case.authority_id, trim(p_reason)
  );
end;
$$;

revoke all on function core.close_case_for_user(uuid, text) from public;
revoke all on function core.close_case_for_user(uuid, text) from anon;
grant execute on function core.close_case_for_user(uuid, text) to authenticated;

-- Canonical UI create command. It is atomic with workflow start: a missing or
-- invalid workflow version rolls the insert back instead of leaving a half-made
-- operational case.
create or replace function core.create_case_for_user(
  p_authority_id uuid,
  p_department_id uuid,
  p_case_number text,
  p_case_type text,
  p_process_type text,
  p_title text,
  p_description text,
  p_priority text,
  p_template_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select authz.current_user_id());
  v_case_id uuid;
  v_instance uuid;
  v_decision jsonb;
begin
  if v_actor is null then
    raise exception 'No active internal user for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(trim(p_case_number), '') is null
     or nullif(trim(p_case_type), '') is null
     or nullif(trim(p_process_type), '') is null
     or nullif(trim(p_title), '') is null
     or nullif(trim(p_template_key), '') is null then
    raise exception 'Required case fields are missing' using errcode = 'check_violation';
  end if;

  if p_department_id is not null and not exists (
    select 1 from organization.departments d
    where d.id = p_department_id and d.authority_id = p_authority_id and d.is_active
  ) then
    raise exception 'Department does not belong to the selected authority'
      using errcode = 'foreign_key_violation';
  end if;

  -- Authorization precedes configuration lookup so an unauthorized caller
  -- cannot use this command to enumerate another authority's workflow catalog.
  v_decision := authz.can('case.create', jsonb_build_object(
    'authority_id', p_authority_id,
    'department_id', p_department_id,
    'information_class', 'INTERNAL'
  ));
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Not permitted to create a case in this scope'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1
    from workflow.workflow_templates t
    join workflow.workflow_template_versions v on v.template_id = t.id
    where t.authority_id = p_authority_id
      and t.key = trim(p_template_key)
      and t.process_type = trim(p_process_type)
      and v.published_at is not null
      and v.valid_from <= now()
      and (v.valid_to is null or v.valid_to > now())
  ) then
    raise exception 'No published workflow "%" matches process type "%" in this authority',
      trim(p_template_key), trim(p_process_type)
      using errcode = 'no_data_found';
  end if;

  insert into core.cases (
    authority_id, department_id, case_number, case_type, process_type, title,
    description, priority, status, phase, registered_at, created_by, updated_by
  )
  values (
    p_authority_id, p_department_id, trim(p_case_number), trim(p_case_type),
    trim(p_process_type), trim(p_title), nullif(trim(p_description), ''),
    coalesce(nullif(trim(p_priority), ''), 'NORMAL'),
    'REGISTERED', 'INTAKE', now(), v_actor, v_actor
  )
  returning id into v_case_id;

  v_instance := workflow.start_instance(v_case_id, trim(p_template_key));

  -- Starting a workflow is part of this one transaction. Apply any declared
  -- initial status/phase projection only after the version is successfully bound.
  perform workflow.apply_case_projection(v_instance);

  perform audit.record(
    'case.created', 'case', v_case_id, p_authority_id,
    format('Created with workflow template %s', trim(p_template_key))
  );

  return v_case_id;
end;
$$;

revoke all on function core.create_case_for_user(uuid, uuid, text, text, text, text, text, text, text) from public;
revoke all on function core.create_case_for_user(uuid, uuid, text, text, text, text, text, text, text) from anon;
grant execute on function core.create_case_for_user(uuid, uuid, text, text, text, text, text, text, text) to authenticated;
