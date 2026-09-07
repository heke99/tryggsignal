-- Tryggsignal — document and search scoping, found by extending the RLS matrix
-- to documents and the search index.
--
-- Two defects, both pre-existing:
--
-- 1. `documents.documents` had no department, so the scope check could only ever
--    match an AUTHORITY-scoped grant. A department-scoped caseworker could not
--    see the documents on their own case. A document now carries the department
--    of its case, set by trigger, and the policy compares the same scope keys as
--    the case policy.
--
-- 2. `search.entities` applied its own secrecy rule on top of the case's, so a
--    senior caseworker who may open a secrecy-classified case could not find it.
--    For a case-linked row the case's own policy is the authority on visibility;
--    the extra rule now applies only to rows with no case behind them.

alter table documents.documents
  add column department_id uuid references organization.departments (id) on delete set null;

update documents.documents d
set department_id = c.department_id
from core.cases c
where c.id = d.case_id and d.department_id is null;

create index documents_department_idx on documents.documents (department_id)
  where department_id is not null;

create or replace function documents.inherit_case_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.case_id is not null and new.department_id is null then
    select c.department_id into new.department_id from core.cases c where c.id = new.case_id;
  end if;
  return new;
end;
$$;

revoke all on function documents.inherit_case_scope() from public;

create trigger documents_inherit_case_scope
  before insert or update of case_id on documents.documents
  for each row execute function documents.inherit_case_scope();

drop policy documents_select on documents.documents;

create policy documents_select on documents.documents
  for select to authenticated
  using (
    (
      -- Staff path: holds document.read in a scope covering the document, the
      -- case behind it is visible, and secrecy clearance where required.
      (select authz.scope_keys('document.read'))
        && authz.case_scope_keys(authority_id, department_id, null)
      and (case_id is null or exists (select 1 from core.cases c where c.id = documents.case_id))
      and (
        information_class <> 'SECRET'
        or (select authz.scope_keys('security.manage'))
             && authz.case_scope_keys(authority_id, department_id, null)
      )
    )
    or (
      -- External party path: verified relation to the case, never RESTRICTED or SECRET.
      information_class in ('PUBLIC', 'INTERNAL')
      and case_id is not null
      and exists (
        select 1 from core.case_parties cp
        where cp.case_id = documents.case_id
          and cp.identity_user_id = (select authz.current_user_id())
          and cp.verified_at is not null
      )
    )
  );

drop policy search_entities_select on search.entities;

create policy search_entities_select on search.entities
  for select to authenticated
  using (
    case
      -- A case-linked row is visible exactly when its case is, so search can
      -- never be stricter or looser than the case itself (masterplan 48).
      when case_id is not null then exists (select 1 from core.cases c where c.id = entities.case_id)
      when security_scope = 'DEPARTMENT' then
        (select authz.scope_keys('case.read')) && authz.case_scope_keys(authority_id, department_id, null)
        and (information_class <> 'SECRET'
             or (select authz.scope_keys('security.manage'))
                  && authz.case_scope_keys(authority_id, department_id, null))
      else
        (select authz.scope_keys('case.read')) && authz.case_scope_keys(authority_id, null, null)
        and (information_class <> 'SECRET'
             or (select authz.scope_keys('security.manage'))
                  && authz.case_scope_keys(authority_id, null, null))
    end
  );
