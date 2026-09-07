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

| Id     | Severity | Finding                                                                                                                                                                                          | Status                                   |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| SEC-01 | Info     | `platform.*` tables have RLS enabled with no policy, so they are unreachable with a client key. This is intentional (control-plane access is server-side only) but shows as INFO in the advisor. | Accepted, documented                     |
| SEC-02 | Medium   | No authentication flow exists yet, so no session can be issued and the session-fixation, CSRF and rate-limit tests that depend on it cannot run.                                                 | Open — blocked on P38                    |
| SEC-03 | Medium   | Malware scanning is not implemented; `ingestion_status` has the `SCANNING` state but nothing performs the scan. Uploads therefore stay in quarantine.                                            | Open — needs a scanning provider (EB-08) |
| SEC-04 | Low      | Rate limiting (masterplan 84) is not implemented; it belongs with the auth and upload endpoints that do not exist yet.                                                                           | Open — P38/P7 follow-up                  |
| SEC-05 | Low      | `TRUST_FORWARDED_HOST` is a deployment-level switch. It is off by default and documented, but a misconfiguration would let a proxy spoof the host.                                               | Accepted with documentation              |

## Verified by the extended matrix

`tests/rls/authorization_matrix.sql` is GREEN across eleven subject types for
cases, documents and the search index, both directions of the cross-authority
leak test, case create/update/delete, quarantine enforcement, an applicant's
upload to their own case, that same applicant being refused on a secrecy-classified
document, document-version immutability, and the audit hash chain.

## Not yet testable

OWASP-style testing of authenticated endpoints, IDOR/BOLA against a live API,
CSRF, SSRF and upload abuse all require the authentication flow and the file
endpoints. They are recorded here so P29 cannot be called GREEN before they run.
