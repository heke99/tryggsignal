-- Tryggsignal Phase G9 — PBL supervision integration.
begin;

create temporary table g9_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g9_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g9-supervision.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'inspector', 'other_dep']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G9 Tillsyn kommun', '212000-0992');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'g9_bygg', 'Byggnadsnämnden'
from organization.legal_entities le
where le.organization_number = '212000-0992';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join (values ('bygglov', 'Bygglov'), ('plan', 'Plan')) x(key, name)
where a.key = 'g9_bygg';

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g9-supervision.invalid';

insert into g9_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g9-supervision.invalid';
insert into g9_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g9-supervision.invalid';
insert into g9_ids
select 'authority', a.id from organization.authorities a where a.key = 'g9_bygg';
insert into g9_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'g9_bygg';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g9_ids where k='worker'),
   (select v from g9_ids where k='authority'),
   (select v from g9_ids where k='dep_bygglov'), true),
  ((select v from g9_ids where k='inspector'),
   (select v from g9_ids where k='authority'),
   (select v from g9_ids where k='dep_bygglov'), true),
  ((select v from g9_ids where k='other_dep'),
   (select v from g9_ids where k='authority'),
   (select v from g9_ids where k='dep_plan'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g9_ids where k=x.user_key),
  r.id, 'DEPARTMENT',
  (select v from g9_ids where k=x.dep_key),
  (select v from g9_ids where k='authority'),
  (select v from g9_ids where k=x.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov'),
  ('inspector', 'building_inspector', 'dep_bygglov'),
  ('other_dep', 'building_case_worker', 'dep_plan')
) x(user_key, role_key, dep_key)
join authz.roles r on r.key = x.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values (
  (select v from g9_ids where k='authority'),
  (select v from g9_ids where k='dep_bygglov'),
  'G9-0001', 'PBL_TILLSYN', 'PBL_TILLSYN',
  'Syntetiskt tillsynsärende', 'IN_REVIEW', 'INTERNAL'
);
insert into g9_ids
select 'case', id from core.cases where case_number = 'G9-0001';

create or replace function pg_temp.g9_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g9_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g9_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- Open and risk-assess the supervision case.
do $$
declare
  v_supervision uuid;
  v_risk uuid;
begin
  perform pg_temp.g9_set_subject('worker');

  select supervision.open_for_user(
    (select v from g9_ids where k='case'),
    'REPORT',
    'Syntetisk uppgift om möjlig olovlig åtgärd.'
  ) into v_supervision;

  select supervision.assess_risk_for_user(
    v_supervision,
    75,
    jsonb_build_array(
      jsonb_build_object('factor', 'potential impact', 'source', 'synthetic')
    )
  ) into v_risk;

  perform pg_temp.g9_clear_subject();

  insert into g9_ids values ('supervision', v_supervision), ('risk', v_risk);

  if not exists (
    select 1
    from supervision.cases s
    join supervision.risk_assessments r on r.supervision_id = s.id
    where s.id = v_supervision
      and s.status = 'INVESTIGATING'
      and s.risk_score = 75
      and s.risk_level = 'HIGH'
      and r.level = 'HIGH'
  ) then
    raise exception 'G9 risk queue state is incorrect';
  end if;
end;
$$;

-- Worker schedules an inspection; worker may not complete it.
do $$
declare
  v_inspection uuid;
  v_worker_blocked boolean := false;
begin
  perform pg_temp.g9_set_subject('worker');

  select supervision.schedule_inspection_for_user(
    (select v from g9_ids where k='supervision'),
    now() + interval '2 days',
    null,
    null,
    'Syntetisk tillsynsinspektion'
  ) into v_inspection;

  begin
    perform supervision.complete_inspection_for_user(
      v_inspection,
      'REJECTED',
      'Otillåten completion av vanlig handläggare'
    );
  exception when no_data_found then
    v_worker_blocked := true;
  end;

  perform pg_temp.g9_clear_subject();

  if not v_worker_blocked then
    raise exception 'Caseworker completed inspection without inspection.complete';
  end if;

  insert into g9_ids values ('inspection', v_inspection);
end;
$$;

do $$
begin
  perform pg_temp.g9_set_subject('inspector');

  perform supervision.complete_inspection_for_user(
    (select v from g9_ids where k='inspection'),
    'REJECTED',
    'Avvikelse konstaterad i syntetiskt prov.'
  );

  perform pg_temp.g9_clear_subject();

  if not exists (
    select 1
    from inspection.inspections i
    join supervision.cases s on s.case_id = i.case_id
    where i.id = (select v from g9_ids where k='inspection')
      and i.status = 'COMPLETED'
      and i.result = 'REJECTED'
      and i.performed_by = (select v from g9_ids where k='inspector')
      and s.status = 'ACTION_REQUIRED'
  ) then
    raise exception 'Inspection completion did not propagate supervision state';
  end if;
end;
$$;

-- Record a serious finding and prove formal orders fail closed without final decision.
do $$
declare
  v_finding uuid;
  v_action uuid;
  v_formal_blocked boolean := false;
begin
  perform pg_temp.g9_set_subject('worker');

  select supervision.record_finding_for_user(
    (select v from g9_ids where k='supervision'),
    (select v from g9_ids where k='inspection'),
    'SERIOUS',
    'Syntetisk allvarlig avvikelse',
    'Kräver operativ uppföljning; juridisk slutsats fattas separat.',
    null,
    now() + interval '10 days'
  ) into v_finding;

  begin
    perform supervision.create_action_for_user(
      (select v from g9_ids where k='supervision'),
      'ORDER',
      'Otillåtet föreläggande utan finalt beslut.',
      now() + interval '7 days',
      'Syntetisk rättslig referens',
      null
    );
  exception when object_not_in_prerequisite_state then
    v_formal_blocked := true;
  end;

  select supervision.create_action_for_user(
    (select v from g9_ids where k='supervision'),
    'REQUEST_INFO',
    'Begär kompletterande sakuppgifter.',
    now() + interval '5 days',
    null,
    null
  ) into v_action;

  perform pg_temp.g9_clear_subject();

  if not v_formal_blocked then
    raise exception 'Formal supervision action bypassed final-decision guard';
  end if;

  insert into g9_ids values ('finding', v_finding), ('action', v_action);
end;
$$;

-- Follow-up, overdue sweep, completion.
do $$
declare
  v_followup uuid;
begin
  perform pg_temp.g9_set_subject('worker');

  select supervision.create_followup_for_user(
    (select v from g9_ids where k='supervision'),
    (select v from g9_ids where k='action'),
    now() + interval '3 days',
    'Kontrollera att begärd information inkommit.'
  ) into v_followup;

  perform pg_temp.g9_clear_subject();

  insert into g9_ids values ('followup', v_followup);
end;
$$;

update supervision.followups
set due_at = now() - interval '1 minute'
where id = (select v from g9_ids where k='followup');

select supervision.sweep_followups();

do $$
begin
  if not exists (
    select 1 from supervision.followups
    where id = (select v from g9_ids where k='followup')
      and status = 'OVERDUE'
  ) then
    raise exception 'G9 follow-up sweep did not mark overdue';
  end if;

  perform pg_temp.g9_set_subject('worker');

  perform supervision.complete_followup_for_user(
    (select v from g9_ids where k='followup'),
    'Uppföljning genomförd.'
  );
  perform supervision.complete_action_for_user(
    (select v from g9_ids where k='action'),
    'Begärd information mottagen och granskad.'
  );

  perform pg_temp.g9_clear_subject();
end;
$$;

-- Closure fails while finding remains open, then succeeds after resolution.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g9_set_subject('worker');

  begin
    perform supervision.close_for_user(
      (select v from g9_ids where k='supervision'),
      'För tidig stängning'
    );
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;

  perform supervision.resolve_finding_for_user(
    (select v from g9_ids where k='finding'),
    'Avvikelsen är utredd och verifierat hanterad i det syntetiska provet.'
  );

  perform supervision.close_for_user(
    (select v from g9_ids where k='supervision'),
    'Samtliga finding, åtgärder och uppföljningar är avslutade.'
  );

  perform pg_temp.g9_clear_subject();

  if not v_blocked then
    raise exception 'Supervision closed while finding remained open';
  end if;

  if not exists (
    select 1 from supervision.cases
    where id = (select v from g9_ids where k='supervision')
      and status = 'CLOSED'
      and closed_at is not null
  ) then
    raise exception 'Supervision did not close after all open work resolved';
  end if;
end;
$$;

-- Wrong department cannot see/use the command boundary.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g9_set_subject('other_dep');
  begin
    perform supervision.open_for_user(
      (select v from g9_ids where k='case'),
      'OWN_INITIATIVE',
      'Otillåten cross-department tillsyn'
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g9_clear_subject();

  if not v_blocked then
    raise exception 'G9 supervision crossed department scope';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g9_ids where k='case')
    and action like 'case.supervision.%';

  if v_count < 10 then
    raise exception 'G9 audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G9 PBL SUPERVISION (risk/inspection/finding/action/follow-up/isolation): GREEN' as result;

rollback;
