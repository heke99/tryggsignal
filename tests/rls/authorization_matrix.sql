-- Tryggsignal — RLS authorization matrix (masterplan 19).
--
-- Runs inside one transaction and rolls back; it leaves no fixtures behind.
-- Every expectation raises on failure, so a clean run that prints GREEN means the
-- matrix passed.
--
--   psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/rls/authorization_matrix.sql
--
-- Last verified GREEN: 2026-09-07 against the development data plane, after the
-- P30 policy rewrite.
--
-- Covered subjects: anonymous, external applicant, external representative,
-- caseworker, caseworker in another department, caseworker in another authority,
-- senior caseworker, decision maker, tenant administrator, auditor, service
-- account. Covered objects: cases, documents, document versions, search index.

begin;

create temporary table t_ids (k text primary key, v uuid) on commit drop;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@matrix.invalid', 'authenticated', 'authenticated'
from unnest(array[
  'worker', 'other_dep', 'other_auth', 'senior', 'decision', 'admin', 'auditor',
  'applicant', 'representative', 'service'
]) as k;

insert into organization.legal_entities (name, organization_number)
values ('Matrixkommun', '212000-0001');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, k, k from organization.legal_entities le,
  unnest(array['mx_bygg', 'mx_miljo']) as k
where le.organization_number = '212000-0001';

insert into organization.departments (authority_id, key, name)
select a.id, d.k, d.k
from organization.authorities a
cross join lateral (
  select unnest(case when a.key = 'mx_bygg' then array['bygglov', 'annat'] else array['tillsyn'] end) as k
) d
where a.key like 'mx_%';

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email,
  case when split_part(au.email, '@', 1) in ('applicant', 'representative') then 'EXTERNAL'
       when split_part(au.email, '@', 1) = 'service' then 'SERVICE'
       else 'STAFF' end
from auth.users au
where au.email like '%@matrix.invalid';

insert into t_ids (k, v)
select split_part(u.email, '@', 1), u.id from identity.users u where u.email like '%@matrix.invalid';
insert into t_ids (k, v)
select 'auth_' || a.key, a.id from organization.authorities a where a.key like 'mx_%';
insert into t_ids (k, v)
select 'dep_' || d.key, d.id from organization.departments d
join organization.authorities a on a.id = d.authority_id where a.key like 'mx_%';

-- Role assignments (masterplan 16/17). Note the deliberate asymmetry: the tenant
-- administrator is scoped to the tenant and therefore carries no authority, which
-- is what denies them standing access to case content (masterplan 81).
insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'worker'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_bygglov'),
       (select v from t_ids where k = 'auth_mx_bygg'),
       (select v from t_ids where k = 'dep_bygglov')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'other_dep'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_annat'),
       (select v from t_ids where k = 'auth_mx_bygg'),
       (select v from t_ids where k = 'dep_annat')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id, department_id)
select (select v from t_ids where k = 'other_auth'), r.id, 'DEPARTMENT',
       (select v from t_ids where k = 'dep_tillsyn'),
       (select v from t_ids where k = 'auth_mx_miljo'),
       (select v from t_ids where k = 'dep_tillsyn')
from authz.roles r where r.key = 'building_case_worker';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id, authority_id)
select (select v from t_ids where k = u.k), r.id, 'AUTHORITY',
       (select v from t_ids where k = 'auth_mx_bygg'), (select v from t_ids where k = 'auth_mx_bygg')
from (values ('senior', 'senior_case_worker'), ('decision', 'decision_maker'),
             ('auditor', 'auditor'), ('service', 'integration_service')) as u(k, role_key)
join authz.roles r on r.key = u.role_key;

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id)
select (select v from t_ids where k = 'admin'), r.id, 'TENANT', null
from authz.roles r where r.key = 'tenant_admin';

insert into authz.role_assignments (user_id, role_id, scope_type, scope_id)
select (select v from t_ids where k = u.k), r.id, 'TENANT', null
from (values ('applicant', 'external_applicant'), ('representative', 'external_representative')) as u(k, role_key)
join authz.roles r on r.key = u.role_key;

insert into identity.user_memberships (user_id, authority_id, department_id)
select (select v from t_ids where k = 'worker'), (select v from t_ids where k = 'auth_mx_bygg'),
       (select v from t_ids where k = 'dep_bygglov');

insert into core.cases (authority_id, department_id, case_number, case_type, process_type,
                        title, status, information_class, assigned_user_id)
values
  ((select v from t_ids where k = 'auth_mx_bygg'), (select v from t_ids where k = 'dep_bygglov'),
   'MX-0001', 'BYGGLOV', 'BYGGLOV', 'Nybyggnad', 'REGISTERED', 'INTERNAL',
   (select v from t_ids where k = 'worker')),
  ((select v from t_ids where k = 'auth_mx_bygg'), (select v from t_ids where k = 'dep_bygglov'),
   'MX-0002', 'BYGGLOV', 'BYGGLOV', 'Skyddat', 'REGISTERED', 'SECRET',
   (select v from t_ids where k = 'senior')),
  ((select v from t_ids where k = 'auth_mx_miljo'), (select v from t_ids where k = 'dep_tillsyn'),
   'MX-0003', 'TILLSYN', 'PBL_TILLSYN', 'Tillsyn', 'REGISTERED', 'INTERNAL', null);

insert into t_ids (k, v) select 'case_' || c.case_number, c.id from core.cases c where c.case_number like 'MX-%';

insert into core.parties (authority_id, party_type, display_name)
values ((select v from t_ids where k = 'auth_mx_bygg'), 'PERSON', 'Sokande Matrix');

insert into core.case_parties (case_id, party_id, authority_id, relationship, identity_user_id, verified_at)
select (select v from t_ids where k = 'case_MX-0001'), p.id,
       (select v from t_ids where k = 'auth_mx_bygg'), 'APPLICANT',
       (select v from t_ids where k = 'applicant'), now()
from core.parties p where p.display_name = 'Sokande Matrix';

insert into documents.documents (authority_id, case_id, document_type, title, information_class)
values
  ((select v from t_ids where k = 'auth_mx_bygg'), (select v from t_ids where k = 'case_MX-0001'),
   'ANSOKAN', 'Ansokan MX-0001', 'INTERNAL'),
  ((select v from t_ids where k = 'auth_mx_bygg'), (select v from t_ids where k = 'case_MX-0001'),
   'INTERNT_PM', 'Sekretess PM', 'SECRET'),
  ((select v from t_ids where k = 'auth_mx_miljo'), (select v from t_ids where k = 'case_MX-0003'),
   'ANSOKAN', 'Ansokan MX-0003', 'INTERNAL');

-- The search index is maintained by the trigger on core.cases, so the fixtures
-- above have already been indexed. Asserting on it here proves the trigger and
-- the search policy agree with the case policy.

create or replace function pg_temp.expect(p_label text, p_actual bigint, p_expected bigint)
returns void language plpgsql as $$
begin
  if p_actual <> p_expected then
    raise exception 'RLS matrix: % expected %, got %', p_label, p_expected, p_actual;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tenant-level administration: authentication is not authorization. Only the
-- tenant administrator receives branding.manage (P36) and domain.manage (P37).
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin_sub uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'admin'));
  v_worker_sub uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'worker'));
  v_allowed boolean;
begin
  set local role authenticated;
  execute format('set local request.jwt.claims = %L',
    json_build_object('sub', v_admin_sub, 'role', 'authenticated')::text);
  select authz.has_tenant_permission('branding.manage') into v_allowed;
  if v_allowed is distinct from true then
    raise exception 'RLS matrix: tenant_admin lacks branding.manage';
  end if;
  select authz.has_tenant_permission('domain.manage') into v_allowed;
  reset role;
  if v_allowed is distinct from true then
    raise exception 'RLS matrix: tenant_admin lacks domain.manage';
  end if;

  set local role authenticated;
  execute format('set local request.jwt.claims = %L',
    json_build_object('sub', v_worker_sub, 'role', 'authenticated')::text);
  select authz.has_tenant_permission('branding.manage') into v_allowed;
  if v_allowed is distinct from false then
    raise exception 'RLS matrix: case worker unexpectedly received branding.manage';
  end if;
  select authz.has_tenant_permission('domain.manage') into v_allowed;
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
  if v_allowed is distinct from false then
    raise exception 'RLS matrix: case worker unexpectedly received domain.manage';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- SELECT matrix: cases, documents and the search index per subject type
-- ---------------------------------------------------------------------------
do $$
declare
  v record; v_sub uuid; v_cases bigint; v_docs bigint; v_search bigint;
begin
  for v in
    select * from (values
      -- username,      cases, documents, search rows
      ('worker',            1::bigint, 1::bigint, 1::bigint),
      ('other_dep',         0, 0, 0),
      ('other_auth',        1, 1, 1),
      ('senior',            2, 1, 2),
      ('decision',          1, 1, 1),
      ('admin',             0, 0, 0),
      ('auditor',           1, 1, 1),
      ('applicant',         1, 1, 1),
      ('representative',    0, 0, 0),
      ('service',           1, 0, 1)
    ) as expected(username, cases, docs, search_rows)
  loop
    select au.id into v_sub from auth.users au
    join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select t.v from t_ids t where t.k = v.username);

    execute 'set local role authenticated';
    execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub, 'role', 'authenticated')::text);
    select count(*) into v_cases from core.cases where case_number like 'MX-%';
    select count(*) into v_docs from documents.documents d
      join core.cases c on c.id = d.case_id where c.case_number like 'MX-%';
    select count(*) into v_search from search.entities where title like 'MX-%';
    reset role;
    execute 'set local request.jwt.claims = ' || quote_literal('{}');

    perform pg_temp.expect(v.username || ' cases', v_cases, v.cases);
    perform pg_temp.expect(v.username || ' documents', v_docs, v.docs);
    perform pg_temp.expect(v.username || ' search rows', v_search, v.search_rows);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Cross-authority leak, both directions (masterplan 13)
-- ---------------------------------------------------------------------------
do $$
declare
  v_case_bygg uuid := (select v from t_ids where k = 'case_MX-0001');
  v_case_miljo uuid := (select v from t_ids where k = 'case_MX-0003');
  v_sub_other uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'other_auth'));
  v_sub_worker uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'worker'));
  v_seen bigint;
begin
  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub_other, 'role', 'authenticated')::text);
  select count(*) into v_seen from core.cases where id = v_case_bygg;
  reset role;
  perform pg_temp.expect('cross-authority leak miljo->bygg', v_seen, 0);

  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_sub_worker, 'role', 'authenticated')::text);
  select count(*) into v_seen from core.cases where id = v_case_miljo;
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
  perform pg_temp.expect('cross-authority leak bygg->miljo', v_seen, 0);
end;
$$;

-- ---------------------------------------------------------------------------
-- Anonymous sessions have no grant at all
-- ---------------------------------------------------------------------------
do $$
declare v_denied boolean := false;
begin
  set local role anon;
  begin
    perform 1 from core.cases;
  exception when insufficient_privilege then v_denied := true;
  end;
  reset role;
  if not v_denied then raise exception 'RLS matrix: anonymous must not reach core.cases'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Write matrix: case CRUD, quarantine enforcement, applicant uploads and
-- document-version immutability
-- ---------------------------------------------------------------------------
do $$
declare
  v_worker_sub uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'worker'));
  v_applicant_sub uuid := (select au.id from auth.users au join identity.users iu on iu.auth_user_id = au.id
    where iu.id = (select v from t_ids where k = 'applicant'));
  v_bygg uuid := (select v from t_ids where k = 'auth_mx_bygg');
  v_bygglov uuid := (select v from t_ids where k = 'dep_bygglov');
  v_annat uuid := (select v from t_ids where k = 'dep_annat');
  v_miljo uuid := (select v from t_ids where k = 'auth_mx_miljo');
  v_case1 uuid := (select v from t_ids where k = 'case_MX-0001');
  v_case3 uuid := (select v from t_ids where k = 'case_MX-0003');
  v_doc uuid := (select id from documents.documents where title = 'Ansokan MX-0001');
  v_secret_doc uuid := (select id from documents.documents where title = 'Sekretess PM');
  v_updated integer;
  v_blocked boolean;
begin
  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_worker_sub, 'role', 'authenticated')::text);

  -- Allowed: create inside the assigned department.
  insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title)
  values (v_bygg, v_bygglov, 'MX-9001', 'BYGGLOV', 'BYGGLOV', 'Nytt');

  v_blocked := false;
  begin
    insert into core.cases (authority_id, department_id, case_number, case_type, process_type, title)
    values (v_bygg, v_annat, 'MX-9002', 'BYGGLOV', 'BYGGLOV', 'Otillatet');
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'worker created a case in another department'; end if;

  v_blocked := false;
  begin
    update core.cases set authority_id = v_miljo where id = v_case1;
  exception when insufficient_privilege or raise_exception then v_blocked := true;
  end;
  if not v_blocked then raise exception 'worker moved a case across authorities'; end if;

  v_blocked := false;
  begin
    delete from core.cases where id = v_case1;
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'worker deleted a case'; end if;

  update core.cases set title = 'Uppdaterad' where id = v_case1;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then raise exception 'worker could not update the assigned case'; end if;

  update core.cases set title = 'Far ej ske' where id = v_case3;
  get diagnostics v_updated = row_count;
  if v_updated <> 0 then raise exception 'worker updated a case in another authority'; end if;

  -- Masterplan 36: a file may only enter through quarantine.
  v_blocked := false;
  begin
    insert into documents.document_versions (document_id, authority_id, version, sha256, mime_type,
      size_bytes, storage_bucket, storage_path, ingestion_status)
    values (v_doc, v_bygg, 9, repeat('a', 64), 'application/pdf', 100,
            'case-documents', v_bygg::text || '/x/9/f.pdf', 'CLEAN');
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'a document version bypassed quarantine'; end if;

  insert into documents.document_versions (document_id, authority_id, version, sha256, mime_type,
    size_bytes, storage_bucket, storage_path)
  values (v_doc, v_bygg, 1, repeat('b', 64), 'application/pdf', 100,
          'quarantine', v_bygg::text || '/y/1/f.pdf');

  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');

  -- Masterplan 96: an applicant may add a document to their own case, but never
  -- to a secrecy-classified one.
  set local role authenticated;
  execute format('set local request.jwt.claims = %L', json_build_object('sub', v_applicant_sub, 'role', 'authenticated')::text);

  insert into documents.document_versions (document_id, authority_id, version, sha256, mime_type,
    size_bytes, storage_bucket, storage_path)
  values (v_doc, v_bygg, 2, repeat('d', 64), 'application/pdf', 100,
          'quarantine', v_bygg::text || '/z/2/f.pdf');

  v_blocked := false;
  begin
    insert into documents.document_versions (document_id, authority_id, version, sha256, mime_type,
      size_bytes, storage_bucket, storage_path)
    values (v_secret_doc, v_bygg, 1, repeat('e', 64), 'application/pdf', 100,
            'quarantine', v_bygg::text || '/s/1/f.pdf');
  exception when insufficient_privilege then v_blocked := true;
  end;
  if not v_blocked then raise exception 'an applicant added a version to a secrecy-classified document'; end if;

  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');

  -- Masterplan 35: an original version is immutable.
  v_blocked := false;
  begin
    update documents.document_versions set sha256 = repeat('c', 64)
    where document_id = v_doc and version = 1;
  exception when raise_exception then v_blocked := true;
  end;
  if not v_blocked then raise exception 'a document version checksum was mutable'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Case history and the audit hash chain (masterplan 20, 80)
-- ---------------------------------------------------------------------------
do $$
declare v_count integer; v_first text; v_second text;
begin
  select count(*) into v_count from core.case_status_history
  where case_id = (select v from t_ids where k = 'case_MX-0001');
  if v_count < 1 then raise exception 'Case status history was not recorded on insert'; end if;

  insert into audit.events (action, resource_type, authority_id, event_hash)
  values ('TEST_ONE', 'case', (select v from t_ids where k = 'auth_mx_bygg'), '')
  returning event_hash into v_first;

  insert into audit.events (action, resource_type, authority_id, event_hash)
  values ('TEST_TWO', 'case', (select v from t_ids where k = 'auth_mx_bygg'), '')
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
