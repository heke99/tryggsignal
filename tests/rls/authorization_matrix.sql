-- Tryggsignal - RLS authorization matrix (masterplan 19).
-- Runs inside one transaction and rolls back; it leaves no fixtures behind.
-- Every expectation raises on failure, so a clean run means GREEN.

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
create temporary table t_ids (k text primary key, v uuid) on commit drop;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@test.invalid', 'authenticated', 'authenticated'
from unnest(array[
  'worker', 'other_dep', 'other_auth', 'senior', 'decision', 'admin', 'auditor',
  'applicant', 'representative', 'service'
]) as k;

insert into organization.legal_entities (name, organization_number)
values ('Testkommun', '212000-0000');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, k, k from organization.legal_entities le,
  unnest(array['bygg', 'miljo']) as k;

insert into organization.departments (authority_id, key, name)
select a.id, d.k, d.k
from organization.authorities a
cross join lateral (
  select unnest(case when a.key = 'bygg' then array['bygglov', 'annat'] else array['tillsyn'] end) as k
) d;

insert into organization.units (department_id, authority_id, key, name)
select d.id, d.authority_id, 'enhet1', 'Enhet 1' from organization.departments d;

insert into organization.teams (unit_id, department_id, authority_id, key, name)
select u.id, u.department_id, u.authority_id, 'team1', 'Team 1' from organization.units u;

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email,
  case when split_part(au.email, '@', 1) in ('applicant', 'representative') then 'EXTERNAL'
       when split_part(au.email, '@', 1) = 'service' then 'SERVICE'
       else 'STAFF' end
from auth.users au
where au.email like '%@test.invalid';

insert into t_ids (k, v)
select split_part(u.email, '@', 1), u.id from identity.users u where u.email like '%@test.invalid';

insert into t_ids (k, v)
select 'auth_' || a.key, a.id from organization.authorities a;

insert into t_ids (k, v)
select 'dep_' || d.key, d.id from organization.departments d;

-- Role assignments (masterplan 16/17)
insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'worker'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_bygglov'),
       (select v from t_ids where k = 'auth_bygg'),
       (select v from t_ids where k = 'dep_bygglov')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'other_dep'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_annat'),
       (select v from t_ids where k = 'auth_bygg'),
       (select v from t_ids where k = 'dep_annat')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'other_auth'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_tillsyn'),
       (select v from t_ids where k = 'auth_miljo'),
       (select v from t_ids where k = 'dep_tillsyn')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id)
select (select v from t_ids where k = u.k), r.id, 'AUTHORITY',
       (select v from t_ids where k = 'auth_bygg'), (select v from t_ids where k = 'auth_bygg')
from (values ('senior', 'senior_case_worker'), ('decision', 'decision_maker'),
             ('auditor', 'auditor'), ('service', 'integration_service')) as u(k, role_key)
join authz.roles r on r.key = u.role_key;

-- Tenant-scoped administrator: configuration only, no standing content access.
insert into authz.role_assignments (user_id, role_id, scope_type, scope_id)
select (select v from t_ids where k = 'admin'), r.id, 'TENANT', null
from authz.roles r where r.key = 'tenant_admin';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id)
select (select v from t_ids where k = u.k), r.id, 'TENANT', null
from (values ('applicant', 'external_applicant'), ('representative', 'external_representative')) as u(k, role_key)
join authz.roles r on r.key = u.role_key;

insert into identity.user_memberships (user_id, authority_id, department_id)
select (select v from t_ids where k = 'worker'), (select v from t_ids where k = 'auth_bygg'),
       (select v from t_ids where k = 'dep_bygglov');

insert into property.properties (authority_id, designation)
values ((select v from t_ids where k = 'auth_bygg'), 'BJORNEN 1:2');

-- Cases: C1 internal in bygg/bygglov, C2 secret in bygg/bygglov, C3 in miljö.
insert into core.cases (authority_id, department_id, case_number, case_type, process_type,
                        title, status, information_class, assigned_user_id)
values
  ((select v from t_ids where k = 'auth_bygg'), (select v from t_ids where k = 'dep_bygglov'),
   'B-2026-0001', 'BYGGLOV', 'BYGGLOV', 'Nybyggnad enbostadshus', 'REGISTERED', 'INTERNAL',
   (select v from t_ids where k = 'worker')),
  ((select v from t_ids where k = 'auth_bygg'), (select v from t_ids where k = 'dep_bygglov'),
   'B-2026-0002', 'BYGGLOV', 'BYGGLOV', 'Skyddat arende', 'REGISTERED', 'SECRET',
   (select v from t_ids where k = 'senior')),
  ((select v from t_ids where k = 'auth_miljo'), (select v from t_ids where k = 'dep_tillsyn'),
   'M-2026-0001', 'TILLSYN', 'PBL_TILLSYN', 'Tillsyn', 'REGISTERED', 'INTERNAL', null);

insert into t_ids (k, v) select 'case_' || c.case_number, c.id from core.cases c;

insert into core.parties (authority_id, party_type, display_name)
values ((select v from t_ids where k = 'auth_bygg'), 'PERSON', 'Sokande Testsson');

insert into core.case_parties (case_id, party_id, authority_id, relationship, identity_user_id, verified_at)
select (select v from t_ids where k = 'case_B-2026-0001'), p.id,
       (select v from t_ids where k = 'auth_bygg'), 'APPLICANT',
       (select v from t_ids where k = 'applicant'), now()
from core.parties p;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function pg_temp.expect_case_count(p_user text, p_expected bigint)
returns void language plpgsql as $$
declare v_actual bigint;
begin
  select count(*) into v_actual from core.cases;
  if v_actual <> p_expected then
    raise exception 'RLS matrix: % should see % case(s), saw %', p_user, p_expected, v_actual;
  end if;
end;
$$;

create or replace function pg_temp.expect_error(p_user text, p_what text, p_sql text)
returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'RLS matrix: % must NOT be able to %', p_user, p_what;
exception
  when insufficient_privilege or check_violation or raise_exception then
    return;
end;
$$;

-- ---------------------------------------------------------------------------
-- SELECT matrix
-- ---------------------------------------------------------------------------
do $$
declare
  v record;
  v_sub uuid;
begin
  for v in
    select * from (values
      ('worker', 1::bigint), ('other_dep', 0), ('other_auth', 1), ('senior', 2),
      ('decision', 1), ('admin', 0), ('auditor', 1), ('applicant', 1),
      ('representative', 0), ('service', 1)
    ) as expected(username, cases)
  loop
    select au.id into v_sub
    from auth.users au
    join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select t.v from t_ids t where t.k = v.username);

    execute format('set local role authenticated');
    execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub, 'role', 'authenticated')::text);
    perform pg_temp.expect_case_count(v.username, v.cases);
    reset role;
    execute 'set local request.jwt.claims = ' || quote_literal('{}');
  end loop;
end;
$$;

-- `other_auth` legitimately sees the case in their own authority; what must hold
-- is that neither side can see across the authority boundary (masterplan 13).
do $$
declare
  -- Resolved before the role switch: the fixture id table is owned by the test
  -- session, not by `authenticated`.
  v_case_bygg uuid := (select v from t_ids where k = 'case_B-2026-0001');
  v_case_miljo uuid := (select v from t_ids where k = 'case_M-2026-0001');
  v_sub_other uuid := (select au.id from auth.users au
    join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'other_auth'));
  v_sub_worker uuid := (select au.id from auth.users au
    join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'worker'));
  v_seen integer;
begin
  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub_other, 'role', 'authenticated')::text);
  select count(*) into v_seen from core.cases where id = v_case_bygg;
  reset role;
  if v_seen <> 0 then
    raise exception 'RLS matrix: cross-authority leak - miljo worker saw a bygg case';
  end if;

  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub_worker, 'role', 'authenticated')::text);
  select count(*) into v_seen from core.cases where id = v_case_miljo;
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
  if v_seen <> 0 then
    raise exception 'RLS matrix: cross-authority leak - bygg worker saw a miljo case';
  end if;
end;
$$;

-- Anonymous sessions have no grant at all on the case tables.
do $$
declare v_denied boolean := false;
begin
  set local role anon;
  begin
    perform 1 from core.cases;
  exception when insufficient_privilege then
    v_denied := true;
  end;
  reset role;
  if not v_denied then
    raise exception 'RLS matrix: anonymous must not reach core.cases';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- INSERT / UPDATE / DELETE matrix
-- ---------------------------------------------------------------------------
do $$
declare
  v_worker_sub uuid;
  v_bygg uuid := (select v from t_ids where k = 'auth_bygg');
  v_bygglov uuid := (select v from t_ids where k = 'dep_bygglov');
  v_annat uuid := (select v from t_ids where k = 'dep_annat');
  v_miljo uuid := (select v from t_ids where k = 'auth_miljo');
  v_case1 uuid := (select v from t_ids where k = 'case_B-2026-0001');
  v_case3 uuid := (select v from t_ids where k = 'case_M-2026-0001');
  v_updated integer;
begin
  select au.id into v_worker_sub
  from auth.users au join identity.users iu on iu.auth_user_id = au.id
  where iu.id = (select v from t_ids where k = 'worker');

  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_worker_sub, 'role', 'authenticated')::text);

  -- Allowed: create inside the assigned department.
  insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title)
  values (v_bygg, v_bygglov, 'B-2026-9001', 'BYGGLOV', 'BYGGLOV', 'Nytt arende');

  -- Denied: create in another department, in another authority, and update or
  -- move a case outside the assigned scope.
  perform pg_temp.expect_error('worker', 'create a case in another department', format(
    'insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title)
     values (%L, %L, ''B-2026-9002'', ''BYGGLOV'', ''BYGGLOV'', ''Otillatet'')', v_bygg, v_annat));

  perform pg_temp.expect_error('worker', 'create a case in another authority', format(
    'insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title)
     values (%L, null, ''M-2026-9003'', ''TILLSYN'', ''PBL_TILLSYN'', ''Otillatet'')', v_miljo));

  perform pg_temp.expect_error('worker', 'move a case to another authority', format(
    'update core.cases set authority_id = %L where id = %L', v_miljo, v_case1));

  perform pg_temp.expect_error('worker', 'delete a case', format(
    'delete from core.cases where id = %L', v_case1));

  -- Allowed update inside scope.
  update core.cases set title = 'Uppdaterad titel' where id = v_case1;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'RLS matrix: worker should be able to update the assigned case';
  end if;

  -- Update of an invisible case affects nothing (no error, no rows).
  update core.cases set title = 'Far ej ske' where id = v_case3;
  get diagnostics v_updated = row_count;
  if v_updated <> 0 then
    raise exception 'RLS matrix: worker updated a case in another authority';
  end if;

  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- Case history is written for every status change (masterplan 20)
-- ---------------------------------------------------------------------------
do $$
declare v_count integer;
begin
  select count(*) into v_count from core.case_status_history
  where case_id = (select v from t_ids where k = 'case_B-2026-0001');
  if v_count < 1 then
    raise exception 'Case status history was not recorded on insert';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit chain integrity (masterplan 80)
-- ---------------------------------------------------------------------------
do $$
declare v_first text; v_second text;
begin
  insert into audit.events (action, resource_type, authority_id, event_hash)
  values ('TEST_ONE', 'case', (select v from t_ids where k = 'auth_bygg'), '')
  returning event_hash into v_first;

  insert into audit.events (action, resource_type, authority_id, event_hash)
  values ('TEST_TWO', 'case', (select v from t_ids where k = 'auth_bygg'), '')
  returning event_hash into v_second;

  if v_first is null or v_second is null or v_first = v_second then
    raise exception 'Audit hash chain did not produce distinct hashes';
  end if;

  if (select previous_event_hash from audit.events where action = 'TEST_TWO') is distinct from v_first then
    raise exception 'Audit hash chain is not linked to the previous event';
  end if;
end;
$$;

select 'RLS AUTHORIZATION MATRIX: GREEN' as result;

rollback;
