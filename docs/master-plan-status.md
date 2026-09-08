# Master Plan Status

Last updated: 2026-09-07.

Status may only be one of `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `EXTERNAL_BLOCKED`, `RED`, `GREEN`.
A phase becomes `GREEN` only when its gate has actually passed. See `docs/blockers.md` for
external dependencies and the current database incident, and `docs/baseline-report.md`
for the P0 baseline.

## Gate results

| Gate                                 | Result                                              | When                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                          | GREEN                                               | 2026-09-07, after the final change                                                                                                                                                      |
| `pnpm typecheck`                     | GREEN                                               | same                                                                                                                                                                                    |
| `pnpm test` (120 tests)              | GREEN                                               | same                                                                                                                                                                                    |
| `pnpm build` (both Next.js apps)     | GREEN                                               | same                                                                                                                                                                                    |
| `pnpm format`                        | GREEN                                               | same                                                                                                                                                                                    |
| `node scripts/sql-guard.mjs`         | GREEN                                               | same                                                                                                                                                                                    |
| `tests/rls/authorization_matrix.sql` | GREEN                                               | run twice against the development data plane, before and after the policy merge — **covers the case matrix only**; the document, storage and search policies added later are unverified |
| Supabase security advisor            | 0 high/medium (8 INFO on `platform.*`, intentional) | before the later migrations; not re-run since                                                                                                                                           |
| Supabase performance advisor         | 0 WARN after merging duplicate permissive policies  | same                                                                                                                                                                                    |
| P30 load test                        | **RED** — aborted, filled the project's disk        | see `docs/performance.md`                                                                                                                                                               |

**The development data plane is currently unavailable** (blocker B-01). Everything that
needs the database is therefore unverifiable right now, including the advisors and the
authorization matrix for the policies added after the case matrix run.

## Phases

| Phase                               | Status           | Notes                                                                                                                                                        |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0 Discovery & Baseline             | GREEN            | `docs/baseline-report.md`                                                                                                                                    |
| P1 Project Foundation               | GREEN            | workspace, TS strict, lint, format, Vitest, CI, SQL guard, env validation                                                                                    |
| P2 Supabase Foundation              | GREEN            | 22 schemas, extensions, default-deny grants, migrations applied and committed                                                                                |
| P3 Organization / Identity          | GREEN            | hierarchy, `identity.users`, memberships, RLS                                                                                                                |
| P4 RBAC / ABAC / RLS                | GREEN            | 15 permissions, 18 roles, scoped assignments, `authz.can()`, audit hash chain, break glass; matrix GREEN                                                     |
| P5 Case Core                        | GREEN            | canonical model, masterplan-50 indexes, RLS via `can()`                                                                                                      |
| P6 Property Core                    | IN_PROGRESS      | properties, identifiers, addresses, buildings, spatial features, relations with PostGIS and provenance — RLS unverified since B-01                           |
| P7 Document Engine                  | IN_PROGRESS      | documents, immutable versions, quarantine-first ingestion, buckets and Storage policies — malware scan missing (EB-08), policies unverified since B-01       |
| P8 Workflow / Deadlines             | IN_PROGRESS      | schema and the explainable deadline calculator are done and unit-tested; the workflow runtime that advances instances is not built                           |
| P9 Rule Engine                      | IN_PROGRESS      | deterministic engine with effective dating and evidence is implemented and tested; no municipal rule set has been authored                                   |
| P10 Queues / Worker / Cron          | IN_PROGRESS      | ten durable PGMQ queues, envelope-checked enqueue, four cron sweeps live; worker batch loop implemented and tested, but no deployed worker process           |
| P11 Search                          | IN_PROGRESS      | read model, tsvector/trigram indexes, scoped RLS policy, parameterized query builder; indexing pipeline not built                                            |
| P12 Generic Integration Framework   | IN_PROGRESS      | contract, generic REST adapter, idempotency, field ownership, sync/event tables; SOAP, SFTP and SQL adapters are slots                                       |
| P13 Migration Engine                | IN_PROGRESS      | raw capture, mapping, reconciliation implemented and tested; no golden dataset run                                                                           |
| P14 National Source Registry        | IN_PROGRESS      | registry with licence, caching rights and freshness; cache-rights trigger enforced                                                                           |
| P15 Lantmäteriet                    | EXTERNAL_BLOCKED | EB-03                                                                                                                                                        |
| P16 Boverket                        | EXTERNAL_BLOCKED | `compliance.energy_declarations` ready; API key required                                                                                                     |
| P17 Bolagsverket / Navet            | EXTERNAL_BLOCKED | EB-04                                                                                                                                                        |
| P18 Digital Post / Identity         | EXTERNAL_BLOCKED | EB-05                                                                                                                                                        |
| P19 Geodata Enrichment              | IN_PROGRESS      | `property.spatial_features` and the source registry are in place; no adapter built                                                                           |
| P20 AI Foundation                   | IN_PROGRESS      | provider abstraction, prompt versioning, runs/findings/reviews, injection defence and scope guard all implemented and tested; no provider contracted (EB-07) |
| P21 Building Permit Workspace       | IN_PROGRESS      | case workspace and control tower render from the tenant data plane; blocked on auth for real data                                                            |
| P22 Completeness Engine             | GREEN            | COMPLETE / INCOMPLETE / HUMAN_REVIEW with evidence, 13 tests including the undecidable case                                                                  |
| P23 PBL Supervision                 | IN_PROGRESS      | inspections, findings and evidence schema; no supervision workflow                                                                                           |
| P24 OVK                             | IN_PROGRESS      | obligations, obligation rules, compliance objects with next-due; no due-date computation job                                                                 |
| P25 Archive / FGS                   | IN_PROGRESS      | retention, legal holds, packages, exports, disposition with approval constraint; no FGS writer                                                               |
| P26 ROI / Analytics                 | IN_PROGRESS      | metric and ROI event model with deadline-miss events emitted by the sweep; no rollup job                                                                     |
| P27 Legacy Edge Connector           | IN_PROGRESS      | .NET outbound channel and envelope written but **never compiled** — no .NET SDK in this environment                                                          |
| P28 First Real Vendor Connector     | EXTERNAL_BLOCKED | EB-06                                                                                                                                                        |
| P29 Security Hardening              | IN_PROGRESS      | `docs/security/security-review.md` — 5 findings, 2 medium, both open and blocked on features that do not exist yet                                           |
| P30 Performance                     | RED              | load test aborted and filled the disk; see `docs/performance.md`                                                                                             |
| P31 Backup / Recovery               | IN_PROGRESS      | runbook and RPO/RTO targets written; no restore drill has been performed                                                                                     |
| P32 Accessibility                   | IN_PROGRESS      | contrast gate enforced and tested, semantic markup, skip link, focus; no screen-reader or axe run                                                            |
| P33 Pilot Readiness                 | IN_PROGRESS      | architecture, security, DPIA support, exit plan, SLA draft, API and integration catalogs, incident process, runbooks written                                 |
| P34 Brand / Domain Foundation       | GREEN            | control-plane model with activation and contrast constraints                                                                                                 |
| P35 Tenant Resolver                 | GREEN            | resolver, normalization, reserved hosts, `src/proxy.ts` (placement guarded by a test after it silently disabled routing in production); 33 unit tests        |
| P36 White-label UI                  | IN_PROGRESS      | token model, WCAG validation, CSS variable rendering and admin view; editor, preview and publish flow not built                                              |
| P37 Custom Domains                  | EXTERNAL_BLOCKED | EB-01                                                                                                                                                        |
| P38 Tenant Auth / Session Isolation | IN_PROGRESS      | host-bound cookie naming, per-tenant auth reference, data-plane binding; no login flow                                                                       |
| P39 Tenant Provisioning             | IN_PROGRESS      | provisioning state machine and dev seed; no automated workflow                                                                                               |
| P40 Domain / White-label Hardening  | GREEN            | 20-case domain and cross-tenant matrix (masterplan 201–204) passing, plus security headers and CSP                                                           |
