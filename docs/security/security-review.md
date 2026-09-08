# Security review — P29

Date: 2026-09-07. Scope: everything implemented so far. This is the standing
review record; each finding is either fixed or listed with its status.

## Controls in place

| Control                                        | Where                                                       | Verified by                                                            |
| ---------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tenant/data-plane isolation                    | `TenantResolver`, `assertDeploymentMatchesContext`          | `tests/unit/tenant-resolver.test.ts`, `DataPlaneMismatchError`         |
| Authority boundary                             | `authz.assigned_authority_ids()`, `authz.can()`             | `tests/rls/authorization_matrix.sql` (both directions)                 |
| RBAC                                           | `authz.roles`/`permissions`/`role_assignments`              | authorization matrix, `tests/unit/authorization.test.ts`               |
| ABAC                                           | `authz.can()` in SQL and TypeScript                         | both suites                                                            |
| RLS on every client-accessible table           | all migrations                                              | Supabase security advisor                                              |
| No DELETE on cases                             | no delete policy, no grant                                  | authorization matrix                                                   |
| Append-only audit with hash chain              | `audit.events` + `audit.chain_event()`                      | authorization matrix                                                   |
| Break-glass, time-limited, MFA, approval       | `audit.break_glass_requests` constraints                    | schema constraints                                                     |
| Upload quarantine                              | `document_versions.ingestion_status` + insert policy        | insert policy requires `QUARANTINED`                                   |
| Immutable document versions                    | `documents.enforce_version_immutability()`                  | trigger                                                                |
| Private Storage buckets + path-scoped policies | `storage.buckets`, `storage.objects` policies               | migration                                                              |
| Prompt-injection fencing                       | `@tryggsignal/ai` `buildPrompt`, `sanitizeUntrustedContent` | `tests/unit/ai-safety.test.ts`                                         |
| Cross-authority AI retrieval guard             | `assertSameAuthority`                                       | same                                                                   |
| Secrets by reference only                      | `SecretProvider`, `credential_reference` check constraints  | `tests/unit/env.test.ts`, DB constraints                               |
| No secrets in `NEXT_PUBLIC_*`                  | `validateEnv` + ESLint rule                                 | `tests/unit/env.test.ts`, `pnpm lint`                                  |
| No RLS disabling in migrations                 | `scripts/sql-guard.mjs` in CI                               | `pnpm exec node scripts/sql-guard.mjs`                                 |
| Security headers + CSP                         | `apps/platform-web/next.config.ts`                          | build output                                                           |
| Host-bound session cookies                     | `tenantCookieName` (`__Host-` prefix, per tenant)           | `tests/unit/cache-key.test.ts`                                         |
| Tenant-scoped cache keys                       | `tenantCacheKey`                                            | same                                                                   |
| Inbound tenant header stripping                | `proxy.ts`                                                  | code review; the proxy deletes every `x-ts-*` header before resolution |
| SQL injection resistance in search             | parameterized `buildSearchQuery`                            | `tests/unit/search-query.test.ts`                                      |

## Findings

| Id     | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Status                                   |
| ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| SEC-01 | Info     | `platform.*` tables have RLS enabled with no policy, so they are unreachable with a client key. This is intentional (control-plane access is server-side only) but shows as INFO in the advisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Accepted, documented                     |
| SEC-02 | Medium   | No authentication flow exists yet, so no session can be issued and the session-fixation, CSRF and rate-limit tests that depend on it cannot run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Open — blocked on P38                    |
| SEC-03 | Medium   | Malware scanning is not implemented; `ingestion_status` has the `SCANNING` state but nothing performs the scan. Uploads therefore stay in quarantine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Open — needs a scanning provider (EB-08) |
| SEC-04 | Low      | Rate limiting (masterplan 84) is not implemented; it belongs with the auth and upload endpoints that do not exist yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Open — P38/P7 follow-up                  |
| SEC-05 | Low      | `TRUST_FORWARDED_HOST` is a deployment-level switch. It is off by default and documented, but a misconfiguration would let a proxy spoof the host.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Accepted with documentation              |
| SEC-11 | Low      | `public.resolve_tenant_host` is SECURITY DEFINER and executable by `anon`, which the advisor flags. It has to be: the proxy resolves a hostname before any session exists. It is the narrower of the two options — the alternative was exposing the whole `platform` schema to the browser key, which would have made `tenant_deployments` (a publishable key and a credential reference per municipality) readable. The function takes a hostname and returns routing statuses plus the slug, canonical hostname and data-plane reference for that one host; it returns no key and no credential reference, and it discloses nothing about a hostname that a visitor to that hostname would not already learn from their own browser. | Accepted, deliberate                     |
| SEC-12 | Info     | `config.processed_jobs` and `config.worker_runs` have RLS enabled with no policy, so they are unreachable with a client key. Deliberate, same pattern as SEC-01; the worker reaches them through a database role, not the API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Accepted, documented                     |

## Verified by the extended matrix

`tests/rls/authorization_matrix.sql` is GREEN across eleven subject types for
cases, documents and the search index, both directions of the cross-authority
leak test, case create/update/delete, quarantine enforcement, an applicant's
upload to their own case, that same applicant being refused on a secrecy-classified
document, document-version immutability, and the audit hash chain.

## Found by running the gates

Two defects were found by tests written for this review rather than by reading
the code, and both would have reached production:

- The proxy was never compiled, because the file sat at the package root instead
  of beside `src/app`. Every hostname fell through to the root page. Recorded as
  B-02 in `docs/blockers.md`; `tests/unit/proxy-placement.test.ts` guards it.
- With a control plane configured, every hostname that is not a platform surface
  returned 500, because PostgREST does not expose the `platform` schema. The fix
  narrowed the surface rather than widening it — see SEC-11 above and B-04.

## Not yet testable

IDOR/BOLA against a live HTTP API, SSRF and upload abuse still require endpoints
that do not exist (the document upload API and the integration inbound API).
A penetration test against a deployed environment has not been performed —
there is no deployed environment yet (EB-01). These are recorded here so P29
cannot be called GREEN before they run.
