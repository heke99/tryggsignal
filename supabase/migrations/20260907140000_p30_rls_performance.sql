-- Tryggsignal P30 — RLS performance fix found by the load test.
-- Masterplan 51: no RLS policy is accepted without a performance test on a
-- realistic data volume.
--
-- Finding: `cases_select` called `authz.can()` once per candidate row. `can()` is
-- a PL/pgSQL function that runs several sub-queries, so it cannot be inlined and
-- the planner must execute it per row. On 120 000 cases, a work-queue query with
-- no selective index (the "unassigned" queue) exceeded a 55 s statement timeout.
--
-- Fix, in two parts:
--   1. The caller's grants are resolved once per statement into a text[] of scope
--      keys. The policy then does a cheap array overlap per row. `authz.can()` is
--      unchanged and remains the explainable decision used by the API layer and
--      by the audit trail; this policy mirrors it exactly.
--   2. The work queues get the partial indexes their predicates actually need.

create or replace function authz.scope_keys(p_permission text)
returns text[]
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(distinct k), array[]::text[])
  from (
    select case ra.scope_type
             when 'AUTHORITY' then 'A:' || ra.authority_id::text
             when 'DEPARTMENT' then 'D:' || ra.department_id::text
             when 'UNIT' then 'D:' || ra.department_id::text
             when 'TEAM' then 'T:' || ra.team_id::text
           end as k
    from authz.role_assignments ra
    join authz.role_permissions rp on rp.role_id = ra.role_id
    join authz.permissions perm on perm.id = rp.permission_id
    where ra.user_id = (select authz.current_user_id())
      and perm.key = p_permission
      and ra.authority_id is not null
      and (ra.valid_from is null or ra.valid_from <= now())
      and (ra.valid_to is null or ra.valid_to > now())
  ) keys
  where k is not null
$$;

comment on function authz.scope_keys(text) is
  'Scope keys granting a permission to the current user, resolved once per statement. '
  'A:<authority> grants the whole authority, D:<department> one department, T:<team> one team.';

revoke all on function authz.scope_keys(text) from public;
grant execute on function authz.scope_keys(text) to authenticated;

-- Row-side keys for a case. Kept as a function so the policy and any future
-- read model cannot drift.
create or replace function authz.case_scope_keys(
  p_authority_id uuid,
  p_department_id uuid,
  p_team_id uuid
)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array_remove(array[
    'A:' || p_authority_id::text,
    case when p_department_id is null then null else 'D:' || p_department_id::text end,
    case when p_team_id is null then null else 'T:' || p_team_id::text end
  ], null)
$$;

revoke all on function authz.case_scope_keys(uuid, uuid, uuid) from public;
grant execute on function authz.case_scope_keys(uuid, uuid, uuid) to authenticated;

drop policy cases_select on core.cases;

create policy cases_select on core.cases
  for select to authenticated
  using (
    -- Staff path: an active assignment whose scope covers the case, plus the
    -- secrecy clearance check. Mirrors authz.can('case.read', …).
    (
      (select authz.scope_keys('case.read'))
        && authz.case_scope_keys(authority_id, department_id, assigned_team_id)
      and (
        information_class <> 'SECRET'
        or assigned_user_id = (select authz.current_user_id())
        or (select authz.scope_keys('security.manage'))
             && authz.case_scope_keys(authority_id, department_id, assigned_team_id)
        or (select authz.scope_keys('case.close'))
             && authz.case_scope_keys(authority_id, department_id, assigned_team_id)
      )
    )
    -- External party path: a verified relation to this case, and never a
    -- RESTRICTED or SECRET case.
    or (
      information_class in ('PUBLIC', 'INTERNAL')
      and exists (
        select 1 from core.case_parties cp
        where cp.case_id = cases.id
          and cp.identity_user_id = (select authz.current_user_id())
          and cp.verified_at is not null
      )
    )
  );

drop policy documents_select on documents.documents;

create policy documents_select on documents.documents
  for select to authenticated
  using (
    (
      (select authz.scope_keys('document.read'))
        && authz.case_scope_keys(authority_id, null, null)
      and information_class <> 'SECRET'
    )
    or (
      information_class in ('PUBLIC', 'INTERNAL')
      and case_id is not null
      and exists (
        select 1 from core.case_parties cp
        where cp.case_id = documents.case_id
          and cp.identity_user_id = (select authz.current_user_id())
          and cp.verified_at is not null
      )
    )
    or (
      information_class = 'SECRET'
      and (select authz.scope_keys('security.manage'))
            && authz.case_scope_keys(authority_id, null, null)
    )
  );

-- Indexes for the control-tower queues (masterplan 50/137: index the predicate
-- that is actually run, not every column).
create index cases_unassigned_queue_idx
  on core.cases (authority_id, created_at)
  where assigned_user_id is null and status not in ('CLOSED', 'ARCHIVED');

create index cases_open_due_idx
  on core.cases (statutory_due_at)
  where status not in ('CLOSED', 'ARCHIVED');

create index cases_status_due_idx
  on core.cases (status, statutory_due_at);

create index cases_my_queue_idx
  on core.cases (assigned_user_id, statutory_due_at)
  where status not in ('CLOSED', 'ARCHIVED');
