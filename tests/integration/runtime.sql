-- Tryggsignal — runtime integration test for the workflow engine, the search
-- index, OVK due dates and the metrics rollup.
--
-- Runs inside one transaction and rolls back. Every expectation raises on
-- failure, so a clean run that prints GREEN means it passed.
--
--   psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/runtime.sql
--
-- Last verified GREEN: 2026-09-07 against the development data plane.

begin;

create temporary table t (k text primary key, v uuid) on commit drop;

insert into organization.legal_entities (name, organization_number) values ('Runtimekommun', '212000-0002');
insert into organization.authorities (legal_entity_id, key, name)
select id, 'rt_bygg', 'Byggnadsnamnden' from organization.legal_entities where organization_number = '212000-0002';
insert into organization.departments (authority_id, key, name)
select id, 'bygglov', 'Bygglov' from organization.authorities where key = 'rt_bygg';

insert into t select 'auth', id from organization.authorities where key = 'rt_bygg';
insert into t select 'dep', id from organization.departments where key = 'bygglov'
  and authority_id = (select v from t where k = 'auth');

insert into workflow.workflow_templates (authority_id, key, name, process_type)
values ((select v from t where k = 'auth'), 'bygglov', 'Bygglovsprocess', 'BYGGLOV');

insert into workflow.workflow_template_versions (template_id, authority_id, version, definition, published_at)
select id, (select v from t where k = 'auth'), 1, '{
  "initial": "INKOMMEN",
  "states": {
    "INKOMMEN": {
      "to": ["KOMPLETTERING", "GRANSKNING"],
      "tasks": [{"key": "registrera", "title": "Registrera arendet"}],
      "timers": [{"key": "mottagningsbevis", "days": 3}]
    },
    "KOMPLETTERING": {
      "to": ["GRANSKNING", "AVSKRIVEN"],
      "tasks": [{"key": "begar_komplettering", "title": "Begar komplettering"}]
    },
    "GRANSKNING": {
      "to": ["BESLUT"],
      "tasks": [{"key": "granska", "title": "Granska handlingar"}]
    },
    "BESLUT": {"to": ["AVSLUTAD"], "tasks": [{"key": "fatta_beslut", "title": "Fatta beslut"}]},
    "AVSKRIVEN": {"to": [], "final": true},
    "AVSLUTAD": {"to": [], "final": true}
  }
}'::jsonb, now()
from workflow.workflow_templates where key = 'bygglov'
  and authority_id = (select v from t where k = 'auth');

insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title, status, registered_at)
values ((select v from t where k = 'auth'), (select v from t where k = 'dep'),
        'RT-0001', 'BYGGLOV', 'BYGGLOV', 'Nybyggnad enbostadshus med garage', 'REGISTERED', now());
insert into t select 'case', id from core.cases where case_number = 'RT-0001';

-- 1. Search indexing happens by trigger, not by a job that could fall behind.
do $$
declare v_hits integer;
begin
  select count(*) into v_hits from search.entities
  where entity_id = (select v from t where k = 'case')
    and search_vector @@ websearch_to_tsquery('swedish', 'enbostadshus');
  if v_hits <> 1 then raise exception 'Search index was not maintained by trigger (hits=%)', v_hits; end if;
end;
$$;

-- 2. Starting the workflow creates the instance, its tasks and its timers, and
--    is idempotent.
do $$
declare v_instance uuid; v_tasks integer; v_timers integer; v_state text;
begin
  v_instance := workflow.start_instance((select v from t where k = 'case'), 'bygglov');
  insert into t values ('instance', v_instance);

  select current_state into v_state from workflow.workflow_instances where id = v_instance;
  if v_state <> 'INKOMMEN' then raise exception 'Wrong initial state %', v_state; end if;

  select count(*) into v_tasks from workflow.workflow_tasks where instance_id = v_instance and status = 'OPEN';
  select count(*) into v_timers from workflow.workflow_timers where instance_id = v_instance and fired_at is null;
  if v_tasks <> 1 or v_timers <> 1 then
    raise exception 'State was not materialized (tasks=%, timers=%)', v_tasks, v_timers;
  end if;

  if workflow.start_instance((select v from t where k = 'case'), 'bygglov') <> v_instance then
    raise exception 'start_instance was not idempotent';
  end if;
  select count(*) into v_tasks from workflow.workflow_tasks where instance_id = v_instance;
  if v_tasks <> 1 then raise exception 'Tasks were duplicated on restart'; end if;
end;
$$;

-- 3. An undeclared transition is refused; a declared one advances, cancels the
--    old state's timers and materializes the new state.
do $$
declare v_instance uuid := (select v from t where k = 'instance'); v_blocked boolean := false; v_tasks integer;
begin
  begin
    perform workflow.advance(v_instance, 'BESLUT', 'hoppar over granskning', 'SYSTEM');
  exception when raise_exception then v_blocked := true;
  end;
  if not v_blocked then raise exception 'An undeclared transition was allowed'; end if;

  perform workflow.advance(v_instance, 'GRANSKNING', 'Handlingar kompletta', 'SYSTEM');

  select count(*) into v_tasks from workflow.workflow_tasks
  where instance_id = v_instance and task_key = 'granska' and status = 'OPEN';
  if v_tasks <> 1 then raise exception 'New state did not materialize its task'; end if;

  if (select count(*) from workflow.workflow_timers
      where instance_id = v_instance and cancelled_at is not null) <> 1 then
    raise exception 'The previous state timer was not cancelled';
  end if;

  if (select count(*) from workflow.workflow_transitions where instance_id = v_instance) <> 2 then
    raise exception 'Transitions were not recorded';
  end if;
end;
$$;

-- 4. OVK due dates and status (masterplan 74).
do $$
declare v_obligation uuid; v_status text; v_due date;
begin
  insert into compliance.obligations (key, name, domain, legal_reference)
  values ('ovk_flerbostadshus', 'OVK flerbostadshus', 'OVK', 'PBF 5 kap. 1-7 §§')
  returning id into v_obligation;

  insert into compliance.obligation_rules (obligation_id, applies_when, interval_months)
  values (v_obligation, '{"building_purpose": "FLERBOSTADSHUS"}'::jsonb, 36);

  insert into property.properties (authority_id, designation)
  values ((select v from t where k = 'auth'), 'RUNTIME 1:1');

  insert into compliance.compliance_objects (authority_id, property_id, obligation_id, object_reference, last_performed_at)
  select (select v from t where k = 'auth'), p.id, v_obligation, 'AGGREGAT-1', current_date - interval '40 months'
  from property.properties p where p.designation = 'RUNTIME 1:1';

  perform compliance.recompute_due_dates();

  select status, next_due_at into v_status, v_due from compliance.compliance_objects
  where object_reference = 'AGGREGAT-1';
  if v_status <> 'OVERDUE' then raise exception 'OVK status should be OVERDUE, was %', v_status; end if;
  if v_due is null then raise exception 'OVK next due date was not computed'; end if;
end;
$$;

-- 5. The metrics rollup produces the day's rows (masterplan 91/92).
do $$
declare v_backlog numeric;
begin
  perform reporting.rollup_metrics(current_date);
  select value into v_backlog from reporting.operational_metrics
  where authority_id = (select v from t where k = 'auth')
    and metric_key = 'backlog_open' and metric_date = current_date;
  if v_backlog is null or v_backlog < 1 then
    raise exception 'Backlog metric was not computed (%)', v_backlog;
  end if;
end;
$$;

select 'RUNTIME INTEGRATION (search, workflow, OVK, metrics): GREEN' as result;

rollback;
