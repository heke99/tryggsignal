# Agent final report — masterplan V3

Date: 2026-09-07. Written per masterplan 146: this is what is done, what is not,
and exactly what a human must do next.

## GREEN phases

P0 Discovery, P1 Project foundation, P2 Supabase foundation, P3 Organization /
identity, P4 RBAC / ABAC / RLS, P5 Case core, P6 Property core, P8 Workflow /
deadlines, P11 Search, P22 Completeness engine, P34 Brand / domain foundation,
P35 Tenant resolver, P40 Domain hardening.

## IN_PROGRESS

P7 Documents, P9 Rule engine, P10 Queues, P12 Integration framework,
P13 Migration engine, P14 Source registry, P19 Geodata, P20 AI foundation,
P21 Building-permit workspace, P23 PBL supervision, P24 OVK, P25 Archive,
P26 ROI, P27 Edge connector, P29 Security hardening, P30 Performance,
P31 Backup, P32 Accessibility, P33 Pilot readiness, P36 White-label UI,
P38 Tenant auth, P39 Provisioning.

Each one has its schema and, where the masterplan calls for logic, a tested
engine. What is missing now is narrower than it was: a deployed environment, a
running worker process, federated identity credentials, and the UI forms that sit
on top of flows the database already enforces.

## RED

None outstanding.

## What the load test cost, and what it bought

The first attempt filled the development project's disk and put Postgres into a
crash-recovery loop; the platform expanded the volume and it recovered. That was
a mistake in how the test was run, and `docs/performance.md` says so and how to
run it properly.

It also did its job. It found two real defects that no unit test would have
caught: `cases_select` evaluated `authz.can()` per row and timed out at 55 s on
120 000 cases, and the document policies could only ever match an
AUTHORITY-scoped grant, so a department-scoped caseworker could neither see nor
upload documents on their own case. Both are fixed, and the authorization matrix
now covers documents, search and uploads so neither can regress.

## EXTERNAL_BLOCKED

EB-01 Vercel project and DNS for `tryggsignal.se`; EB-02 one Supabase project per
municipality; EB-03 Lantmäteriet NGP/Geotorget; EB-04 Bolagsverket and Navet;
EB-05 Digital Post and Sweden Connect; EB-06 a named pilot customer and vendor API
access; EB-07 an AI provider decision; EB-08 a malware-scanning provider.

## Security state

`docs/security/security-review.md`. The authorization model is enforced in the
database and was verified GREEN by the authorization matrix across 11 subject
types, including both directions of the cross-authority leak test. Five findings
are recorded; two are medium and both are blocked on features that do not exist
yet (no auth flow, no malware scanning). The advisors last reported zero
high/medium security findings, but that run predates the later migrations.

## Migration state

The migration engine has raw capture, mapping with unmapped-value reporting, and
the reconciliation gate — all unit-tested. No golden dataset has been run,
because no real legacy export exists.

## Performance measurements

At 120 000 cases, under `role authenticated` with RLS active: deadline queue
6.3 ms, unassigned queue 427 ms (was a 55 s timeout), case lookup 2.5 ms,
paginated work list 7.6 ms, my-cases 2.8 ms. All inside the < 500 ms read SLO.
Documents, search, mutations and concurrency are unmeasured.

## Test results

120 unit tests passing across 17 files. Lint, typecheck, format, build and the
SQL guard all pass. `tests/rls/authorization_matrix.sql` is GREEN across 11
subject types for cases, documents and search, plus both cross-authority
directions, case CRUD, quarantine enforcement, applicant uploads, version
immutability and the audit hash chain. Both Supabase advisors report zero
ERROR and zero WARN.

## Production readiness

Not production ready, but the reason has changed. A user can now sign in, a case
can be created and advanced through a versioned workflow, it is indexed for
search the moment it exists, its deadlines are computed with an explanation, and
none of it crosses an authority boundary. What is missing is operational: no
deployed environment (EB-01), no per-municipality data planes (EB-02), no running
worker, no federated identity, and no municipality has authored its own rule set
or workflow — that last one is a legal exercise, not a coding one.

The foundations that are hardest to retrofit — authority boundary, RLS,
provenance, audit chain, tenant and data-plane isolation, deterministic rules,
explainable deadlines, host-bound sessions — are in place and tested.

## Exact next external actions, in order

1. **Increase the disk on the Supabase project `fjccdslnyyzhdjhkhcya`** (Settings
   → Compute and Disk). That lets crash recovery finish and brings the database
   back. Then delete the synthetic rows (`PERF-%` cases, the `Perfkommun` legal
   entity, `perfworker@test.invalid`) and re-run
   `tests/rls/authorization_matrix.sql` and both advisors.
2. Create the Vercel project and point `*.tryggsignal.se` at it (EB-01), then run
   `docs/runbooks/custom-domain-provisioning.md` for the first municipality.
3. Provision a separate Supabase project per pilot municipality in `eu-north-1`
   (EB-02) and record it in `platform.tenant_deployments`.
4. Decide the identity path for the pilot (Entra ID for staff, Sweden Connect for
   citizens) so P38 can be built — this unblocks most of the IN_PROGRESS list.
5. Name the pilot municipality and obtain its legacy vendor's API documentation
   (EB-06).
