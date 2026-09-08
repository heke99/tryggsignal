-- Tryggsignal Phase G11 — Mina sidor / external citizen portal.
-- The portal reuses the tenant data plane and RLS. External users never receive
-- general case.create or staff permissions; new applications enter through one
-- narrow atomic command that creates the case, verified party relationship and
-- pinned workflow instance in the same transaction.

-- ---------------------------------------------------------------------------
-- Auth audience resolution
-- ---------------------------------------------------------------------------

-- Exactly one enabled provider per tenant/audience is allowed. Historical or
-- alternative configurations stay disabled until explicitly activated.
create unique index if not exists tenant_auth_one_enabled_audience_idx
  on platform.tenant_auth_configurations (tenant_id, audience)
  where enabled;

create or replace function public.resolve_tenant_auth_config(
  p_hostname text,
  p_tenant_id uuid,
  p_reference text,
  p_audience text
)
returns table (
  reference text,
  tenant_id uuid,
  audience text,
  kind text,
  display_name text,
  issuer text,
  metadata_url text,
  credential_reference text,
  allowed_email_domains text[],
  environment text,
  enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    cfg.reference,
    cfg.tenant_id,
    cfg.audience::text,
    cfg.kind::text,
    cfg.display_name,
    cfg.issuer,
    cfg.metadata_url,
    cfg.credential_reference,
    cfg.allowed_email_domains,
    cfg.environment,
    cfg.enabled
  from platform.tenant_domains d
  join platform.tenants t on t.id = d.tenant_id
  join platform.tenant_auth_configurations cfg on cfg.tenant_id = t.id
  where d.normalized_hostname = lower(p_hostname)
    and d.status = 'ACTIVE'
    and t.id = p_tenant_id
    and t.status = 'ACTIVE'
    and cfg.audience::text = p_audience
    and cfg.enabled
    -- STAFF remains pinned to the routing reference for backwards compatibility.
    -- EXTERNAL is selected by the independently unique audience configuration,
    -- so staff and citizen identity providers can coexist on one tenant host.
    and (
      p_audience = 'EXTERNAL'
      or cfg.reference = p_reference
    )
  limit 1;
$$;

revoke all on function public.resolve_tenant_auth_config(text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_tenant_auth_config(text, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Citizen application catalog
-- ---------------------------------------------------------------------------

create table config.citizen_application_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  department_id uuid not null references organization.departments (id) on delete restrict,
  process_type text not null check (process_type in (
    'BYGGLOV', 'ANMALAN', 'FORHANDSBESKED', 'RIVNINGSLOV', 'MARKLOV'
  )),
  case_type text not null,
  workflow_template_key text not null,
  display_name text not null,
  description text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, department_id, process_type, workflow_template_key)
);

create trigger citizen_application_profiles_set_updated_at
  before update on config.citizen_application_profiles
  for each row execute function config.set_updated_at();

alter table config.citizen_application_profiles enable row level security;
grant select on config.citizen_application_profiles to authenticated;

create policy citizen_application_profiles_select
  on config.citizen_application_profiles
  for select to authenticated
  using (enabled);

-- Counter is private database state. It generates a collision-safe provisional
-- web reference; a municipality may later replace it with its canonical diary
-- number through the ordinary staff process.
create table core.citizen_case_reference_counters (
  authority_id uuid not null references organization.authorities (id) on delete cascade,
  reference_year integer not null check (reference_year between 2000 and 2200),
  last_value bigint not null check (last_value >= 1),
  primary key (authority_id, reference_year)
);

alter table core.citizen_case_reference_counters enable row level security;
-- No client grants or policies: only the owner-level submission command uses it.

-- ---------------------------------------------------------------------------
-- External document visibility
-- ---------------------------------------------------------------------------

alter table documents.documents
  add column portal_visible boolean not null default false;

drop policy if exists documents_select on documents.documents;
create policy documents_select on documents.documents
  for select to authenticated
  using (
    case
      when authz.is_external_user() then
        case_id is not null
        and information_class in ('PUBLIC', 'INTERNAL')
        and (portal_visible or created_by = (select authz.current_user_id()))
        and (
          authz.can('document.read', jsonb_build_object(
            'authority_id', authority_id,
            'information_class', information_class,
            'relationship_to_case', (
              select cp.relationship
              from core.case_parties cp
              where cp.case_id = documents.case_id
                and cp.identity_user_id = (select authz.current_user_id())
                and cp.verified_at is not null
              limit 1
            )
          )) ->> 'allowed'
        )::boolean
        and exists (select 1 from core.cases c where c.id = documents.case_id)
      else
        (
          authz.can('document.read', jsonb_build_object(
            'authority_id', authority_id,
            'information_class', information_class
          )) ->> 'allowed'
        )::boolean
        and (case_id is null or exists (select 1 from core.cases c where c.id = documents.case_id))
    end
  );

create or replace function documents.set_portal_visibility_for_user(
  p_document_id uuid,
  p_visible boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
  v_decision jsonb;
begin
  select * into v_document
  from documents.documents d
  where d.id = p_document_id
  for update;

  if not found or v_document.case_id is null then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_document.case_id;

  v_decision := authz.can('document.classify', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_document.information_class
  ));

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  if p_visible and v_document.information_class in ('RESTRICTED', 'SECRET') then
    raise exception 'Restricted or secret documents cannot be published to Mina sidor'
      using errcode = 'check_violation';
  end if;

  update documents.documents
  set portal_visible = p_visible
  where id = v_document.id;

  perform audit.record(
    case when p_visible then 'case.document.portal_published'
         else 'case.document.portal_hidden' end,
    'case',
    v_case.id,
    v_case.authority_id,
    format('Document %s portal visibility set to %s', v_document.id, p_visible)
  );
end;
$$;

revoke all on function documents.set_portal_visibility_for_user(uuid, boolean)
  from public, anon;
grant execute on function documents.set_portal_visibility_for_user(uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- External communication visibility and inbound portal messages
-- ---------------------------------------------------------------------------

drop policy if exists messages_select on communication.messages;
create policy messages_select on communication.messages
  for select to authenticated
  using (
    case
      when authz.is_external_user() then
        case_id is not null
        and information_class in ('PUBLIC', 'INTERNAL')
        and exists (select 1 from core.cases c where c.id = messages.case_id)
        and (
          (direction = 'INBOUND' and created_by = (select authz.current_user_id()))
          or
          (
            direction = 'OUTBOUND'
            and exists (
              select 1
              from communication.deliveries d
              join core.case_parties cp on cp.party_id = d.recipient_party_id
              where d.message_id = messages.id
                and d.channel = 'PORTAL'
                and d.status in ('SENT', 'DELIVERED', 'READ')
                and cp.case_id = messages.case_id
                and cp.identity_user_id = (select authz.current_user_id())
                and cp.verified_at is not null
            )
          )
        )
      else
        case
          when case_id is null
            then authz.has_permission('case.read', authority_id, null, null)
          else exists (select 1 from core.cases c where c.id = messages.case_id)
        end
    end
  );

drop policy if exists deliveries_select on communication.deliveries;
create policy deliveries_select on communication.deliveries
  for select to authenticated
  using (
    case
      when authz.is_external_user() then
        channel = 'PORTAL'
        and status in ('SENT', 'DELIVERED', 'READ')
        and exists (
          select 1
          from communication.messages m
          join core.case_parties cp on cp.party_id = deliveries.recipient_party_id
          where m.id = deliveries.message_id
            and cp.case_id = m.case_id
            and cp.identity_user_id = (select authz.current_user_id())
            and cp.verified_at is not null
        )
      else
        exists (select 1 from communication.messages m where m.id = deliveries.message_id)
    end
  );

create or replace function communication.send_portal_message_for_user(
  p_case_id uuid,
  p_subject text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_actor identity.users%rowtype;
  v_subject text := trim(coalesce(p_subject, ''));
  v_body text := trim(coalesce(p_body, ''));
  v_message_id uuid;
begin
  select * into v_actor
  from identity.users u
  where u.id = (select authz.current_user_id())
    and u.status = 'ACTIVE'
    and u.user_type = 'EXTERNAL';

  if not found then
    raise exception 'Citizen portal session is unavailable' using errcode = 'insufficient_privilege';
  end if;

  if length(v_subject) < 2 or length(v_subject) > 300
     or length(v_body) < 2 or length(v_body) > 20000 then
    raise exception 'Portal message is outside allowed length'
      using errcode = 'check_violation';
  end if;

  select * into v_case
  from core.cases c
  where c.id = p_case_id;

  if not found or v_case.status = 'ARCHIVED' then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from core.case_parties cp
    where cp.case_id = v_case.id
      and cp.identity_user_id = v_actor.id
      and cp.verified_at is not null
      and cp.relationship in ('APPLICANT', 'REPRESENTATIVE')
  ) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  insert into communication.messages (
    authority_id, case_id, direction, subject, body, information_class, created_by
  )
  values (
    v_case.authority_id, v_case.id, 'INBOUND', v_subject, v_body, 'INTERNAL', v_actor.id
  )
  returning id into v_message_id;

  perform audit.record(
    'case.portal.message_received',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Citizen portal message %s received', v_message_id)
  );

  return v_message_id;
end;
$$;

revoke all on function communication.send_portal_message_for_user(uuid, text, text)
  from public, anon;
grant execute on function communication.send_portal_message_for_user(uuid, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- External child-table hardening
-- ---------------------------------------------------------------------------

-- Mina sidor reads canonical case status/history, documents, explicit portal
-- communication and final decisions. Internal workflow/rule/referral/inspection/
-- AI/archive details remain staff-only even when the external party can read the
-- parent case.

drop policy if exists workflow_instances_select on workflow.workflow_instances;
create policy workflow_instances_select on workflow.workflow_instances
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = workflow_instances.case_id)
  );

drop policy if exists workflow_transitions_select on workflow.workflow_transitions;
create policy workflow_transitions_select on workflow.workflow_transitions
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (
      select 1 from workflow.workflow_instances i where i.id = workflow_transitions.instance_id
    )
  );

drop policy if exists workflow_tasks_select on workflow.workflow_tasks;
create policy workflow_tasks_select on workflow.workflow_tasks
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = workflow_tasks.case_id)
  );

drop policy if exists deadlines_select on workflow.deadlines;
create policy deadlines_select on workflow.deadlines
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = deadlines.case_id)
  );

drop policy if exists deadline_events_select on workflow.deadline_events;
create policy deadline_events_select on workflow.deadline_events
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from workflow.deadlines d where d.id = deadline_events.deadline_id)
  );

drop policy if exists deadline_calculations_select on workflow.deadline_calculations;
create policy deadline_calculations_select on workflow.deadline_calculations
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from workflow.deadlines d where d.id = deadline_calculations.deadline_id)
  );

drop policy if exists rule_evaluations_select on rules.rule_evaluations;
create policy rule_evaluations_select on rules.rule_evaluations
  for select to authenticated
  using (
    not authz.is_external_user()
    and (
      (case_id is null and authority_id in (select authz.assigned_authority_ids()))
      or exists (select 1 from core.cases c where c.id = rule_evaluations.case_id)
    )
  );

drop policy if exists referrals_select on referral.referrals;
create policy referrals_select on referral.referrals
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = referrals.case_id)
  );

drop policy if exists referral_recipients_select on referral.referral_recipients;
create policy referral_recipients_select on referral.referral_recipients
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from referral.referrals r where r.id = referral_recipients.referral_id)
  );

drop policy if exists referral_responses_select on referral.referral_responses;
create policy referral_responses_select on referral.referral_responses
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from referral.referrals r where r.id = referral_responses.referral_id)
  );

drop policy if exists hearings_select on referral.hearings;
create policy hearings_select on referral.hearings
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = hearings.case_id)
  );

drop policy if exists hearing_recipients_select on referral.hearing_recipients;
create policy hearing_recipients_select on referral.hearing_recipients
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from referral.hearings h where h.id = hearing_recipients.hearing_id)
  );

drop policy if exists hearing_responses_select on referral.hearing_responses;
create policy hearing_responses_select on referral.hearing_responses
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from referral.hearings h where h.id = hearing_responses.hearing_id)
  );

drop policy if exists inspections_select on inspection.inspections;
create policy inspections_select on inspection.inspections
  for select to authenticated
  using (
    not authz.is_external_user()
    and (
      case when case_id is null
        then authz.has_permission('case.read', authority_id, null, null)
        else exists (select 1 from core.cases c where c.id = inspections.case_id)
      end
    )
  );

drop policy if exists findings_select on inspection.findings;
create policy findings_select on inspection.findings
  for select to authenticated
  using (
    not authz.is_external_user()
    and (
      case when case_id is null
        then authz.has_permission('case.read', authority_id, null, null)
        else exists (select 1 from core.cases c where c.id = findings.case_id)
      end
    )
  );

drop policy if exists ai_runs_select on ai.runs;
create policy ai_runs_select on ai.runs
  for select to authenticated
  using (
    not authz.is_external_user()
    and (
      case when case_id is null
        then authz.has_permission('case.read', authority_id, null, null)
        else exists (select 1 from core.cases c where c.id = runs.case_id)
      end
    )
  );

drop policy if exists archive_packages_select on archive.archive_packages;
create policy archive_packages_select on archive.archive_packages
  for select to authenticated
  using (
    not authz.is_external_user()
    and exists (select 1 from core.cases c where c.id = archive_packages.case_id)
  );

-- ---------------------------------------------------------------------------
-- Atomic citizen application submission
-- ---------------------------------------------------------------------------

create or replace function core.submit_citizen_application_for_user(
  p_profile_id uuid,
  p_title text,
  p_description text default null,
  p_contact_phone text default null,
  p_relationship text default 'APPLICANT'
)
returns table (
  case_id uuid,
  case_number text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor identity.users%rowtype;
  v_profile config.citizen_application_profiles%rowtype;
  v_template workflow.workflow_templates%rowtype;
  v_version workflow.workflow_template_versions%rowtype;
  v_initial_state text;
  v_initial jsonb;
  v_initial_status text;
  v_initial_phase text;
  v_counter bigint;
  v_case_id uuid;
  v_case_number text;
  v_party_id uuid;
  v_instance_id uuid;
  v_title text := trim(coalesce(p_title, ''));
  v_description text := nullif(trim(coalesce(p_description, '')), '');
  v_phone text := nullif(trim(coalesce(p_contact_phone, '')), '');
  v_relationship text := upper(trim(coalesce(p_relationship, 'APPLICANT')));
begin
  select * into v_actor
  from identity.users u
  where u.id = (select authz.current_user_id())
    and u.status = 'ACTIVE'
    and u.user_type = 'EXTERNAL';

  if not found then
    raise exception 'Citizen portal session is unavailable'
      using errcode = 'insufficient_privilege';
  end if;

  if length(v_title) < 3 or length(v_title) > 240
     or (v_description is not null and length(v_description) > 10000)
     or (v_phone is not null and length(v_phone) > 80)
     or v_relationship not in ('APPLICANT', 'REPRESENTATIVE') then
    raise exception 'Citizen application contains invalid values'
      using errcode = 'check_violation';
  end if;

  select * into v_profile
  from config.citizen_application_profiles p
  where p.id = p_profile_id
    and p.enabled;

  if not found then
    raise exception 'Application profile is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from organization.departments d
    where d.id = v_profile.department_id
      and d.authority_id = v_profile.authority_id
      and d.is_active
  ) then
    raise exception 'Application profile is unavailable' using errcode = 'no_data_found';
  end if;

  select t.* into v_template
  from workflow.workflow_templates t
  where t.authority_id = v_profile.authority_id
    and t.key = v_profile.workflow_template_key
    and t.process_type = v_profile.process_type;

  if not found then
    raise exception 'Application profile is unavailable' using errcode = 'no_data_found';
  end if;

  select v.* into v_version
  from workflow.workflow_template_versions v
  where v.template_id = v_template.id
    and v.published_at is not null
    and v.valid_from <= now()
    and (v.valid_to is null or v.valid_to > now())
  order by v.version desc
  limit 1;

  if not found then
    raise exception 'Application profile has no published workflow'
      using errcode = 'no_data_found';
  end if;

  v_initial_state := nullif(v_version.definition->>'initial', '');
  v_initial := v_version.definition->'states'->v_initial_state;
  if v_initial_state is null or v_initial is null then
    raise exception 'Published workflow has no valid initial state'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_initial_status := coalesce(nullif(v_initial->>'case_status', ''), 'RECEIVED');
  v_initial_phase := coalesce(nullif(v_initial->>'case_phase', ''), 'INTAKE');

  if v_initial_status in ('DECIDED', 'CLOSED', 'ARCHIVED') then
    raise exception 'Citizen workflow cannot start in consequential status %', v_initial_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into core.citizen_case_reference_counters (
    authority_id, reference_year, last_value
  )
  values (
    v_profile.authority_id, extract(year from current_date)::integer, 1
  )
  on conflict (authority_id, reference_year) do update
  set last_value = core.citizen_case_reference_counters.last_value + 1
  returning last_value into v_counter;

  v_case_number := format(
    'WEB-%s-%s',
    extract(year from current_date)::integer,
    lpad(v_counter::text, 6, '0')
  );

  insert into core.cases (
    authority_id,
    department_id,
    case_number,
    external_case_number,
    case_type,
    process_type,
    title,
    description,
    status,
    phase,
    information_class,
    received_at,
    registered_at,
    created_by,
    updated_by,
    source_system
  )
  values (
    v_profile.authority_id,
    v_profile.department_id,
    v_case_number,
    v_case_number,
    v_profile.case_type,
    v_profile.process_type,
    v_title,
    v_description,
    v_initial_status,
    v_initial_phase,
    'INTERNAL',
    now(),
    case when v_initial_status = 'REGISTERED' then now() else null end,
    v_actor.id,
    v_actor.id,
    'CITIZEN_PORTAL'
  )
  returning id into v_case_id;

  select cp.party_id into v_party_id
  from core.case_parties cp
  join core.parties p on p.id = cp.party_id
  where cp.identity_user_id = v_actor.id
    and cp.authority_id = v_profile.authority_id
    and cp.relationship = v_relationship
    and cp.verified_at is not null
    and p.party_type = 'PERSON'
  order by cp.created_at
  limit 1;

  if v_party_id is null then
    insert into core.parties (
      authority_id, party_type, display_name, contact_email, contact_phone
    )
    values (
      v_profile.authority_id,
      'PERSON',
      v_actor.display_name,
      v_actor.email,
      v_phone
    )
    returning id into v_party_id;
  elsif v_phone is not null then
    update core.parties
    set contact_phone = v_phone
    where id = v_party_id;
  end if;

  insert into core.case_parties (
    case_id,
    party_id,
    authority_id,
    relationship,
    identity_user_id,
    verified_at
  )
  values (
    v_case_id,
    v_party_id,
    v_profile.authority_id,
    v_relationship,
    v_actor.id,
    now()
  );

  insert into workflow.workflow_instances (
    authority_id,
    case_id,
    template_version_id,
    current_state
  )
  values (
    v_profile.authority_id,
    v_case_id,
    v_version.id,
    v_initial_state
  )
  returning id into v_instance_id;

  insert into workflow.workflow_transitions (
    instance_id,
    authority_id,
    to_state,
    triggered_by,
    trigger_type,
    reason
  )
  values (
    v_instance_id,
    v_profile.authority_id,
    v_initial_state,
    v_actor.id,
    'SYSTEM',
    'Citizen application submitted'
  );

  update core.cases
  set workflow_version_id = v_version.id
  where id = v_case_id;

  perform workflow.materialize_state(v_instance_id);

  perform audit.record(
    'case.citizen_application.submitted',
    'case',
    v_case_id,
    v_profile.authority_id,
    format(
      'Citizen application %s submitted as verified %s using workflow %s version %s',
      v_case_number,
      v_relationship,
      v_template.key,
      v_version.version
    )
  );

  return query select v_case_id, v_case_number;
end;
$$;

revoke all on function core.submit_citizen_application_for_user(
  uuid, text, text, text, text
) from public, anon;
grant execute on function core.submit_citizen_application_for_user(
  uuid, text, text, text, text
) to authenticated;
