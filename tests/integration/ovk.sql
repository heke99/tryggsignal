-- Tryggsignal Phase G10 — operational OVK integration.
begin;

create temporary table g10_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g10_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g10-ovk.invalid', 'authenticated', 'authenticated'
from unnest(array['inspector', 'worker', 'other_dep']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G10 OVK kommun', '212000-1016');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'g10_bygg', 'Byggnadsnämnden'
from organization.legal_entities le
where le.organization_number = '212000-1016';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join (values ('bygglov', 'Bygglov'), ('plan', 'Plan')) x(key, name)
where a.key = 'g10_bygg';

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g10-ovk.invalid';

insert into g10_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g10-ovk.invalid';
insert into g10_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g10-ovk.invalid';
insert into g10_ids
select 'authority', a.id from organization.authorities a where a.key = 'g10_bygg';
insert into g10_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'g10_bygg';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g10_ids where k='inspector'),
   (select v from g10_ids where k='authority'),
   (select v from g10_ids where k='dep_bygglov'), true),
  ((select v from g10_ids where k='worker'),
   (select v from g10_ids where k='authority'),
   (select v from g10_ids where k='dep_bygglov'), true),
  ((select v from g10_ids where k='other_dep'),
   (select v from g10_ids where k='authority'),
   (select v from g10_ids where k='dep_plan'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g10_ids where k=x.user_key),
  r.id,
  'DEPARTMENT',
  (select v from g10_ids where k=x.dep_key),
  (select v from g10_ids where k='authority'),
  (select v from g10_ids where k=x.dep_key)
from (values
  ('inspector', 'building_inspector', 'dep_bygglov'),
  ('worker', 'building_case_worker', 'dep_bygglov'),
  ('other_dep', 'building_inspector', 'dep_plan')
) x(user_key, role_key, dep_key)
join authz.roles r on r.key = x.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values (
  (select v from g10_ids where k='authority'),
  (select v from g10_ids where k='dep_bygglov'),
  'G10-OVK-0001', 'OVK', 'OVK',
  'Syntetiskt OVK-ärende', 'IN_REVIEW', 'INTERNAL'
);
insert into g10_ids
select 'case', id from core.cases where case_number = 'G10-OVK-0001';

insert into property.properties (
  authority_id, designation, municipality_code, source, source_object_id, source_version
)
values (
  (select v from g10_ids where k='authority'),
  'G10 KOMMUNEN 10:1', '0180', 'LANTMATERIET', 'lm-g10-1', '2026-09'
);
insert into g10_ids
select 'property', id from property.properties where designation = 'G10 KOMMUNEN 10:1';

insert into property.buildings (
  authority_id, property_id, building_designation, building_purpose, year_built, source
)
values (
  (select v from g10_ids where k='authority'),
  (select v from g10_ids where k='property'),
  'G10 Byggnad 1', 'FLERBOSTADSHUS', 2001, 'LANTMATERIET'
);
insert into g10_ids
select 'building', id from property.buildings where building_designation = 'G10 Byggnad 1';

insert into core.case_properties (case_id, property_id, authority_id, is_primary)
values (
  (select v from g10_ids where k='case'),
  (select v from g10_ids where k='property'),
  (select v from g10_ids where k='authority'),
  true
);

insert into compliance.obligations (key, name, domain, legal_reference, description)
values (
  'g10_ovk_flerbostad',
  'G10 OVK flerbostad',
  'OVK',
  'Syntetisk versionerad OVK-referens',
  'Syntetisk skyldighet för integrationsprovet.'
);
insert into g10_ids
select 'obligation', id from compliance.obligations where key = 'g10_ovk_flerbostad';

insert into compliance.obligation_rules (
  obligation_id, applies_when, interval_months, valid_from
)
values (
  (select v from g10_ids where k='obligation'),
  '{"building_purpose":"FLERBOSTADSHUS"}'::jsonb,
  36,
  current_date - 1
);

create or replace function pg_temp.g10_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g10_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g10_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- Building inspector links/registers the OVK object. Old control date => OVERDUE.
do $$
declare
  v_object uuid;
begin
  perform pg_temp.g10_set_subject('inspector');

  select compliance.link_ovk_object_for_user(
    (select v from g10_ids where k='case'),
    (select v from g10_ids where k='property'),
    (select v from g10_ids where k='building'),
    (select v from g10_ids where k='obligation'),
    'FTX-AGGREGAT-1',
    'FTX',
    (current_date - interval '40 months')::date
  ) into v_object;

  perform pg_temp.g10_clear_subject();
  insert into g10_ids values ('object', v_object);

  if not exists (
    select 1
    from compliance.compliance_objects o
    join compliance.ovk_case_objects co on co.compliance_object_id = o.id
    where o.id = v_object
      and co.case_id = (select v from g10_ids where k='case')
      and o.status = 'OVERDUE'
      and o.next_due_at is not null
  ) then
    raise exception 'G10 object did not enter OVERDUE due queue';
  end if;
end;
$$;

-- Ordinary building caseworker has no ovk.manage.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g10_set_subject('worker');
  begin
    perform compliance.link_ovk_object_for_user(
      (select v from g10_ids where k='case'),
      (select v from g10_ids where k='property'),
      (select v from g10_ids where k='building'),
      (select v from g10_ids where k='obligation'),
      'FTX-AGGREGAT-WORKER',
      'FTX',
      null
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g10_clear_subject();

  if not v_blocked then
    raise exception 'Building caseworker managed OVK without ovk.manage';
  end if;
end;
$$;

-- Inspector in another department has authority-level OVK mandate but may not
-- mutate this case-bound OVK cycle because exact case.read scope fails.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g10_set_subject('other_dep');
  begin
    perform compliance.link_ovk_object_for_user(
      (select v from g10_ids where k='case'),
      (select v from g10_ids where k='property'),
      (select v from g10_ids where k='building'),
      (select v from g10_ids where k='obligation'),
      'FTX-AGGREGAT-OTHER',
      'FTX',
      null
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g10_clear_subject();

  if not v_blocked then
    raise exception 'OVK mutation crossed case department scope';
  end if;
end;
$$;

-- Prepare one case document with a quarantined and two clean immutable versions.
insert into documents.documents (
  authority_id, case_id, department_id, document_type, title,
  information_class, secrecy_level
)
values (
  (select v from g10_ids where k='authority'),
  (select v from g10_ids where k='case'),
  (select v from g10_ids where k='dep_bygglov'),
  'OVK_PROTOCOL',
  'Syntetiska OVK-protokoll',
  'INTERNAL',
  0
);
insert into g10_ids
select 'document', id from documents.documents where title = 'Syntetiska OVK-protokoll';

insert into documents.document_versions (
  document_id, authority_id, version, sha256, mime_type, detected_mime_type,
  size_bytes, storage_bucket, storage_path, original_filename, ingestion_status
)
values
  (
    (select v from g10_ids where k='document'),
    (select v from g10_ids where k='authority'),
    1, repeat('1',64), 'application/pdf', 'application/pdf',
    1000, 'quarantine', 'g10/quarantine-v1.pdf', 'ovk-v1.pdf', 'QUARANTINED'
  ),
  (
    (select v from g10_ids where k='document'),
    (select v from g10_ids where k='authority'),
    2, repeat('2',64), 'application/pdf', 'application/pdf',
    1100, 'documents', 'g10/clean-v2.pdf', 'ovk-v2.pdf', 'CLEAN'
  ),
  (
    (select v from g10_ids where k='document'),
    (select v from g10_ids where k='authority'),
    3, repeat('3',64), 'application/pdf', 'application/pdf',
    1200, 'documents', 'g10/clean-v3.pdf', 'ovk-v3.pdf', 'CLEAN'
  );

insert into g10_ids
select 'version_' || version::text, id
from documents.document_versions
where document_id = (select v from g10_ids where k='document');

-- Quarantined protocol evidence must fail closed.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g10_set_subject('inspector');
  begin
    perform compliance.record_ovk_protocol_for_user(
      (select v from g10_ids where k='case'),
      (select v from g10_ids where k='object'),
      current_date,
      'NOT_APPROVED',
      (select v from g10_ids where k='document'),
      (select v from g10_ids where k='version_1'),
      'Syntetisk kontrollant',
      'G10 Kontroll AB',
      'Det här protokollet är fortfarande i karantän.'
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g10_clear_subject();

  if not v_blocked then
    raise exception 'Quarantined OVK protocol was accepted';
  end if;
end;
$$;

-- A real CLEAN NOT_APPROVED protocol keeps the object out of COMPLIANT and
-- creates an explicit action-required finding.
do $$
declare
  v_protocol uuid;
begin
  perform pg_temp.g10_set_subject('inspector');

  select compliance.record_ovk_protocol_for_user(
    (select v from g10_ids where k='case'),
    (select v from g10_ids where k='object'),
    current_date,
    'NOT_APPROVED',
    (select v from g10_ids where k='document'),
    (select v from g10_ids where k='version_2'),
    'Syntetisk kontrollant',
    'G10 Kontroll AB',
    'Kontrollen är utförd men inte godkänd.'
  ) into v_protocol;

  perform pg_temp.g10_clear_subject();
  insert into g10_ids values ('protocol_failed', v_protocol);

  if not exists (
    select 1
    from compliance.compliance_objects o
    where o.id = (select v from g10_ids where k='object')
      and o.last_protocol_result = 'NOT_APPROVED'
      and o.status = 'DUE'
      and o.risk_score >= 80
      and o.last_protocol_id = v_protocol
  ) then
    raise exception 'NOT_APPROVED protocol incorrectly produced compliant state';
  end if;

  if not exists (
    select 1
    from compliance.compliance_findings f
    where f.compliance_object_id = (select v from g10_ids where k='object')
      and f.protocol_id = v_protocol
      and f.finding_type = 'PROTOCOL_NOT_APPROVED'
      and f.status = 'ACTION_REQUIRED'
  ) then
    raise exception 'NOT_APPROVED protocol did not enter supervision queue';
  end if;
end;
$$;

-- A later approved CLEAN protocol restores date-based compliance, but prior
-- findings remain open until a human resolves them.
do $$
declare
  v_protocol uuid;
  v_finding uuid;
begin
  perform pg_temp.g10_set_subject('inspector');

  select compliance.record_ovk_protocol_for_user(
    (select v from g10_ids where k='case'),
    (select v from g10_ids where k='object'),
    current_date,
    'APPROVED',
    (select v from g10_ids where k='document'),
    (select v from g10_ids where k='version_3'),
    'Syntetisk kontrollant',
    'G10 Kontroll AB',
    'Ny kontroll verifierad och godkänd.'
  ) into v_protocol;

  select f.id into v_finding
  from compliance.compliance_findings f
  where f.compliance_object_id = (select v from g10_ids where k='object')
    and f.status = 'ACTION_REQUIRED'
  order by f.detected_at
  limit 1;

  perform pg_temp.g10_clear_subject();

  insert into g10_ids values ('protocol_approved', v_protocol), ('finding_auto', v_finding);

  if not exists (
    select 1
    from compliance.compliance_objects o
    where o.id = (select v from g10_ids where k='object')
      and o.last_protocol_result = 'APPROVED'
      and o.status = 'COMPLIANT'
      and o.next_due_at > current_date
  ) then
    raise exception 'Approved OVK protocol did not restore date-based compliance';
  end if;

  if v_finding is null then
    raise exception 'Prior failed-protocol finding disappeared without human resolution';
  end if;
end;
$$;

-- Manual OVK finding and explicit human resolution.
do $$
declare
  v_manual uuid;
begin
  perform pg_temp.g10_set_subject('inspector');

  select compliance.record_ovk_finding_for_user(
    (select v from g10_ids where k='case'),
    (select v from g10_ids where k='object'),
    (select v from g10_ids where k='protocol_approved'),
    'REMARK_ON_AIRFLOW',
    'Syntetisk anmärkning om luftflöde som kräver uppföljning.',
    'DEVIATION',
    now() + interval '14 days'
  ) into v_manual;

  perform compliance.resolve_ovk_finding_for_user(
    (select v from g10_ids where k='case'),
    (select v from g10_ids where k='finding_auto'),
    'Tidigare underkänt protokoll ersatt av ny verifierad och godkänd kontroll.'
  );

  perform compliance.resolve_ovk_finding_for_user(
    (select v from g10_ids where k='case'),
    v_manual,
    'Syntetisk avvikelse verifierad som åtgärdad.'
  );

  perform pg_temp.g10_clear_subject();

  insert into g10_ids values ('finding_manual', v_manual);

  if exists (
    select 1
    from compliance.compliance_findings f
    where f.compliance_object_id = (select v from g10_ids where k='object')
      and f.status in ('OPEN', 'ACTION_REQUIRED')
  ) then
    raise exception 'Resolved OVK findings remained in supervision queue';
  end if;
end;
$$;

-- Audit coverage.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g10_ids where k='case')
    and action in (
      'case.ovk.object_linked',
      'case.ovk.protocol_recorded',
      'case.ovk.finding_recorded',
      'case.ovk.finding_resolved'
    );

  if v_count < 6 then
    raise exception 'G10 OVK audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G10 OVK (objects/due/protocol/CLEAN/findings/supervision/isolation): GREEN' as result;

rollback;
