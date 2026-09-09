-- Tryggsignal Gate G — one complete synthetic building-permit flow.
--
-- Static configuration/reference data is seeded as fixture owner. From the moment
-- the case is created, every case-scoped business mutation goes through the same
-- authenticated command boundaries used by the product. No direct SQL mutation
-- of the operational case, party links, case-property links, referrals,
-- completeness assessments, workflow state or decisions is allowed in the flow.

begin;

create temporary table gate_g_ids (k text primary key, v uuid) on commit drop;
grant select, insert on gate_g_ids to authenticated;

-- ---------------------------------------------------------------------------
-- Static municipality/auth configuration
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@gate-g.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'decisionmaker']) as k;

insert into organization.legal_entities (name, organization_number)
values ('Gate G kommun', '212000-0999');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'gate_g_bygg', 'Gate G byggnadsnämnd'
from organization.legal_entities le
where le.organization_number = '212000-0999';

insert into organization.departments (authority_id, key, name)
select a.id, 'bygglov', 'Bygglov'
from organization.authorities a
where a.key = 'gate_g_bygg';

insert into identity.users (auth_user_id, display_name, email, user_type)
select
  au.id,
  case when au.email like 'worker@%' then 'Gate G handläggare' else 'Gate G beslutsfattare' end,
  au.email,
  'STAFF'
from auth.users au
where au.email like '%@gate-g.invalid';

insert into gate_g_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@gate-g.invalid';

insert into gate_g_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@gate-g.invalid';

insert into gate_g_ids
select 'authority', a.id
from organization.authorities a
where a.key = 'gate_g_bygg';

insert into gate_g_ids
select 'department', d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'gate_g_bygg' and d.key = 'bygglov';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  (
    (select v from gate_g_ids where k='worker'),
    (select v from gate_g_ids where k='authority'),
    (select v from gate_g_ids where k='department'),
    true
  ),
  (
    (select v from gate_g_ids where k='decisionmaker'),
    (select v from gate_g_ids where k='authority'),
    null,
    true
  );

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from gate_g_ids where k='worker'),
  r.id,
  'DEPARTMENT',
  (select v from gate_g_ids where k='department'),
  (select v from gate_g_ids where k='authority'),
  (select v from gate_g_ids where k='department')
from authz.roles r
where r.key = 'building_case_worker';

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id
)
select
  (select v from gate_g_ids where k='decisionmaker'),
  r.id,
  'AUTHORITY',
  (select v from gate_g_ids where k='authority'),
  (select v from gate_g_ids where k='authority')
from authz.roles r
where r.key in ('senior_case_worker', 'decision_maker');

-- Versioned workflow data drives canonical case state/phase.
insert into workflow.workflow_templates (authority_id, key, name, process_type)
values (
  (select v from gate_g_ids where k='authority'),
  'gate_g_bygglov',
  'Gate G syntetiskt bygglov',
  'BYGGLOV'
);

insert into workflow.workflow_template_versions (
  template_id, authority_id, version, definition, published_at
)
select
  t.id,
  t.authority_id,
  1,
  '{
    "initial":"INKOMMEN",
    "states":{
      "INKOMMEN":{
        "case_status":"REGISTERED",
        "case_phase":"INTAKE",
        "to":["GRANSKNING"],
        "tasks":[{"key":"registrera","title":"Registrera ansökan"}]
      },
      "GRANSKNING":{
        "case_status":"IN_REVIEW",
        "case_phase":"REVIEW",
        "to":["BESLUT"],
        "tasks":[{"key":"granska","title":"Granska komplett ärende"}]
      },
      "BESLUT":{
        "case_status":"AWAITING_DECISION",
        "case_phase":"DECISION",
        "to":["AVSLUTAD"],
        "tasks":[{"key":"beslut","title":"Fatta beslut"}]
      },
      "AVSLUTAD":{
        "case_status":"DECIDED",
        "case_phase":"DECISION",
        "to":[],
        "final":true
      }
    }
  }'::jsonb,
  now()
from workflow.workflow_templates t
where t.authority_id = (select v from gate_g_ids where k='authority')
  and t.key = 'gate_g_bygglov';

-- Static property reference data. Linking it to the case happens later via RPC.
insert into property.properties (authority_id, designation, municipality_code, source)
values (
  (select v from gate_g_ids where k='authority'),
  'GATE G 1:1',
  '0180',
  'LANTMATERIET'
);

insert into gate_g_ids
select 'property', p.id
from property.properties p
where p.authority_id = (select v from gate_g_ids where k='authority')
  and p.designation = 'GATE G 1:1';

-- Synthetic sourced completeness rules. They prove the rule/version/source
-- machinery; they do not pretend to be national law.
insert into rules.rule_sets (authority_id, key, name, domain)
values (
  (select v from gate_g_ids where k='authority'),
  'gate_g_building_permit_complete',
  'Gate G syntetisk kompletthetsprofil',
  'COMPLETENESS'
);

insert into gate_g_ids
select 'ruleset', rs.id
from rules.rule_sets rs
where rs.authority_id = (select v from gate_g_ids where k='authority')
  and rs.key = 'gate_g_building_permit_complete';

insert into rules.rule_set_versions (
  rule_set_id, version, valid_from, published_at
)
values (
  (select v from gate_g_ids where k='ruleset'),
  1,
  current_date,
  now()
);

insert into gate_g_ids
select 'rules_version', v.id
from rules.rule_set_versions v
where v.rule_set_id = (select v from gate_g_ids where k='ruleset')
  and v.version = 1;

insert into rules.rules (
  rule_set_version_id, key, name, severity, predicate, legal_reference
)
values
  (
    (select v from gate_g_ids where k='rules_version'),
    'applicant',
    'Sökande registrerad',
    'REQUIRED',
    '{"kind":"PARTY_RELATIONSHIP","value":"APPLICANT"}',
    'Gate G syntetiskt testbeslut'
  ),
  (
    (select v from gate_g_ids where k='rules_version'),
    'property',
    'Fastighet kopplad',
    'REQUIRED',
    '{"kind":"PROPERTY_LINK"}',
    'Gate G syntetiskt testbeslut'
  );

insert into rules.rule_sources (rule_id, source_type, reference)
select r.id, 'LOCAL_DECISION', 'Gate G syntetiskt testbeslut — endast CI'
from rules.rules r
where r.rule_set_version_id = (select v from gate_g_ids where k='rules_version');

create or replace function pg_temp.gate_g_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from gate_g_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.gate_g_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- ---------------------------------------------------------------------------
-- Operational flow — command boundaries only
-- ---------------------------------------------------------------------------

-- 1. Create atomically with the published workflow.
do $$
declare
  v_case uuid;
  v_instance uuid;
begin
  perform pg_temp.gate_g_set_subject('worker');

  select core.create_case_for_user(
    (select v from gate_g_ids where k='authority'),
    (select v from gate_g_ids where k='department'),
    'GATE-G-2026-0001',
    'BYGGLOV',
    'BYGGLOV',
    'Nybyggnad enbostadshus',
    'Komplett syntetiskt bygglov för Gate G.',
    'NORMAL',
    'gate_g_bygglov'
  ) into v_case;

  select i.id into v_instance
  from workflow.workflow_instances i
  where i.case_id = v_case;

  perform pg_temp.gate_g_clear_subject();

  insert into gate_g_ids values ('case', v_case), ('instance', v_instance);
end;
$$;

-- 2. Separate assignment permission: authority-scoped senior assigns worker.
do $$
begin
  perform pg_temp.gate_g_set_subject('decisionmaker');

  perform core.assign_case_for_user(
    (select v from gate_g_ids where k='case'),
    (select v from gate_g_ids where k='worker'),
    null,
    'Gate G: fördelas till ansvarig handläggare'
  );

  perform pg_temp.gate_g_clear_subject();
end;
$$;

-- 3. Add applicant and referral organization through G2 command boundary.
do $$
declare
  v_applicant_relation uuid;
  v_referral_relation uuid;
  v_applicant_party uuid;
  v_referral_party uuid;
begin
  perform pg_temp.gate_g_set_subject('worker');

  select core.add_case_party_for_user(
    (select v from gate_g_ids where k='case'),
    'PERSON',
    'Gate G Sökande',
    'APPLICANT',
    null,
    'gate-g-person-ref',
    'sokande@gate-g.invalid',
    '+46700000001'
  ) into v_applicant_relation;

  select core.add_case_party_for_user(
    (select v from gate_g_ids where k='case'),
    'ORGANIZATION',
    'Gate G Remissinstans',
    'OTHER',
    '559999-9999',
    null,
    'remiss@gate-g.invalid',
    '+46800000001'
  ) into v_referral_relation;

  select cp.party_id into v_applicant_party
  from core.case_parties cp where cp.id = v_applicant_relation;

  select cp.party_id into v_referral_party
  from core.case_parties cp where cp.id = v_referral_relation;

  perform pg_temp.gate_g_clear_subject();

  insert into gate_g_ids values
    ('applicant_relation', v_applicant_relation),
    ('applicant_party', v_applicant_party),
    ('referral_party', v_referral_party);
end;
$$;

-- 4. Link canonical property through G3 command boundary.
do $$
begin
  perform pg_temp.gate_g_set_subject('worker');

  perform core.link_property_to_case_for_user(
    (select v from gate_g_ids where k='case'),
    (select v from gate_g_ids where k='property'),
    true
  );

  perform pg_temp.gate_g_clear_subject();
end;
$$;

-- 5. Deterministic sourced completeness must now be COMPLETE.
do $$
declare
  v_assessment uuid;
begin
  perform pg_temp.gate_g_set_subject('worker');

  select rules.evaluate_case_completeness_for_user(
    (select v from gate_g_ids where k='case'),
    (select v from gate_g_ids where k='rules_version')
  ) into v_assessment;

  perform pg_temp.gate_g_clear_subject();

  insert into gate_g_ids values ('assessment', v_assessment);

  if not exists (
    select 1
    from rules.completeness_assessments a
    where a.id = v_assessment
      and a.result = 'COMPLETE'
      and a.superseded_at is null
      and jsonb_array_length(a.missing_items) = 0
  ) then
    raise exception 'Gate G completeness did not become COMPLETE';
  end if;
end;
$$;

-- 6. Enter review state.
do $$
begin
  perform pg_temp.gate_g_set_subject('worker');

  perform workflow.advance_case_for_user(
    (select v from gate_g_ids where k='instance'),
    'GRANSKNING',
    'Gate G: grunduppgifter, sökande och fastighet verifierade'
  );

  perform pg_temp.gate_g_clear_subject();
end;
$$;

-- 7. Create, send and answer one referral entirely through G7/worker commands.
do $$
declare
  v_referral uuid;
  v_recipient uuid;
  v_delivery uuid;
  v_response uuid;
begin
  perform pg_temp.gate_g_set_subject('worker');

  select referral.create_for_user(
    (select v from gate_g_ids where k='case'),
    'Gate G teknisk remiss',
    'Syntetisk remiss inför beslut.',
    now() + interval '14 days'
  ) into v_referral;

  select referral.add_recipient_for_user(
    v_referral,
    (select v from gate_g_ids where k='referral_party'),
    null,
    null
  ) into v_recipient;

  select referral.queue_delivery_for_user(v_recipient, 'EMAIL')
  into v_delivery;

  perform pg_temp.gate_g_clear_subject();

  -- Provider/worker acknowledgement is the supported transition to SENT.
  perform communication.worker_apply_delivery_event(
    v_delivery,
    'SENT',
    'gate-g-provider-001',
    null
  );

  perform pg_temp.gate_g_set_subject('worker');

  select referral.record_response_for_user(
    v_recipient,
    'Ingen erinran i Gate G.',
    'NO_OBJECTION',
    null
  ) into v_response;

  perform pg_temp.gate_g_clear_subject();

  insert into gate_g_ids values
    ('referral', v_referral),
    ('referral_recipient', v_recipient),
    ('referral_delivery', v_delivery),
    ('referral_response', v_response);
end;
$$;

-- 8. Review complete; enter decision state.
do $$
begin
  perform pg_temp.gate_g_set_subject('worker');

  perform workflow.advance_case_for_user(
    (select v from gate_g_ids where k='instance'),
    'BESLUT',
    'Gate G: kompletthet klar och remiss besvarad'
  );

  perform pg_temp.gate_g_clear_subject();
end;
$$;

-- 9. Caseworker prepares a human draft and submits it for review.
do $$
declare
  v_decision uuid;
  v_version uuid;
begin
  perform pg_temp.gate_g_set_subject('worker');

  select decision.create_for_user(
    (select v from gate_g_ids where k='case'),
    'BYGGLOV_BESLUT',
    'GATE-G-BESLUT-0001'
  ) into v_decision;

  select decision.add_version_for_user(
    v_decision,
    'Bygglov beviljas i det syntetiska Gate G-provet.',
    jsonb_build_array(jsonb_build_object('text', 'Syntetiskt villkor för CI')),
    jsonb_build_array(jsonb_build_object('reference', 'Gate G syntetisk referens')),
    'HUMAN'
  ) into v_version;

  perform decision.submit_review_for_user(v_decision);

  perform pg_temp.gate_g_clear_subject();

  insert into gate_g_ids values ('decision', v_decision), ('decision_version', v_version);
end;
$$;

-- 10. Only the authorized human decision-maker may approve and decide.
do $$
begin
  perform pg_temp.gate_g_set_subject('decisionmaker');

  perform decision.approve_for_user(
    (select v from gate_g_ids where k='decision')
  );

  perform decision.decide_for_user(
    (select v from gate_g_ids where k='decision'),
    'Gate G syntetisk delegationsordning § 1',
    now() + interval '21 days'
  );

  -- Final workflow projection to DECIDED also requires decision.approve.
  perform workflow.advance_case_for_user(
    (select v from gate_g_ids where k='instance'),
    'AVSLUTAD',
    'Gate G: behörigt mänskligt beslut registrerat'
  );

  perform pg_temp.gate_g_clear_subject();
end;
$$;

-- ---------------------------------------------------------------------------
-- Gate assertions
-- ---------------------------------------------------------------------------

do $$
declare
  v_audit integer;
begin
  if not exists (
    select 1
    from core.cases c
    join workflow.workflow_instances wi on wi.case_id = c.id
    where c.id = (select v from gate_g_ids where k='case')
      and c.case_number = 'GATE-G-2026-0001'
      and c.assigned_user_id = (select v from gate_g_ids where k='worker')
      and c.primary_property_id = (select v from gate_g_ids where k='property')
      and c.status = 'DECIDED'
      and c.phase = 'DECISION'
      and wi.id = (select v from gate_g_ids where k='instance')
      and wi.current_state = 'AVSLUTAD'
      and wi.status = 'COMPLETED'
  ) then
    raise exception 'Gate G canonical case/workflow final state is incomplete';
  end if;

  if not exists (
    select 1
    from core.case_parties cp
    where cp.id = (select v from gate_g_ids where k='applicant_relation')
      and cp.case_id = (select v from gate_g_ids where k='case')
      and cp.relationship = 'APPLICANT'
  ) then
    raise exception 'Gate G applicant relation is missing';
  end if;

  if not exists (
    select 1
    from rules.completeness_assessments a
    where a.id = (select v from gate_g_ids where k='assessment')
      and a.result = 'COMPLETE'
  ) then
    raise exception 'Gate G completeness evidence is not COMPLETE';
  end if;

  if not exists (
    select 1
    from referral.referrals r
    join referral.referral_responses rsp on rsp.referral_id = r.id
    where r.id = (select v from gate_g_ids where k='referral')
      and r.status = 'ANSWERED'
      and rsp.id = (select v from gate_g_ids where k='referral_response')
      and rsp.position = 'NO_OBJECTION'
  ) then
    raise exception 'Gate G referral was not completed';
  end if;

  if not exists (
    select 1
    from decision.decisions d
    where d.id = (select v from gate_g_ids where k='decision')
      and d.case_id = (select v from gate_g_ids where k='case')
      and d.status = 'DECIDED'
      and d.approved_by = (select v from gate_g_ids where k='decisionmaker')
      and d.decided_by = (select v from gate_g_ids where k='decisionmaker')
      and d.approved_at is not null
      and d.decided_at is not null
  ) then
    raise exception 'Gate G human decision state is incomplete';
  end if;

  select count(*) into v_audit
  from audit.events e
  where e.resource_id = (select v from gate_g_ids where k='case')
    and e.action in (
      'case.created',
      'case.assignment.changed',
      'case.party.added',
      'case.property.linked',
      'case.completeness.evaluated',
      'case.workflow.advanced',
      'case.referral.created',
      'case.referral.response_recorded',
      'case.decision.created',
      'case.decision.review_submitted',
      'case.decision.approved',
      'case.decision.decided'
    );

  if v_audit < 12 then
    raise exception 'Gate G audit chain incomplete, got % matching events', v_audit;
  end if;
end;
$$;

select 'GATE G BUILDING PERMIT (create -> complete -> referral -> human decision): GREEN'
  as result;

rollback;
