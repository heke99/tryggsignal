-- Tryggsignal P4 — RLS policies and least-privilege grants.
-- Masterplan 18/19: every client-accessible table gets scoped policies, `TO
-- authenticated` is never authorization on its own, and DELETE exists only where
-- the domain actually allows it (it does not, masterplan 89).
--
-- SECURITY DEFINER justification (masterplan 18): `authz.current_user_id()` and
-- `authz.is_external_user()` must read the caller's own row in `identity.users`
-- while that table's own policies are being evaluated. Leaving them SECURITY
-- INVOKER produces genuine policy recursion. Both take no caller-controlled
-- input — they derive everything from `auth.uid()` — return only the caller's own
-- identity, run with an empty search_path, and are executable by `authenticated`
-- only. They are covered by tests/rls/authorization_matrix.sql.

alter function authz.current_user_id() security definer;
alter function authz.is_external_user() security definer;

revoke all on function authz.current_user_id() from public;
revoke all on function authz.is_external_user() from public;
grant execute on function authz.current_user_id() to authenticated;
grant execute on function authz.is_external_user() to authenticated;
grant execute on function authz.assigned_authority_ids() to authenticated;
grant execute on function authz.has_permission(text, uuid, uuid, uuid) to authenticated;
grant execute on function authz.can(text, jsonb) to authenticated;

-- The status-history trigger writes an append-only row on behalf of a user who
-- has no INSERT policy on the history table; it must therefore run as owner.
alter function core.record_case_status_change() security definer;
alter function platform.record_domain_event() security definer;

grant usage on schema organization, identity, authz, core, property to authenticated;

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
grant select on organization.legal_entities, organization.authorities,
  organization.departments, organization.units, organization.teams to authenticated;

create policy authorities_select on organization.authorities
  for select to authenticated
  using (id in (select authz.assigned_authority_ids()));

create policy legal_entities_select on organization.legal_entities
  for select to authenticated
  using (exists (
    select 1 from organization.authorities a
    where a.legal_entity_id = legal_entities.id
      and a.id in (select authz.assigned_authority_ids())
  ));

create policy departments_select on organization.departments
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy units_select on organization.units
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy teams_select on organization.teams
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
grant select on identity.users, identity.user_memberships to authenticated;
grant update (display_name, last_login_at) on identity.users to authenticated;

create policy users_select_self on identity.users
  for select to authenticated
  using (auth_user_id = (select auth.uid()));

-- Colleagues inside an authority the caller is assigned to, so assignee names
-- render without exposing the whole user table.
create policy users_select_colleagues on identity.users
  for select to authenticated
  using (exists (
    select 1 from identity.user_memberships m
    where m.user_id = users.id
      and m.authority_id in (select authz.assigned_authority_ids())
  ));

create policy users_update_self on identity.users
  for update to authenticated
  using (auth_user_id = (select auth.uid()))
  with check (auth_user_id = (select auth.uid()));

create policy user_memberships_select on identity.user_memberships
  for select to authenticated
  using (
    user_id = (select authz.current_user_id())
    or authority_id in (select authz.assigned_authority_ids())
  );

-- ---------------------------------------------------------------------------
-- Authorization catalog and assignments
-- ---------------------------------------------------------------------------
grant select on authz.roles, authz.permissions, authz.role_permissions,
  authz.role_assignments to authenticated;

-- The role/permission catalog is not sensitive, but it is still read-only and
-- only for signed-in sessions.
create policy roles_select on authz.roles for select to authenticated using (true);
create policy permissions_select on authz.permissions for select to authenticated using (true);
create policy role_permissions_select on authz.role_permissions
  for select to authenticated using (true);

-- A user sees their own assignments; a security admin sees assignments inside
-- the authorities they administer.
create policy role_assignments_select_self on authz.role_assignments
  for select to authenticated
  using (user_id = (select authz.current_user_id()));

create policy role_assignments_select_admin on authz.role_assignments
  for select to authenticated
  using (
    authority_id is not null
    and authz.has_permission('security.manage', authority_id, department_id, team_id)
  );

-- ---------------------------------------------------------------------------
-- Property
-- ---------------------------------------------------------------------------
grant select on property.properties to authenticated;

create policy properties_select on property.properties
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

-- ---------------------------------------------------------------------------
-- Classification catalog
-- ---------------------------------------------------------------------------
grant select on core.classifications, core.classification_versions,
  core.classification_mappings to authenticated;

create policy classifications_select on core.classifications
  for select to authenticated using (true);
create policy classification_versions_select on core.classification_versions
  for select to authenticated using (true);
create policy classification_mappings_select on core.classification_mappings
  for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------
grant select, insert, update on core.cases to authenticated;

-- One decision function for both the API layer and the database boundary, so a
-- policy change cannot drift from `can()` (masterplan 17/18).
create policy cases_select on core.cases
  for select to authenticated
  using (
    (authz.can('case.read', jsonb_build_object(
      'authority_id', authority_id,
      'department_id', department_id,
      'assigned_user_id', assigned_user_id,
      'assigned_team_id', assigned_team_id,
      'information_class', information_class,
      'relationship_to_case', (
        select cp.relationship from core.case_parties cp
        where cp.case_id = cases.id
          and cp.identity_user_id = (select authz.current_user_id())
          and cp.verified_at is not null
        limit 1
      )
    )) ->> 'allowed')::boolean
  );

create policy cases_insert on core.cases
  for insert to authenticated
  with check (
    authz.has_permission('case.create', authority_id, department_id, assigned_team_id)
  );

create policy cases_update on core.cases
  for update to authenticated
  using (authz.has_permission('case.update', authority_id, department_id, assigned_team_id))
  with check (authz.has_permission('case.update', authority_id, department_id, assigned_team_id));

-- Masterplan 13: a case may never be moved across the authority boundary by an
-- UPDATE, which a WITH CHECK alone cannot prevent.
create or replace function core.forbid_authority_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.authority_id is distinct from old.authority_id then
    raise exception 'A case may not be moved between authorities'
      using errcode = 'raise_exception';
  end if;
  return new;
end;
$$;

revoke all on function core.forbid_authority_change() from public;

create trigger cases_forbid_authority_change
  before update on core.cases
  for each row execute function core.forbid_authority_change();

-- ---------------------------------------------------------------------------
-- Case graph
-- ---------------------------------------------------------------------------
grant select on core.case_status_history, core.case_assignments, core.case_properties to authenticated;
grant select on core.parties, core.case_parties to authenticated;

-- History is visible exactly when the case itself is visible, so the two can
-- never disagree.
create policy case_status_history_select on core.case_status_history
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = case_status_history.case_id));

create policy case_assignments_select on core.case_assignments
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy case_properties_select on core.case_properties
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy parties_select on core.parties
  for select to authenticated
  using (
    authority_id in (select authz.assigned_authority_ids())
    or exists (
      select 1 from core.case_parties cp
      where cp.party_id = parties.id
        and cp.identity_user_id = (select authz.current_user_id())
        and cp.verified_at is not null
    )
  );

create policy case_parties_select on core.case_parties
  for select to authenticated
  using (
    authority_id in (select authz.assigned_authority_ids())
    or (identity_user_id = (select authz.current_user_id()) and verified_at is not null)
  );

-- Indexes supporting the RLS predicates above (masterplan 51).
create index case_status_history_authority_idx on core.case_status_history (authority_id);
create index case_assignments_authority_idx on core.case_assignments (authority_id);
create index case_parties_authority_idx on core.case_parties (authority_id);
create index case_properties_authority_idx on core.case_properties (authority_id);
