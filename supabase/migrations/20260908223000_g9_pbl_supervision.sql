-- Tryggsignal Phase G9 / P23 — operational PBL supervision.
-- Legal conclusions stay in versioned rules/decisions. This domain orchestrates
-- supervision work, risk, inspections, findings, actions and follow-up.

create schema if not exists supervision;

grant usage on schema supervision to authenticated;

insert into authz.permissions (key, description)
values ('supervision.manage', 'Manage PBL supervision work attached to authorized cases')
on conflict (key) do nothing;

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('building_case_worker', 'supervision.manage'),
  ('senior_case_worker', 'supervision.manage'),
  ('building_inspector', 'supervision.manage')
) x(role_key, permission_key)
join authz.roles r on r.key = x.role_key
join authz.permissions p on p.key = x.permission_key
on conflict do nothing;

create table supervision.cases (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  source_type text not null check (source_type in (
    'REPORT', 'OWN_INITIATIVE', 'INSPECTION', 'OTHER'
  )),
  allegation text,
  status text not null default 'NEW' check (status in (
    'NEW', 'TRIAGE', 'INVESTIGATING', 'ACTION_REQUIRED', 'FOLLOW_UP', 'CLOSED'
  )),
  risk_score numeric(5,2) not null default 0 check (risk_score between 0 and 100),
  risk_level text not null default 'LOW' check (risk_level in (
    'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'
  )),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  close_reason text,
  created_by uuid not null references identity.users (id) on delete restrict,
  updated_at timestamptz not null default now(),
  unique (case_id)
);

create table supervision.risk_assessments (
  id uuid primary key default extensions.gen_random_uuid(),
  supervision_id uuid not null references supervision.cases (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  score numeric(5,2) not null check (score between 0 and 100),
  level text not null check (level in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  reasons jsonb not null default '[]'::jsonb,
  assessed_by uuid not null references identity.users (id) on delete restrict,
  assessed_at timestamptz not null default now()
);

create table supervision.actions (
  id uuid primary key default extensions.gen_random_uuid(),
  supervision_id uuid not null references supervision.cases (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  action_type text not null check (action_type in (
    'REQUEST_INFO', 'INSPECTION', 'COMMUNICATION', 'ORDER', 'PROHIBITION',
    'SANCTION_REVIEW', 'OTHER'
  )),
  description text not null,
  legal_reference text,
  decision_id uuid references decision.decisions (id) on delete restrict,
  status text not null default 'ACTIVE' check (status in (
    'PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'
  )),
  due_at timestamptz,
  completed_at timestamptz,
  outcome text,
  created_by uuid not null references identity.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table supervision.followups (
  id uuid primary key default extensions.gen_random_uuid(),
  supervision_id uuid not null references supervision.cases (id) on delete cascade,
  action_id uuid references supervision.actions (id) on delete set null,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  due_at timestamptz not null,
  status text not null default 'OPEN' check (status in (
    'OPEN', 'OVERDUE', 'DONE', 'CANCELLED'
  )),
  note text,
  outcome text,
  completed_at timestamptz,
  completed_by uuid references identity.users (id) on delete restrict,
  created_by uuid not null references identity.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index supervision_cases_risk_queue_idx
  on supervision.cases (authority_id, status, risk_score desc, opened_at)
  where status <> 'CLOSED';
create index supervision_risk_history_idx
  on supervision.risk_assessments (supervision_id, assessed_at desc);
create index supervision_actions_open_idx
  on supervision.actions (authority_id, due_at)
  where status in ('PLANNED', 'ACTIVE');
create index supervision_followups_due_idx
  on supervision.followups (authority_id, due_at)
  where status in ('OPEN', 'OVERDUE');

create trigger supervision_cases_updated_at
  before update on supervision.cases
  for each row execute function config.set_updated_at();

alter table supervision.cases enable row level security;
alter table supervision.risk_assessments enable row level security;
alter table supervision.actions enable row level security;
alter table supervision.followups enable row level security;

grant select on supervision.cases, supervision.risk_assessments,
  supervision.actions, supervision.followups to authenticated;

create policy supervision_cases_select on supervision.cases
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = cases.case_id));

create policy supervision_risk_assessments_select on supervision.risk_assessments
  for select to authenticated
  using (
    exists (
      select 1
      from supervision.cases s
      where s.id = risk_assessments.supervision_id
    )
  );

create policy supervision_actions_select on supervision.actions
  for select to authenticated
  using (
    exists (
      select 1
      from supervision.cases s
      where s.id = actions.supervision_id
    )
  );

create policy supervision_followups_select on supervision.followups
  for select to authenticated
  using (
    exists (
      select 1
      from supervision.cases s
      where s.id = followups.supervision_id
    )
  );

insert into config.scheduled_tasks (key, description, schedule)
values (
  'supervision_followup_sweep',
  'Mark PBL supervision follow-ups overdue without performing legal action',
  '*/15 * * * *'
)
on conflict (key) do nothing;

create or replace function supervision.case_resource(p_case core.cases)
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

revoke all on function supervision.case_resource(core.cases) from public;

create or replace function supervision.open_for_user(
  p_case_id uuid,
  p_source_type text,
  p_allegation text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_source text := upper(trim(coalesce(p_source_type, '')));
  v_id uuid;
begin
  if v_source not in ('REPORT', 'OWN_INITIATIVE', 'INSPECTION', 'OTHER') then
    raise exception 'Unsupported supervision source type' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_allegation, '')) > 10000 then
    raise exception 'Supervision allegation is too long' using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found or v_case.process_type <> 'PBL_TILLSYN' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  insert into supervision.cases (
    authority_id, case_id, source_type, allegation, created_by
  )
  values (
    v_case.authority_id, v_case.id, v_source,
    nullif(trim(coalesce(p_allegation, '')), ''), v_actor
  )
  returning id into v_id;

  perform audit.record(
    'case.supervision.opened', 'case', v_case.id, v_case.authority_id,
    format('PBL supervision %s opened from source %s', v_id, v_source)
  );

  return v_id;
end;
$$;

revoke all on function supervision.open_for_user(uuid, text, text) from public;
revoke all on function supervision.open_for_user(uuid, text, text) from anon;
grant execute on function supervision.open_for_user(uuid, text, text) to authenticated;

create or replace function supervision.assess_risk_for_user(
  p_supervision_id uuid,
  p_score numeric,
  p_reasons jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_level text;
  v_id uuid;
begin
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'Risk score must be between 0 and 100' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_reasons, '[]'::jsonb)) <> 'array' then
    raise exception 'Risk reasons must be an array' using errcode = 'check_violation';
  end if;

  select * into v_supervision
  from supervision.cases s
  where s.id = p_supervision_id
  for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  v_level := case
    when p_score >= 80 then 'CRITICAL'
    when p_score >= 60 then 'HIGH'
    when p_score >= 30 then 'MEDIUM'
    else 'LOW'
  end;

  insert into supervision.risk_assessments (
    supervision_id, authority_id, score, level, reasons, assessed_by
  )
  values (
    v_supervision.id, v_supervision.authority_id, p_score, v_level,
    coalesce(p_reasons, '[]'::jsonb), v_actor
  )
  returning id into v_id;

  update supervision.cases
  set risk_score = p_score,
      risk_level = v_level,
      status = case when status in ('NEW', 'TRIAGE') then 'INVESTIGATING' else status end
  where id = v_supervision.id;

  perform audit.record(
    'case.supervision.risk_assessed', 'case', v_case.id, v_case.authority_id,
    format('PBL supervision %s risk assessed %s/%s', v_supervision.id, p_score, v_level)
  );

  return v_id;
end;
$$;

revoke all on function supervision.assess_risk_for_user(uuid, numeric, jsonb) from public;
revoke all on function supervision.assess_risk_for_user(uuid, numeric, jsonb) from anon;
grant execute on function supervision.assess_risk_for_user(uuid, numeric, jsonb) to authenticated;

create or replace function supervision.schedule_inspection_for_user(
  p_supervision_id uuid,
  p_scheduled_at timestamptz,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_id uuid;
begin
  if p_scheduled_at is null or p_scheduled_at <= now() then
    raise exception 'Inspection must be scheduled in the future' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_notes, '')) > 10000 then
    raise exception 'Inspection notes are too long' using errcode = 'check_violation';
  end if;

  select * into v_supervision from supervision.cases s where s.id = p_supervision_id for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  if p_property_id is not null and not exists (
    select 1 from core.case_properties cp
    where cp.case_id = v_case.id and cp.property_id = p_property_id
  ) then
    raise exception 'Inspection property is unavailable' using errcode = 'no_data_found';
  end if;
  if p_building_id is not null and not exists (
    select 1 from property.buildings b
    where b.id = p_building_id
      and (p_property_id is null or b.property_id = p_property_id)
  ) then
    raise exception 'Inspection building is unavailable' using errcode = 'no_data_found';
  end if;

  insert into inspection.inspections (
    authority_id, case_id, property_id, building_id, inspection_type,
    scheduled_at, status, notes
  )
  values (
    v_case.authority_id, v_case.id, p_property_id, p_building_id,
    'PBL_TILLSYN', p_scheduled_at, 'PLANNED',
    nullif(trim(coalesce(p_notes, '')), '')
  )
  returning id into v_id;

  update supervision.cases
  set status = 'INVESTIGATING'
  where id = v_supervision.id and status in ('NEW', 'TRIAGE');

  perform audit.record(
    'case.supervision.inspection_scheduled', 'case', v_case.id, v_case.authority_id,
    format('PBL supervision %s inspection %s scheduled', v_supervision.id, v_id)
  );

  return v_id;
end;
$$;

revoke all on function supervision.schedule_inspection_for_user(uuid, timestamptz, uuid, uuid, text)
  from public;
revoke all on function supervision.schedule_inspection_for_user(uuid, timestamptz, uuid, uuid, text)
  from anon;
grant execute on function supervision.schedule_inspection_for_user(uuid, timestamptz, uuid, uuid, text)
  to authenticated;

create or replace function supervision.complete_inspection_for_user(
  p_inspection_id uuid,
  p_result text,
  p_notes text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inspection inspection.inspections%rowtype;
  v_case core.cases%rowtype;
  v_supervision supervision.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_result text := upper(trim(coalesce(p_result, '')));
begin
  if v_result not in ('APPROVED', 'APPROVED_WITH_REMARKS', 'REJECTED', 'NOT_APPLICABLE') then
    raise exception 'Unsupported inspection result' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_notes, '')) > 10000 then
    raise exception 'Inspection notes are too long' using errcode = 'check_violation';
  end if;

  select * into v_inspection
  from inspection.inspections i
  where i.id = p_inspection_id
  for update;
  if not found or v_inspection.status not in ('PLANNED', 'IN_PROGRESS') then
    raise exception 'Inspection is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_inspection.case_id;
  v_authz := authz.can('inspection.complete', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Inspection is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_supervision
  from supervision.cases s
  where s.case_id = v_case.id;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  update inspection.inspections
  set status = 'COMPLETED',
      result = v_result,
      notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes),
      performed_at = now(),
      performed_by = v_actor
  where id = v_inspection.id;

  update supervision.cases
  set status = case when v_result = 'REJECTED' then 'ACTION_REQUIRED' else 'INVESTIGATING' end
  where id = v_supervision.id;

  perform audit.record(
    'case.supervision.inspection_completed', 'case', v_case.id, v_case.authority_id,
    format('Inspection %s completed with result %s', v_inspection.id, v_result)
  );
end;
$$;

revoke all on function supervision.complete_inspection_for_user(uuid, text, text) from public;
revoke all on function supervision.complete_inspection_for_user(uuid, text, text) from anon;
grant execute on function supervision.complete_inspection_for_user(uuid, text, text) to authenticated;

create or replace function supervision.record_finding_for_user(
  p_supervision_id uuid,
  p_inspection_id uuid,
  p_severity text,
  p_title text,
  p_description text default null,
  p_rule_id uuid default null,
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_severity text := upper(trim(coalesce(p_severity, '')));
  v_id uuid;
begin
  if v_severity not in ('INFO', 'REMARK', 'DEVIATION', 'SERIOUS') then
    raise exception 'Unsupported finding severity' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_title, ''))) < 2 or length(p_title) > 300 then
    raise exception 'Finding title must contain 2-300 characters' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_description, '')) > 10000 then
    raise exception 'Finding description is too long' using errcode = 'check_violation';
  end if;
  if p_due_at is not null and p_due_at <= now() then
    raise exception 'Finding due_at must be in the future' using errcode = 'check_violation';
  end if;

  select * into v_supervision from supervision.cases s where s.id = p_supervision_id for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  if p_inspection_id is not null and not exists (
    select 1 from inspection.inspections i
    where i.id = p_inspection_id and i.case_id = v_case.id
  ) then
    raise exception 'Inspection is unavailable' using errcode = 'no_data_found';
  end if;

  insert into inspection.findings (
    inspection_id, authority_id, case_id, severity, title, description,
    rule_id, status, due_at
  )
  values (
    p_inspection_id, v_case.authority_id, v_case.id, v_severity,
    trim(p_title), nullif(trim(coalesce(p_description, '')), ''), p_rule_id,
    case when v_severity in ('DEVIATION', 'SERIOUS') then 'ACTION_REQUIRED' else 'OPEN' end,
    p_due_at
  )
  returning id into v_id;

  if v_severity in ('DEVIATION', 'SERIOUS') then
    update supervision.cases set status = 'ACTION_REQUIRED' where id = v_supervision.id;
  end if;

  perform audit.record(
    'case.supervision.finding_recorded', 'case', v_case.id, v_case.authority_id,
    format('Finding %s recorded with severity %s', v_id, v_severity)
  );

  return v_id;
end;
$$;

revoke all on function supervision.record_finding_for_user(uuid, uuid, text, text, text, uuid, timestamptz)
  from public;
revoke all on function supervision.record_finding_for_user(uuid, uuid, text, text, text, uuid, timestamptz)
  from anon;
grant execute on function supervision.record_finding_for_user(uuid, uuid, text, text, text, uuid, timestamptz)
  to authenticated;

create or replace function supervision.add_finding_evidence_for_user(
  p_finding_id uuid,
  p_document_id uuid,
  p_document_version_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finding inspection.findings%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_id uuid;
begin
  select * into v_finding from inspection.findings f where f.id = p_finding_id;
  if not found or v_finding.case_id is null then
    raise exception 'Finding is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_finding.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Finding is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from documents.documents d
    join documents.document_versions dv on dv.document_id = d.id
    where d.id = p_document_id
      and d.case_id = v_case.id
      and dv.id = p_document_version_id
      and dv.ingestion_status = 'CLEAN'
  ) then
    raise exception 'Finding evidence is unavailable' using errcode = 'no_data_found';
  end if;

  insert into inspection.finding_evidence (
    finding_id, document_id, document_version_id, note
  )
  values (
    v_finding.id, p_document_id, p_document_version_id,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning id into v_id;

  perform audit.record(
    'case.supervision.finding_evidence_added', 'case', v_case.id, v_case.authority_id,
    format('Evidence %s added to finding %s', v_id, v_finding.id)
  );

  return v_id;
end;
$$;

revoke all on function supervision.add_finding_evidence_for_user(uuid, uuid, uuid, text) from public;
revoke all on function supervision.add_finding_evidence_for_user(uuid, uuid, uuid, text) from anon;
grant execute on function supervision.add_finding_evidence_for_user(uuid, uuid, uuid, text) to authenticated;

create or replace function supervision.resolve_finding_for_user(
  p_finding_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_finding inspection.findings%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
begin
  if length(trim(coalesce(p_note, ''))) < 2 or length(p_note) > 4000 then
    raise exception 'Resolution note must contain 2-4000 characters'
      using errcode = 'check_violation';
  end if;

  select * into v_finding from inspection.findings f where f.id = p_finding_id for update;
  if not found or v_finding.case_id is null then
    raise exception 'Finding is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_finding.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Finding is unavailable' using errcode = 'no_data_found';
  end if;

  update inspection.findings
  set status = 'RESOLVED', resolved_at = now(),
      description = concat_ws(E'\n\n', description, 'Resolution: ' || trim(p_note))
  where id = v_finding.id;

  perform audit.record(
    'case.supervision.finding_resolved', 'case', v_case.id, v_case.authority_id,
    format('Finding %s resolved: %s', v_finding.id, left(trim(p_note), 500))
  );
end;
$$;

revoke all on function supervision.resolve_finding_for_user(uuid, text) from public;
revoke all on function supervision.resolve_finding_for_user(uuid, text) from anon;
grant execute on function supervision.resolve_finding_for_user(uuid, text) to authenticated;

create or replace function supervision.create_action_for_user(
  p_supervision_id uuid,
  p_action_type text,
  p_description text,
  p_due_at timestamptz default null,
  p_legal_reference text default null,
  p_decision_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_type text := upper(trim(coalesce(p_action_type, '')));
  v_id uuid;
begin
  if v_type not in (
    'REQUEST_INFO', 'INSPECTION', 'COMMUNICATION', 'ORDER', 'PROHIBITION',
    'SANCTION_REVIEW', 'OTHER'
  ) then
    raise exception 'Unsupported supervision action type' using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_description, ''))) < 2 or length(p_description) > 10000 then
    raise exception 'Action description must contain 2-10000 characters'
      using errcode = 'check_violation';
  end if;
  if p_due_at is not null and p_due_at <= now() then
    raise exception 'Action due_at must be in the future' using errcode = 'check_violation';
  end if;

  select * into v_supervision from supervision.cases s where s.id = p_supervision_id for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  if v_type in ('ORDER', 'PROHIBITION') then
    if nullif(trim(coalesce(p_legal_reference, '')), '') is null
       or p_decision_id is null
       or not exists (
         select 1 from decision.decisions d
         where d.id = p_decision_id
           and d.case_id = v_case.id
           and d.status = 'DECIDED'
       ) then
      raise exception 'Formal supervision action requires legal reference and final decision'
        using errcode = 'object_not_in_prerequisite_state';
    end if;
  end if;

  insert into supervision.actions (
    supervision_id, authority_id, action_type, description,
    legal_reference, decision_id, status, due_at, created_by
  )
  values (
    v_supervision.id, v_case.authority_id, v_type, trim(p_description),
    nullif(trim(coalesce(p_legal_reference, '')), ''), p_decision_id,
    'ACTIVE', p_due_at, (select authz.current_user_id())
  )
  returning id into v_id;

  update supervision.cases
  set status = case when v_type in ('ORDER', 'PROHIBITION', 'SANCTION_REVIEW')
    then 'ACTION_REQUIRED' else status end
  where id = v_supervision.id;

  perform audit.record(
    'case.supervision.action_created', 'case', v_case.id, v_case.authority_id,
    format('Supervision action %s of type %s created', v_id, v_type)
  );

  return v_id;
end;
$$;

revoke all on function supervision.create_action_for_user(uuid, text, text, timestamptz, text, uuid)
  from public;
revoke all on function supervision.create_action_for_user(uuid, text, text, timestamptz, text, uuid)
  from anon;
grant execute on function supervision.create_action_for_user(uuid, text, text, timestamptz, text, uuid)
  to authenticated;

create or replace function supervision.complete_action_for_user(
  p_action_id uuid,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action supervision.actions%rowtype;
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
begin
  if length(trim(coalesce(p_outcome, ''))) < 2 or length(p_outcome) > 4000 then
    raise exception 'Action outcome must contain 2-4000 characters'
      using errcode = 'check_violation';
  end if;
  select * into v_action from supervision.actions a where a.id = p_action_id for update;
  if not found or v_action.status not in ('PLANNED', 'ACTIVE') then
    raise exception 'Supervision action is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_supervision from supervision.cases s where s.id = v_action.supervision_id;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Supervision action is unavailable' using errcode = 'no_data_found';
  end if;

  update supervision.actions
  set status = 'COMPLETED', completed_at = now(), outcome = trim(p_outcome)
  where id = v_action.id;

  perform audit.record(
    'case.supervision.action_completed', 'case', v_case.id, v_case.authority_id,
    format('Supervision action %s completed', v_action.id)
  );
end;
$$;

revoke all on function supervision.complete_action_for_user(uuid, text) from public;
revoke all on function supervision.complete_action_for_user(uuid, text) from anon;
grant execute on function supervision.complete_action_for_user(uuid, text) to authenticated;

create or replace function supervision.create_followup_for_user(
  p_supervision_id uuid,
  p_action_id uuid default null,
  p_due_at timestamptz default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_id uuid;
begin
  if p_due_at is null or p_due_at <= now() then
    raise exception 'Follow-up due_at must be in the future' using errcode = 'check_violation';
  end if;
  if length(coalesce(p_note, '')) > 4000 then
    raise exception 'Follow-up note is too long' using errcode = 'check_violation';
  end if;

  select * into v_supervision from supervision.cases s where s.id = p_supervision_id for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  if p_action_id is not null and not exists (
    select 1 from supervision.actions a
    where a.id = p_action_id and a.supervision_id = v_supervision.id
  ) then
    raise exception 'Supervision action is unavailable' using errcode = 'no_data_found';
  end if;

  insert into supervision.followups (
    supervision_id, action_id, authority_id, due_at, note, created_by
  )
  values (
    v_supervision.id, p_action_id, v_case.authority_id, p_due_at,
    nullif(trim(coalesce(p_note, '')), ''), (select authz.current_user_id())
  )
  returning id into v_id;

  update supervision.cases set status = 'FOLLOW_UP' where id = v_supervision.id;

  perform audit.record(
    'case.supervision.followup_created', 'case', v_case.id, v_case.authority_id,
    format('Supervision follow-up %s due %s', v_id, p_due_at)
  );

  return v_id;
end;
$$;

revoke all on function supervision.create_followup_for_user(uuid, uuid, timestamptz, text) from public;
revoke all on function supervision.create_followup_for_user(uuid, uuid, timestamptz, text) from anon;
grant execute on function supervision.create_followup_for_user(uuid, uuid, timestamptz, text)
  to authenticated;

create or replace function supervision.complete_followup_for_user(
  p_followup_id uuid,
  p_outcome text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_followup supervision.followups%rowtype;
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
begin
  if length(trim(coalesce(p_outcome, ''))) < 2 or length(p_outcome) > 4000 then
    raise exception 'Follow-up outcome must contain 2-4000 characters'
      using errcode = 'check_violation';
  end if;
  select * into v_followup from supervision.followups f where f.id = p_followup_id for update;
  if not found or v_followup.status not in ('OPEN', 'OVERDUE') then
    raise exception 'Supervision follow-up is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_supervision from supervision.cases s where s.id = v_followup.supervision_id;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) or v_actor is null then
    raise exception 'Supervision follow-up is unavailable' using errcode = 'no_data_found';
  end if;

  update supervision.followups
  set status = 'DONE', outcome = trim(p_outcome),
      completed_at = now(), completed_by = v_actor
  where id = v_followup.id;

  update supervision.cases
  set status = case
    when exists (
      select 1 from inspection.findings fi
      where fi.case_id = v_case.id
        and fi.status in ('OPEN', 'ACTION_REQUIRED', 'ESCALATED')
    ) then 'ACTION_REQUIRED'
    else 'INVESTIGATING'
  end
  where id = v_supervision.id;

  perform audit.record(
    'case.supervision.followup_completed', 'case', v_case.id, v_case.authority_id,
    format('Supervision follow-up %s completed', v_followup.id)
  );
end;
$$;

revoke all on function supervision.complete_followup_for_user(uuid, text) from public;
revoke all on function supervision.complete_followup_for_user(uuid, text) from anon;
grant execute on function supervision.complete_followup_for_user(uuid, text) to authenticated;

create or replace function supervision.close_for_user(
  p_supervision_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_supervision supervision.cases%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
begin
  if length(trim(coalesce(p_reason, ''))) < 3 or length(p_reason) > 4000 then
    raise exception 'Close reason must contain 3-4000 characters'
      using errcode = 'check_violation';
  end if;
  select * into v_supervision from supervision.cases s where s.id = p_supervision_id for update;
  if not found or v_supervision.status = 'CLOSED' then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;
  select * into v_case from core.cases c where c.id = v_supervision.case_id;
  v_authz := authz.can('supervision.manage', supervision.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'PBL supervision case is unavailable' using errcode = 'no_data_found';
  end if;

  if exists (
    select 1 from inspection.findings f
    where f.case_id = v_case.id
      and f.status in ('OPEN', 'ACTION_REQUIRED', 'ESCALATED')
  ) or exists (
    select 1 from supervision.actions a
    where a.supervision_id = v_supervision.id and a.status in ('PLANNED', 'ACTIVE')
  ) or exists (
    select 1 from supervision.followups f
    where f.supervision_id = v_supervision.id and f.status in ('OPEN', 'OVERDUE')
  ) then
    raise exception 'Open findings, actions or follow-ups prevent supervision closure'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update supervision.cases
  set status = 'CLOSED', closed_at = now(), close_reason = trim(p_reason)
  where id = v_supervision.id;

  perform audit.record(
    'case.supervision.closed', 'case', v_case.id, v_case.authority_id,
    format('PBL supervision %s closed: %s', v_supervision.id, left(trim(p_reason), 500))
  );
end;
$$;

revoke all on function supervision.close_for_user(uuid, text) from public;
revoke all on function supervision.close_for_user(uuid, text) from anon;
grant execute on function supervision.close_for_user(uuid, text) to authenticated;

create or replace function supervision.sweep_followups()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_row record;
begin
  for v_row in
    update supervision.followups f
    set status = 'OVERDUE'
    where f.status = 'OPEN' and f.due_at < now()
    returning f.id, f.supervision_id, f.authority_id
  loop
    v_count := v_count + 1;
    perform audit.record(
      'case.supervision.followup_overdue',
      'case',
      (select s.case_id from supervision.cases s where s.id = v_row.supervision_id),
      v_row.authority_id,
      format('Supervision follow-up %s is overdue', v_row.id)
    );
  end loop;

  update config.scheduled_tasks
  set last_run_at = now(),
      last_result = format('%s supervision follow-up(s) marked overdue', v_count)
  where key = 'supervision_followup_sweep';

  return v_count;
end;
$$;

revoke all on function supervision.sweep_followups() from public;
revoke all on function supervision.sweep_followups() from anon, authenticated;
