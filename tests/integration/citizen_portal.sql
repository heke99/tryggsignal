-- Tryggsignal Phase G11 — Mina sidor citizen portal integration.
-- Static identities/configuration are seeded with owner SQL. All citizen/business
-- mutations under test go through the same narrow commands used by the product.
begin;

create temporary table g11_ids (k text primary key, v uuid) on commit drop;
create temporary table g11_text (k text primary key, v text) on commit drop;
grant select, insert on g11_ids, g11_text to authenticated;

-- ---------------------------------------------------------------------------
-- Control-plane auth audience: one active STAFF + one active EXTERNAL provider.
-- ---------------------------------------------------------------------------
with created_tenant as (
  insert into platform.tenants (
    slug, display_name, status, canonical_hostname, auth_configuration_reference, activated_at
  )
  values (
    'g11kommun', 'G11 kommun', 'ACTIVE', 'g11kommun.tryggsignal.se', 'g11-staff-auth', now()
  )
  returning id
)
insert into g11_ids
select 'tenant', id from created_tenant;

insert into platform.tenant_domains (
  tenant_id, hostname, normalized_hostname, domain_type, status, is_canonical, is_fallback,
  ownership_status, dns_status, tls_status, verified_at, activated_at
)
values (
  (select v from g11_ids where k='tenant'),
  'g11kommun.tryggsignal.se',
  'g11kommun.tryggsignal.se',
  'PLATFORM_SUBDOMAIN',
  'ACTIVE',
  true,
  true,
  'VERIFIED',
  'OK',
  'ISSUED',
  now(),
  now()
);

insert into platform.tenant_auth_configurations (
  tenant_id, reference, audience, kind, display_name, environment, enabled
)
values
  (
    (select v from g11_ids where k='tenant'),
    'g11-staff-auth', 'STAFF', 'SUPABASE_PASSWORD', 'G11 personal', 'TEST', true
  ),
  (
    (select v from g11_ids where k='tenant'),
    'g11-external-auth', 'EXTERNAL', 'SUPABASE_PASSWORD', 'G11 Mina sidor', 'TEST', true
  );

do $$
declare
  v_reference text;
  v_blocked boolean := false;
begin
  select r.reference into v_reference
  from public.resolve_tenant_auth_config(
    'g11kommun.tryggsignal.se',
    (select v from g11_ids where k='tenant'),
    'g11-staff-auth',
    'EXTERNAL'
  ) r;

  if v_reference <> 'g11-external-auth' then
    raise exception 'EXTERNAL auth did not resolve independently of STAFF reference';
  end if;

  begin
    insert into platform.tenant_auth_configurations (
      tenant_id, reference, audience, kind, display_name,
      credential_reference, environment, enabled
    )
    values (
      (select v from g11_ids where k='tenant'),
      'g11-external-auth-duplicate',
      'EXTERNAL',
      'OIDC',
      'Duplicate external',
      'secret/g11-external-duplicate',
      'TEST',
      true
    );
  exception when unique_violation then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Tenant accepted multiple enabled EXTERNAL auth configurations';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Municipal identities and application configuration.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g11.invalid', 'authenticated', 'authenticated'
from unnest(array['applicant', 'outsider', 'staff']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G11 Portal kommun', '212000-1115');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'g11_bygg', 'Byggnadsnämnden'
from organization.legal_entities le
where le.organization_number = '212000-1115';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join (values
  ('bygglov', 'Bygglov'),
  ('plan', 'Plan')
) x(key, name)
where a.key = 'g11_bygg';

insert into identity.users (
  auth_user_id, display_name, email, user_type, identity_provider
)
select
  au.id,
  case split_part(au.email, '@', 1)
    when 'applicant' then 'G11 Sökande'
    when 'outsider' then 'G11 Annan person'
    else 'G11 Handläggare'
  end,
  au.email,
  case when au.email like 'staff@%' then 'STAFF' else 'EXTERNAL' end,
  'SUPABASE'
from auth.users au
where au.email like '%@g11.invalid';

insert into g11_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@g11.invalid';

insert into g11_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@g11.invalid';

insert into g11_ids
select 'authority', a.id
from organization.authorities a
where a.key = 'g11_bygg';

insert into g11_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'g11_bygg';

insert into identity.user_memberships (
  user_id, authority_id, department_id, is_primary
)
values (
  (select v from g11_ids where k='staff'),
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='dep_bygglov'),
  true
);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g11_ids where k='staff'),
  r.id,
  'DEPARTMENT',
  (select v from g11_ids where k='dep_bygglov'),
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='dep_bygglov')
from authz.roles r
where r.key = 'building_case_worker';

insert into workflow.workflow_templates (
  authority_id, key, name, process_type
)
values (
  (select v from g11_ids where k='authority'),
  'g11_bygglov_portal',
  'G11 bygglov från Mina sidor',
  'BYGGLOV'
);

insert into workflow.workflow_template_versions (
  template_id, authority_id, version, definition, valid_from, published_at
)
select
  t.id,
  t.authority_id,
  1,
  '{
    "initial":"INKOMMEN",
    "states":{
      "INKOMMEN":{
        "case_status":"RECEIVED",
        "case_phase":"INTAKE",
        "to":["GRANSKNING"],
        "tasks":[{"key":"REGISTRERA","title":"Registrera inkommet webbärende"}]
      },
      "GRANSKNING":{
        "case_status":"IN_REVIEW",
        "case_phase":"REVIEW",
        "to":["BESLUT"]
      },
      "BESLUT":{
        "case_status":"AWAITING_DECISION",
        "case_phase":"DECISION",
        "to":[]
      }
    }
  }'::jsonb,
  now() - interval '1 day',
  now() - interval '1 day'
from workflow.workflow_templates t
where t.key = 'g11_bygglov_portal'
  and t.authority_id = (select v from g11_ids where k='authority');

insert into config.citizen_application_profiles (
  authority_id, department_id, process_type, case_type,
  workflow_template_key, display_name, description
)
values (
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='dep_bygglov'),
  'BYGGLOV',
  'BYGGLOV',
  'g11_bygglov_portal',
  'Bygglov',
  'Syntetisk G11-profil'
);

insert into g11_ids
select 'profile', id
from config.citizen_application_profiles
where display_name = 'Bygglov'
  and authority_id = (select v from g11_ids where k='authority');

create or replace function pg_temp.g11_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g11_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g11_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Applicant submits through the atomic citizen command.
-- ---------------------------------------------------------------------------
do $$
declare
  v_case uuid;
  v_number text;
begin
  perform pg_temp.g11_set_subject('applicant');

  select r.case_id, r.case_number
  into v_case, v_number
  from core.submit_citizen_application_for_user(
    (select v from g11_ids where k='profile'),
    'Tillbyggnad av bostadshus',
    'Syntetisk ansökan från Mina sidor.',
    '+46700000000',
    'APPLICANT'
  ) r;

  perform pg_temp.g11_clear_subject();

  insert into g11_ids values ('case', v_case);
  insert into g11_text values ('case_number', v_number);

  if v_number !~ '^WEB-[0-9]{4}-[0-9]{6}$' then
    raise exception 'Citizen application got invalid provisional reference %', v_number;
  end if;

  if not exists (
    select 1
    from core.cases c
    join core.case_parties cp on cp.case_id = c.id
    join workflow.workflow_instances wi on wi.case_id = c.id
    join workflow.workflow_template_versions wv on wv.id = wi.template_version_id
    where c.id = v_case
      and c.source_system = 'CITIZEN_PORTAL'
      and c.status = 'RECEIVED'
      and c.phase = 'INTAKE'
      and cp.identity_user_id = (select v from g11_ids where k='applicant')
      and cp.relationship = 'APPLICANT'
      and cp.verified_at is not null
      and wv.version = 1
      and exists (
        select 1 from workflow.workflow_tasks wt
        where wt.instance_id = wi.id
          and wt.task_key = 'REGISTRERA'
      )
  ) then
    raise exception 'Citizen application was not atomically bound to party and workflow';
  end if;
end;
$$;

-- External users still have no broad direct case.create permission.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g11_set_subject('applicant');
  begin
    insert into core.cases (
      authority_id, department_id, case_number, case_type, process_type, title
    )
    values (
      (select v from g11_ids where k='authority'),
      (select v from g11_ids where k='dep_bygglov'),
      'G11-FORGED',
      'BYGGLOV',
      'BYGGLOV',
      'Forged direct insert'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.g11_clear_subject();

  if not v_blocked then
    raise exception 'External applicant received direct case.create access';
  end if;
end;
$$;

-- STAFF cannot reuse the citizen submission boundary.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g11_set_subject('staff');
  begin
    perform core.submit_citizen_application_for_user(
      (select v from g11_ids where k='profile'),
      'Staff-forged citizen case',
      null,
      null,
      'APPLICANT'
    );
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  perform pg_temp.g11_clear_subject();

  if not v_blocked then
    raise exception 'STAFF session could use citizen submission command';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Parent-case RLS and internal child-table minimization.
-- ---------------------------------------------------------------------------
insert into referral.referrals (
  authority_id, case_id, subject, description, due_at
)
values (
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='case'),
  'Intern remiss',
  'Den här remissen ska inte visas i Mina sidor.',
  now() + interval '14 days'
);

do $$
declare
  v_count integer;
begin
  perform pg_temp.g11_set_subject('applicant');

  select count(*) into v_count
  from core.cases
  where id = (select v from g11_ids where k='case');
  if v_count <> 1 then
    raise exception 'Applicant cannot read own verified case';
  end if;

  select count(*) into v_count
  from workflow.workflow_instances
  where case_id = (select v from g11_ids where k='case');
  if v_count <> 0 then
    raise exception 'Mina sidor leaked internal workflow instance';
  end if;

  select count(*) into v_count
  from workflow.workflow_tasks
  where case_id = (select v from g11_ids where k='case');
  if v_count <> 0 then
    raise exception 'Mina sidor leaked internal workflow tasks';
  end if;

  select count(*) into v_count
  from referral.referrals
  where case_id = (select v from g11_ids where k='case');
  if v_count <> 0 then
    raise exception 'Mina sidor leaked internal referral data';
  end if;

  perform pg_temp.g11_clear_subject();

  perform pg_temp.g11_set_subject('outsider');
  select count(*) into v_count
  from core.cases
  where id = (select v from g11_ids where k='case');
  perform pg_temp.g11_clear_subject();

  if v_count <> 0 then
    raise exception 'Unrelated external identity could read applicant case';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Applicant complement upload metadata is case-scoped and quarantined.
-- ---------------------------------------------------------------------------
do $$
declare
  v_prepared jsonb;
begin
  perform pg_temp.g11_set_subject('applicant');

  select documents.prepare_case_document_upload_for_user(
    (select v from g11_ids where k='case'),
    'KOMPLETTERING',
    'Kompletterande ritning',
    'Uppladdad av sökanden.',
    'INTERNAL',
    0,
    'komplettering.pdf',
    'application/pdf',
    2048,
    repeat('a', 64)
  ) into v_prepared;

  perform pg_temp.g11_clear_subject();

  insert into g11_ids values
    ('applicant_document', (v_prepared->>'document_id')::uuid),
    ('applicant_version', (v_prepared->>'document_version_id')::uuid);

  if not exists (
    select 1
    from documents.document_versions v
    join documents.documents d on d.id = v.document_id
    where v.id = (select v from g11_ids where k='applicant_version')
      and d.created_by = (select v from g11_ids where k='applicant')
      and d.portal_visible = false
      and v.ingestion_status = 'QUARANTINED'
      and v.storage_bucket = 'quarantine'
  ) then
    raise exception 'Citizen complement did not enter quarantine correctly';
  end if;
end;
$$;

-- Static municipal documents represent staff output; portal publication itself
-- is exercised through the staff command.
insert into documents.documents (
  authority_id, case_id, department_id, document_type, title,
  information_class, secrecy_level, created_by, portal_visible
)
values
  (
    (select v from g11_ids where k='authority'),
    (select v from g11_ids where k='case'),
    (select v from g11_ids where k='dep_bygglov'),
    'KOMMUN_HANDLING',
    'Kommunens delbara handling',
    'INTERNAL',
    0,
    (select v from g11_ids where k='staff'),
    false
  ),
  (
    (select v from g11_ids where k='authority'),
    (select v from g11_ids where k='case'),
    (select v from g11_ids where k='dep_bygglov'),
    'INTERN_ANTECKNING',
    'Sekretessklassad intern handling',
    'RESTRICTED',
    2,
    (select v from g11_ids where k='staff'),
    false
  );

insert into g11_ids
select case title
  when 'Kommunens delbara handling' then 'staff_document'
  else 'restricted_document'
end, id
from documents.documents
where case_id = (select v from g11_ids where k='case')
  and title in ('Kommunens delbara handling', 'Sekretessklassad intern handling');

insert into documents.document_versions (
  document_id, authority_id, version, sha256, mime_type, detected_mime_type,
  size_bytes, storage_bucket, storage_path, original_filename, ingestion_status,
  created_by
)
values
  (
    (select v from g11_ids where k='staff_document'),
    (select v from g11_ids where k='authority'),
    1, repeat('b', 64), 'application/pdf', 'application/pdf',
    1024, 'case-documents',
    (select v from g11_ids where k='authority')::text || '/' ||
      (select v from g11_ids where k='staff_document')::text || '/1/delbar.pdf',
    'delbar.pdf', 'CLEAN',
    (select v from g11_ids where k='staff')
  ),
  (
    (select v from g11_ids where k='restricted_document'),
    (select v from g11_ids where k='authority'),
    1, repeat('c', 64), 'application/pdf', 'application/pdf',
    1024, 'case-documents',
    (select v from g11_ids where k='authority')::text || '/' ||
      (select v from g11_ids where k='restricted_document')::text || '/1/hemlig.pdf',
    'hemlig.pdf', 'CLEAN',
    (select v from g11_ids where k='staff')
  );

-- Before publication applicant sees only own upload; outsider sees neither.
do $$
declare
  v_count integer;
begin
  perform pg_temp.g11_set_subject('applicant');
  select count(*) into v_count
  from documents.documents
  where case_id = (select v from g11_ids where k='case');
  perform pg_temp.g11_clear_subject();

  if v_count <> 1 then
    raise exception 'Applicant saw staff document before explicit portal publication';
  end if;

  perform pg_temp.g11_set_subject('outsider');
  select count(*) into v_count
  from documents.documents
  where case_id = (select v from g11_ids where k='case');
  perform pg_temp.g11_clear_subject();

  if v_count <> 0 then
    raise exception 'Unrelated external identity saw case documents';
  end if;
end;
$$;

-- Staff publishes safe document; restricted publication fails closed.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g11_set_subject('staff');

  perform documents.set_portal_visibility_for_user(
    (select v from g11_ids where k='staff_document'),
    true
  );

  begin
    perform documents.set_portal_visibility_for_user(
      (select v from g11_ids where k='restricted_document'),
      true
    );
  exception when check_violation then
    v_blocked := true;
  end;

  perform pg_temp.g11_clear_subject();

  if not v_blocked then
    raise exception 'Restricted document was published to Mina sidor';
  end if;
end;
$$;

do $$
declare
  v_count integer;
  v_versions integer;
begin
  perform pg_temp.g11_set_subject('applicant');

  select count(*) into v_count
  from documents.documents
  where case_id = (select v from g11_ids where k='case');

  select count(*) into v_versions
  from documents.document_versions
  where document_id = (select v from g11_ids where k='staff_document');

  perform pg_temp.g11_clear_subject();

  if v_count <> 2 or v_versions <> 1 then
    raise exception 'Published safe document was not exposed as one CLEAN version';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Portal communication is explicit; internal outbound messages stay hidden.
-- ---------------------------------------------------------------------------
do $$
declare
  v_message uuid;
begin
  perform pg_temp.g11_set_subject('applicant');
  select communication.send_portal_message_for_user(
    (select v from g11_ids where k='case'),
    'Fråga om mitt ärende',
    'Detta är ett syntetiskt meddelande från sökanden.'
  ) into v_message;
  perform pg_temp.g11_clear_subject();

  insert into g11_ids values ('inbound_message', v_message);
end;
$$;

insert into communication.messages (
  authority_id, case_id, direction, subject, body, information_class, created_by
)
values
  (
    (select v from g11_ids where k='authority'),
    (select v from g11_ids where k='case'),
    'OUTBOUND',
    'Portalbesked',
    'Detta besked är avsett för sökanden i portalen.',
    'INTERNAL',
    (select v from g11_ids where k='staff')
  ),
  (
    (select v from g11_ids where k='authority'),
    (select v from g11_ids where k='case'),
    'OUTBOUND',
    'Intern kommunikation',
    'Detta får inte läcka till Mina sidor.',
    'INTERNAL',
    (select v from g11_ids where k='staff')
  );

insert into g11_ids
select case subject
  when 'Portalbesked' then 'outbound_portal'
  else 'outbound_internal'
end, id
from communication.messages
where case_id = (select v from g11_ids where k='case')
  and subject in ('Portalbesked', 'Intern kommunikation');

insert into communication.deliveries (
  message_id, authority_id, channel, recipient_party_id,
  correlation_id, status, sent_at
)
select
  (select v from g11_ids where k='outbound_portal'),
  (select v from g11_ids where k='authority'),
  'PORTAL',
  cp.party_id,
  gen_random_uuid(),
  'SENT',
  now()
from core.case_parties cp
where cp.case_id = (select v from g11_ids where k='case')
  and cp.identity_user_id = (select v from g11_ids where k='applicant')
  and cp.relationship = 'APPLICANT';

do $$
declare
  v_count integer;
begin
  perform pg_temp.g11_set_subject('applicant');
  select count(*) into v_count
  from communication.messages
  where case_id = (select v from g11_ids where k='case');
  perform pg_temp.g11_clear_subject();

  if v_count <> 2 then
    raise exception 'Applicant portal message visibility expected 2, got %', v_count;
  end if;

  perform pg_temp.g11_set_subject('outsider');
  select count(*) into v_count
  from communication.messages
  where case_id = (select v from g11_ids where k='case');
  perform pg_temp.g11_clear_subject();

  if v_count <> 0 then
    raise exception 'Unrelated external identity saw portal communication';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Only final decisions are visible externally.
-- ---------------------------------------------------------------------------
insert into decision.decisions (
  authority_id, case_id, decision_type, decision_number, status, created_at
)
values (
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='case'),
  'BYGGLOV',
  'G11-DRAFT',
  'DRAFT',
  now()
);

insert into decision.decisions (
  authority_id, case_id, decision_type, decision_number, status,
  decided_by, decided_at, created_at
)
values (
  (select v from g11_ids where k='authority'),
  (select v from g11_ids where k='case'),
  'BYGGLOV',
  'G11-FINAL',
  'DECIDED',
  (select v from g11_ids where k='staff'),
  now(),
  now()
);

insert into decision.decision_versions (
  decision_id, authority_id, version, body, conditions, legal_references, created_by
)
select
  d.id,
  d.authority_id,
  1,
  case when d.status = 'DECIDED'
    then 'Slutligt syntetiskt beslut.'
    else 'Internt utkast som inte får visas.'
  end,
  '[]'::jsonb,
  '["Syntetisk rättslig referens"]'::jsonb,
  (select v from g11_ids where k='staff')
from decision.decisions d
where d.case_id = (select v from g11_ids where k='case')
  and d.decision_number in ('G11-DRAFT', 'G11-FINAL');

update decision.decisions d
set current_version = 1
where d.case_id = (select v from g11_ids where k='case')
  and d.decision_number in ('G11-DRAFT', 'G11-FINAL');

do $$
declare
  v_count integer;
begin
  perform pg_temp.g11_set_subject('applicant');

  select count(*) into v_count
  from decision.decisions
  where case_id = (select v from g11_ids where k='case');

  perform pg_temp.g11_clear_subject();

  if v_count <> 1 then
    raise exception 'Applicant decision visibility expected exactly one final decision, got %', v_count;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Audit evidence for citizen actions/publication.
-- ---------------------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g11_ids where k='case')
    and action in (
      'case.citizen_application.submitted',
      'case.portal.message_received',
      'case.document.portal_published'
    );

  if v_count < 3 then
    raise exception 'G11 audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G11 CITIZEN PORTAL (auth/application/RLS/documents/messages/decisions/isolation): GREEN'
  as result;

rollback;
