-- Tryggsignal — advisor follow-up after the P4 gate.
-- Supabase performance advisor flagged two tables with multiple permissive
-- SELECT policies for `authenticated`; each policy is evaluated per row, so the
-- two alternatives are merged into one policy with the same semantics.
-- Also indexes the foreign keys that RLS and the work queues actually traverse
-- (masterplan 51/137) — not every FK, only the ones on a real access path.

drop policy users_select_self on identity.users;
drop policy users_select_colleagues on identity.users;

create policy users_select on identity.users
  for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or exists (
      select 1 from identity.user_memberships m
      where m.user_id = users.id
        and m.authority_id in (select authz.assigned_authority_ids())
    )
  );

drop policy role_assignments_select_self on authz.role_assignments;
drop policy role_assignments_select_admin on authz.role_assignments;

create policy role_assignments_select on authz.role_assignments
  for select to authenticated
  using (
    user_id = (select authz.current_user_id())
    or (
      authority_id is not null
      and authz.has_permission('security.manage', authority_id, department_id, team_id)
    )
  );

create index role_assignments_role_idx on authz.role_assignments (role_id);
create index role_assignments_department_idx on authz.role_assignments (department_id)
  where department_id is not null;
create index role_assignments_team_idx on authz.role_assignments (team_id)
  where team_id is not null;
create index role_permissions_permission_idx on authz.role_permissions (permission_id);
create index case_parties_party_idx on core.case_parties (party_id);
create index cases_assigned_user_idx on core.cases (assigned_user_id)
  where assigned_user_id is not null;
create index cases_assigned_team_idx on core.cases (assigned_team_id)
  where assigned_team_id is not null;
create index user_memberships_department_idx on identity.user_memberships (department_id)
  where department_id is not null;
