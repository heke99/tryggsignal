-- Tryggsignal P4 — RBAC + ABAC foundation.
-- Masterplan 16 (RBAC tables and catalog), 17 (ABAC can()), 18 (RLS without
-- SECURITY DEFINER shortcuts). Every function here is SECURITY INVOKER: the
-- policies on authz.* already restrict a caller to their own assignments, so no
-- privilege escalation is needed to evaluate a policy.

create table authz.permissions (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z_]+\.[a-z_]+$'),
  description text not null
);

create table authz.roles (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z_]+$'),
  name text not null,
  is_external boolean not null default false,
  is_service boolean not null default false
);

create table authz.role_permissions (
  role_id uuid not null references authz.roles (id) on delete cascade,
  permission_id uuid not null references authz.permissions (id) on delete cascade,
  primary key (role_id, permission_id)
);

create type authz.scope_type as enum ('TENANT', 'AUTHORITY', 'DEPARTMENT', 'UNIT', 'TEAM');

create table authz.role_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references identity.users (id) on delete cascade,
  role_id uuid not null references authz.roles (id) on delete restrict,
  scope_type authz.scope_type not null,
  scope_id uuid,
  -- Denormalized scope resolution. RLS policies read only this table for the
  -- current user, which keeps policy evaluation non-recursive and indexable.
  authority_id uuid references organization.authorities (id) on delete cascade,
  department_id uuid references organization.departments (id) on delete cascade,
  team_id uuid references organization.teams (id) on delete cascade,
  valid_from timestamptz,
  valid_to timestamptz,
  granted_by uuid references identity.users (id),
  granted_reason text,
  created_at timestamptz not null default now(),
  constraint scope_requires_id check (scope_type = 'TENANT' or scope_id is not null),
  constraint non_tenant_scope_requires_authority check (
    scope_type = 'TENANT' or authority_id is not null
  ),
  constraint department_scope_requires_department check (
    scope_type not in ('DEPARTMENT', 'UNIT') or department_id is not null
  ),
  constraint team_scope_requires_team check (scope_type <> 'TEAM' or team_id is not null),
  constraint validity_window_ordered check (valid_to is null or valid_from is null or valid_to > valid_from)
);

create index role_assignments_user_idx on authz.role_assignments (user_id);
create index role_assignments_user_authority_idx
  on authz.role_assignments (user_id, authority_id);
create index role_assignments_authority_idx on authz.role_assignments (authority_id);

-- Masterplan 16: permission catalog.
insert into authz.permissions (key, description) values
  ('case.read', 'Read cases'),
  ('case.create', 'Create cases'),
  ('case.update', 'Update case data'),
  ('case.assign', 'Assign cases to users or teams'),
  ('case.close', 'Close cases'),
  ('document.read', 'Read documents'),
  ('document.upload', 'Upload documents'),
  ('document.classify', 'Classify documents'),
  ('decision.prepare', 'Prepare decisions'),
  ('decision.approve', 'Approve and issue decisions'),
  ('inspection.create', 'Create inspections'),
  ('inspection.complete', 'Complete inspections'),
  ('audit.read', 'Read the audit trail'),
  ('integration.manage', 'Manage integrations and connectors'),
  ('security.manage', 'Manage security configuration');

insert into authz.roles (key, name, is_external, is_service) values
  ('tenant_admin', 'Tenantadministratör', false, false),
  ('security_admin', 'Säkerhetsadministratör', false, false),
  ('registrar', 'Registrator', false, false),
  ('building_case_worker', 'Bygglovshandläggare', false, false),
  ('senior_case_worker', 'Senior handläggare', false, false),
  ('building_inspector', 'Byggnadsinspektör', false, false),
  ('environmental_inspector', 'Miljöinspektör', false, false),
  ('planning_officer', 'Planhandläggare', false, false),
  ('decision_maker', 'Beslutsfattare', false, false),
  ('board_secretary', 'Nämndsekreterare', false, false),
  ('archivist', 'Arkivarie', false, false),
  ('records_manager', 'Registrator/arkivansvarig', false, false),
  ('finance_officer', 'Ekonomihandläggare', false, false),
  ('gis_officer', 'GIS-handläggare', false, false),
  ('auditor', 'Revisor', false, false),
  ('external_applicant', 'Extern sökande', true, false),
  ('external_representative', 'Externt ombud', true, false),
  ('integration_service', 'Integrationstjänst', false, true);

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from (values
  ('tenant_admin', 'case.read'), ('tenant_admin', 'case.assign'),
  ('tenant_admin', 'audit.read'), ('tenant_admin', 'integration.manage'),
  ('security_admin', 'audit.read'), ('security_admin', 'security.manage'),
  ('registrar', 'case.read'), ('registrar', 'case.create'), ('registrar', 'case.update'),
  ('registrar', 'document.read'), ('registrar', 'document.upload'),
  ('building_case_worker', 'case.read'), ('building_case_worker', 'case.create'),
  ('building_case_worker', 'case.update'), ('building_case_worker', 'document.read'),
  ('building_case_worker', 'document.upload'), ('building_case_worker', 'document.classify'),
  ('building_case_worker', 'decision.prepare'),
  ('senior_case_worker', 'case.read'), ('senior_case_worker', 'case.create'),
  ('senior_case_worker', 'case.update'), ('senior_case_worker', 'case.assign'),
  ('senior_case_worker', 'case.close'), ('senior_case_worker', 'document.read'),
  ('senior_case_worker', 'document.upload'), ('senior_case_worker', 'document.classify'),
  ('senior_case_worker', 'decision.prepare'),
  ('building_inspector', 'case.read'), ('building_inspector', 'document.read'),
  ('building_inspector', 'inspection.create'), ('building_inspector', 'inspection.complete'),
  ('environmental_inspector', 'case.read'), ('environmental_inspector', 'document.read'),
  ('environmental_inspector', 'inspection.create'), ('environmental_inspector', 'inspection.complete'),
  ('planning_officer', 'case.read'), ('planning_officer', 'document.read'),
  ('decision_maker', 'case.read'), ('decision_maker', 'document.read'),
  ('decision_maker', 'decision.prepare'), ('decision_maker', 'decision.approve'),
  ('board_secretary', 'case.read'), ('board_secretary', 'document.read'),
  ('board_secretary', 'decision.prepare'),
  ('archivist', 'case.read'), ('archivist', 'document.read'),
  ('records_manager', 'case.read'), ('records_manager', 'document.read'),
  ('records_manager', 'case.update'),
  ('finance_officer', 'case.read'),
  ('gis_officer', 'case.read'), ('gis_officer', 'document.read'),
  ('auditor', 'case.read'), ('auditor', 'document.read'), ('auditor', 'audit.read'),
  ('external_applicant', 'case.read'), ('external_applicant', 'document.read'),
  ('external_applicant', 'document.upload'),
  ('external_representative', 'case.read'), ('external_representative', 'document.read'),
  ('external_representative', 'document.upload'),
  ('integration_service', 'case.read'), ('integration_service', 'case.create'),
  ('integration_service', 'case.update'), ('integration_service', 'document.upload')
) as grant_pair(role_key, permission_key)
join authz.roles r on r.key = grant_pair.role_key
join authz.permissions p on p.key = grant_pair.permission_key;

-- ---------------------------------------------------------------------------
-- Policy functions (SECURITY INVOKER, STABLE, empty search_path)
-- ---------------------------------------------------------------------------

create or replace function authz.current_user_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select u.id
  from identity.users u
  where u.auth_user_id = (select auth.uid())
    and u.status = 'ACTIVE'
$$;

comment on function authz.current_user_id() is
  'Internal user id for the current session. Authorization never reads user_metadata (masterplan 18).';

create or replace function authz.is_external_user()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (select u.user_type = 'EXTERNAL'
     from identity.users u
     where u.auth_user_id = (select auth.uid())),
    true
  )
$$;

create or replace function authz.assigned_authority_ids()
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct ra.authority_id
  from authz.role_assignments ra
  where ra.user_id = (select authz.current_user_id())
    and ra.authority_id is not null
    and (ra.valid_from is null or ra.valid_from <= now())
    and (ra.valid_to is null or ra.valid_to > now())
$$;

create or replace function authz.has_permission(
  p_permission text,
  p_authority_id uuid,
  p_department_id uuid default null,
  p_team_id uuid default null
)
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
    join authz.permissions perm on perm.id = rp.permission_id
    where ra.user_id = (select authz.current_user_id())
      and perm.key = p_permission
      and (ra.valid_from is null or ra.valid_from <= now())
      and (ra.valid_to is null or ra.valid_to > now())
      and (
        ra.scope_type = 'TENANT'
        or (
          ra.authority_id = p_authority_id
          and (
            ra.scope_type = 'AUTHORITY'
            or (ra.scope_type in ('DEPARTMENT', 'UNIT') and ra.department_id = p_department_id)
            or (ra.scope_type = 'TEAM' and ra.team_id = p_team_id)
          )
        )
      )
  )
$$;

comment on function authz.has_permission(text, uuid, uuid, uuid) is
  'RBAC check scoped by authority/department/team. Used directly by RLS policies (masterplan 16/18).';

-- Masterplan 17: can(user, permission, resource) → allowed, policy_id, reason.
create or replace function authz.can(p_permission text, p_resource jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_user uuid := (select authz.current_user_id());
  v_authority uuid := nullif(p_resource->>'authority_id', '')::uuid;
  v_department uuid := nullif(p_resource->>'department_id', '')::uuid;
  v_team uuid := nullif(p_resource->>'assigned_team_id', '')::uuid;
  v_assigned_user uuid := nullif(p_resource->>'assigned_user_id', '')::uuid;
  v_information_class text := coalesce(p_resource->>'information_class', 'INTERNAL');
  v_relationship text := nullif(p_resource->>'relationship_to_case', '');
begin
  if v_user is null then
    return jsonb_build_object('allowed', false, 'policy_id', 'policy.no_identity',
      'reason', 'No active internal user for the current session.');
  end if;

  if authz.is_external_user() then
    if v_relationship is null then
      return jsonb_build_object('allowed', false, 'policy_id', 'policy.external_relationship',
        'reason', 'No verified relationship to the resource.');
    end if;
    if p_permission not in ('case.read', 'document.read', 'document.upload') then
      return jsonb_build_object('allowed', false, 'policy_id', 'policy.external_permission',
        'reason', format('External parties may not perform %s.', p_permission));
    end if;
    if v_information_class in ('RESTRICTED', 'SECRET') then
      return jsonb_build_object('allowed', false, 'policy_id', 'policy.information_class',
        'reason', 'Resource information class excludes external access.');
    end if;
    return jsonb_build_object('allowed', true, 'policy_id', 'policy.external_party',
      'reason', format('Verified %s on the resource.', v_relationship));
  end if;

  if v_authority is null or v_authority not in (select authz.assigned_authority_ids()) then
    return jsonb_build_object('allowed', false, 'policy_id', 'policy.authority_boundary',
      'reason', 'Subject has no assignment inside the resource authority.');
  end if;

  if not authz.has_permission(p_permission, v_authority, v_department, v_team) then
    return jsonb_build_object('allowed', false, 'policy_id', 'policy.rbac',
      'reason', format('No active role assignment grants %s on this scope.', p_permission));
  end if;

  if v_information_class = 'SECRET'
     and v_assigned_user is distinct from v_user
     and not authz.has_permission('security.manage', v_authority, v_department, v_team)
     and not authz.has_permission('case.close', v_authority, v_department, v_team) then
    return jsonb_build_object('allowed', false, 'policy_id', 'policy.information_class',
      'reason', 'Secrecy-classified resource requires explicit clearance.');
  end if;

  return jsonb_build_object('allowed', true, 'policy_id', 'policy.rbac',
    'reason', format('Role assignment grants %s in the resource scope.', p_permission));
end;
$$;

revoke all on function authz.current_user_id() from public;
revoke all on function authz.is_external_user() from public;
revoke all on function authz.assigned_authority_ids() from public;
revoke all on function authz.has_permission(text, uuid, uuid, uuid) from public;
revoke all on function authz.can(text, jsonb) from public;

alter table authz.permissions enable row level security;
alter table authz.roles enable row level security;
alter table authz.role_permissions enable row level security;
alter table authz.role_assignments enable row level security;
