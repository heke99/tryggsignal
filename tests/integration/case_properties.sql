-- Tryggsignal Phase G3 — operational case property integration.
-- Covers linking, primary selection, local provisional registration,
-- parent-case RLS, direct-write denial and authority isolation.

begin;

create temporary table g3_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g3_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g3-property.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'other_dep', 'other_auth']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G3 Property kommun', '212000-0935');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g3_bygg', 'Byggnadsnämnden'),
  ('g3_miljo', 'Miljönämnden')
) as x(key, name)
where le.organization_number = '212000-0935';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join lateral (
  select * from (values
    ('bygglov', 'Bygglov'),
    ('plan', 'Plan')
  ) as d(key, name)
  where a.key = 'g3_bygg'
  union all
  select 'tillsyn', 'Tillsyn' where a.key = 'g3_miljo'
) x;

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g3-property.invalid';

insert into g3_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@g3-property.invalid';

insert into g3_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@g3-property.invalid';

insert into g3_ids
select 'auth_' || a.key, a.id
from organization.authorities a
where a.key like 'g3_%';

insert into g3_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g3_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g3_ids where k='worker'),
   (select v from g3_ids where k='auth_g3_bygg'),
   (select v from g3_ids where k='dep_bygglov'), true),
  ((select v from g3_ids where k='other_dep'),
   (select v from g3_ids where k='auth_g3_bygg'),
   (select v from g3_ids where k='dep_plan'), true),
  ((select v from g3_ids where k='other_auth'),
   (select v from g3_ids where k='auth_g3_miljo'),
   (select v from g3_ids where k='dep_tillsyn'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g3_ids where k=u.user_key),
  r.id,
  'DEPARTMENT',
  (select v from g3_ids where k=u.dep_key),
  (select v from g3_ids where k=u.auth_key),
  (select v from g3_ids where k=u.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov', 'auth_g3_bygg'),
  ('other_dep', 'building_case_worker', 'dep_plan', 'auth_g3_bygg'),
  ('other_auth', 'building_case_worker', 'dep_tillsyn', 'auth_g3_miljo')
) as u(user_key, role_key, dep_key, auth_key)
join authz.roles r on r.key = u.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type, title, status
)
values
  ((select v from g3_ids where k='auth_g3_bygg'),
   (select v from g3_ids where k='dep_bygglov'),
   'G3-0001', 'BYGGLOV', 'BYGGLOV', 'Fastighetsärende', 'REGISTERED'),
  ((select v from g3_ids where k='auth_g3_bygg'),
   (select v from g3_ids where k='dep_bygglov'),
   'G3-0002', 'BYGGLOV', 'BYGGLOV', 'Stängt ärende', 'CLOSED');

insert into g3_ids
select 'case_' || case_number, id
from core.cases
where case_number like 'G3-%';

insert into property.properties (
  authority_id, designation, municipality_code, source, source_object_id, source_version
)
values
  ((select v from g3_ids where k='auth_g3_bygg'),
   'G3 KOMMUNEN 1:1', '0180', 'LANTMATERIET', 'lm-g3-1', '2026-09'),
  ((select v from g3_ids where k='auth_g3_bygg'),
   'G3 KOMMUNEN 1:2', '0180', 'LANTMATERIET', 'lm-g3-2', '2026-09'),
  ((select v from g3_ids where k='auth_g3_miljo'),
   'G3 ANNAN 9:9', '0181', 'LANTMATERIET', 'lm-g3-x', '2026-09');

insert into g3_ids
select case designation
  when 'G3 KOMMUNEN 1:1' then 'property_one'
  when 'G3 KOMMUNEN 1:2' then 'property_two'
  else 'property_other_auth'
end, id
from property.properties
where designation like 'G3 %';

insert into property.addresses (
  authority_id, property_id, street_name, street_number, postal_code, postal_town, source
)
values (
  (select v from g3_ids where k='auth_g3_bygg'),
  (select v from g3_ids where k='property_one'),
  'Testgatan', '1', '111 11', 'Teststad', 'LANTMATERIET'
);

insert into property.buildings (
  authority_id, property_id, building_designation, building_purpose, year_built, source
)
values (
  (select v from g3_ids where k='auth_g3_bygg'),
  (select v from g3_ids where k='property_one'),
  'Byggnad 1', 'BOSTAD', 2020, 'LANTMATERIET'
);

create or replace function pg_temp.g3_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g3_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g3_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- First link becomes primary automatically.
do $$
begin
  perform pg_temp.g3_set_subject('worker');

  perform core.link_property_to_case_for_user(
    (select v from g3_ids where k='case_G3-0001'),
    (select v from g3_ids where k='property_one'),
    false
  );

  perform pg_temp.g3_clear_subject();

  if not exists (
    select 1
    from core.case_properties cp
    where cp.case_id = (select v from g3_ids where k='case_G3-0001')
      and cp.property_id = (select v from g3_ids where k='property_one')
      and cp.is_primary
  ) then
    raise exception 'First property was not promoted to primary';
  end if;

  if (select primary_property_id
      from core.cases
      where id = (select v from g3_ids where k='case_G3-0001'))
     is distinct from (select v from g3_ids where k='property_one') then
    raise exception 'Case primary_property_id did not synchronize';
  end if;
end;
$$;

-- Multiple links are allowed, exactly one primary is maintained.
do $$
begin
  perform pg_temp.g3_set_subject('worker');

  perform core.link_property_to_case_for_user(
    (select v from g3_ids where k='case_G3-0001'),
    (select v from g3_ids where k='property_two'),
    false
  );

  perform core.set_primary_property_for_user(
    (select v from g3_ids where k='case_G3-0001'),
    (select v from g3_ids where k='property_two')
  );

  perform pg_temp.g3_clear_subject();

  if (select count(*)
      from core.case_properties
      where case_id = (select v from g3_ids where k='case_G3-0001')
        and is_primary) <> 1 then
    raise exception 'Case has an invalid number of primary properties';
  end if;
end;
$$;

-- Local fallback registration remains explicitly provisional and source-traced.
do $$
declare
  v_property uuid;
begin
  perform pg_temp.g3_set_subject('worker');

  select core.register_local_property_for_case_user(
    (select v from g3_ids where k='case_G3-0001'),
    'G3 LOKAL 2:4',
    '0180',
    'Lokalgatan',
    '24',
    'A',
    '123 45',
    'Teststad',
    false
  ) into v_property;

  perform pg_temp.g3_clear_subject();

  insert into g3_ids values ('property_local', v_property);

  if not exists (
    select 1
    from property.properties p
    where p.id = v_property
      and p.source = 'LOCAL'
      and p.attributes->>'provisional' = 'true'
  ) then
    raise exception 'Local property provenance is missing';
  end if;

  if not exists (
    select 1
    from property.property_identifiers i
    where i.property_id = v_property
      and i.identifier_type = 'FASTIGHETSBETECKNING'
      and i.value = 'G3 LOKAL 2:4'
      and i.source = 'LOCAL'
  ) then
    raise exception 'Local property identifier is missing';
  end if;

  if not exists (
    select 1
    from property.addresses a
    where a.property_id = v_property
      and a.street_name = 'Lokalgatan'
      and a.street_number = '24'
      and a.source = 'LOCAL'
  ) then
    raise exception 'Local property address is missing';
  end if;
end;
$$;

-- Same-authority but wrong department may read general property reference data,
-- but must not infer a hidden case-property association.
do $$
declare
  v_visible integer;
begin
  perform pg_temp.g3_set_subject('other_dep');

  select count(*) into v_visible
  from core.case_properties
  where case_id = (select v from g3_ids where k='case_G3-0001');

  perform pg_temp.g3_clear_subject();

  if v_visible <> 0 then
    raise exception 'case_properties leaked a department-hidden case relation';
  end if;
end;
$$;

-- Cross-authority property and case access are denied by the mutation boundary.
do $$
declare
  v_property_blocked boolean := false;
  v_case_blocked boolean := false;
begin
  perform pg_temp.g3_set_subject('worker');

  begin
    perform core.link_property_to_case_for_user(
      (select v from g3_ids where k='case_G3-0001'),
      (select v from g3_ids where k='property_other_auth'),
      false
    );
  exception when no_data_found then
    v_property_blocked := true;
  end;

  perform pg_temp.g3_clear_subject();
  perform pg_temp.g3_set_subject('other_auth');

  begin
    perform core.link_property_to_case_for_user(
      (select v from g3_ids where k='case_G3-0001'),
      (select v from g3_ids where k='property_one'),
      false
    );
  exception when no_data_found then
    v_case_blocked := true;
  end;

  perform pg_temp.g3_clear_subject();

  if not v_property_blocked or not v_case_blocked then
    raise exception 'Cross-authority property boundary failed';
  end if;
end;
$$;

-- Closed case is immutable for property linkage.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g3_set_subject('worker');

  begin
    perform core.link_property_to_case_for_user(
      (select v from g3_ids where k='case_G3-0002'),
      (select v from g3_ids where k='property_one'),
      false
    );
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;

  perform pg_temp.g3_clear_subject();

  if not v_blocked then
    raise exception 'Closed case accepted a property mutation';
  end if;
end;
$$;

-- Direct client writes stay closed.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g3_set_subject('worker');

  begin
    insert into core.case_properties (
      case_id, property_id, authority_id, is_primary
    )
    values (
      (select v from g3_ids where k='case_G3-0001'),
      (select v from g3_ids where k='property_one'),
      (select v from g3_ids where k='auth_g3_bygg'),
      false
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  perform pg_temp.g3_clear_subject();

  if not v_blocked then
    raise exception 'Direct case_properties write bypass was allowed';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g3_ids where k='case_G3-0001')
    and action in ('case.property.linked', 'case.property.local_registered');

  if v_count < 4 then
    raise exception 'G3 property audit coverage incomplete, got % events', v_count;
  end if;
end;
$$;

select 'G3 CASE PROPERTY (link/primary/local/RLS/isolation): GREEN' as result;

rollback;
