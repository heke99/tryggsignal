# Blockers

Updated 2026-09-07.

`BLOCKED` = internal technical dependency. `EXTERNAL_BLOCKED` = credential, license, vendor API
access, contract or external human decision that the agent cannot obtain. Never invent external
access to make a phase appear GREEN.

## EXTERNAL_BLOCKED

| Id    | Phase  | Blocker                                                                                                                                                        | What exists already                                                                         | Exact next external action                                                                                        |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| EB-01 | P37    | No Vercel project, no DNS control for `tryggsignal.se`, no TLS issuance                                                                                        | Domain data model, activation constraint, provisioning/rollback runbook, resolver and proxy | Create the Vercel project, point `*.tryggsignal.se` at it, then run `docs/runbooks/custom-domain-provisioning.md` |
| EB-02 | P1/P39 | Production Supabase projects per municipality do not exist; one project currently holds control plane and reference data plane                                 | Migrations are split so `platform` and the data-plane schemas can be applied separately     | Provision one project per pilot municipality in `eu-north-1` and record it in `platform.tenant_deployments`       |
| EB-03 | P15    | Lantmäteriet NGP and Geotorget (Fastighet, Byggnad, Belägenhetsadress) require a per-municipality agreement and credentials                                    | Provenance model, data-source classification, per-tenant credential reference               | Municipality orders Geotorget access; register the credential reference per data plane                            |
| EB-04 | P17    | Skatteverket Navet requires municipal authorization and legal basis; Bolagsverket requires an agreement                                                        | Party model with minimized personal data (`person_reference` only)                          | Municipality confirms legal basis and provides scoped credentials                                                 |
| EB-05 | P18    | Digital Post and Sweden Connect onboarding not started; OIDC must not be enabled against Sweden Connect before the official connection is available and tested | Identity provider column and per-tenant auth configuration reference                        | Start the Digg onboarding process for the pilot municipality                                                      |
| EB-06 | P28    | No named pilot customer, so no vendor product/version/API documentation to build against                                                                       | Generic connector contract and adapter slots                                                | Name the pilot municipality and obtain the vendor's API documentation and test environment                        |
| EB-07 | P20    | No AI provider decision or credentials                                                                                                                         | Provider-neutral design in ADR-005                                                          | Decide provider and data-processing terms, then supply credentials                                                |

| EB-08 | P7 | No malware-scanning provider is contracted, so uploads cannot leave quarantine | Quarantine-first ingestion state machine, immutable versions, SHA-256, private buckets | Choose a scanning service (or an on-prem scanner reachable from the worker) and supply credentials |

## BLOCKED

| Id   | Phase                       | Blocker                                                                                                                                                                                                                                          | Impact                                                                                                                                                                                                               | Remedy                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-01 | P30 and every database gate | The development data plane (`fjccdslnyyzhdjhkhcya`) ran out of disk during the P30 load test and Postgres is looping in crash recovery: `could not write to file "pg_wal/xlogtemp.NNNN": No space left on device`. It cannot accept connections. | Migrations already applied are intact on disk, but nothing can be run or verified against the database until it is back. The RLS matrix was GREEN before the incident; the policies added afterwards are unverified. | Increase the project's disk size in the Supabase dashboard (Settings → Compute and Disk). The volume expansion lets crash recovery finish. Then delete the synthetic rows (`delete from core.cases where case_number like 'PERF-%'`, and the `Perfkommun` legal entity and `perfworker@test.invalid` user) and re-run `tests/rls/authorization_matrix.sql` and the advisors. |

## Notes

- The P30 load test is what filled the disk. It was run on the same small project
  that carries the control plane, in one uninterrupted batch. `docs/performance.md`
  records what went wrong and how the test must be run instead.
- No production data has been copied anywhere. The only fixture in the control plane is the
  `demokommun` development tenant, whose domain is deliberately `PENDING` because no DNS or TLS
  verification has taken place.
- The masterplan's `vector` extension is intentionally not enabled: semantic search (P20) is not
  implemented, and masterplan 12 forbids enabling extensions without need.
