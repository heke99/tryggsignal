-- Tryggsignal Phase G7 — operational referrals/communications integration.
begin;

create temporary table g7_ids (k text primary key, v uuid) on commit drop;
grant select, insert on g7_ids to authenticated;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@g7-referral.invalid', 'authenticated', 'authenticated'
from unnest(array['worker', 'other_dep', 'other_auth']) as k;

insert into organization.legal_entities (name, organization_number)
values ('G7 Referral kommun', '212000-0976');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, x.key, x.name
from organization.legal_entities le
cross join (values
  ('g7_bygg', 'Byggnadsnämnden'),
  ('g7_miljo', 'Miljönämnden')
) x(key, name)
where le.organization_number = '212000-0976';

insert into organization.departments (authority_id, key, name)
select a.id, x.key, x.name
from organization.authorities a
cross join lateral (
  select * from (values ('bygglov', 'Bygglov'), ('plan', 'Plan')) d(key, name)
  where a.key = 'g7_bygg'
  union all
  select 'tillsyn', 'Tillsyn' where a.key = 'g7_miljo'
) x;

insert into identity.users (auth_user_id, display_name, email, user_type)
select au.id, split_part(au.email, '@', 1), au.email, 'STAFF'
from auth.users au
where au.email like '%@g7-referral.invalid';

insert into g7_ids
select split_part(u.email, '@', 1), u.id
from identity.users u where u.email like '%@g7-referral.invalid';
insert into g7_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u where u.email like '%@g7-referral.invalid';
insert into g7_ids
select 'auth_' || a.key, a.id from organization.authorities a where a.key like 'g7_%';
insert into g7_ids
select 'dep_' || d.key, d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key like 'g7_%';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  ((select v from g7_ids where k='worker'),
   (select v from g7_ids where k='auth_g7_bygg'),
   (select v from g7_ids where k='dep_bygglov'), true),
  ((select v from g7_ids where k='other_dep'),
   (select v from g7_ids where k='auth_g7_bygg'),
   (select v from g7_ids where k='dep_plan'), true),
  ((select v from g7_ids where k='other_auth'),
   (select v from g7_ids where k='auth_g7_miljo'),
   (select v from g7_ids where k='dep_tillsyn'), true);

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from g7_ids where k=u.user_key),
  r.id, 'DEPARTMENT',
  (select v from g7_ids where k=u.dep_key),
  (select v from g7_ids where k=u.auth_key),
  (select v from g7_ids where k=u.dep_key)
from (values
  ('worker', 'building_case_worker', 'dep_bygglov', 'auth_g7_bygg'),
  ('other_dep', 'building_case_worker', 'dep_plan', 'auth_g7_bygg'),
  ('other_auth', 'building_case_worker', 'dep_tillsyn', 'auth_g7_miljo')
) u(user_key, role_key, dep_key, auth_key)
join authz.roles r on r.key = u.role_key;

insert into core.cases (
  authority_id, department_id, case_number, case_type, process_type,
  title, status, information_class
)
values (
  (select v from g7_ids where k='auth_g7_bygg'),
  (select v from g7_ids where k='dep_bygglov'),
  'G7-0001', 'BYGGLOV', 'BYGGLOV', 'Remissärende', 'IN_REVIEW', 'INTERNAL'
);

insert into g7_ids
select 'case', id from core.cases where case_number = 'G7-0001';

insert into core.parties (
  authority_id, party_type, display_name, contact_email
)
values (
  (select v from g7_ids where k='auth_g7_bygg'),
  'ORGANIZATION',
  'G7 Remissinstans',
  'remissinstans@g7.invalid'
);
insert into g7_ids
select 'party', id from core.parties where display_name = 'G7 Remissinstans';

insert into core.case_parties (
  case_id, party_id, authority_id, relationship
)
values (
  (select v from g7_ids where k='case'),
  (select v from g7_ids where k='party'),
  (select v from g7_ids where k='auth_g7_bygg'),
  'OTHER'
);

create or replace function pg_temp.g7_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from g7_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.g7_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- Create + recipient + queue. Queueing must not claim SENT.
do $$
declare
  v_referral uuid;
  v_recipient uuid;
  v_delivery uuid;
  v_delivery_again uuid;
begin
  perform pg_temp.g7_set_subject('worker');

  select referral.create_for_user(
    (select v from g7_ids where k='case'),
    'Teknisk remiss',
    'Svara på den syntetiska remissen.',
    now() + interval '14 days'
  ) into v_referral;

  select referral.add_recipient_for_user(
    v_referral,
    (select v from g7_ids where k='party'),
    null,
    null
  ) into v_recipient;

  select referral.queue_delivery_for_user(v_recipient, 'EMAIL') into v_delivery;
  select referral.queue_delivery_for_user(v_recipient, 'EMAIL') into v_delivery_again;

  perform pg_temp.g7_clear_subject();

  if v_delivery <> v_delivery_again then
    raise exception 'Queueing the same recipient was not idempotent';
  end if;

  insert into g7_ids values
    ('referral_answered', v_referral),
    ('recipient_answered', v_recipient),
    ('delivery_answered', v_delivery);

  if not exists (
    select 1
    from referral.referrals r
    join referral.referral_recipients rr on rr.referral_id = r.id
    join communication.deliveries d on d.id = rr.delivery_id
    where r.id = v_referral
      and r.status = 'QUEUED'
      and r.sent_at is null
      and rr.status = 'QUEUED'
      and d.status = 'PENDING'
      and d.channel = 'EMAIL'
  ) then
    raise exception 'Queued referral falsely claimed sent or missed delivery state';
  end if;

  if not exists (
    select 1
    from pgmq.q_notifications q
    where q.message->>'type' = 'notification'
      and q.message->>'idempotency_key' = 'delivery:' || v_delivery::text
  ) then
    raise exception 'Referral delivery was not enqueued in durable notifications queue';
  end if;
end;
$$;

-- Provider/worker acknowledgement is the only transition to SENT.
select communication.worker_apply_delivery_event(
  (select v from g7_ids where k='delivery_answered'),
  'SENT',
  'provider-g7-001',
  null
);

do $$
begin
  if not exists (
    select 1
    from referral.referrals r
    join referral.referral_recipients rr on rr.referral_id = r.id
    join communication.deliveries d on d.id = rr.delivery_id
    where r.id = (select v from g7_ids where k='referral_answered')
      and r.status = 'SENT'
      and r.sent_at is not null
      and rr.status = 'SENT'
      and rr.sent_at is not null
      and d.status = 'SENT'
      and d.external_reference = 'provider-g7-001'
  ) then
    raise exception 'Provider acknowledgement did not produce SENT state';
  end if;
end;
$$;

-- Record response as the caseworker.
do $$
declare
  v_response uuid;
begin
  perform pg_temp.g7_set_subject('worker');

  select referral.record_response_for_user(
    (select v from g7_ids where k='recipient_answered'),
    'Ingen erinran i det syntetiska integrationsprovet.',
    'NO_OBJECTION',
    null
  ) into v_response;

  perform pg_temp.g7_clear_subject();

  if not exists (
    select 1
    from referral.referral_responses rsp
    join referral.referrals r on r.id = rsp.referral_id
    where rsp.id = v_response
      and rsp.position = 'NO_OBJECTION'
      and r.status = 'ANSWERED'
  ) then
    raise exception 'Referral response did not produce ANSWERED state';
  end if;
end;
$$;

-- A second referral exercises overdue + no-response + follow-up.
do $$
declare
  v_referral uuid;
  v_recipient uuid;
  v_delivery uuid;
begin
  perform pg_temp.g7_set_subject('worker');

  select referral.create_for_user(
    (select v from g7_ids where k='case'),
    'Remiss utan svar',
    'Detta prov ska bli overdue efter owner-adjusted test clock.',
    now() + interval '7 days'
  ) into v_referral;

  select referral.add_recipient_for_user(
    v_referral,
    (select v from g7_ids where k='party'),
    null,
    null
  ) into v_recipient;

  select referral.queue_delivery_for_user(v_recipient, 'EMAIL') into v_delivery;

  perform pg_temp.g7_clear_subject();

  insert into g7_ids values
    ('referral_overdue', v_referral),
    ('recipient_overdue', v_recipient),
    ('delivery_overdue', v_delivery);
end;
$$;

select communication.worker_apply_delivery_event(
  (select v from g7_ids where k='delivery_overdue'),
  'SENT',
  'provider-g7-002',
  null
);

update referral.referrals
set due_at = now() - interval '1 minute'
where id = (select v from g7_ids where k='referral_overdue');

select referral.sweep_overdue();

do $$
declare
  v_followup uuid;
begin
  if not exists (
    select 1
    from referral.referrals r
    join referral.referral_recipients rr on rr.referral_id = r.id
    where r.id = (select v from g7_ids where k='referral_overdue')
      and r.status = 'OVERDUE'
      and rr.status = 'NO_RESPONSE'
  ) then
    raise exception 'Overdue sweep did not mark no-response state';
  end if;

  perform pg_temp.g7_set_subject('worker');

  select referral.queue_followup_for_user(
    (select v from g7_ids where k='recipient_overdue'),
    'EMAIL'
  ) into v_followup;

  perform pg_temp.g7_clear_subject();

  if not exists (
    select 1
    from communication.deliveries d
    where d.id = v_followup
      and d.status = 'PENDING'
  ) then
    raise exception 'Follow-up delivery was not queued';
  end if;

  if not exists (
    select 1
    from referral.referral_recipients rr
    join referral.referrals r on r.id = rr.referral_id
    where rr.id = (select v from g7_ids where k='recipient_overdue')
      and rr.reminded_at is not null
      and r.last_followup_at is not null
  ) then
    raise exception 'Follow-up timestamps were not persisted';
  end if;
end;
$$;

-- Wrong department and wrong authority must not create/manage the case referral.
do $$
declare
  v_dep_blocked boolean := false;
  v_auth_blocked boolean := false;
begin
  perform pg_temp.g7_set_subject('other_dep');
  begin
    perform referral.create_for_user(
      (select v from g7_ids where k='case'),
      'Otillåten',
      null,
      now() + interval '2 days'
    );
  exception when no_data_found then
    v_dep_blocked := true;
  end;
  perform pg_temp.g7_clear_subject();

  perform pg_temp.g7_set_subject('other_auth');
  begin
    perform referral.add_recipient_for_user(
      (select v from g7_ids where k='referral_overdue'),
      null,
      'Otillåten organisation',
      'outside@g7.invalid'
    );
  exception when no_data_found then
    v_auth_blocked := true;
  end;
  perform pg_temp.g7_clear_subject();

  if not v_dep_blocked or not v_auth_blocked then
    raise exception 'G7 referral command crossed case scope';
  end if;
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events
  where resource_id = (select v from g7_ids where k='case')
    and action in (
      'case.referral.created',
      'case.referral.recipient_added',
      'case.referral.delivery_queued',
      'case.referral.response_recorded',
      'case.referral.followup_queued'
    );

  if v_count < 8 then
    raise exception 'G7 audit coverage incomplete, got %', v_count;
  end if;
end;
$$;

select 'G7 REFERRALS (create/queue/sent/response/overdue/followup/isolation): GREEN' as result;

rollback;
