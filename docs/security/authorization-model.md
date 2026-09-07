# Authorization model

Masterplan 13, 16, 17, 18, 19, 81, 82.

## Layers

1. **Tenant / data plane** — the hostname resolves to exactly one tenant and one Supabase project.
   A mismatch between the resolved context and the deployment record raises `DataPlaneMismatchError`;
   there is no fallback to a default project.
2. **Authority boundary** — `authority` (nämnd) is a security boundary. A subject with no active
   assignment inside the resource's authority is denied before any permission is considered.
3. **RBAC** — `authz.roles`, `authz.permissions`, `authz.role_permissions`, `authz.role_assignments`.
4. **ABAC** — `authz.can(permission, resource)` adds information class, assignment scope, validity
   window and external-party relationship.
5. **RLS** — the policy on `core.cases` calls `authz.can()` directly, so the API layer and the database
   cannot drift apart.

## Scope semantics

| Scope                 | Grants within                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `TENANT`              | configuration only — carries no `authority_id`, so the authority-boundary check denies case content |
| `AUTHORITY`           | every department in that authority                                                                  |
| `DEPARTMENT` / `UNIT` | the named department                                                                                |
| `TEAM`                | cases assigned to that team                                                                         |

A tenant administrator therefore has no standing read access to case content. Support access is the
audited break-glass flow, not a role.

## Secrecy

`information_class` is `PUBLIC | INTERNAL | RESTRICTED | SECRET`. A `SECRET` resource requires the
assigned caseworker, `security.manage`, or `case.close` clearance. External parties are denied
`RESTRICTED` and `SECRET` outright and may only reach a resource through a verified
`core.case_parties` relationship.

## SECURITY DEFINER inventory

| Function                                                                | Why                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `authz.current_user_id()`                                               | breaks RLS recursion on `identity.users`; no caller input, returns only the caller's own id |
| `authz.is_external_user()`                                              | same                                                                                        |
| `core.record_case_status_change()`                                      | writes append-only history for a user who has no INSERT policy on it                        |
| `platform.record_domain_event()`                                        | writes the control-plane domain audit trail                                                 |
| `audit.chain_event()`, `audit.record()`                                 | maintain the append-only hash chain; the caller cannot choose the actor                     |
| `platform.assert_slug_not_reserved()`, `core.forbid_authority_change()` | constraint triggers                                                                         |

Every one of them runs with `set search_path = ''`, has `EXECUTE` revoked from `PUBLIC`, and is
granted only where needed. None of them exists to work around a policy that could be written correctly.

## Test matrix

`tests/rls/authorization_matrix.sql` covers anonymous, external applicant, external representative,
caseworker, caseworker in another department, caseworker in another authority, senior caseworker,
decision maker, tenant administrator, auditor and service account, for SELECT/INSERT/UPDATE/DELETE,
plus both directions of the cross-authority leak test and the audit hash chain.

Last verified run against the development data plane: **GREEN** (2026-09-07).
