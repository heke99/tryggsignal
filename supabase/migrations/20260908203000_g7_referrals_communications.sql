-- Tryggsignal Phase G7 — operational referrals and communications.
-- Sending is provider-neutral: QUEUED is not SENT. External provider activation
-- remains EB-09 until the notification worker has a contracted adapter.

insert into authz.permissions (key, description) values
  ('referral.manage', 'Create and manage case referrals and responses'),
  ('communication.send', 'Queue case communication for external delivery')
on conflict (key) do nothing;

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('building_case_worker', 'referral.manage'),
  ('building_case_worker', 'communication.send'),
  ('senior_case_worker', 'referral.manage'),
  ('senior_case_worker', 'communication.send'),
  ('registrar', 'communication.send')
) as x(role_key, permission_key)
join authz.roles r on r.key = x.role_key
join authz.permissions p on p.key = x.permission_key
on conflict do nothing;

alter table referral.referrals
  add column communication_message_id uuid references communication.messages (id) on delete set null,
  add column queued_at timestamptz,
  add column last_followup_at timestamptz;

alter table referral.referrals
  drop constraint referrals_status_check;

alter table referral.referrals
  add constraint referrals_status_check
  check (status in (
    'DRAFT', 'QUEUED', 'SENT', 'PARTIALLY_ANSWERED', 'ANSWERED', 'OVERDUE', 'CLOSED'
  ));

alter table referral.referral_recipients
  add column delivery_id uuid references communication.deliveries (id) on delete set null;

alter table referral.referral_recipients
  drop constraint referral_recipients_status_check;

alter table referral.referral_recipients
  add constraint referral_recipients_status_check
  check (status in ('PENDING', 'QUEUED', 'SENT', 'ANSWERED', 'DECLINED', 'NO_RESPONSE'));

alter table referral.referral_responses
  add column recorded_by uuid references identity.users (id);

create index referral_recipients_delivery_idx
  on referral.referral_recipients (delivery_id)
  where delivery_id is not null;

insert into config.scheduled_tasks (key, description, schedule)
values (
  'referral_overdue_sweep',
  'Mark sent referrals overdue and recipients without responses as no-response',
  '*/15 * * * *'
)
on conflict (key) do nothing;

create or replace function referral.case_resource(p_case core.cases)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'authority_id', p_case.authority_id,
    'department_id', p_case.department_id,
    'assigned_user_id', p_case.assigned_user_id,
    'assigned_team_id', p_case.assigned_team_id,
    'information_class', p_case.information_class
  )
$$;

revoke all on function referral.case_resource(core.cases) from public;

create or replace function referral.recompute_status(p_referral_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referral referral.referrals%rowtype;
  v_total integer;
  v_answered integer;
  v_active integer;
  v_status text;
begin
  select * into v_referral
  from referral.referrals r
  where r.id = p_referral_id
  for update;

  if not found then
    raise exception 'Unknown referral %', p_referral_id using errcode = 'no_data_found';
  end if;

  select
    count(*),
    count(*) filter (where status in ('ANSWERED', 'DECLINED')),
    count(*) filter (where status in ('QUEUED', 'SENT', 'NO_RESPONSE'))
  into v_total, v_answered, v_active
  from referral.referral_recipients rr
  where rr.referral_id = p_referral_id;

  if v_referral.status = 'CLOSED' then
    v_status := 'CLOSED';
  elsif v_total > 0 and v_answered = v_total then
    v_status := 'ANSWERED';
  elsif v_answered > 0 then
    v_status := 'PARTIALLY_ANSWERED';
  elsif v_referral.sent_at is not null and v_referral.due_at < now() then
    v_status := 'OVERDUE';
  elsif v_referral.sent_at is not null then
    v_status := 'SENT';
  elsif v_active > 0 or v_referral.queued_at is not null then
    v_status := 'QUEUED';
  else
    v_status := 'DRAFT';
  end if;

  update referral.referrals
  set status = v_status
  where id = p_referral_id;

  return v_status;
end;
$$;

revoke all on function referral.recompute_status(uuid) from public;
revoke all on function referral.recompute_status(uuid) from anon, authenticated;

create or replace function referral.create_for_user(
  p_case_id uuid,
  p_subject text,
  p_description text,
  p_due_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_id uuid;
  v_subject text := trim(coalesce(p_subject, ''));
begin
  if length(v_subject) < 2 or length(v_subject) > 300 then
    raise exception 'Referral subject must contain 2-300 characters'
      using errcode = 'check_violation';
  end if;
  if p_due_at is null or p_due_at <= now() then
    raise exception 'Referral due_at must be in the future'
      using errcode = 'check_violation';
  end if;
  if length(coalesce(p_description, '')) > 10000 then
    raise exception 'Referral description is too long'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('referral.manage', referral.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  insert into referral.referrals (
    authority_id, case_id, subject, description, due_at, created_by
  )
  values (
    v_case.authority_id, v_case.id, v_subject,
    nullif(trim(coalesce(p_description, '')), ''),
    p_due_at, (select authz.current_user_id())
  )
  returning id into v_id;

  perform audit.record(
    'case.referral.created', 'case', v_case.id, v_case.authority_id,
    format('Referral %s created with due_at %s', v_id, p_due_at)
  );

  return v_id;
end;
$$;

revoke all on function referral.create_for_user(uuid, text, text, timestamptz) from public;
revoke all on function referral.create_for_user(uuid, text, text, timestamptz) from anon;
grant execute on function referral.create_for_user(uuid, text, text, timestamptz) to authenticated;

create or replace function referral.add_recipient_for_user(
  p_referral_id uuid,
  p_party_id uuid default null,
  p_organization_name text default null,
  p_contact_address text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_referral referral.referrals%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_id uuid;
  v_org text := nullif(trim(coalesce(p_organization_name, '')), '');
  v_address text := nullif(trim(coalesce(p_contact_address, '')), '');
begin
  select * into v_referral from referral.referrals r where r.id = p_referral_id;
  if not found then
    raise exception 'Referral is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_referral.case_id;
  v_authz := authz.can('referral.manage', referral.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Referral is unavailable' using errcode = 'no_data_found';
  end if;

  if v_referral.status not in ('DRAFT', 'QUEUED') or v_referral.sent_at is not null then
    raise exception 'Recipients cannot be added after the referral was sent'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if p_party_id is not null then
    if not exists (
      select 1
      from core.case_parties cp
      where cp.case_id = v_case.id
        and cp.party_id = p_party_id
    ) then
      raise exception 'Recipient party is unavailable' using errcode = 'no_data_found';
    end if;
  elsif v_org is null or v_address is null then
    raise exception 'An external recipient requires organization name and contact address'
      using errcode = 'check_violation';
  end if;

  if v_org is not null and length(v_org) > 300 then
    raise exception 'Organization name is too long' using errcode = 'check_violation';
  end if;
  if v_address is not null and length(v_address) > 500 then
    raise exception 'Contact address is too long' using errcode = 'check_violation';
  end if;

  insert into referral.referral_recipients (
    referral_id, authority_id, party_id, organization_name, contact_address
  )
  values (
    v_referral.id, v_referral.authority_id, p_party_id, v_org, v_address
  )
  returning id into v_id;

  perform audit.record(
    'case.referral.recipient_added', 'case', v_case.id, v_case.authority_id,
    format('Recipient %s added to referral %s', v_id, v_referral.id)
  );

  return v_id;
end;
$$;

revoke all on function referral.add_recipient_for_user(uuid, uuid, text, text) from public;
revoke all on function referral.add_recipient_for_user(uuid, uuid, text, text) from anon;
grant execute on function referral.add_recipient_for_user(uuid, uuid, text, text) to authenticated;

create or replace function referral.queue_delivery_for_user(
  p_recipient_id uuid,
  p_channel text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient referral.referral_recipients%rowtype;
  v_referral referral.referrals%rowtype;
  v_case core.cases%rowtype;
  v_party core.parties%rowtype;
  v_authz jsonb;
  v_message_id uuid;
  v_delivery_id uuid;
  v_channel text := upper(trim(coalesce(p_channel, '')));
  v_address text;
  v_correlation uuid := extensions.gen_random_uuid();
begin
  if v_channel not in ('EMAIL', 'DIGITAL_POST', 'SMS', 'PORTAL', 'API', 'PHYSICAL_POST') then
    raise exception 'Unsupported communication channel %', v_channel
      using errcode = 'check_violation';
  end if;

  select * into v_recipient
  from referral.referral_recipients rr
  where rr.id = p_recipient_id
  for update;

  if not found then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_referral from referral.referrals r where r.id = v_recipient.referral_id for update;
  select * into v_case from core.cases c where c.id = v_referral.case_id;

  v_authz := authz.can('communication.send', referral.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  if v_recipient.status not in ('PENDING', 'QUEUED') then
    raise exception 'Recipient is not queueable in status %', v_recipient.status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_recipient.delivery_id is not null then
    return v_recipient.delivery_id;
  end if;

  v_address := v_recipient.contact_address;
  if v_recipient.party_id is not null then
    select * into v_party from core.parties p where p.id = v_recipient.party_id;
    if v_channel = 'EMAIL' then
      v_address := coalesce(v_address, v_party.contact_email);
    elsif v_channel = 'SMS' then
      v_address := coalesce(v_address, v_party.contact_phone);
    end if;
  end if;

  if v_channel not in ('PORTAL', 'API') and nullif(trim(coalesce(v_address, '')), '') is null then
    raise exception 'Recipient has no address for channel %', v_channel
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_message_id := v_referral.communication_message_id;
  if v_message_id is null then
    insert into communication.messages (
      authority_id, case_id, direction, subject, body, information_class,
      created_by, correlation_id
    )
    values (
      v_case.authority_id, v_case.id, 'OUTBOUND', v_referral.subject,
      v_referral.description, v_case.information_class,
      (select authz.current_user_id()), v_correlation
    )
    returning id into v_message_id;

    update referral.referrals
    set communication_message_id = v_message_id
    where id = v_referral.id;
  end if;

  insert into communication.deliveries (
    message_id, authority_id, channel, recipient_party_id, recipient_address,
    correlation_id, status
  )
  values (
    v_message_id, v_case.authority_id, v_channel, v_recipient.party_id,
    nullif(trim(coalesce(v_address, '')), ''), v_correlation, 'PENDING'
  )
  returning id into v_delivery_id;

  update referral.referral_recipients
  set delivery_id = v_delivery_id,
      status = 'QUEUED'
  where id = v_recipient.id;

  update referral.referrals
  set queued_at = coalesce(queued_at, now()),
      status = case when sent_at is null then 'QUEUED' else status end
  where id = v_referral.id;

  perform config.enqueue_job(
    'notifications',
    'notification',
    v_case.id::text,
    v_case.authority_id,
    'delivery:' || v_delivery_id::text,
    jsonb_build_object('delivery_id', v_delivery_id),
    v_correlation
  );

  perform audit.record(
    'case.referral.delivery_queued', 'case', v_case.id, v_case.authority_id,
    format('Delivery %s queued for referral %s recipient %s via %s',
      v_delivery_id, v_referral.id, v_recipient.id, v_channel)
  );

  return v_delivery_id;
end;
$$;

revoke all on function referral.queue_delivery_for_user(uuid, text) from public;
revoke all on function referral.queue_delivery_for_user(uuid, text) from anon;
grant execute on function referral.queue_delivery_for_user(uuid, text) to authenticated;

create or replace function communication.worker_apply_delivery_event(
  p_delivery_id uuid,
  p_event_type text,
  p_external_reference text default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery communication.deliveries%rowtype;
  v_recipient referral.referral_recipients%rowtype;
  v_referral_id uuid;
  v_event text := upper(trim(coalesce(p_event_type, '')));
begin
  select * into v_delivery
  from communication.deliveries d
  where d.id = p_delivery_id
  for update;

  if not found then
    raise exception 'Unknown delivery %', p_delivery_id using errcode = 'no_data_found';
  end if;

  if v_event not in ('SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED') then
    raise exception 'Unsupported delivery event %', v_event using errcode = 'check_violation';
  end if;

  insert into communication.delivery_events (delivery_id, event_type, detail)
  values (
    v_delivery.id,
    v_event,
    jsonb_build_object(
      'external_reference', nullif(trim(coalesce(p_external_reference, '')), ''),
      'reason', nullif(trim(coalesce(p_reason, '')), '')
    )
  );

  update communication.deliveries
  set status = v_event,
      attempt = attempt + 1,
      external_reference = coalesce(
        nullif(trim(coalesce(p_external_reference, '')), ''),
        external_reference
      ),
      sent_at = case when v_event in ('SENT', 'DELIVERED', 'READ')
        then coalesce(sent_at, now()) else sent_at end,
      delivered_at = case when v_event in ('DELIVERED', 'READ')
        then coalesce(delivered_at, now()) else delivered_at end,
      failed_reason = case when v_event in ('FAILED', 'BOUNCED')
        then nullif(left(trim(coalesce(p_reason, '')), 2000), '') else null end
  where id = v_delivery.id;

  select * into v_recipient
  from referral.referral_recipients rr
  where rr.delivery_id = v_delivery.id
  for update;

  if found then
    v_referral_id := v_recipient.referral_id;

    if v_event in ('SENT', 'DELIVERED', 'READ') then
      update referral.referral_recipients
      set status = case when status = 'ANSWERED' then status else 'SENT' end,
          sent_at = coalesce(sent_at, now())
      where id = v_recipient.id;

      update referral.referrals
      set sent_at = coalesce(sent_at, now())
      where id = v_referral_id;

      perform referral.recompute_status(v_referral_id);
    end if;
  end if;
end;
$$;

revoke all on function communication.worker_apply_delivery_event(uuid, text, text, text) from public;
revoke all on function communication.worker_apply_delivery_event(uuid, text, text, text)
  from anon, authenticated;

create or replace function referral.record_response_for_user(
  p_recipient_id uuid,
  p_response_text text,
  p_position text,
  p_document_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient referral.referral_recipients%rowtype;
  v_referral referral.referrals%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_position text := upper(trim(coalesce(p_position, '')));
  v_text text := nullif(trim(coalesce(p_response_text, '')), '');
  v_id uuid;
begin
  if v_position not in ('NO_OBJECTION', 'OBJECTION', 'CONDITIONAL', 'NO_OPINION') then
    raise exception 'Unsupported referral response position'
      using errcode = 'check_violation';
  end if;
  if v_text is not null and length(v_text) > 20000 then
    raise exception 'Referral response is too long' using errcode = 'check_violation';
  end if;
  if v_text is null and p_document_id is null then
    raise exception 'A referral response requires text or a document'
      using errcode = 'check_violation';
  end if;

  select * into v_recipient
  from referral.referral_recipients rr
  where rr.id = p_recipient_id
  for update;

  if not found then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_referral from referral.referrals r where r.id = v_recipient.referral_id;
  select * into v_case from core.cases c where c.id = v_referral.case_id;
  v_authz := authz.can('referral.manage', referral.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  if p_document_id is not null and not exists (
    select 1
    from documents.documents d
    join documents.document_versions dv
      on dv.document_id = d.id
     and dv.version = d.current_version
    where d.id = p_document_id
      and d.case_id = v_case.id
      and dv.ingestion_status = 'CLEAN'
  ) then
    raise exception 'Response document is unavailable' using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from referral.referral_responses rr
    where rr.recipient_id = v_recipient.id
  ) then
    raise exception 'Recipient already has a recorded response'
      using errcode = 'unique_violation';
  end if;

  insert into referral.referral_responses (
    referral_id, recipient_id, authority_id, document_id,
    response_text, position, recorded_by
  )
  values (
    v_referral.id, v_recipient.id, v_case.authority_id, p_document_id,
    v_text, v_position, (select authz.current_user_id())
  )
  returning id into v_id;

  update referral.referral_recipients
  set status = 'ANSWERED'
  where id = v_recipient.id;

  perform referral.recompute_status(v_referral.id);

  perform audit.record(
    'case.referral.response_recorded', 'case', v_case.id, v_case.authority_id,
    format('Response %s recorded for referral %s recipient %s with position %s',
      v_id, v_referral.id, v_recipient.id, v_position)
  );

  return v_id;
end;
$$;

revoke all on function referral.record_response_for_user(uuid, text, text, uuid) from public;
revoke all on function referral.record_response_for_user(uuid, text, text, uuid) from anon;
grant execute on function referral.record_response_for_user(uuid, text, text, uuid) to authenticated;

create or replace function referral.queue_followup_for_user(
  p_recipient_id uuid,
  p_channel text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient referral.referral_recipients%rowtype;
  v_referral referral.referrals%rowtype;
  v_case core.cases%rowtype;
  v_party core.parties%rowtype;
  v_authz jsonb;
  v_channel text := upper(trim(coalesce(p_channel, '')));
  v_address text;
  v_message_id uuid;
  v_delivery_id uuid;
  v_correlation uuid := extensions.gen_random_uuid();
begin
  select * into v_recipient
  from referral.referral_recipients rr
  where rr.id = p_recipient_id
  for update;
  if not found then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_referral from referral.referrals r where r.id = v_recipient.referral_id for update;
  select * into v_case from core.cases c where c.id = v_referral.case_id;
  v_authz := authz.can('communication.send', referral.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Referral recipient is unavailable' using errcode = 'no_data_found';
  end if;

  if v_recipient.status not in ('SENT', 'NO_RESPONSE') then
    raise exception 'Follow-up requires a sent recipient without an answer'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_channel not in ('EMAIL', 'DIGITAL_POST', 'SMS', 'PORTAL', 'API', 'PHYSICAL_POST') then
    raise exception 'Unsupported communication channel %', v_channel
      using errcode = 'check_violation';
  end if;

  v_address := v_recipient.contact_address;
  if v_recipient.party_id is not null then
    select * into v_party from core.parties p where p.id = v_recipient.party_id;
    if v_channel = 'EMAIL' then
      v_address := coalesce(v_address, v_party.contact_email);
    elsif v_channel = 'SMS' then
      v_address := coalesce(v_address, v_party.contact_phone);
    end if;
  end if;

  if v_channel not in ('PORTAL', 'API') and nullif(trim(coalesce(v_address, '')), '') is null then
    raise exception 'Recipient has no address for channel %', v_channel
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into communication.messages (
    authority_id, case_id, direction, subject, body, information_class,
    created_by, correlation_id
  )
  values (
    v_case.authority_id, v_case.id, 'OUTBOUND',
    'Påminnelse: ' || v_referral.subject,
    v_referral.description, v_case.information_class,
    (select authz.current_user_id()), v_correlation
  )
  returning id into v_message_id;

  insert into communication.deliveries (
    message_id, authority_id, channel, recipient_party_id, recipient_address,
    correlation_id, status
  )
  values (
    v_message_id, v_case.authority_id, v_channel, v_recipient.party_id,
    nullif(trim(coalesce(v_address, '')), ''), v_correlation, 'PENDING'
  )
  returning id into v_delivery_id;

  update referral.referral_recipients
  set reminded_at = now()
  where id = v_recipient.id;

  update referral.referrals
  set last_followup_at = now()
  where id = v_referral.id;

  perform config.enqueue_job(
    'notifications',
    'notification',
    v_case.id::text,
    v_case.authority_id,
    'referral-followup:' || v_delivery_id::text,
    jsonb_build_object(
      'delivery_id', v_delivery_id,
      'referral_id', v_referral.id,
      'followup', true
    ),
    v_correlation
  );

  perform audit.record(
    'case.referral.followup_queued', 'case', v_case.id, v_case.authority_id,
    format('Follow-up delivery %s queued for referral %s recipient %s',
      v_delivery_id, v_referral.id, v_recipient.id)
  );

  return v_delivery_id;
end;
$$;

revoke all on function referral.queue_followup_for_user(uuid, text) from public;
revoke all on function referral.queue_followup_for_user(uuid, text) from anon;
grant execute on function referral.queue_followup_for_user(uuid, text) to authenticated;

create or replace function referral.sweep_overdue()
returns integer
language plpgsql
security definer
set search_path = ''
as $
declare
  v_count integer := 0;
  v_referral record;
begin
  for v_referral in
    update referral.referrals r
    set status = 'OVERDUE'
    where r.sent_at is not null
      and r.due_at < now()
      and r.status in ('SENT', 'PARTIALLY_ANSWERED')
    returning r.id, r.case_id, r.authority_id
  loop
    v_count := v_count + 1;

    update referral.referral_recipients rr
    set status = 'NO_RESPONSE'
    where rr.referral_id = v_referral.id
      and rr.status = 'SENT';

    perform audit.record(
      'case.referral.overdue',
      'case',
      v_referral.case_id,
      v_referral.authority_id,
      format('Referral %s passed its due_at without all responses', v_referral.id)
    );
  end loop;

  update config.scheduled_tasks
  set last_run_at = now(),
      last_result = format('%s referral(s) marked overdue', v_count)
  where key = 'referral_overdue_sweep';

  return v_count;
end;
$;

revoke all on function referral.sweep_overdue() from public;
revoke all on function referral.sweep_overdue() from anon, authenticated;
