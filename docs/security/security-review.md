# Security review — P29

Date: 2026-09-08. Scope: implemented code plus live Supabase/Vercel verification performed
while executing the corrected Masterplan V3 remediation.

## Controls in place

| Control                                        | Where                                                                         | Verification                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Hostname → tenant routing                      | `TenantResolver`, `public.resolve_tenant_host`                                | unit/E2E baseline; RPC exposes routing fields only                                           |
| Exact tenant data-plane binding                | service-role-only `resolve_tenant_runtime` + `assertDeploymentMatchesContext` | deployment id + project-ref regression tests; no control-plane fallback                      |
| Tenant auth configuration binding              | service-role-only `resolve_tenant_auth_config`                                | password flow now refuses an unconfigured/different provider                                 |
| Authentic server-side session check            | `tenantClient().auth.getUser(token)`                                          | cookie presence is no longer treated as authentication                                       |
| Host-only access + refresh cookies             | `sessionCookie`, `refreshSessionCookie`                                       | unit tests; no Domain attribute                                                              |
| Session refresh/revocation                     | `/auth/refresh`, local Supabase sign-out                                      | implemented; protected layouts validate before rendering                                     |
| Distributed auth rate limiting                 | `platform.rate_limit_buckets`, `consume_rate_limit`                           | one atomic control-plane counter shared by Vercel instances; raw IP is HMACed before storage |
| Authority boundary / RBAC / ABAC / RLS         | `authz.*` and RLS policies                                                    | extended authorization matrix baseline GREEN                                                 |
| Upload quarantine / immutable versions         | document schema + storage policies                                            | matrix/constraints; malware scan still blocked                                               |
| AI scope/injection controls                    | `@tryggsignal/ai`                                                             | unit tests                                                                                   |
| Secret references / no `NEXT_PUBLIC_*` secrets | `EnvSecretProvider`, env validator                                            | unit + SQL constraints                                                                       |
| SQL migration guard                            | `scripts/sql-guard.mjs`                                                       | CI                                                                                           |
| Security headers / CSP                         | platform Next config                                                          | build                                                                                        |
| Inbound tenant-header stripping                | `src/proxy.ts`                                                                | routing code + E2E baseline                                                                  |

## Findings

| Id     | Severity              | Finding                                                                                                                                                                                                                                                                                                                                                            | Status                                                        |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| SEC-01 | Info                  | Server-only control-plane/worker tables use RLS with no client policy. Supabase reports these as informational `rls_enabled_no_policy` findings.                                                                                                                                                                                                                   | Accepted, deliberate default-deny                             |
| SEC-02 | Medium                | Federated staff auth is incomplete. Password auth is tenant-bound and the refresh/session lifecycle is now implemented, but Entra ID, SAML and general OIDC runtime/callback validation are not implemented end-to-end.                                                                                                                                            | Open — P38 IN_PROGRESS                                        |
| SEC-03 | Medium                | Malware scanning is not implemented; quarantined uploads cannot become production-clean.                                                                                                                                                                                                                                                                           | Open — EB-08                                                  |
| SEC-04 | Medium                | Production rate limiting is only fully distributed for the current password-login flow. Upload, public submission, search, AI and export must use the same distributed mechanism when their real endpoints are wired.                                                                                                                                              | Open — P29/P7/P20 follow-up                                   |
| SEC-05 | Low                   | `TRUST_FORWARDED_HOST` is deployment-controlled; setting it incorrectly widens host-spoofing risk.                                                                                                                                                                                                                                                                 | Accepted with deployment documentation                        |
| SEC-11 | Low                   | `public.resolve_tenant_host` is an anonymous/authenticated `SECURITY DEFINER` RPC, so the Supabase advisor emits two WARN entries. This is intentional for pre-auth hostname resolution. The function returns only one hostname's routing/status fields and no key/credential reference. Runtime deployment/auth RPCs are separately restricted to `service_role`. | Accepted, deliberate; keep narrow and regression-test output  |
| SEC-12 | Info                  | Worker/idempotency runtime tables are server-only and intentionally have no client RLS policy.                                                                                                                                                                                                                                                                     | Accepted                                                      |
| SEC-13 | High if misconfigured | Tenant runtime now requires `CONTROL_PLANE_SECRET_REFERENCE` and a server-only referenced service credential. Missing configuration fails closed with `DEPLOYMENT_UNAVAILABLE`; exposing the credential through a public env would be a security incident.                                                                                                         | Mitigated in code; production env must be configured/verified |
| SEC-14 | Medium                | A real two-data-plane isolation test cannot run until EB-02 is resolved. The current control plane has only the `demokommun` DEV fixture, whose deployment points to the same Tryggsignal project; there are still no two separate municipality data planes.                                                                                                                                                                                                                              | Open — EB-02                                                  |

## Current Supabase advisor result

Re-run on 2026-09-08 after the current schema changes:

- no reported critical/high advisor finding;
- two WARN entries both refer to the intentional `public.resolve_tenant_host`
  `SECURITY DEFINER` exposure (anon + authenticated);
- informational no-policy findings are dominated by deliberately server-only
  tables;
- performance advisor still reports many unindexed foreign keys and unused
  indexes that must be evaluated during P30 rather than mass-added/removed
  without workload evidence.

## Still required before P29 can be GREEN

Real HTTP/API testing remains required for IDOR/BOLA, upload abuse, CSRF, XSS,
SSRF, open redirect, host/tenant spoofing, cookie confusion, cache poisoning,
secret/dependency scanning, rate-limit bypass, prompt injection and malicious
files. A deployed two-tenant environment and the real upload/integration
endpoints are prerequisites for several of these checks.
