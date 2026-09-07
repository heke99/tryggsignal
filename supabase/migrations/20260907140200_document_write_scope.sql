-- Tryggsignal — document write policies had the same department-scope defect as
-- the read policy: `has_permission(..., null, null)` can only ever match an
-- AUTHORITY-scoped grant, so a department-scoped caseworker could not upload a
-- version to their own case, and an applicant could not upload at all.
--
-- All three write policies now use the same scope-key comparison as the read
-- policies, and the external-party path from masterplan 96 is explicit.

drop policy documents_insert on documents.documents;
drop policy documents_update on documents.documents;
drop policy document_versions_insert on documents.document_versions;

create policy documents_insert on documents.documents
  for insert to authenticated
  with check (
    (select authz.scope_keys('document.upload'))
      && authz.case_scope_keys(authority_id, department_id, null)
    or (
      -- Masterplan 96: an applicant or representative may add documents to a case
      -- they are a verified party to, and never a classified one.
      information_class in ('PUBLIC', 'INTERNAL')
      and case_id is not null
      and exists (
        select 1 from core.case_parties cp
        where cp.case_id = documents.case_id
          and cp.identity_user_id = (select authz.current_user_id())
          and cp.verified_at is not null
          and cp.relationship in ('APPLICANT', 'REPRESENTATIVE')
      )
    )
  );

create policy documents_update on documents.documents
  for update to authenticated
  using (
    (select authz.scope_keys('document.classify'))
      && authz.case_scope_keys(authority_id, department_id, null)
  )
  with check (
    (select authz.scope_keys('document.classify'))
      && authz.case_scope_keys(authority_id, department_id, null)
  );

create policy document_versions_insert on documents.document_versions
  for insert to authenticated
  with check (
    -- Masterplan 36: a file always enters through quarantine, whoever uploads it.
    ingestion_status = 'QUARANTINED'
    and exists (
      select 1 from documents.documents d
      where d.id = document_versions.document_id
        and d.authority_id = document_versions.authority_id
        and (
          (select authz.scope_keys('document.upload'))
            && authz.case_scope_keys(d.authority_id, d.department_id, null)
          or (
            d.information_class in ('PUBLIC', 'INTERNAL')
            and d.case_id is not null
            and exists (
              select 1 from core.case_parties cp
              where cp.case_id = d.case_id
                and cp.identity_user_id = (select authz.current_user_id())
                and cp.verified_at is not null
                and cp.relationship in ('APPLICANT', 'REPRESENTATIVE')
            )
          )
        )
    )
  );
