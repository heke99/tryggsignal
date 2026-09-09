# Master Plan Status

Last updated: 2026-09-09.

Status is evidence-based. A phase is only `GREEN` when its own implemented gate has passed.
External credentials, production domains, vendor access, paid project creation and a real pilot are
never simulated to make the plan look complete. See `docs/blockers.md` and
`docs/security/security-review.md`.

## Current remediation result

The corrected execution order A → B → C → R has now been implemented on the remediation PR.

- **A — status/repo truth:** stale blockers/security text corrected; `db:status` implemented; database is healthy.
- **B — tenant data plane:** tenant case-data has no control-plane fallback. Runtime requires an exact
  hostname/tenant/deployment/project match and fails closed.
- **C — auth/session:** password auth is bound to the tenant's configured provider/data plane; access and
  refresh cookies are host-only; token validity is checked against Auth; refresh/logout/revocation and
  distributed login rate limiting are implemented.
- **R — release gate:** automatic `main` production deploys are disabled for both app projects. The new
  Release Gate runs source verification, clean migration replay, RLS/integration matrices and Playwright
  before a manual production deployment may run.

The first full Release Gate run is GREEN. Production itself is deliberately not marked GREEN while
EB-01/EB-02 remain.

## Gate results

| Gate                         | Result                   | Evidence                                                                                                            |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Fast source gate             | GREEN                    | Release Gate #9: format, lint, typecheck, 165/165 unit tests, both Next.js builds, SQL guard.                       |
| Migration replay             | GREEN                    | All migrations replayed from zero in disposable local Supabase.                                                     |
| Authorization / RLS          | GREEN                    | Extended authorization matrix passed in disposable database.                                                        |
| DB integrations              | GREEN                    | Runtime, branding/provisioning, worker runtime and tenant runtime isolation matrices passed.                        |
| Playwright E2E               | GREEN                    | Production build/proxy E2E suite passed in Release Gate.                                                            |
| Tenant runtime isolation     | GREEN (logic)            | Synthetic A/B host/deployment/auth/rate-limit matrix passed and rolled back; physical two-project gate still EB-02. |
| Live db status               | GREEN                    | Tryggsignal live RPC reports ok=true, 10/10 queues, required RPCs present, RLS-unprotected tables=0.                |
| Supabase security advisor    | GREEN with accepted WARN | 0 critical/high; only the two documented SECURITY DEFINER warnings for pre-auth resolve_tenant_host.                |
| Supabase performance advisor | IN_PROGRESS              | No WARN/ERROR from current advisor result; INFO foreign-key/index findings will be workload-evaluated in P30.       |
| Production deployment        | BLOCKED                  | Release workflow is ready, but intended Vercel domain topology/production tenant are not ready (EB-01/EB-02).       |

## Live infrastructure truth

- Supabase `Tryggsignal` is `ACTIVE_HEALTHY` in `eu-north-1`.
- `demokommun` is the only control-plane fixture. It is DEV; its ACTIVE/HEALTHY deployment points back
  to the same Tryggsignal Supabase project.
- `demokommun.tryggsignal.se` remains PENDING/UNVERIFIED with DNS/TLS UNKNOWN. It is not a
  production-ready tenant.
- Marketing owns `tryggsignal.se` and `www.tryggsignal.se`.
- The wildcard `*.tryggsignal.se` is still attached to `tryggsignal-platform-web-3eti`, not the intended
  `tryggsignal-platform-web`.
- There are not yet two physically separate municipality Supabase data planes. That is EB-02.

## Phases

| Phase                               | Status           | Notes                                                                                                                                                                                                    |
| ----------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 Discovery & Baseline             | GREEN            | Baseline report exists and is current enough for implementation work.                                                                                                                                    |
| P1 Project Foundation               | GREEN            | Strict TS workspace, lint/format/Vitest, SQL guard, CI and release gate are runnable.                                                                                                                    |
| P2 Supabase Foundation              | GREEN            | Schemas/extensions/default-deny foundation; migrations now replay cleanly from an empty disposable Supabase database.                                                                                    |
| P3 Organization / Identity          | GREEN            | Organization hierarchy, users and memberships with RLS.                                                                                                                                                  |
| P4 RBAC / ABAC / RLS                | GREEN            | Permission/role model, authz.can(), audit chain and break-glass; extended authorization matrix GREEN.                                                                                                    |
| P5 Case Core                        | GREEN            | Canonical case model, indexes and RLS.                                                                                                                                                                   |
| P6 Property Core                    | IN_PROGRESS      | Property graph/provenance exists and replay/RLS gates pass; operational property UI remains in Phase G.                                                                                                  |
| P7 Document Engine                  | IN_PROGRESS      | Immutable versions, quarantine-first model and Storage/RLS are verified; real upload + malware scan remains, EB-08.                                                                                      |
| P8 Workflow / Deadlines             | GREEN            | Versioned runtime, transitions/tasks/timers and deadline calculator are implemented; runtime integration test GREEN.                                                                                     |
| P9 Rule Engine                      | IN_PROGRESS      | Deterministic/effective-dated engine with evidence is tested; representative municipal ruleset still needed.                                                                                             |
| P10 Queues / Jobs                   | GREEN            | Ten durable PGMQ queues, runnable worker, idempotency, retries, heartbeat, dead letters and run log; worker integration GREEN.                                                                           |
| P11 Search                          | GREEN            | Scoped read model, query builder and trigger-maintained search index; RLS/runtime integration GREEN.                                                                                                     |
| P12 Generic Integration Framework   | GREEN            | Phase H verifies REST, File, SFTP and SQL-read adapters, SOAP/webhook slots, canonical mapping/provenance, duplicate receipt, reconciliation, RLS, health and SERVICE audit in clean replay.             |
| P13 Migration Engine                | IN_PROGRESS      | Raw capture, mapping and reconciliation exist; golden dataset run not completed.                                                                                                                         |
| P14 National Source Registry        | IN_PROGRESS      | Source/licence/cache/freshness registry exists; no real national source is GREEN yet.                                                                                                                    |
| P15 Lantmäteriet                    | EXTERNAL_BLOCKED | EB-03.                                                                                                                                                                                                   |
| P16 Boverket                        | EXTERNAL_BLOCKED | Data model exists; real API access/adapter verification remains.                                                                                                                                         |
| P17 Bolagsverket / Navet            | EXTERNAL_BLOCKED | EB-04.                                                                                                                                                                                                   |
| P18 Digital Post / Identity         | EXTERNAL_BLOCKED | EB-05; Sweden Connect production access must not be fabricated.                                                                                                                                          |
| P19 Geodata Enrichment              | IN_PROGRESS      | Spatial model/source registry exist; production adapter remains.                                                                                                                                         |
| P20 AI Foundation                   | IN_PROGRESS      | Provider abstraction, prompt/run/finding/review and safety tests exist; real provider/DPA remains EB-07.                                                                                                 |
| P21 Building Permit Workspace       | GREEN            | Phase G operational workspace is complete; Gate G runs one synthetic BYGGLOV from command-based creation through COMPLETE assessment, referral and accountable human decision.                           |
| P22 Completeness Engine             | GREEN            | COMPLETE / INCOMPLETE / HUMAN_REVIEW with evidence is tested.                                                                                                                                            |
| P23 PBL Supervision                 | GREEN            | G9 operational supervision flow is integration-tested: risk, inspection, findings/evidence, actions, follow-up, close and isolation.                                                                     |
| P24 OVK                             | GREEN            | G10 operational OVK flow is integration-tested: object/due state, CLEAN protocol evidence, findings, supervision linkage and isolation.                                                                  |
| P25 Archive / FGS                   | IN_PROGRESS      | Retention/legal hold/package/export models exist; FGS writer/validation remains.                                                                                                                         |
| P26 ROI / Analytics                 | IN_PROGRESS      | Operational metrics rollup exists and integration test is GREEN; production analytics surface remains.                                                                                                   |
| P27 Legacy Edge Connector           | IN_PROGRESS      | .NET connector source exists but has not yet passed dotnet restore/build/tests.                                                                                                                          |
| P28 First Real Vendor Connector     | EXTERNAL_BLOCKED | EB-06.                                                                                                                                                                                                   |
| P29 Security Hardening              | IN_PROGRESS      | No critical/high Supabase advisor finding; two intentional host-resolver WARNs documented. Full endpoint/pentest matrix remains.                                                                         |
| P30 Performance                     | IN_PROGRESS      | Database recovered after prior load incident; earlier RLS defect fixed. Representative disposable-project load test is still required.                                                                   |
| P31 Backup / Recovery               | IN_PROGRESS      | Runbook/RPO/RTO exist; DB + Storage restore drill not yet completed.                                                                                                                                     |
| P32 Accessibility                   | IN_PROGRESS      | Structural Playwright/contrast checks pass; full WCAG 2.2 AA keyboard/focus/forms/zoom/screen-reader gate remains.                                                                                       |
| P33 Pilot Readiness                 | IN_PROGRESS      | Procurement/runbook material exists; real pilot Global DoD not completed.                                                                                                                                |
| P34 Brand / Domain Foundation       | GREEN            | Control-plane domain/branding model, activation and contrast constraints.                                                                                                                                |
| P35 Tenant Resolver                 | GREEN            | Hostname normalization/reserved hosts/proxy placement and pre-auth narrow host RPC are verified.                                                                                                         |
| P36 White-label UI                  | IN_PROGRESS      | Versioned branding publish/rollback DB functions and validation exist; real editor/asset/runtime branding product flow remains.                                                                          |
| P37 Custom Domains                  | EXTERNAL_BLOCKED | Vercel projects exist, but wildcard is on the duplicate platform project; intended platform bindings, DNS/TLS/provider health remain EB-01.                                                              |
| P38 Tenant Auth / Session Isolation | IN_PROGRESS      | Exact tenant runtime/auth config, password login, network token validation, host-only access+refresh cookies, refresh/logout and distributed login limiter implemented; Entra/SAML/OIDC runtime remains. |
| P39 Tenant Provisioning             | IN_PROGRESS      | State machine/branding provisioning tests are GREEN; automated Supabase/domain orchestrator and real second data plane remain.                                                                           |
| P40 Domain / White-label Hardening  | IN_PROGRESS      | Existing domain/E2E matrix is GREEN, but P40 cannot be GREEN before P36-P39 and two-real-data-plane isolation are complete.                                                                              |

## Phase H generic integration completion

**Phase H / P12 is GREEN.** The generic connector layer has one canonical mapping/provenance
contract across REST, File, SFTP and SQL-read. SOAP remains an explicit capability-empty slot until a
verified WSDL/auth contract exists, while inbound webhook events use the same idempotent durable
receipt boundary.

The H gate verifies:

- truthful connector capabilities;
- deterministic source hash and mapping version provenance;
- File, SFTP and SQL-read transport behavior;
- service-only raw inbound receipt;
- duplicate delivery produces one durable event plus duplicate evidence;
- reconciliation transitions connector health between `DEGRADED` and `HEALTHY`;
- SERVICE audit evidence for receipt, duplicates and reconciliation.

No vendor-specific or national API behavior is fabricated by the generic adapters.

## Phase G operational completion

**Phase G is GREEN for the implemented product/runtime gates.** G1–G11 each pass their dedicated
integration test in a clean disposable Supabase replay. The final Gate G additionally proves one
synthetic `BYGGLOV` through the integrated command path:

`create → assign → applicant → property → COMPLETE → workflow review → referral send/response → decision draft/review → authorized human approve/decide → final DECIDED workflow state`.

After creation, the Gate G business flow does not directly mutate the operational case,
case-party links, case-property links, completeness assessments, referrals, workflow state or
decisions. Those transitions use the product command boundaries and their RLS/authz checks.

This does **not** convert external blockers into green. In particular, real Sweden Connect
production access, a production malware-scanner provider/worker deployment, physical multi-project
tenant evidence and production domain/provider prerequisites remain tracked blockers for their
later/global gates.

## Test suites

| Suite                   | Command / file                                     | Verified scope                                                                               |
| ----------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Unit                    | pnpm test                                          | 21 files / 165 tests GREEN.                                                                  |
| End-to-end              | pnpm test:e2e                                      | Built platform proxy, routing/isolation/security headers/accessibility structure GREEN.      |
| RLS matrix              | tests/rls/authorization_matrix.sql                 | Cross-authority/tenant scope, cases, documents, search, uploads and audit controls.          |
| Runtime                 | tests/integration/runtime.sql                      | Workflow, search indexing, OVK and metrics.                                                  |
| Worker                  | tests/integration/worker_runtime.sql               | Queue delivery, claim/idempotency/retry/heartbeat/dead-letter/run log.                       |
| Branding / provisioning | tests/integration/branding_and_provisioning.sql    | Publish/rollback, provisioning state machine and offboarding safeguards.                     |
| Tenant runtime          | tests/integration/tenant_runtime.sql               | Exact hostname/deployment/project/auth isolation plus distributed rate limiter.              |
| Gate G                  | tests/integration/gate_g_building_permit.sql       | Complete synthetic BYGGLOV from command-based creation to accountable human decision.        |
| Phase H integrations    | tests/integration/generic_integration_adapters.sql | Generic catalog, duplicate receipt, provenance, reconciliation, health and SERVICE audit.    |
| Release gate            | .github/workflows/release.yml                      | Source verification + migration replay + SQL matrices + Playwright before production deploy. |

## What is still required for MASTERPLAN V3 Global DoD

The corrected implementation sequence is complete through H. The next planned work begins at I, followed by J → K → L → M → N → O → P → Q → T.

Global DoD still requires, among other things:

- two municipality data planes operating simultaneously with zero cross-tenant route/session/cache/data leak;
- production domain verification/TLS and a real custom-domain lifecycle;
- tenant provisioning/orchestration and complete white-label runtime;
- required generic adapters and a golden migration dataset;
- at least one real national integration and one real/representative municipal connector;
- real AI provider only after provider/DPA decision;
- FGS package validation;
- full endpoint security hardening;
- representative disposable-project load test;
- real DB and Storage restore drill;
- full WCAG 2.2 AA critical-flow gate;
- a real pilot municipality and procurement/exit/support/offboarding verification.

Only after those evidence gates pass may the masterplan be marked fully GREEN.
