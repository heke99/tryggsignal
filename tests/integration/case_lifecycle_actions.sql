-- Tryggsignal Phase G1/G5 — operational case lifecycle integration.
-- Proves the authenticated path used by the platform UI:
-- create -> workflow -> assign -> pause/resume -> transitions -> human decision
-- permission -> close, plus negative cross-authority/permission cases.
--
-- Runs in one transaction and rolls back.
--
--   psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/case_lifecycle_actions.sql

begin;

create temporary table g_ids (k text primary key, v uuid) on commit drop;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g-lifecycle.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'senior', 'outsider']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G Lifecycle kommun', '212000-0918');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g_bygg', 'Byggnadsnamnden'),
  ('g_miljo', 'Miljonamnden')
) as x(key, name)
where le.organization_number = '212000-0918';

insert into organization.departments (authority_id, key, name)
select a.id, 'bygglov', 'Bygglov'
from organization.authorities a where a.key = 'g_bygg';

insert into organization.departments (authority_id, key, name)
select a.id, 'tillsyn', 'Tillsyn'
from organization.authorities a where a.key = 'g_miljo';

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au where au.email like '%@g-lifecycle.invalid';

insert into g_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g-lifecycle.invalid';

insert into g_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g-lifecycle.invalid';

insert into g_ids
select 'auth_' || a.key, a.id
from organization.authorities a where a.key like 'g_%';

insert into g_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g_ids where k='worker'),
   (select v from g_ids where k='auth_g_bygg'),
   (select v from g_ids where k='dep_bygglov'), true),
  ((select v from g_ids where k='senior'),
   (select v from g_ids where k='auth_g_bygg'),
   (select v from g_ids where k='dep_bygglov'), true),
  ((select v from g_ids where k='outsider'),
   (select v from g_ids where k='auth_g_miljo'),
   (select v from g_ids where k='dep_tillsyn'), true);

-- Worker: ordinary department-scoped caseworker.
insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select (select v from g_ids where k='worker'), r.id, 'DEPARTMENT',
       (select v from g_ids where k='dep_bygglov'),
       (select v from g_ids where k='auth_g_bygg'),
       (select v from g_ids where k='dep_bygglov')
from authz.roles r where r.key = 'building_case_worker';

-- Senior: case assign/close plus the separate human decision permission.
insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id
)
select (select v from g_ids where k='senior'), r.id, 'AUTHORITY',
       (select v from g_ids where k='auth_g_bygg'),
       (select v from g_ids where k='auth_g_bygg')
from authz.roles r where r.key in ('senior_case_worker', 'decision_maker');

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select (select v from g_ids where k='outsider'), r.id, 'DEPARTMENT',
       (select v from g_ids where k='dep_tillsyn'),
       (select v from g_ids where k='auth_g_miljo'),
       (select v from g_ids where k='dep_tillsyn')
from authz.roles r where r.key = 'building_case_worker';

insert into workflow.workflow_templates (authority_id, key, name, process_type)
values (
  (select v from g_ids where k='auth_g_bygg'),
  'bygglov_operativ',
  'Bygglov operativ',
  'BYGGLOV'
);

insert into workflow.workflow_template_versions (
  template_id, authority_id, version, definition, published_at
)
select t.id, t.authority_id, 1, '{
  "initial": "INKOMMEN",
  "states": {
    "INKOMMEN": {
      "case_status": "REGISTERED",
      "case_phase": "INTAKE",
      "to": ["GRANSKNING"],
      "tasks": [{"key":"registrera","title":"Registrera och kontrollera grunduppgifter"}]
    },
    "GRANSKNING": {
      "case_status": "IN_REVIEW",
      "case_phase": "REVIEW",
      "to": ["BESLUT"],
      "tasks": [{"key":"granska","title":"Granska ärendet"}]
    },
    "BESLUT": {
      "case_status": "AWAITING_DECISION",
      "case_phase": "DECISION",
      "to": ["AVSLUTAD"],
      "tasks": [{"key":"beslut","title":"Fatta behörigt beslut"}]
    },
    "AVSLUTAD": {
      "case_status": "DECIDED",
      "case_phase": "DECISION",
      "to": [],
      "final": true
    }
  }
}'::jsonb, now()
from workflow.workflow_templates t
where t.key = 'bygglov_operativ'
  and t.authority_id = (select v from g_ids where k='auth_g_bygg');

create or replace function pg_temp.set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Worker creates a case atomically with the published workflow.
-- ---------------------------------------------------------------------------
do $$
declare
  v_case uuid;
  v_instance uuid;
  v_status text;
  v_phase text;
  v_state text;
begin
  perform pg_temp.set_subject('worker');

  select core.create_case_for_user(
    (select v from g_ids where k='auth_g_bygg'),
    (select v from g_ids where k='dep_bygglov'),
    'G-2026-0001',
    'BYGGLOV',
    'BYGGLOV',
    'Nybyggnad enbostadshus',
    'Syntetiskt komplett livscykelärende',
    'NORMAL',
    'bygglov_operativ'
  ) into v_case;

  insert into g_ids values ('case', v_case);

  select c.status, c.phase into v_status, v_phase
  from core.cases c where c.id = v_case;

  select i.id, i.current_state into v_instance, v_state
  from workflow.workflow_instances i where i.case_id = v_case;

  insert into g_ids values ('instance', v_instance);

  if v_status <> 'REGISTERED' or v_phase <> 'INTAKE' or v_state <> 'INKOMMEN' then
    raise exception 'Create projection mismatch status=% phase=% state=%', v_status, v_phase, v_state;
  end if;

  if (select count(*) from workflow.workflow_tasks
      where instance_id = v_instance and task_key = 'registrera' and status = 'OPEN') <> 1 then
    raise exception 'Initial workflow task was not materialized';
  end if;

  perform pg_temp.clear_subject();
end;
$$;

-- Cross-authority create is denied even though the RPC runs as owner.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.set_subject('worker');
  begin
    perform core.create_case_for_user(
      (select v from g_ids where k='auth_g_miljo'),
      (select v from g_ids where k='dep_tillsyn'),
      'G-XAUTH-1', 'TILLSYN', 'PBL_TILLSYN', 'Otillaten', null, 'NORMAL', 'missing'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.clear_subject();

  if not v_blocked then
    raise exception 'Cross-authority create was allowed';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Assignment is a separate permission and keeps history.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.set_subject('worker');
  begin
    perform core.assign_case_for_user(
      (select v from g_ids where k='case'),
      (select v from g_ids where k='worker'),
      null,
      'Worker tries to self-assign'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.clear_subject();

  if not v_blocked then
    raise exception 'building_case_worker unexpectedly received case.assign';
  end if;

  perform pg_temp.set_subject('senior');
  perform core.assign_case_for_user(
    (select v from g_ids where k='case'),
    (select v from g_ids where k='worker'),
    null,
    'Senior assigns responsible caseworker'
  );
  perform pg_temp.clear_subject();

  if (select assigned_user_id from core.cases where id = (select v from g_ids where k='case'))
     is distinct from (select v from g_ids where k='worker') then
    raise exception 'Canonical assigned_user_id was not updated';
  end if;

  if (select count(*) from core.case_assignments
      where case_id = (select v from g_ids where k='case')
        and assigned_user_id = (select v from g_ids where k='worker')
        and unassigned_at is null) <> 1 then
    raise exception 'Assignment history row missing';
  end if;
end;
$$;

-- An assignee from another authority is rejected.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.set_subject('senior');
  begin
    perform core.assign_case_for_user(
      (select v from g_ids where k='case'),
      (select v from g_ids where k='outsider'),
      null,
      'Must fail'
    );
  exception when foreign_key_violation then
    v_blocked := true;
  end;
  perform pg_temp.clear_subject();

  if not v_blocked then
    raise exception 'Cross-authority assignee was accepted';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Worker can advance and pause/resume the assigned case. Case status/phase
--    follows versioned workflow metadata, not frontend hard-coding.
-- ---------------------------------------------------------------------------
do $$
declare
  v_instance uuid := (select v from g_ids where k='instance');
  v_status text;
  v_phase text;
  v_workflow_status text;
begin
  perform pg_temp.set_subject('worker');

  perform workflow.advance_case_for_user(v_instance, 'GRANSKNING', 'Grunduppgifter kontrollerade');

  select c.status, c.phase into v_status, v_phase
  from core.cases c where c.id = (select v from g_ids where k='case');

  if v_status <> 'IN_REVIEW' or v_phase <> 'REVIEW' then
    raise exception 'Workflow projection failed status=% phase=%', v_status, v_phase;
  end if;

  perform workflow.set_pause_for_user(v_instance, true, 'Invantar extern uppgift');
  select status into v_workflow_status from workflow.workflow_instances where id = v_instance;
  if v_workflow_status <> 'PAUSED' then raise exception 'Pause failed'; end if;

  perform workflow.set_pause_for_user(v_instance, false, 'Uppgift mottagen');
  select status into v_workflow_status from workflow.workflow_instances where id = v_instance;
  if v_workflow_status <> 'RUNNING' then raise exception 'Resume failed'; end if;

  perform workflow.advance_case_for_user(v_instance, 'BESLUT', 'Beredning klar');

  perform pg_temp.clear_subject();
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Consequential final transition requires decision.approve. Ordinary worker
--    is denied; a human with both senior + decision-maker roles succeeds.
-- ---------------------------------------------------------------------------
do $$
declare
  v_instance uuid := (select v from g_ids where k='instance');
  v_blocked boolean := false;
  v_state text;
  v_case_status text;
begin
  perform pg_temp.set_subject('worker');
  begin
    perform workflow.advance_case_for_user(v_instance, 'AVSLUTAD', 'Worker may not decide');
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.clear_subject();

  if not v_blocked then
    raise exception 'Final decision transition did not require decision.approve';
  end if;

  perform pg_temp.set_subject('senior');
  perform workflow.advance_case_for_user(v_instance, 'AVSLUTAD', 'Behörig mänsklig beslutsfattare');
  perform pg_temp.clear_subject();

  select current_state into v_state from workflow.workflow_instances where id = v_instance;
  select status into v_case_status from core.cases where id = (select v from g_ids where k='case');

  if v_state <> 'AVSLUTAD' or v_case_status <> 'DECIDED' then
    raise exception 'Human final transition failed state=% case_status=%', v_state, v_case_status;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Closing is separately permissioned and only allowed after workflow final.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
  v_status text;
begin
  perform pg_temp.set_subject('worker');
  begin
    perform core.close_case_for_user((select v from g_ids where k='case'), 'Worker tries to close');
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.clear_subject();

  if not v_blocked then
    raise exception 'Worker without case.close closed the case';
  end if;

  perform pg_temp.set_subject('senior');
  perform core.close_case_for_user((select v from g_ids where k='case'), 'Beslut fattat och ärendet avslutat');
  perform pg_temp.clear_subject();

  select status into v_status from core.cases where id = (select v from g_ids where k='case');
  if v_status <> 'CLOSED' then
    raise exception 'Senior close did not produce CLOSED';
  end if;
end;
$$;

-- Audit is part of the command, not an optional UI side effect.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g_ids where k='case')
    and action in (
      'case.created',
      'case.assignment.changed',
      'case.workflow.advanced',
      'case.workflow.paused',
      'case.workflow.resumed',
      'case.closed'
    );

  if v_count < 7 then
    raise exception 'Lifecycle audit coverage incomplete, only % events', v_count;
  end if;
end;
$$;

select 'G CASE LIFECYCLE (create/assign/workflow/pause/decision/close): GREEN' as result;

rollback;
