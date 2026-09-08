# Runbook — tenant provisioning, recovery and rollback

Masterplan 192–194 / P39.

## Goal

A municipality is never considered ready because a single API call returned success. Provisioning is
an ordered, persisted workflow. Every external operation is either idempotent or preceded by a
provider lookup that makes retries safe.

The canonical step order is:

1. CREATE_TENANT
2. RESERVE_SLUG
3. CREATE_TENANT_DEPLOYMENT
4. CREATE_SUPABASE_PROJECT
5. WAIT_UNTIL_READY
6. APPLY_BASE_MIGRATIONS
7. ENABLE_REQUIRED_EXTENSIONS
8. APPLY_AUTHORIZATION
9. SEED_SYSTEM_ROLES
10. CREATE_BRANDING_DRAFT
11. ENABLE_PLATFORM_DOMAIN
12. CONFIGURE_AUTH
13. RUN_HEALTH_CHECK
14. RUN_SECURITY_SMOKE
15. RUN_TENANT_ISOLATION
16. MARK_CUSTOMER_TEST_READY
17. PROMOTE

`platform.tenant_provisioning_steps` is the execution journal. The business checkpoint in
`tenant_provisioning_runs.state` remains separate from `run_status`, which describes whether the
execution is PENDING, RUNNING, SUCCEEDED, FAILED, EXTERNAL_BLOCKED or ROLLED_BACK.

## Idempotency rules

- Every onboarding request has a stable idempotency key.
- The same key returns the same tenant and provisioning run.
- The platform tenant, fallback domain and initial branding draft are created with unique constraints
  and `not exists` guards.
- Supabase project creation must use a deterministic project name. Before POST `/v1/projects`, the
  provider lists projects in the intended organization. An exact existing match is reused. Multiple
  matches are an incident and stop the run.
- A provisioning step already marked SUCCEEDED is skipped by the orchestrator on rerun.
- A provider retry increments the step attempt counter and the run retry counter.
- Raw database passwords, service-role keys and Management API tokens are never persisted in the
  control plane. Only SecretProvider references are stored.

## External blocks

Use EXTERNAL_BLOCKED rather than FAILED when the code is healthy but a human/provider prerequisite
is missing, for example:

- Supabase organization/cost approval,
- Vercel production-environment approval,
- municipality DNS change,
- Entra/Sweden Connect onboarding.

An EXTERNAL_BLOCKED run can be resumed. Previously SUCCEEDED steps are not re-executed.

## Data-plane creation

For a real municipality:

1. Resolve the approved Supabase organization and cost before creating a paid project.
2. Generate a unique high-entropy database password and store it in the approved secret provider.
3. Call the Management API through `SupabaseManagementProvider.ensureProject`.
4. Poll project health until required services report `ACTIVE_HEALTHY`.
5. Obtain/enable a modern publishable API key. Never store a secret API key in
   `platform.tenant_deployments`.
6. Apply the repository's ordered base migrations. If the Management API migrations endpoint is not
   enabled for the account, execute the same immutable migration set through the approved CI/CLI
   channel and record the step as EXTERNAL_BLOCKED until that channel exists.
7. Run the authorization matrix and security advisor against the new data plane before promotion.
8. Register only the final project ref, publishable key, region, schema version, health status and a
   privileged credential *reference* in the control plane.

## Recovery

### Provider timeout during CREATE_SUPABASE_PROJECT

Do not issue another blind create request. Resume the run. `ensureProject` first discovers the
deterministic project identity and reuses it if the first call actually succeeded.

### Migration failure

Keep the tenant non-serving. Record FAILED on APPLY_BASE_MIGRATIONS or the exact later migration
step. Fix forward with a new immutable migration and retry from that step. Do not edit an already
applied production migration.

### Domain failure

The tenant's domain stays non-ACTIVE until ownership, DNS and TLS are all verified. Follow
`custom-domain-provisioning.md`. A failed custom domain must never remove the platform fallback.

### Health/security smoke failure

Do not promote. Keep the run RUNNING/FAILED as appropriate, record the failing evidence and remediate
before MARK_CUSTOMER_TEST_READY or PROMOTE.

## Rollback / compensating actions

Provisioning rollback is compensation, not destructive database rewind.

- Branding draft: leave unpublished or supersede later.
- Platform/custom domain: disable routing; preserve the platform fallback and release tombstone.
- Auth configuration: disable it and revoke its credential reference.
- Supabase project: pause/quarantine the project when appropriate; do not delete it automatically.
- Deployment registration: mark SUSPENDED/DECOMMISSIONED only after evidence/export requirements are
  met.
- Tenant: use the offboarding workflow. Never hard-delete a municipality from an automated rollback.

`ProvisioningOrchestrator.rollback` runs only explicit rollback handlers in reverse order and records
ROLLED_BACK on those steps. Irreversible or legally sensitive cleanup stays manual/audited.

## Gate

P39 is internally GREEN only when all of the following pass on the same head:

- first synthetic municipality request creates exactly one tenant/run,
- rerun with the same idempotency key creates no duplicate tenant/domain/branding/deployment,
- canonical 17 execution steps are seeded,
- out-of-order steps are refused,
- failed and external-blocked checkpoints can resume without repeating succeeded work,
- early SUCCEEDED is refused,
- explicit rollback state is persisted,
- clean migration replay, authorization/RLS, integrations and Playwright are GREEN.

A real second municipality data plane remains EB-02 until its organization/cost and physical project
are explicitly approved and provisioned.
