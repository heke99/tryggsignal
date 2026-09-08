-- Tryggsignal Phase G6 — sourced deterministic completeness integration.
-- Operational evaluation/review use authenticated RPCs; fixture setup may use owner SQL.

begin;

create temporary table g6_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g6_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g6-completeness.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'other_dep', 'other_auth']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G6 Completeness kommun', '212000-0968');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g6_bygg', 'Byggnadsnämnden'),
  ('g6_miljo', 'Miljönämnden')
) x(key, name)
where le.organization_number = '212000-0968';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join lateral (
  select * from (values ('bygglov', 'Bygglov'), ('plan', 'Plan')) d(key, name)
  where a.key = 'g6_bygg'
  union all
  select 'tillsyn', 'Tillsyn' where a.key = 'g6_miljo'
) x;

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g6-completeness.invalid';

insert into g6_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g6-completeness.invalid';
insert into g6_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g6-completeness.invalid';
insert into g6_ids
select 'auth_' || a.key, a.id from organization.authorities a where a.key like 'g6_%';
insert into g6_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g6_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g6_ids where k='worker'),
   (select v from g6_ids where k='auth_g6_bygg'),
   (select v from g6_ids where k='dep_bygglov'), true),
  ((select v from g6_ids where k='other_dep'),
   (select v from g6_ids where k='auth_g6_bygg'),
   (select v from g6_ids where k='dep_plan'), true),
  ((select v from g6_ids where k='other_auth'),
   (select v from g6_ids where k='auth_g6_miljo'),
   (select v from g6_ids where k='dep_tillsyn'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g6_ids where k=u.user_key),
  r.id,
  'DEPARTMENT',
  (select v from g6_ids where k=u.dep_key),
  (select v from g6_ids where k=u.auth_key),
  (select v from g6_ids where k=u.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov', 'auth_g6_bygg'),
  ('other_dep', 'building_case_worker', 'dep_plan', 'auth_g6_bygg'),
  ('other_auth', 'building_case_worker', 'dep_tillsyn', 'auth_g6_miljo')
) u(user_key, role_key, dep_key, auth_key)
join authz.roles r on r.key = u.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values (
  (select v from g6_ids where k='auth_g6_bygg'),
  (select v from g6_ids where k='dep_bygglov'),
  'G6-0001', 'BYGGLOV', 'BYGGLOV', 'Completenessärende', 'REGISTERED', 'INTERNAL'
);

insert into g6_ids
select 'case', id from core.cases where case_number = 'G6-0001';

-- Synthetic LOCAL_DECISION profile: it proves the version/source machinery,
-- not any national legal requirement.
insert into rules.rule_sets (authority_id, key, name, domain)
values (
  (select v from g6_ids where k='auth_g6_bygg'),
  'g6_synthetic', 'G6 syntetisk kompletthetsprofil', 'COMPLETENESS'
)
returning id;

insert into g6_ids
select 'ruleset', id from rules.rule_sets where key = 'g6_synthetic';

insert into rules.rule_set_versions (
  rule_set_id, version, valid_from, published_at
)
values ((select v from g6_ids where k='ruleset'), 1, current_date, now());

insert into g6_ids
select 'version', id from rules.rule_set_versions
where rule_set_id = (select v from g6_ids where k='ruleset') and version = 1;

insert into rules.rules (
  rule_set_version_id, key, name, severity, predicate, legal_reference
)
values
  ((select v from g6_ids where k='version'), 'applicant', 'Sökande registrerad', 'REQUIRED',
   '{"kind":"PARTY_RELATIONSHIP","value":"APPLICANT"}', 'Syntetiskt testbeslut G6'),
  ((select v from g6_ids where k='version'), 'property', 'Fastighet kopplad', 'REQUIRED',
   '{"kind":"PROPERTY_LINK"}', 'Syntetiskt testbeslut G6'),
  ((select v from g6_ids where k='version'), 'application', 'Ren ansökan finns', 'REQUIRED',
   '{"kind":"CLEAN_DOCUMENT_TYPE","value":"ANSOKAN"}', 'Syntetiskt testbeslut G6');

insert into rules.rule_sources (rule_id, source_type, reference)
select r.id, 'LOCAL_DECISION', 'Syntetiskt testbeslut G6 — endast CI'
from rules.rules r
where r.rule_set_version_id = (select v from g6_ids where k='version');

-- Manual-review profile.
insert into rules.rule_sets (authority_id, key, name, domain)
values (
  (select v from g6_ids where k='auth_g6_bygg'),
  'g6_manual', 'G6 syntetisk manuell profil', 'COMPLETENESS'
);
insert into g6_ids
select 'manual_ruleset', id from rules.rule_sets where key = 'g6_manual';
insert into rules.rule_set_versions (rule_set_id, version, valid_from, published_at)
values ((select v from g6_ids where k='manual_ruleset'), 1, current_date, now());
insert into g6_ids
select 'manual_version', id from rules.rule_set_versions
where rule_set_id = (select v from g6_ids where k='manual_ruleset');

insert into rules.rules (
  rule_set_version_id, key, name, severity, predicate, legal_reference
)
values (
  (select v from g6_ids where k='manual_version'),
  'manual_condition',
  'Handläggare måste bedöma särskild omständighet',
  'REQUIRED',
  '{"kind":"MANUAL_REVIEW"}',
  'Syntetiskt testbeslut G6'
);
insert into rules.rule_sources (rule_id, source_type, reference)
select r.id, 'LOCAL_DECISION', 'Syntetiskt testbeslut G6 — endast CI'
from rules.rules r
where r.rule_set_version_id = (select v from g6_ids where k='manual_version');

create or replace function pg_temp.g6_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g6_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g6_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- 1. Missing evidence -> INCOMPLETE with explicit missing items.
do $$
declare
  v_id uuid;
begin
  perform pg_temp.g6_set_subject('worker');

  select rules.evaluate_case_completeness_for_user(
    (select v from g6_ids where k='case'),
    (select v from g6_ids where k='version')
  ) into v_id;

  perform pg_temp.g6_clear_subject();
  insert into g6_ids values ('assessment_incomplete', v_id);

  if not exists (
    select 1 from rules.completeness_assessments a
    where a.id = v_id
      and a.result = 'INCOMPLETE'
      and jsonb_array_length(a.missing_items) = 3
      and jsonb_array_length(a.evidence) = 3
  ) then
    raise exception 'Missing evidence did not yield deterministic INCOMPLETE';
  end if;
end;
$$;

-- Add evidence as fixture owner, then re-evaluate through the RPC.
insert into core.parties (authority_id, party_type, display_name)
values ((select v from g6_ids where k='auth_g6_bygg'), 'PERSON', 'G6 Sökande');
insert into core.case_parties (case_id, party_id, authority_id, relationship)
select
  (select v from g6_ids where k='case'),
  p.id,
  (select v from g6_ids where k='auth_g6_bygg'),
  'APPLICANT'
from core.parties p where p.display_name = 'G6 Sökande';

insert into property.properties (authority_id, designation, source)
values ((select v from g6_ids where k='auth_g6_bygg'), 'G6 1:1', 'LOCAL');
insert into core.case_properties (case_id, property_id, authority_id, is_primary)
select
  (select v from g6_ids where k='case'),
  p.id,
  (select v from g6_ids where k='auth_g6_bygg'),
  true
from property.properties p where p.designation = 'G6 1:1';

insert into documents.documents (
  authority_id, case_id, department_id, document_type, title, information_class
)
values (
  (select v from g6_ids where k='auth_g6_bygg'),
  (select v from g6_ids where k='case'),
  (select v from g6_ids where k='dep_bygglov'),
  'ANSOKAN', 'G6 ansökan', 'INTERNAL'
);
insert into documents.document_versions (
  document_id, authority_id, version, sha256, mime_type, size_bytes,
  storage_bucket, storage_path, ingestion_status
)
select
  d.id, d.authority_id, 1, repeat('a', 64), 'application/pdf', 10,
  'quarantine', d.authority_id::text || '/' || d.id::text || '/1/g6',
  'CLEAN'
from documents.documents d where d.title = 'G6 ansökan';

do $$
declare
  v_id uuid;
begin
  perform pg_temp.g6_set_subject('worker');

  select rules.evaluate_case_completeness_for_user(
    (select v from g6_ids where k='case'),
    (select v from g6_ids where k='version')
  ) into v_id;

  perform pg_temp.g6_clear_subject();

  if not exists (
    select 1 from rules.completeness_assessments a
    where a.id = v_id
      and a.result = 'COMPLETE'
      and jsonb_array_length(a.missing_items) = 0
      and superseded_at is null
  ) then
    raise exception 'Complete evidence did not yield COMPLETE';
  end if;

  if not exists (
    select 1 from rules.completeness_assessments a
    where a.id = (select v from g6_ids where k='assessment_incomplete')
      and a.superseded_at is not null
  ) then
    raise exception 'Previous completeness assessment was not superseded';
  end if;
end;
$$;

-- 3. Explicit manual predicate -> HUMAN_REVIEW and human resolution is audited.
do $$
declare
  v_assessment uuid;
  v_review uuid;
begin
  perform pg_temp.g6_set_subject('worker');

  select rules.evaluate_case_completeness_for_user(
    (select v from g6_ids where k='case'),
    (select v from g6_ids where k='manual_version')
  ) into v_assessment;

  if (select result from rules.completeness_assessments where id = v_assessment)
     <> 'HUMAN_REVIEW' then
    raise exception 'Manual predicate did not yield HUMAN_REVIEW';
  end if;

  select rules.review_case_completeness_for_user(
    v_assessment,
    'COMPLETE',
    'Syntetisk handläggarbedömning för integrationsprovet.'
  ) into v_review;

  perform pg_temp.g6_clear_subject();

  if not exists (
    select 1 from rules.completeness_reviews
    where id = v_review and decision = 'COMPLETE'
  ) then
    raise exception 'Human completeness review was not persisted';
  end if;
end;
$$;

-- 4. Same authority/wrong department and another authority cannot evaluate.
do $$
declare
  v_dep_blocked boolean := false;
  v_auth_blocked boolean := false;
begin
  perform pg_temp.g6_set_subject('other_dep');
  begin
    perform rules.evaluate_case_completeness_for_user(
      (select v from g6_ids where k='case'),
      (select v from g6_ids where k='version')
    );
  exception when no_data_found then
    v_dep_blocked := true;
  end;
  perform pg_temp.g6_clear_subject();

  perform pg_temp.g6_set_subject('other_auth');
  begin
    perform rules.evaluate_case_completeness_for_user(
      (select v from g6_ids where k='case'),
      (select v from g6_ids where k='version')
    );
  exception when no_data_found then
    v_auth_blocked := true;
  end;
  perform pg_temp.g6_clear_subject();

  if not v_dep_blocked or not v_auth_blocked then
    raise exception 'Completeness evaluation crossed case scope';
  end if;
end;
$$;

-- 5. Every rule must have a source; unsourced config is fail-closed.
insert into rules.rule_sets (authority_id, key, name, domain)
values ((select v from g6_ids where k='auth_g6_bygg'), 'g6_unsourced', 'Unsourced', 'COMPLETENESS');
insert into rules.rule_set_versions (rule_set_id, version, valid_from, published_at)
select id, 1, current_date, now() from rules.rule_sets where key = 'g6_unsourced';
insert into rules.rules (rule_set_version_id, key, name, severity, predicate)
select v.id, 'bad', 'Unsourced rule', 'REQUIRED', '{"kind":"PROPERTY_LINK"}'
from rules.rule_set_versions v
join rules.rule_sets rs on rs.id = v.rule_set_id
where rs.key = 'g6_unsourced';

do $$
declare
  v_blocked boolean := false;
  v_version uuid;
begin
  select v.id into v_version
  from rules.rule_set_versions v
  join rules.rule_sets rs on rs.id = v.rule_set_id
  where rs.key = 'g6_unsourced';

  perform pg_temp.g6_set_subject('worker');
  begin
    perform rules.evaluate_case_completeness_for_user(
      (select v from g6_ids where k='case'),
      v_version
    );
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;
  perform pg_temp.g6_clear_subject();

  if not v_blocked then
    raise exception 'Unsourced completeness rule was evaluated';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g6_ids where k='case')
    and action in ('case.completeness.evaluated', 'case.completeness.reviewed');

  if v_count < 4 then
    raise exception 'G6 completeness audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G6 COMPLETENESS (complete/incomplete/human-review/sources/isolation): GREEN' as result;

rollback;
