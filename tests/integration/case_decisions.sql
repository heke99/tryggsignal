-- Tryggsignal Phase G8 — operational decision lifecycle integration.
begin;

create temporary table g8_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g8_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g8-decision.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'decisionmaker', 'other_dep']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G8 Beslut kommun', '212000-0984');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'g8_bygg', 'Byggnadsnämnden'
from organization.legal_entities le
where le.organization_number = '212000-0984';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join (values ('bygglov', 'Bygglov'), ('plan', 'Plan')) x(key, name)
where a.key = 'g8_bygg';

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g8-decision.invalid';

insert into g8_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g8-decision.invalid';
insert into g8_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g8-decision.invalid';
insert into g8_ids
select 'authority', a.id from organization.authorities a where a.key = 'g8_bygg';
insert into g8_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'g8_bygg';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g8_ids where k='worker'),
   (select v from g8_ids where k='authority'),
   (select v from g8_ids where k='dep_bygglov'), true),
  ((select v from g8_ids where k='decisionmaker'),
   (select v from g8_ids where k='authority'),
   (select v from g8_ids where k='dep_bygglov'), true),
  ((select v from g8_ids where k='other_dep'),
   (select v from g8_ids where k='authority'),
   (select v from g8_ids where k='dep_plan'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g8_ids where k=x.user_key),
  r.id,
  'DEPARTMENT',
  (select v from g8_ids where k=x.dep_key),
  (select v from g8_ids where k='authority'),
  (select v from g8_ids where k=x.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov'),
  ('decisionmaker', 'decision_maker', 'dep_bygglov'),
  ('other_dep', 'building_case_worker', 'dep_plan')
) x(user_key, role_key, dep_key)
join authz.roles r on r.key = x.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values (
  (select v from g8_ids where k='authority'),
  (select v from g8_ids where k='dep_bygglov'),
  'G8-0001', 'BYGGLOV', 'BYGGLOV',
  'Syntetiskt beslutsärende', 'AWAITING_DECISION', 'INTERNAL'
);

insert into g8_ids
select 'case', id from core.cases where case_number = 'G8-0001';

insert into core.parties (
  authority_id, party_type, display_name, contact_email
)
values (
  (select v from g8_ids where k='authority'),
  'PERSON',
  'Syntetisk sökande',
  'sokande@g8.invalid'
);

insert into g8_ids
select 'party', id from core.parties where display_name = 'Syntetisk sökande';

insert into core.case_parties (case_id, party_id, authority_id, relationship)
values (
  (select v from g8_ids where k='case'),
  (select v from g8_ids where k='party'),
  (select v from g8_ids where k='authority'),
  'APPLICANT'
);

create or replace function pg_temp.g8_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g8_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g8_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- Handläggaren creates and versions an AI-assisted draft. AI output remains draft.
do $$
declare
  v_decision uuid;
  v_version uuid;
begin
  perform pg_temp.g8_set_subject('worker');

  select decision.create_for_user(
    (select v from g8_ids where k='case'),
    'BYGGLOV_BESLUT',
    'G8-BESLUT-0001'
  ) into v_decision;

  select decision.add_version_for_user(
    v_decision,
    'Bygglov beviljas enligt den syntetiska beslutsversionen.',
    jsonb_build_array(jsonb_build_object('text', 'Kontrollplan ska följas')),
    jsonb_build_array(jsonb_build_object('reference', 'PBL syntetisk referens')),
    'AI_DRAFT'
  ) into v_version;

  perform decision.submit_review_for_user(v_decision);

  perform pg_temp.g8_clear_subject();

  insert into g8_ids values ('decision', v_decision), ('version', v_version);

  if not exists (
    select 1
    from decision.decisions d
    join decision.decision_versions dv
      on dv.decision_id = d.id and dv.version = d.current_version
    where d.id = v_decision
      and d.status = 'REVIEW'
      and d.current_version = 1
      and dv.generated_by = 'AI_DRAFT'
      and d.decided_by is null
  ) then
    raise exception 'AI draft incorrectly bypassed review/final decision boundary';
  end if;
end;
$$;

-- Ordinary caseworker must never approve.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g8_set_subject('worker');
  begin
    perform decision.approve_for_user((select v from g8_ids where k='decision'));
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g8_clear_subject();

  if not v_blocked then
    raise exception 'Building case worker approved a decision without decision.approve';
  end if;
end;
$$;

-- Decision maker approves and makes the accountable human decision.
do $$
declare
  v_missing_reference_blocked boolean := false;
  v_external_signature_blocked boolean := false;
  v_signature uuid;
begin
  perform pg_temp.g8_set_subject('decisionmaker');

  perform decision.approve_for_user((select v from g8_ids where k='decision'));

  begin
    perform decision.decide_for_user(
      (select v from g8_ids where k='decision'),
      '',
      now() + interval '21 days'
    );
  exception when check_violation then
    v_missing_reference_blocked := true;
  end;

  perform decision.decide_for_user(
    (select v from g8_ids where k='decision'),
    'Delegationsordning G8 § 1',
    now() + interval '21 days'
  );

  begin
    perform decision.sign_for_user(
      (select v from g8_ids where k='decision'),
      'BANKID',
      null,
      '{}'::jsonb
    );
  exception when check_violation then
    v_external_signature_blocked := true;
  end;

  select decision.sign_for_user(
    (select v from g8_ids where k='decision'),
    'MANUAL_ATTESTATION',
    null,
    jsonb_build_object('test', true)
  ) into v_signature;

  perform pg_temp.g8_clear_subject();

  if not v_missing_reference_blocked or not v_external_signature_blocked then
    raise exception 'G8 final-decision/signature fail-closed guards did not hold';
  end if;

  insert into g8_ids values ('signature', v_signature);

  if not exists (
    select 1
    from decision.decisions d
    join decision.signatures s on s.decision_id = d.id
    where d.id = (select v from g8_ids where k='decision')
      and d.status = 'DECIDED'
      and d.approved_by = (select v from g8_ids where k='decisionmaker')
      and d.decided_by = (select v from g8_ids where k='decisionmaker')
      and d.approved_at is not null
      and d.decided_at is not null
      and d.signed_at is not null
      and d.issued_at is null
      and s.signed_by = (select v from g8_ids where k='decisionmaker')
      and s.method = 'MANUAL_ATTESTATION'
  ) then
    raise exception 'Accountable human approval/decision/signature state is incomplete';
  end if;
end;
$$;

-- Final decision versions are immutable.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g8_set_subject('worker');
  begin
    perform decision.add_version_for_user(
      (select v from g8_ids where k='decision'),
      'Otillåten efterhandsändring.',
      '[]'::jsonb,
      '[]'::jsonb,
      'HUMAN'
    );
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;
  perform pg_temp.g8_clear_subject();

  if not v_blocked then
    raise exception 'Final decision accepted a new mutable version';
  end if;
end;
$$;

-- Issue is queued first and must not claim actual issuance.
do $$
declare
  v_issuance uuid;
  v_delivery uuid;
begin
  perform pg_temp.g8_set_subject('decisionmaker');

  select decision.issue_for_user(
    (select v from g8_ids where k='decision'),
    (select v from g8_ids where k='party'),
    'EMAIL'
  ) into v_issuance;

  perform pg_temp.g8_clear_subject();

  select delivery_id into v_delivery
  from decision.issuances
  where id = v_issuance;

  insert into g8_ids values ('issuance', v_issuance), ('delivery', v_delivery);

  if not exists (
    select 1
    from decision.issuances i
    join communication.deliveries d on d.id = i.delivery_id
    join decision.decisions dec on dec.id = i.decision_id
    where i.id = v_issuance
      and i.status = 'QUEUED'
      and i.issued_at is null
      and d.status = 'PENDING'
      and dec.issued_at is null
  ) then
    raise exception 'Queued issuance falsely claimed an external send';
  end if;

  if not exists (
    select 1
    from pgmq.q_notifications q
    where q.message->>'idempotency_key' = 'decision-issuance:' || v_issuance::text
  ) then
    raise exception 'Decision issuance was not durably enqueued';
  end if;
end;
$$;

-- Provider acknowledgement updates delivery and the issuance trigger propagates state.
select communication.worker_apply_delivery_event(
  (select v from g8_ids where k='delivery'),
  'SENT',
  'provider-g8-001',
  null
);

do $$
begin
  if not exists (
    select 1
    from decision.issuances i
    join decision.decisions d on d.id = i.decision_id
    join communication.deliveries dl on dl.id = i.delivery_id
    where i.id = (select v from g8_ids where k='issuance')
      and i.status = 'SENT'
      and i.issued_at is not null
      and d.issued_at is not null
      and dl.status = 'SENT'
      and dl.external_reference = 'provider-g8-001'
  ) then
    raise exception 'Provider SENT event did not synchronize decision issuance';
  end if;
end;
$$;

-- Department boundary stays fail-closed.
do $$
declare
  v_blocked boolean := false;
begin
  perform pg_temp.g8_set_subject('other_dep');
  begin
    perform decision.create_for_user(
      (select v from g8_ids where k='case'),
      'OTILLATET',
      null
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  perform pg_temp.g8_clear_subject();

  if not v_blocked then
    raise exception 'G8 decision command crossed department scope';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g8_ids where k='case')
    and action in (
      'case.decision.created',
      'case.decision.version_created',
      'case.decision.review_submitted',
      'case.decision.approved',
      'case.decision.decided',
      'case.decision.signed',
      'case.decision.issuance_queued',
      'case.decision.issued'
    );

  if v_count < 8 then
    raise exception 'G8 decision audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G8 DECISIONS (draft/version/review/approve/decide/sign/issue/isolation): GREEN' as result;

rollback;
