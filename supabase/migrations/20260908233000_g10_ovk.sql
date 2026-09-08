-- Tryggsignal Phase G10 / P24 — operational OVK.
-- OVK obligations and intervals remain versioned data. This migration adds
-- case linkage, protocol evidence, findings and a due/supervision queue.

insert into authz.permissions (key, description)
values ('ovk.manage', 'Manage OVK objects, protocols and findings within an authority')
on conflict (key) do nothing;

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('tenant_admin', 'ovk.manage'),
  ('senior_case_worker', 'ovk.manage'),
  ('building_inspector', 'ovk.manage')
) x(role_key, permission_key)
join authz.roles r on r.key = x.role_key
join authz.permissions p on p.key = x.permission_key
on conflict do nothing;

alter table compliance.compliance_objects
  add column last_protocol_result text
    check (last_protocol_result in ('APPROVED', 'APPROVED_WITH_REMARKS', 'NOT_APPROVED'));

create table compliance.ovk_case_objects (
  case_id uuid not null references core.cases (id) on delete cascade,
  compliance_object_id uuid not null references compliance.compliance_objects (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  linked_by uuid not null references identity.users (id) on delete restrict,
  linked_at timestamptz not null default now(),
  primary key (case_id, compliance_object_id)
);

create table compliance.ovk_protocols (
  id uuid primary key default extensions.gen_random_uuid(),
  compliance_object_id uuid not null references compliance.compliance_objects (id) on delete cascade,
  case_id uuid not null references core.cases (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  performed_at date not null,
  result text not null check (result in (
    'APPROVED', 'APPROVED_WITH_REMARKS', 'NOT_APPROVED'
  )),
  protocol_document_id uuid not null references documents.documents (id) on delete restrict,
  protocol_document_version_id uuid not null references documents.document_versions (id) on delete restrict,
  inspector_name text,
  inspector_organization text,
  notes text,
  recorded_by uuid not null references identity.users (id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique (compliance_object_id, protocol_document_version_id)
);

alter table compliance.compliance_objects
  add column last_protocol_id uuid references compliance.ovk_protocols (id) on delete set null;

alter table compliance.compliance_findings
  add column protocol_id uuid references compliance.ovk_protocols (id) on delete set null,
  add column severity text not null default 'REMARK'
    check (severity in ('INFO', 'REMARK', 'DEVIATION', 'SERIOUS')),
  add column status text not null default 'OPEN'
    check (status in ('OPEN', 'ACTION_REQUIRED', 'RESOLVED', 'CLOSED')),
  add column due_at timestamptz,
  add column resolution_note text,
  add column resolved_by uuid references identity.users (id) on delete restrict;

create unique index compliance_objects_property_reference_unique
  on compliance.compliance_objects (
    authority_id, obligation_id, property_id, object_reference
  )
  where building_id is null;

create index ovk_case_objects_object_idx
  on compliance.ovk_case_objects (compliance_object_id, case_id);
create index ovk_protocols_object_idx
  on compliance.ovk_protocols (compliance_object_id, performed_at desc, recorded_at desc);
create index ovk_protocols_case_idx
  on compliance.ovk_protocols (case_id, performed_at desc);
create index ovk_findings_open_idx
  on compliance.compliance_findings (authority_id, due_at)
  where status in ('OPEN', 'ACTION_REQUIRED');

alter table compliance.ovk_case_objects enable row level security;
alter table compliance.ovk_protocols enable row level security;

grant select on compliance.ovk_case_objects, compliance.ovk_protocols to authenticated;

create or replace function compliance.can_manage_ovk(p_authority_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from authz.role_assignments ra
    join authz.role_permissions rp on rp.role_id = ra.role_id
    join authz.permissions p on p.id = rp.permission_id
    where ra.user_id = (select authz.current_user_id())
      and p.key = 'ovk.manage'
      and (ra.valid_from is null or ra.valid_from <= now())
      and (ra.valid_to is null or ra.valid_to > now())
      and (
        ra.scope_type = 'TENANT'
        or ra.authority_id = p_authority_id
      )
  )
$$;

revoke all on function compliance.can_manage_ovk(uuid) from public;
grant execute on function compliance.can_manage_ovk(uuid) to authenticated;

drop policy if exists compliance_objects_select on compliance.compliance_objects;
create policy compliance_objects_select on compliance.compliance_objects
  for select to authenticated
  using (
    compliance.can_manage_ovk(authority_id)
    or exists (
      select 1
      from compliance.ovk_case_objects co
      join core.cases c on c.id = co.case_id
      where co.compliance_object_id = compliance_objects.id
    )
  );

drop policy if exists compliance_findings_select on compliance.compliance_findings;
create policy compliance_findings_select on compliance.compliance_findings
  for select to authenticated
  using (
    exists (
      select 1
      from compliance.compliance_objects o
      where o.id = compliance_findings.compliance_object_id
    )
  );

create policy ovk_case_objects_select on compliance.ovk_case_objects
  for select to authenticated
  using (
    exists (select 1 from core.cases c where c.id = ovk_case_objects.case_id)
  );

create policy ovk_protocols_select on compliance.ovk_protocols
  for select to authenticated
  using (
    exists (
      select 1
      from compliance.ovk_case_objects co
      where co.case_id = ovk_protocols.case_id
        and co.compliance_object_id = ovk_protocols.compliance_object_id
    )
  );

-- Deterministic replacement for the original P24 sweep:
-- * one active rule per obligation (latest valid_from/id)
-- * NOT_APPROVED can never become COMPLIANT merely because it is recent
-- * risk remains explainable from due state plus failed protocol.
create or replace function compliance.recompute_due_dates()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with active_rule as (
    select distinct on (r.obligation_id)
      r.obligation_id,
      r.interval_months
    from compliance.obligation_rules r
    where r.valid_from <= current_date
      and (r.valid_to is null or r.valid_to > current_date)
    order by r.obligation_id, r.valid_from desc, r.id desc
  )
  update compliance.compliance_objects o
  set next_due_at = case
        when o.last_performed_at is null then null
        else (o.last_performed_at + (r.interval_months * interval '1 month'))::date
      end,
      status = case
        when o.status = 'EXEMPT' then 'EXEMPT'
        when o.last_performed_at is null then 'UNKNOWN'
        when o.last_protocol_result = 'NOT_APPROVED' then 'DUE'
        when o.last_performed_at + (r.interval_months * interval '1 month') < current_date then 'OVERDUE'
        when o.last_performed_at + (r.interval_months * interval '1 month')
             < current_date + interval '90 days' then 'DUE'
        else 'COMPLIANT'
      end,
      risk_score = case
        when o.status = 'EXEMPT' then 0
        when o.last_protocol_result = 'NOT_APPROVED' then greatest(
          80,
          case
            when o.last_performed_at is null then 80
            else least(100, greatest(0,
              extract(day from (
                current_date - (o.last_performed_at + (r.interval_months * interval '1 month'))
              ))::numeric
            ))
          end
        )
        when o.last_performed_at is null then 50
        else least(100, greatest(0,
          extract(day from (
            current_date - (o.last_performed_at + (r.interval_months * interval '1 month'))
          ))::numeric
        ))
      end
  from active_rule r
  where r.obligation_id = o.obligation_id;

  get diagnostics v_count = row_count;

  update config.scheduled_tasks
  set last_run_at = now(),
      last_result = format('%s compliance object(s) recomputed', v_count)
  where key = 'compliance_due_sweep';

  return v_count;
end;
$$;

revoke all on function compliance.recompute_due_dates() from public;
revoke all on function compliance.recompute_due_dates() from anon, authenticated;

create or replace function compliance.case_resource(p_case core.cases)
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

revoke all on function compliance.case_resource(core.cases) from public;

create or replace function compliance.link_ovk_object_for_user(
  p_case_id uuid,
  p_property_id uuid,
  p_building_id uuid,
  p_obligation_id uuid,
  p_object_reference text,
  p_ventilation_system_type text default null,
  p_last_performed_at date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_object compliance.compliance_objects%rowtype;
  v_actor uuid := (select authz.current_user_id());
  v_authz jsonb;
  v_reference text := nullif(trim(coalesce(p_object_reference, '')), '');
  v_system text := nullif(trim(coalesce(p_ventilation_system_type, '')), '');
begin
  if v_reference is null or length(v_reference) > 300 then
    raise exception 'OVK object reference must contain 1-300 characters'
      using errcode = 'check_violation';
  end if;
  if v_system is not null and length(v_system) > 300 then
    raise exception 'Ventilation system type is too long'
      using errcode = 'check_violation';
  end if;
  if p_last_performed_at is not null and p_last_performed_at > current_date then
    raise exception 'Last performed date cannot be in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found or v_case.process_type <> 'OVK' then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('case.read', compliance.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false)
     or not compliance.can_manage_ovk(v_case.authority_id)
     or v_actor is null then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from core.case_properties cp
    where cp.case_id = v_case.id
      and cp.property_id = p_property_id
  ) then
    raise exception 'OVK property is unavailable' using errcode = 'no_data_found';
  end if;

  if p_building_id is not null and not exists (
    select 1
    from property.buildings b
    where b.id = p_building_id
      and b.property_id = p_property_id
  ) then
    raise exception 'OVK building is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from compliance.obligations o
    where o.id = p_obligation_id
      and o.domain = 'OVK'
      and exists (
        select 1
        from compliance.obligation_rules r
        where r.obligation_id = o.id
          and r.valid_from <= current_date
          and (r.valid_to is null or r.valid_to > current_date)
      )
  ) then
    raise exception 'OVK obligation is unavailable' using errcode = 'no_data_found';
  end if;

  select o.* into v_object
  from compliance.compliance_objects o
  where o.authority_id = v_case.authority_id
    and o.obligation_id = p_obligation_id
    and o.property_id = p_property_id
    and o.building_id is not distinct from p_building_id
    and o.object_reference = v_reference
  order by o.created_at
  limit 1
  for update;

  if not found then
    insert into compliance.compliance_objects (
      authority_id, property_id, building_id, obligation_id, object_reference,
      ventilation_system_type, last_performed_at
    )
    values (
      v_case.authority_id, p_property_id, p_building_id, p_obligation_id,
      v_reference, v_system, p_last_performed_at
    )
    returning * into v_object;
  else
    update compliance.compliance_objects
    set ventilation_system_type = coalesce(v_system, ventilation_system_type),
        last_performed_at = coalesce(p_last_performed_at, last_performed_at)
    where id = v_object.id
    returning * into v_object;
  end if;

  insert into compliance.ovk_case_objects (
    case_id, compliance_object_id, authority_id, linked_by
  )
  values (v_case.id, v_object.id, v_case.authority_id, v_actor)
  on conflict (case_id, compliance_object_id) do nothing;

  perform compliance.recompute_due_dates();

  perform audit.record(
    'case.ovk.object_linked', 'case', v_case.id, v_case.authority_id,
    format('OVK object %s linked to case with reference %s', v_object.id, v_reference)
  );

  return v_object.id;
end;
$$;

revoke all on function compliance.link_ovk_object_for_user(uuid, uuid, uuid, uuid, text, text, date)
  from public;
revoke all on function compliance.link_ovk_object_for_user(uuid, uuid, uuid, uuid, text, text, date)
  from anon;
grant execute on function compliance.link_ovk_object_for_user(uuid, uuid, uuid, uuid, text, text, date)
  to authenticated;

create or replace function compliance.record_ovk_protocol_for_user(
  p_case_id uuid,
  p_compliance_object_id uuid,
  p_performed_at date,
  p_result text,
  p_document_id uuid,
  p_document_version_id uuid,
  p_inspector_name text default null,
  p_inspector_organization text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_object compliance.compliance_objects%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
  v_result text := upper(trim(coalesce(p_result, '')));
  v_protocol_id uuid;
begin
  if p_performed_at is null or p_performed_at > current_date then
    raise exception 'OVK protocol date must not be in the future'
      using errcode = 'check_violation';
  end if;
  if v_result not in ('APPROVED', 'APPROVED_WITH_REMARKS', 'NOT_APPROVED') then
    raise exception 'Unsupported OVK protocol result'
      using errcode = 'check_violation';
  end if;
  if length(coalesce(p_inspector_name, '')) > 300
     or length(coalesce(p_inspector_organization, '')) > 300
     or length(coalesce(p_notes, '')) > 10000 then
    raise exception 'OVK protocol metadata is too long'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found or v_case.process_type <> 'OVK' then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;
  v_authz := authz.can('case.read', compliance.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false)
     or not compliance.can_manage_ovk(v_case.authority_id)
     or v_actor is null then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  select o.* into v_object
  from compliance.compliance_objects o
  join compliance.ovk_case_objects co
    on co.compliance_object_id = o.id
   and co.case_id = v_case.id
  where o.id = p_compliance_object_id
    and o.authority_id = v_case.authority_id
  for update;

  if not found then
    raise exception 'OVK object is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1
    from documents.documents d
    join documents.document_versions dv
      on dv.document_id = d.id
    where d.id = p_document_id
      and d.case_id = v_case.id
      and d.authority_id = v_case.authority_id
      and dv.id = p_document_version_id
      and dv.ingestion_status = 'CLEAN'
  ) then
    raise exception 'OVK protocol document is unavailable' using errcode = 'no_data_found';
  end if;

  insert into compliance.ovk_protocols (
    compliance_object_id, case_id, authority_id, performed_at, result,
    protocol_document_id, protocol_document_version_id,
    inspector_name, inspector_organization, notes, recorded_by
  )
  values (
    v_object.id, v_case.id, v_case.authority_id, p_performed_at, v_result,
    p_document_id, p_document_version_id,
    nullif(trim(coalesce(p_inspector_name, '')), ''),
    nullif(trim(coalesce(p_inspector_organization, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    v_actor
  )
  returning id into v_protocol_id;

  update compliance.compliance_objects
  set last_performed_at = p_performed_at,
      last_protocol_result = v_result,
      last_protocol_id = v_protocol_id
  where id = v_object.id;

  perform compliance.recompute_due_dates();

  if v_result = 'NOT_APPROVED' and not exists (
    select 1
    from compliance.compliance_findings f
    where f.compliance_object_id = v_object.id
      and f.protocol_id = v_protocol_id
      and f.status in ('OPEN', 'ACTION_REQUIRED')
  ) then
    insert into compliance.compliance_findings (
      compliance_object_id, authority_id, protocol_id, finding_type,
      description, severity, status
    )
    values (
      v_object.id, v_case.authority_id, v_protocol_id,
      'PROTOCOL_NOT_APPROVED',
      'OVK-protokollet är registrerat som inte godkänt; saklig och juridisk uppföljning krävs.',
      'SERIOUS', 'ACTION_REQUIRED'
    );
  end if;

  perform audit.record(
    'case.ovk.protocol_recorded', 'case', v_case.id, v_case.authority_id,
    format('OVK protocol %s recorded for object %s with result %s',
      v_protocol_id, v_object.id, v_result)
  );

  return v_protocol_id;
end;
$$;

revoke all on function compliance.record_ovk_protocol_for_user(
  uuid, uuid, date, text, uuid, uuid, text, text, text
) from public;
revoke all on function compliance.record_ovk_protocol_for_user(
  uuid, uuid, date, text, uuid, uuid, text, text, text
) from anon;
grant execute on function compliance.record_ovk_protocol_for_user(
  uuid, uuid, date, text, uuid, uuid, text, text, text
) to authenticated;

create or replace function compliance.record_ovk_finding_for_user(
  p_case_id uuid,
  p_compliance_object_id uuid,
  p_protocol_id uuid,
  p_finding_type text,
  p_description text,
  p_severity text default 'REMARK',
  p_due_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_type text := trim(coalesce(p_finding_type, ''));
  v_severity text := upper(trim(coalesce(p_severity, 'REMARK')));
  v_id uuid;
begin
  if length(v_type) < 2 or length(v_type) > 200 then
    raise exception 'OVK finding type must contain 2-200 characters'
      using errcode = 'check_violation';
  end if;
  if length(trim(coalesce(p_description, ''))) < 2 or length(p_description) > 10000 then
    raise exception 'OVK finding description must contain 2-10000 characters'
      using errcode = 'check_violation';
  end if;
  if v_severity not in ('INFO', 'REMARK', 'DEVIATION', 'SERIOUS') then
    raise exception 'Unsupported OVK finding severity'
      using errcode = 'check_violation';
  end if;
  if p_due_at is not null and p_due_at <= now() then
    raise exception 'OVK finding due_at must be in the future'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found or v_case.process_type <> 'OVK' then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('case.read', compliance.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false)
     or not compliance.can_manage_ovk(v_case.authority_id) then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1 from compliance.ovk_case_objects co
    where co.case_id = v_case.id
      and co.compliance_object_id = p_compliance_object_id
  ) then
    raise exception 'OVK object is unavailable' using errcode = 'no_data_found';
  end if;

  if p_protocol_id is not null and not exists (
    select 1 from compliance.ovk_protocols p
    where p.id = p_protocol_id
      and p.case_id = v_case.id
      and p.compliance_object_id = p_compliance_object_id
  ) then
    raise exception 'OVK protocol is unavailable' using errcode = 'no_data_found';
  end if;

  insert into compliance.compliance_findings (
    compliance_object_id, authority_id, protocol_id, finding_type,
    description, severity, status, due_at
  )
  values (
    p_compliance_object_id, v_case.authority_id, p_protocol_id, v_type,
    trim(p_description), v_severity,
    case when v_severity in ('DEVIATION', 'SERIOUS') then 'ACTION_REQUIRED' else 'OPEN' end,
    p_due_at
  )
  returning id into v_id;

  perform audit.record(
    'case.ovk.finding_recorded', 'case', v_case.id, v_case.authority_id,
    format('OVK finding %s recorded with severity %s', v_id, v_severity)
  );

  return v_id;
end;
$$;

revoke all on function compliance.record_ovk_finding_for_user(
  uuid, uuid, uuid, text, text, text, timestamptz
) from public;
revoke all on function compliance.record_ovk_finding_for_user(
  uuid, uuid, uuid, text, text, text, timestamptz
) from anon;
grant execute on function compliance.record_ovk_finding_for_user(
  uuid, uuid, uuid, text, text, text, timestamptz
) to authenticated;

create or replace function compliance.resolve_ovk_finding_for_user(
  p_case_id uuid,
  p_finding_id uuid,
  p_resolution_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_finding compliance.compliance_findings%rowtype;
  v_authz jsonb;
  v_actor uuid := (select authz.current_user_id());
begin
  if length(trim(coalesce(p_resolution_note, ''))) < 2
     or length(p_resolution_note) > 4000 then
    raise exception 'OVK resolution note must contain 2-4000 characters'
      using errcode = 'check_violation';
  end if;

  select * into v_case from core.cases c where c.id = p_case_id;
  if not found or v_case.process_type <> 'OVK' then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  v_authz := authz.can('case.read', compliance.case_resource(v_case));
  if not coalesce((v_authz->>'allowed')::boolean, false)
     or not compliance.can_manage_ovk(v_case.authority_id)
     or v_actor is null then
    raise exception 'OVK case is unavailable' using errcode = 'no_data_found';
  end if;

  select f.* into v_finding
  from compliance.compliance_findings f
  join compliance.ovk_case_objects co
    on co.compliance_object_id = f.compliance_object_id
   and co.case_id = v_case.id
  where f.id = p_finding_id
  for update;

  if not found or v_finding.status not in ('OPEN', 'ACTION_REQUIRED') then
    raise exception 'OVK finding is unavailable' using errcode = 'no_data_found';
  end if;

  update compliance.compliance_findings
  set status = 'RESOLVED',
      resolved_at = now(),
      resolution_note = trim(p_resolution_note),
      resolved_by = v_actor
  where id = v_finding.id;

  perform audit.record(
    'case.ovk.finding_resolved', 'case', v_case.id, v_case.authority_id,
    format('OVK finding %s resolved', v_finding.id)
  );
end;
$$;

revoke all on function compliance.resolve_ovk_finding_for_user(uuid, uuid, text) from public;
revoke all on function compliance.resolve_ovk_finding_for_user(uuid, uuid, text) from anon;
grant execute on function compliance.resolve_ovk_finding_for_user(uuid, uuid, text) to authenticated;
