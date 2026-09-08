-- Tryggsignal Phase G4 — operational document integration.
-- Verifies command-only metadata writes, exact-path quarantine storage policy,
-- processing confirmation, CLEAN-only reads, external applicant rules,
-- department/authority isolation, version immutability and audit.

begin;

create temporary table g4_ids (k text primary key, v uuid) on commit drop;
create temporary table g4_text (k text primary key, v text) on commit drop;
grant select, insert on g4_ids, g4_text to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g4-documents.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'other_dep', 'other_auth', 'applicant', 'neighbour']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G4 Documents kommun', '212000-0943');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g4_bygg', 'Byggnadsnämnden'),
  ('g4_miljo', 'Miljönämnden')
) as x(key, name)
where le.organization_number = '212000-0943';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join lateral (
  select * from (values
    ('bygglov', 'Bygglov'),
    ('plan', 'Plan')
  ) as d(key, name)
  where a.key = 'g4_bygg'
  union all
  select 'tillsyn', 'Tillsyn' where a.key = 'g4_miljo'
) x;

insert into identity.users (auth_user_id, display_name, email, user_type)
select
  au.id,
  split_part(au.email, '@', 1),
  au.email,
  case
    when split_part(au.email, '@', 1) in ('applicant', 'neighbour') then 'EXTERNAL'
    else 'STAFF'
  end
from auth.users au
where au.email like '%@g4-documents.invalid';

insert into g4_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@g4-documents.invalid';

insert into g4_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@g4-documents.invalid';

insert into g4_ids
select 'auth_' || a.key, a.id
from organization.authorities a
where a.key like 'g4_%';

insert into g4_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g4_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g4_ids where k='worker'),
   (select v from g4_ids where k='auth_g4_bygg'),
   (select v from g4_ids where k='dep_bygglov'), true),
  ((select v from g4_ids where k='other_dep'),
   (select v from g4_ids where k='auth_g4_bygg'),
   (select v from g4_ids where k='dep_plan'), true),
  ((select v from g4_ids where k='other_auth'),
   (select v from g4_ids where k='auth_g4_miljo'),
   (select v from g4_ids where k='dep_tillsyn'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g4_ids where k=u.user_key),
  r.id,
  'DEPARTMENT',
  (select v from g4_ids where k=u.dep_key),
  (select v from g4_ids where k=u.auth_key),
  (select v from g4_ids where k=u.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov', 'auth_g4_bygg'),
  ('other_dep', 'building_case_worker', 'dep_plan', 'auth_g4_bygg'),
  ('other_auth', 'building_case_worker', 'dep_tillsyn', 'auth_g4_miljo')
) as u(user_key, role_key, dep_key, auth_key)
join authz.roles r on r.key = u.role_key;

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id)
select
  (select v from g4_ids where k=u.user_key),
  r.id,
  'TENANT',
  null
from (values
  ('applicant', 'external_applicant'),
  ('neighbour', 'external_applicant')
) as u(user_key, role_key)
join authz.roles r on r.key = u.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values
  ((select v from g4_ids where k='auth_g4_bygg'),
   (select v from g4_ids where k='dep_bygglov'),
   'G4-0001', 'BYGGLOV', 'BYGGLOV', 'Dokumentärende', 'REGISTERED', 'INTERNAL'),
  ((select v from g4_ids where k='auth_g4_bygg'),
   (select v from g4_ids where k='dep_plan'),
   'G4-0002', 'BYGGLOV', 'BYGGLOV', 'Annat department', 'REGISTERED', 'INTERNAL'),
  ((select v from g4_ids where k='auth_g4_miljo'),
   (select v from g4_ids where k='dep_tillsyn'),
   'G4-0003', 'TILLSYN', 'PBL_TILLSYN', 'Annan myndighet', 'REGISTERED', 'INTERNAL');

insert into g4_ids
select 'case_' || case_number, id
from core.cases
where case_number like 'G4-%';

insert into core.parties (authority_id, party_type, display_name)
values
  ((select v from g4_ids where k='auth_g4_bygg'), 'PERSON', 'G4 Sökande'),
  ((select v from g4_ids where k='auth_g4_bygg'), 'PERSON', 'G4 Granne');

insert into core.case_parties (
  case_id, party_id, authority_id, relationship, identity_user_id, verified_at
)
select
  (select v from g4_ids where k='case_G4-0001'),
  p.id,
  (select v from g4_ids where k='auth_g4_bygg'),
  case when p.display_name = 'G4 Sökande' then 'APPLICANT' else 'NEIGHBOUR' end,
  case
    when p.display_name = 'G4 Sökande' then (select v from g4_ids where k='applicant')
    else (select v from g4_ids where k='neighbour')
  end,
  now()
from core.parties p
where p.display_name in ('G4 Sökande', 'G4 Granne');

create or replace function pg_temp.g4_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g4_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g4_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Staff prepares immutable metadata and one exact quarantine path.
-- ---------------------------------------------------------------------------
do $$
declare
  v_prepared jsonb;
begin
  perform pg_temp.g4_set_subject('worker');

  select documents.prepare_case_document_upload_for_user(
    (select v from g4_ids where k='case_G4-0001'),
    'ANSOKAN',
    'Ansökan med ritning',
    'Första inkomna handlingen',
    'INTERNAL',
    0,
    'ansokan.pdf',
    'application/pdf',
    12345,
    repeat('a', 64)
  ) into v_prepared;

  insert into g4_ids values
    ('doc_staff', (v_prepared->>'document_id')::uuid),
    ('ver_staff_1', (v_prepared->>'document_version_id')::uuid);
  insert into g4_text values
    ('path_staff_1', v_prepared->>'path');

  perform pg_temp.g4_clear_subject();

  if v_prepared->>'bucket' <> 'quarantine'
     or (v_prepared->>'version')::integer <> 1 then
    raise exception 'Prepared upload did not target quarantine version 1';
  end if;

  if not exists (
    select 1
    from documents.document_versions v
    where v.id = (select v from g4_ids where k='ver_staff_1')
      and v.ingestion_status = 'QUARANTINED'
      and v.storage_bucket = 'quarantine'
      and v.storage_path = (select v from g4_text where k='path_staff_1')
      and v.upload_confirmed_at is null
      and v.processing_enqueued_at is null
  ) then
    raise exception 'Prepared document version metadata is incomplete';
  end if;

  if (select current_version from documents.documents
      where id = (select v from g4_ids where k='doc_staff')) <> 1 then
    raise exception 'Document current_version was not bumped to one';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Storage RLS accepts only the pre-authorized exact path.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g4_set_subject('worker');

  begin
    insert into storage.objects (bucket_id, name)
    values ('quarantine', (select v from g4_text where k='path_staff_1') || '/forged');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Storage accepted an unprepared quarantine path';
  end if;

  insert into storage.objects (bucket_id, name)
  values ('quarantine', (select v from g4_text where k='path_staff_1'));

  perform pg_temp.g4_clear_subject();
end;
$$;

-- Quarantined bytes cannot be read back by the browser.
do $$
declare
  v_count integer;
begin
  perform pg_temp.g4_set_subject('worker');

  select count(*) into v_count
  from storage.objects
  where bucket_id = 'quarantine'
    and name = (select v from g4_text where k='path_staff_1');

  perform pg_temp.g4_clear_subject();

  if v_count <> 0 then
    raise exception 'Quarantined object became readable before CLEAN';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Confirmation verifies Storage presence and queues processing once.
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.g4_set_subject('worker');

  perform documents.confirm_document_upload_for_user(
    (select v from g4_ids where k='ver_staff_1')
  );
  -- Idempotent confirmation must not enqueue a second processing job.
  perform documents.confirm_document_upload_for_user(
    (select v from g4_ids where k='ver_staff_1')
  );

  perform pg_temp.g4_clear_subject();

  if not exists (
    select 1
    from documents.document_versions v
    where v.id = (select v from g4_ids where k='ver_staff_1')
      and v.upload_confirmed_at is not null
      and v.processing_enqueued_at is not null
  ) then
    raise exception 'Upload confirmation did not persist operational timestamps';
  end if;
end;
$$;

-- Simulate a trusted scanner result as the database owner. The production worker
-- remains EXTERNAL_BLOCKED by EB-08 and never fabricates this transition.
update documents.document_versions
set detected_mime_type = 'application/pdf',
    scanned_at = now(),
    ingestion_status = 'CLEAN'
where id = (select v from g4_ids where k='ver_staff_1');

-- CLEAN object is readable to the case worker but not to another department.
do $$
declare
  v_count integer;
begin
  perform pg_temp.g4_set_subject('worker');
  select count(*) into v_count
  from storage.objects
  where bucket_id = 'quarantine'
    and name = (select v from g4_text where k='path_staff_1');
  perform pg_temp.g4_clear_subject();

  if v_count <> 1 then
    raise exception 'Authorized case worker could not read CLEAN storage object';
  end if;

  perform pg_temp.g4_set_subject('other_dep');
  select count(*) into v_count
  from storage.objects
  where bucket_id = 'quarantine'
    and name = (select v from g4_text where k='path_staff_1');
  perform pg_temp.g4_clear_subject();

  if v_count <> 0 then
    raise exception 'CLEAN storage object leaked across department case scope';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. New versions remain append-only and receive a fresh exact path.
-- ---------------------------------------------------------------------------
do $$
declare
  v_prepared jsonb;
begin
  perform pg_temp.g4_set_subject('worker');

  select documents.prepare_new_version_upload_for_user(
    (select v from g4_ids where k='doc_staff'),
    'ansokan-komplettering.pdf',
    'application/pdf',
    22222,
    repeat('b', 64)
  ) into v_prepared;

  perform pg_temp.g4_clear_subject();

  insert into g4_ids values ('ver_staff_2', (v_prepared->>'document_version_id')::uuid);
  insert into g4_text values ('path_staff_2', v_prepared->>'path');

  if (v_prepared->>'version')::integer <> 2
     or (v_prepared->>'path') = (select v from g4_text where k='path_staff_1') then
    raise exception 'New document version did not get a unique version/path';
  end if;

  if (select current_version from documents.documents
      where id = (select v from g4_ids where k='doc_staff')) <> 2 then
    raise exception 'current_version did not advance to two';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Applicant may prepare INTERNAL uploads on own verified case, never
--    RESTRICTED; a verified neighbour is not an upload principal.
-- ---------------------------------------------------------------------------
do $$
declare
  v_prepared jsonb;
  v_blocked boolean := false;
begin
  perform pg_temp.g4_set_subject('applicant');

  select documents.prepare_case_document_upload_for_user(
    (select v from g4_ids where k='case_G4-0001'),
    'KOMPLETTERING',
    'Sökandens komplettering',
    null,
    'INTERNAL',
    0,
    'komplettering.pdf',
    'application/pdf',
    333,
    repeat('c', 64)
  ) into v_prepared;

  if v_prepared->>'document_id' is null then
    raise exception 'Applicant upload preparation returned no document';
  end if;

  begin
    perform documents.prepare_case_document_upload_for_user(
      (select v from g4_ids where k='case_G4-0001'),
      'KOMPLETTERING',
      'Otillåten sekretesshandling',
      null,
      'RESTRICTED',
      2,
      'restricted.pdf',
      'application/pdf',
      444,
      repeat('d', 64)
    );
  exception when no_data_found then
    v_blocked := true;
  end;

  perform pg_temp.g4_clear_subject();

  if not v_blocked then
    raise exception 'Applicant prepared a RESTRICTED document';
  end if;

  v_blocked := false;
  perform pg_temp.g4_set_subject('neighbour');

  begin
    perform documents.prepare_case_document_upload_for_user(
      (select v from g4_ids where k='case_G4-0001'),
      'YTTRANDE',
      'Grannens uppladdning',
      null,
      'INTERNAL',
      0,
      'granne.pdf',
      'application/pdf',
      555,
      repeat('e', 64)
    );
  exception when no_data_found then
    v_blocked := true;
  end;

  perform pg_temp.g4_clear_subject();

  if not v_blocked then
    raise exception 'Neighbour relationship was treated as an upload principal';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Department and authority BOLA boundaries.
-- ---------------------------------------------------------------------------
do $$
declare
  v_dep_blocked boolean := false;
  v_auth_blocked boolean := false;
begin
  perform pg_temp.g4_set_subject('other_dep');

  begin
    perform documents.prepare_case_document_upload_for_user(
      (select v from g4_ids where k='case_G4-0001'),
      'PM', 'Fel department', null, 'INTERNAL', 0,
      'fel.pdf', 'application/pdf', 10, repeat('f', 64)
    );
  exception when no_data_found then
    v_dep_blocked := true;
  end;

  perform pg_temp.g4_clear_subject();
  perform pg_temp.g4_set_subject('other_auth');

  begin
    perform documents.prepare_case_document_upload_for_user(
      (select v from g4_ids where k='case_G4-0001'),
      'PM', 'Fel myndighet', null, 'INTERNAL', 0,
      'fel2.pdf', 'application/pdf', 10, repeat('1', 64)
    );
  exception when no_data_found then
    v_auth_blocked := true;
  end;

  perform pg_temp.g4_clear_subject();

  if not v_dep_blocked or not v_auth_blocked then
    raise exception 'Document preparation crossed case scope';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Direct browser metadata/version writes are gone; classification goes RPC.
-- ---------------------------------------------------------------------------
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g4_set_subject('worker');

  begin
    update documents.documents
    set title = 'Bypass'
    where id = (select v from g4_ids where k='doc_staff');
  exception when insufficient_privilege then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Direct document metadata update bypass was allowed';
  end if;

  perform documents.update_document_metadata_for_user(
    (select v from g4_ids where k='doc_staff'),
    'ANSOKAN',
    'Klassificerad ansökan',
    'Metadata via command boundary',
    'INTERNAL',
    1
  );

  perform pg_temp.g4_clear_subject();

  if not exists (
    select 1
    from documents.documents
    where id = (select v from g4_ids where k='doc_staff')
      and title = 'Klassificerad ansökan'
      and secrecy_level = 1
  ) then
    raise exception 'Document metadata command did not persist';
  end if;
end;
$$;

-- Content identity remains immutable.
do $$
declare
  v_blocked boolean := false;
begin
  begin
    update documents.document_versions
    set sha256 = repeat('9', 64)
    where id = (select v from g4_ids where k='ver_staff_1');
  exception when raise_exception then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Document version content identity became mutable';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g4_ids where k='case_G4-0001')
    and action in (
      'case.document.upload_prepared',
      'case.document.version_prepared',
      'case.document.upload_confirmed',
      'case.document.metadata_updated'
    );

  if v_count < 5 then
    raise exception 'G4 document audit coverage incomplete, got % events', v_count;
  end if;
end;
$$;

select 'G4 DOCUMENTS (quarantine/storage/RLS/versioning/external): GREEN' as result;

rollback;
