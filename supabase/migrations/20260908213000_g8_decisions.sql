-- Tryggsignal Phase G8 — operational decision lifecycle.
-- Draft/version/review/approve/decide/sign/issue are deliberately separate.
-- A final decision always records an accountable authenticated human.

alter table decision.decisions
  add column approved_by uuid references identity.users (id),
  add column approved_at timestamptz,
  add column signed_at timestamptz,
  add column issued_at timestamptz;

create table decision.signatures (
  id uuid primary key default extensions.gen_random_uuid(),
  decision_id uuid not null references decision.decisions (id) on delete cascade,
  decision_version_id uuid not null references decision.decision_versions (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  signed_by uuid not null references identity.users (id) on delete restrict,
  signed_at timestamptz not null default now(),
  method text not null check (method in (
    'MANUAL_ATTESTATION', 'BANKID', 'QUALIFIED_ELECTRONIC', 'OTHER'
  )),
  provider_reference text,
  evidence jsonb not null default '{}'::jsonb,
  unique (decision_id)
);

create table decision.issuances (
  id uuid primary key default extensions.gen_random_uuid(),
  decision_id uuid not null references decision.decisions (id) on delete cascade,
  decision_version_id uuid not null references decision.decision_versions (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  recipient_party_id uuid not null references core.parties (id) on delete restrict,
  message_id uuid not null references communication.messages (id) on delete restrict,
  delivery_id uuid not null references communication.deliveries (id) on delete restrict,
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'CANCELLED')),
  queued_at timestamptz not null default now(),
  issued_at timestamptz,
  created_by uuid not null references identity.users (id) on delete restrict,
  unique (decision_id, recipient_party_id)
);

create index decision_signatures_authority_idx
  on decision.signatures (authority_id, signed_at desc);
create index decision_issuances_decision_idx
  on decision.issuances (decision_id, queued_at desc);
create index decision_issuances_delivery_idx
  on decision.issuances (delivery_id);

alter table decision.signatures enable row level security;
alter table decision.issuances enable row level security;

grant select on decision.signatures, decision.issuances to authenticated;

create policy decision_signatures_select on decision.signatures
  for select to authenticated
  using (
    exists (
      select 1
      from decision.decisions d
      where d.id = signatures.decision_id
    )
  );

create policy decision_issuances_select on decision.issuances
  for select to authenticated
  using (
    exists (
      select 1
      from decision.decisions d
      where d.id = issuances.decision_id
    )
  );

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('decision_maker', 'communication.send'),
  ('senior_case_worker', 'decision.approve')
) as x(role_key, permission_key)
join authz.roles r on r.key = x.role_key
join authz.permissions p on p.key = x.permission_key
on conflict do nothing;

create or replace function decision.case_resource(p_case core.cases)
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

revoke all on function decision.case_resource(core.cases) from public;

create or replace function decision.create_for_user(
  p_case_id uuid,
  p_decision_type text,
  p_decision_number text default null
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
  v_type text := trim(coalesce(p_decision_type, ''));
  v_number text := nullif(trim(coalesce(p_decision_number, '')), '');
begin
  if length(v_type) < 2 or length(v_type) > 120 then
    raise exception 'Decision type must contain 2-120 characters'
      using errcode = 'check_violation';
  end if;
  if v_number is not null and length(v_number) > 120 then
    raise exception 'Decision number is too long'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('decision.prepare', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  insert into decision.decisions (
    authority_id, case_id, decision_type, decision_number, status
  )
  values (
    v_case.authority_id, v_case.id, v_type, v_number, 'DRAFT'
  )
  returning id into v_id;

  perform audit.record(
    'case.decision.created', 'case', v_case.id, v_case.authority_id,
    format('Decision %s created as DRAFT', v_id)
  );

  return v_id;
end;
$$;

revoke all on function decision.create_for_user(uuid, text, text) from public;
revoke all on function decision.create_for_user(uuid, text, text) from anon;
grant execute on function decision.create_for_user(uuid, text, text) to authenticated;

create or replace function decision.add_version_for_user(
  p_decision_id uuid,
  p_body text,
  p_conditions jsonb default '[]'::jsonb,
  p_legal_references jsonb default '[]'::jsonb,
  p_generated_by text default 'HUMAN'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_version integer;
  v_id uuid;
  v_generated text := upper(trim(coalesce(p_generated_by, 'HUMAN')));
begin
  if length(trim(coalesce(p_body, ''))) < 3 or length(p_body) > 100000 then
    raise exception 'Decision body must contain 3-100000 characters'
      using errcode = 'check_violation';
  end if;
  if v_generated not in ('HUMAN', 'AI_DRAFT', 'TEMPLATE') then
    raise exception 'Unsupported generated_by value'
      using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_conditions, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_legal_references, '[]'::jsonb)) <> 'array' then
    raise exception 'Conditions and legal references must be arrays'
      using errcode = 'check_violation';
  end if;

  select * into v_decision
  from decision.decisions d
  where d.id = p_decision_id
  for update;

  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('decision.prepare', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;

  if v_decision.status not in ('DRAFT', 'REVIEW') then
    raise exception 'A decided or approved decision is immutable'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if v_decision.status = 'REVIEW' then
    update decision.decisions
    set status = 'DRAFT', approved_by = null, approved_at = null
    where id = v_decision.id;

    perform audit.record(
      'case.decision.review_withdrawn', 'case', v_case.id, v_case.authority_id,
      format('Decision %s returned to DRAFT because a new version was created', v_decision.id)
    );
  end if;

  v_version := v_decision.current_version + 1;

  insert into decision.decision_versions (
    decision_id, authority_id, version, body, conditions, legal_references,
    generated_by, created_by
  )
  values (
    v_decision.id, v_case.authority_id, v_version, trim(p_body),
    coalesce(p_conditions, '[]'::jsonb),
    coalesce(p_legal_references, '[]'::jsonb),
    v_generated, (select authz.current_user_id())
  )
  returning id into v_id;

  update decision.decisions
  set current_version = v_version
  where id = v_decision.id;

  perform audit.record(
    'case.decision.version_created', 'case', v_case.id, v_case.authority_id,
    format('Decision %s version %s created by %s', v_decision.id, v_version, v_generated)
  );

  return v_id;
end;
$$;

revoke all on function decision.add_version_for_user(uuid, text, jsonb, jsonb, text) from public;
revoke all on function decision.add_version_for_user(uuid, text, jsonb, jsonb, text) from anon;
grant execute on function decision.add_version_for_user(uuid, text, jsonb, jsonb, text) to authenticated;

create or replace function decision.submit_review_for_user(p_decision_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
begin
  select * into v_decision from decision.decisions d where d.id = p_decision_id for update;
  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('decision.prepare', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  if v_decision.status <> 'DRAFT' or v_decision.current_version < 1 then
    raise exception 'Only a versioned DRAFT can enter review'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update decision.decisions set status = 'REVIEW' where id = v_decision.id;
  perform audit.record(
    'case.decision.review_submitted', 'case', v_case.id, v_case.authority_id,
    format('Decision %s submitted for review', v_decision.id)
  );
end;
$$;

revoke all on function decision.submit_review_for_user(uuid) from public;
revoke all on function decision.submit_review_for_user(uuid) from anon;
grant execute on function decision.submit_review_for_user(uuid) to authenticated;

create or replace function decision.approve_for_user(p_decision_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
begin
  select * into v_decision from decision.decisions d where d.id = p_decision_id for update;
  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('decision.approve', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  if v_decision.status <> 'REVIEW' or v_decision.current_version < 1 then
    raise exception 'Only a reviewed decision can be approved'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update decision.decisions
  set status = 'APPROVED', approved_by = v_actor, approved_at = now()
  where id = v_decision.id;

  perform audit.record(
    'case.decision.approved', 'case', v_case.id, v_case.authority_id,
    format('Decision %s approved by human %s', v_decision.id, v_actor)
  );
end;
$$;

revoke all on function decision.approve_for_user(uuid) from public;
revoke all on function decision.approve_for_user(uuid) from anon;
grant execute on function decision.approve_for_user(uuid) to authenticated;

create or replace function decision.decide_for_user(
  p_decision_id uuid,
  p_delegation_reference text,
  p_appeal_deadline_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_delegation text := nullif(trim(coalesce(p_delegation_reference, '')), '');
begin
  select * into v_decision from decision.decisions d where d.id = p_decision_id for update;
  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('decision.approve', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  if v_decision.status <> 'APPROVED' then
    raise exception 'Only an approved decision can be decided'
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if v_delegation is null or length(v_delegation) > 500 then
    raise exception 'A human decision requires a delegation/authority reference'
      using errcode = 'check_violation';
  end if;
  if p_appeal_deadline_at is not null and p_appeal_deadline_at <= now() then
    raise exception 'Appeal deadline must be in the future'
      using errcode = 'check_violation';
  end if;

  update decision.decisions
  set status = 'DECIDED',
      decided_by = v_actor,
      decided_at = now(),
      delegation_reference = v_delegation,
      appeal_deadline_at = p_appeal_deadline_at
  where id = v_decision.id;

  perform audit.record(
    'case.decision.decided', 'case', v_case.id, v_case.authority_id,
    format('Decision %s decided by accountable human %s', v_decision.id, v_actor)
  );
end;
$$;

revoke all on function decision.decide_for_user(uuid, text, timestamptz) from public;
revoke all on function decision.decide_for_user(uuid, text, timestamptz) from anon;
grant execute on function decision.decide_for_user(uuid, text, timestamptz) to authenticated;

create or replace function decision.sign_for_user(
  p_decision_id uuid,
  p_method text,
  p_provider_reference text default null,
  p_evidence jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_version_id uuid;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_method text := upper(trim(coalesce(p_method, '')));
  v_reference text := nullif(trim(coalesce(p_provider_reference, '')), '');
  v_id uuid;
begin
  if v_method not in ('MANUAL_ATTESTATION', 'BANKID', 'QUALIFIED_ELECTRONIC', 'OTHER') then
    raise exception 'Unsupported signature method' using errcode = 'check_violation';
  end if;
  if v_method <> 'MANUAL_ATTESTATION' and v_reference is null then
    raise exception 'External signature methods require a provider reference'
      using errcode = 'check_violation';
  end if;

  select * into v_decision from decision.decisions d where d.id = p_decision_id for update;
  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('decision.approve', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  if v_decision.status <> 'DECIDED' or v_decision.decided_by is null then
    raise exception 'Only a final human decision can be signed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select dv.id into v_version_id
  from decision.decision_versions dv
  where dv.decision_id = v_decision.id
    and dv.version = v_decision.current_version;

  if v_version_id is null then
    raise exception 'Decision has no current version'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into decision.signatures (
    decision_id, decision_version_id, authority_id, signed_by,
    method, provider_reference, evidence
  )
  values (
    v_decision.id, v_version_id, v_case.authority_id, v_actor,
    v_method, v_reference, coalesce(p_evidence, '{}'::jsonb)
  )
  returning id into v_id;

  update decision.decisions set signed_at = now() where id = v_decision.id;

  perform audit.record(
    'case.decision.signed', 'case', v_case.id, v_case.authority_id,
    format('Decision %s signature %s recorded by human %s using %s',
      v_decision.id, v_id, v_actor, v_method)
  );

  return v_id;
end;
$$;

revoke all on function decision.sign_for_user(uuid, text, text, jsonb) from public;
revoke all on function decision.sign_for_user(uuid, text, text, jsonb) from anon;
grant execute on function decision.sign_for_user(uuid, text, text, jsonb) to authenticated;

create or replace function decision.issue_for_user(
  p_decision_id uuid,
  p_recipient_party_id uuid,
  p_channel text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_decision decision.decisions%rowtype;
  v_case core.cases%rowtype;
  v_party core.parties%rowtype;
  v_version_id uuid;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_channel text := upper(trim(coalesce(p_channel, '')));
  v_address text;
  v_message_id uuid;
  v_delivery_id uuid;
  v_issuance_id uuid;
  v_correlation uuid := extensions.gen_random_uuid();
begin
  if v_channel not in ('EMAIL', 'DIGITAL_POST', 'SMS', 'PORTAL', 'API', 'PHYSICAL_POST') then
    raise exception 'Unsupported communication channel'
      using errcode = 'check_violation';
  end if;

  select * into v_decision from decision.decisions d where d.id = p_decision_id for update;
  if not found then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_decision.case_id;
  v_authz := authz.can('communication.send', decision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Decision is unavailable' using errcode = 'no_data_found';
  end if;
  if v_decision.status <> 'DECIDED'
     or not exists (select 1 from decision.signatures s where s.decision_id = v_decision.id) then
    raise exception 'Decision must be final and signed before issuance'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1 from core.case_parties cp
    where cp.case_id = v_case.id
      and cp.party_id = p_recipient_party_id
  ) then
    raise exception 'Recipient party is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_party from core.parties p where p.id = p_recipient_party_id;
  if v_channel = 'EMAIL' then
    v_address := v_party.contact_email;
  elsif v_channel = 'SMS' then
    v_address := v_party.contact_phone;
  else
    v_address := coalesce(v_party.contact_email, v_party.contact_phone);
  end if;

  if v_channel not in ('PORTAL', 'API')
     and nullif(trim(coalesce(v_address, '')), '') is null then
    raise exception 'Recipient has no address for issuance channel'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select dv.id into v_version_id
  from decision.decision_versions dv
  where dv.decision_id = v_decision.id
    and dv.version = v_decision.current_version;

  insert into communication.messages (
    authority_id, case_id, direction, subject, body, information_class,
    created_by, correlation_id
  )
  select
    v_case.authority_id,
    v_case.id,
    'OUTBOUND',
    coalesce('Beslut ' || v_decision.decision_number, 'Beslut i ärende ' || v_case.case_number),
    dv.body,
    v_case.information_class,
    v_actor,
    v_correlation
  from decision.decision_versions dv
  where dv.id = v_version_id
  returning id into v_message_id;

  insert into communication.deliveries (
    message_id, authority_id, channel, recipient_party_id, recipient_address,
    correlation_id, status
  )
  values (
    v_message_id, v_case.authority_id, v_channel, p_recipient_party_id,
    nullif(trim(coalesce(v_address, '')), ''), v_correlation, 'PENDING'
  )
  returning id into v_delivery_id;

  insert into decision.issuances (
    decision_id, decision_version_id, authority_id, recipient_party_id,
    message_id, delivery_id, status, created_by
  )
  values (
    v_decision.id, v_version_id, v_case.authority_id, p_recipient_party_id,
    v_message_id, v_delivery_id, 'QUEUED', v_actor
  )
  returning id into v_issuance_id;

  perform config.enqueue_job(
    'notifications',
    'notification',
    v_case.id::text,
    v_case.authority_id,
    'decision-issuance:' || v_issuance_id::text,
    jsonb_build_object(
      'delivery_id', v_delivery_id,
      'decision_id', v_decision.id,
      'issuance_id', v_issuance_id
    ),
    v_correlation
  );

  perform audit.record(
    'case.decision.issuance_queued', 'case', v_case.id, v_case.authority_id,
    format('Decision %s issuance %s queued to party %s via %s',
      v_decision.id, v_issuance_id, p_recipient_party_id, v_channel)
  );

  return v_issuance_id;
end;
$$;

revoke all on function decision.issue_for_user(uuid, uuid, text) from public;
revoke all on function decision.issue_for_user(uuid, uuid, text) from anon;
grant execute on function decision.issue_for_user(uuid, uuid, text) to authenticated;

create or replace function decision.sync_issuance_from_delivery()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decision_id uuid;
  v_case_id uuid;
  v_authority uuid;
  v_new_status text;
begin
  if new.status = old.status then
    return new;
  end if;

  v_new_status := case new.status
    when 'SENT' then 'SENT'
    when 'DELIVERED' then 'DELIVERED'
    when 'READ' then 'READ'
    when 'FAILED' then 'FAILED'
    when 'BOUNCED' then 'BOUNCED'
    when 'CANCELLED' then 'CANCELLED'
    else null
  end;

  if v_new_status is null then
    return new;
  end if;

  update decision.issuances i
  set status = v_new_status,
      issued_at = case
        when v_new_status in ('SENT', 'DELIVERED', 'READ') then coalesce(i.issued_at, now())
        else i.issued_at
      end
  where i.delivery_id = new.id
  returning i.decision_id, i.authority_id into v_decision_id, v_authority;

  if v_decision_id is not null and v_new_status in ('SENT', 'DELIVERED', 'READ') then
    update decision.decisions d
    set issued_at = coalesce(d.issued_at, now())
    where d.id = v_decision_id
    returning d.case_id into v_case_id;

    perform audit.record(
      'case.decision.issued', 'case', v_case_id, v_authority,
      format('Decision %s delivery %s reached %s', v_decision_id, new.id, v_new_status)
    );
  end if;

  return new;
end;
$$;

revoke all on function decision.sync_issuance_from_delivery() from public;

create trigger decision_issuance_delivery_sync
  after update of status on communication.deliveries
  for each row execute function decision.sync_issuance_from_delivery();
