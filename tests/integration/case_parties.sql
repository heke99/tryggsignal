-- Tryggsignal Phase G2 — case parties integration.
-- Covers person/organization parties, roles in case, contact updates, audit,
-- shared-party safety and cross-authority/BOLA denial.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f tests/integration/case_parties.sql

begin;

create temporary table g2_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g2_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g2-parties.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'other_dep', 'other_auth', 'senior']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G2 Parts kommun', '212000-0919');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g2_bygg', 'Byggnadsnämnden'),
  ('g2_miljo', 'Miljönämnden')
) as x(key, name)
where le.organization_number = '212000-0919';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join lateral (
  select * from (values
    ('bygglov', 'Bygglov'),
    ('plan', 'Plan')
  ) as d(key, name)
  where a.key = 'g2_bygg'
  union all
  select 'tillsyn', 'Tillsyn' where a.key = 'g2_miljo'
) x;

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g2-parties.invalid';

insert into g2_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@g2-parties.invalid';

insert into g2_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@g2-parties.invalid';

insert into g2_ids
select 'auth_' || a.key, a.id
from organization.authorities a
where a.key like 'g2_%';

insert into g2_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g2_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g2_ids where k='worker'),
   (select v from g2_ids where k='auth_g2_bygg'),
   (select v from g2_ids where k='dep_bygglov'), true),
  ((select v from g2_ids where k='other_dep'),
   (select v from g2_ids where k='auth_g2_bygg'),
   (select v from g2_ids where k='dep_plan'), true),
  ((select v from g2_ids where k='other_auth'),
   (select v from g2_ids where k='auth_g2_miljo'),
   (select v from g2_ids where k='dep_tillsyn'), true),
  ((select v from g2_ids where k='senior'),
   (select v from g2_ids where k='auth_g2_bygg'),
   null, true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select (select v from g2_ids where k=u.user_key), r.id, 'DEPARTMENT',
       (select v from g2_ids where k=u.dep_key),
       (select v from g2_ids where k=u.auth_key),
       (select v from g2_ids where k=u.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov', 'auth_g2_bygg'),
  ('other_dep', 'building_case_worker', 'dep_plan', 'auth_g2_bygg'),
  ('other_auth', 'building_case_worker', 'dep_tillsyn', 'auth_g2_miljo')
) as u(user_key, role_key, dep_key, auth_key)
join authz.roles r on r.key = u.role_key;

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id
)
select (select v from g2_ids where k='senior'), r.id, 'AUTHORITY',
       (select v from g2_ids where k='auth_g2_bygg'),
       (select v from g2_ids where k='auth_g2_bygg')
from authz.roles r
where r.key = 'senior_case_worker';

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type, title, status
)
values
  ((select v from g2_ids where k='auth_g2_bygg'),
   (select v from g2_ids where k='dep_bygglov'),
   'G2-0001', 'BYGGLOV', 'BYGGLOV', 'Nybyggnad', 'REGISTERED'),
  ((select v from g2_ids where k='auth_g2_bygg'),
   (select v from g2_ids where k='dep_plan'),
   'G2-0002', 'BYGGLOV', 'BYGGLOV', 'Planärende', 'REGISTERED'),
  ((select v from g2_ids where k='auth_g2_miljo'),
   (select v from g2_ids where k='dep_tillsyn'),
   'G2-0003', 'TILLSYN', 'PBL_TILLSYN', 'Tillsyn', 'REGISTERED');

insert into g2_ids
select 'case_' || case_number, id
from core.cases
where case_number like 'G2-%';

create or replace function pg_temp.g2_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g2_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g2_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Person applicant can be created by a caseworker on an accessible case.
-- ---------------------------------------------------------------------------
do $$
declare
  v_relation uuid;
  v_party uuid;
begin
  perform pg_temp.g2_set_subject('worker');

  select core.add_case_party_for_user(
    (select v from g2_ids where k='case_G2-0001'),
    'PERSON',
    'Anna Sökande',
    'APPLICANT',
    null,
    'population-ref-anna',
    'anna@example.se',
    '+46700000001'
  ) into v_relation;

  insert into g2_ids values ('relation_person', v_relation);

  select party_id into v_party
  from core.case_parties
  where id = v_relation;

  insert into g2_ids values ('party_person', v_party);

  if not exists (
    select 1
    from core.parties p
    where p.id = v_party
      and p.party_type = 'PERSON'
      and p.display_name = 'Anna Sökande'
      and p.organization_number is null
      and p.person_reference = 'population-ref-anna'
      and p.contact_email = 'anna@example.se'
  ) then
    raise exception 'Person party was not created correctly';
  end if;

  perform pg_temp.g2_clear_subject();
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Organization/property-owner path and deterministic data minimization.
-- ---------------------------------------------------------------------------
do $$
declare
  v_relation uuid;
  v_party uuid;
begin
  perform pg_temp.g2_set_subject('worker');

  select core.add_case_party_for_user(
    (select v from g2_ids where k='case_G2-0001'),
    'ORGANIZATION',
    'Fastighet AB',
    'PROPERTY_OWNER',
    '559999-0001',
    'must-be-discarded-for-org',
    'kontakt@fastighet.example',
    '+468000000'
  ) into v_relation;

  select party_id into v_party from core.case_parties where id = v_relation;
  insert into g2_ids values ('party_org', v_party);

  if not exists (
    select 1 from core.parties p
    where p.id = v_party
      and p.party_type = 'ORGANIZATION'
      and p.organization_number = '559999-0001'
      and p.person_reference is null
  ) then
    raise exception 'Organization party minimization failed';
  end if;

  perform pg_temp.g2_clear_subject();
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Relationship and contact updates are audited and case-authorized.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.g2_set_subject('worker');

  perform core.update_case_party_relationship_for_user(
    (select v from g2_ids where k='relation_person'),
    'REPRESENTATIVE'
  );

  perform core.update_party_contact_for_user(
    (select v from g2_ids where k='case_G2-0001'),
    (select v from g2_ids where k='party_person'),
    'Anna Ombud',
    null,
    'population-ref-anna',
    'anna.ombud@example.se',
    '+46700000002'
  );

  perform pg_temp.g2_clear_subject();

  if (select relationship from core.case_parties
      where id = (select v from g2_ids where k='relation_person')) <> 'REPRESENTATIVE' then
    raise exception 'Relationship update failed';
  end if;

  if not exists (
    select 1 from core.parties
    where id = (select v from g2_ids where k='party_person')
      and display_name = 'Anna Ombud'
      and contact_email = 'anna.ombud@example.se'
  ) then
    raise exception 'Contact update failed';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Cross-authority/BOLA: another authority cannot add to or mutate this case.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g2_set_subject('other_auth');

  begin
    perform core.add_case_party_for_user(
      (select v from g2_ids where k='case_G2-0001'),
      'PERSON',
      'Otillåten',
      'APPLICANT',
      null, null, null, null
    );
  exception when no_data_found then
    v_blocked := true;
  end;

  perform pg_temp.g2_clear_subject();

  if not v_blocked then
    raise exception 'Cross-authority party add was allowed';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Shared canonical party cannot be silently changed by a worker who lacks
--    update rights on one of the other linked cases.
-- ---------------------------------------------------------------------------
insert into core.case_parties (case_id, party_id, authority_id, relationship)
values (
  (select v from g2_ids where k='case_G2-0002'),
  (select v from g2_ids where k='party_person'),
  (select v from g2_ids where k='auth_g2_bygg'),
  'OTHER'
);

do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g2_set_subject('worker');

  begin
    perform core.update_party_contact_for_user(
      (select v from g2_ids where k='case_G2-0001'),
      (select v from g2_ids where k='party_person'),
      'För bred ändring',
      null,
      'population-ref-anna',
      'forbred@example.se',
      null
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  perform pg_temp.g2_clear_subject();

  if not v_blocked then
    raise exception 'Shared party contact leaked across inaccessible case scope';
  end if;
end;
$$;

-- An authority-scoped senior who can update both cases may update the canonical
-- contact safely.
do $$
begin
  perform pg_temp.g2_set_subject('senior');

  perform core.update_party_contact_for_user(
    (select v from g2_ids where k='case_G2-0001'),
    (select v from g2_ids where k='party_person'),
    'Anna Gemensam',
    null,
    'population-ref-anna',
    'anna.gemensam@example.se',
    '+46700000003'
  );

  perform pg_temp.g2_clear_subject();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Direct client writes remain closed; the RPCs are the mutation boundary.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g2_set_subject('worker');

  begin
    insert into core.parties (authority_id, party_type, display_name)
    values (
      (select v from g2_ids where k='auth_g2_bygg'),
      'PERSON',
      'Bypass'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  perform pg_temp.g2_clear_subject();

  if not v_blocked then
    raise exception 'Direct core.parties insert bypass was allowed';
  end if;
end;
$$;

-- Audit is mandatory for every mutation command.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g2_ids where k='case_G2-0001')
    and action in (
      'case.party.added',
      'case.party.relationship.changed',
      'case.party.contact.updated'
    );

  if v_count < 5 then
    raise exception 'G2 party audit coverage incomplete, got % events', v_count;
  end if;
end;
$$;

select 'G2 CASE PARTIES (person/org/roles/contact/isolation): GREEN' as result;

rollback;
