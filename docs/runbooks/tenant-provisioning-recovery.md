# Tenant provisioning recovery

This runbook covers Masterplan V3 P39 tenant provisioning failures and safe reruns.

## Invariants

- A tenant remains `PROVISIONING` until its provisioning run reaches `READY`.
- `READY` requires a verified ACTIVE Tryggsignal fallback domain and a HEALTHY ACTIVE production data plane with a recorded schema version.
- Provisioning requests use a stable idempotency key. Retrying the same request must return the same tenant and provisioning run.
- A production tenant has at most one deployment per environment.
- Control-plane rows store secret references, never database passwords, secret API keys, or service-role values.
- An offboarded tenant or released hostname must not be silently reused.

## Failure handling

1. Identify the provisioning run by `idempotency_key`, `correlation_id`, tenant id, and current `state`.
2. Inspect `last_error`, attempt count, domain state, deployment health, schema version, and the external provider project status.
3. Do not advance the run manually past a failed prerequisite.
4. If the run is `FAILED`, fix the underlying provider/schema/domain issue and move it back to `REQUESTED`. This increments `attempt_count`.
5. Rerun using the same idempotency key. Do not invent a new key to work around a failed run.

## Common recovery cases

### Supabase project was never created

- Confirm that the Management API has no project for the intended provisioning operation.
- Correct organization, quota, billing, credentials, or provider availability.
- Retry the same provisioning operation.

### Supabase project exists but is not healthy

- Keep the tenant non-servable.
- Poll project health until required services report `ACTIVE_HEALTHY`.
- Do not register the deployment as HEALTHY before provider health proves it.

### Project exists but schema migration failed

- Keep the run before `SCHEMA_APPLIED`.
- Inspect the failed migration and apply a forward fix through the normal migration pipeline.
- Replay the complete migration set against a disposable project/database before retrying the tenant.
- Record the resulting schema version only after the migration succeeds.

### Data plane registered but domain is not ready

- Keep the run before `READY`.
- Repair platform-domain ownership/DNS/TLS state.
- `READY` must remain blocked until the fallback domain is `ACTIVE`, ownership is `VERIFIED`, DNS is `OK`, and TLS is `ISSUED`.

### Worker lost its response after a successful step

- Retry the same state checkpoint. `advance_provisioning` is idempotent when the requested state already matches the current state.
- Retry data-plane registration with the same tenant/environment/project. The upsert must return the existing deployment rather than creating a duplicate.

## Rollback policy

Provisioning is recovered by forward repair and idempotent rerun, not by blindly restoring a production database.

Supabase is stateful. PITR or restore-point rollback can remove data written after the recovery point and must not be used as a generic provisioning retry mechanism. For an already serving production tenant, database rollback requires an explicit incident decision and a separate data-loss assessment.

For a newly created, non-serving orphan provider project:

1. Confirm no `ACTIVE` control-plane deployment references the project.
2. Confirm the tenant has never reached `READY` and has not served municipal data.
3. Revoke/delete any provider credentials or secret references associated with the orphan.
4. Remove the orphan provider resource through the approved provider administration path.
5. Keep the failed provisioning run/audit metadata for traceability; retry with the same logical onboarding/idempotency key after the orphan is resolved.

## Verification before closing recovery

- one tenant for the slug,
- one provisioning run for the idempotency key,
- one production deployment for the tenant,
- expected schema version,
- provider services healthy,
- fallback domain verified and active,
- branding configuration present,
- tenant reaches `READY` once,
- rerunning the same operation changes no identities or resource counts,
- clean replay, RLS/integration gates, and tenant isolation tests are GREEN.
