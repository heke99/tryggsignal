# Blockers

Updated 2026-09-07.

`BLOCKED` = internal technical dependency. `EXTERNAL_BLOCKED` = credential, license, vendor API
access, contract or external human decision that the agent cannot obtain. Never invent external
access to make a phase appear GREEN.

## EXTERNAL_BLOCKED

| Id    | Phase  | Blocker                                                                                                                                                        | What exists already                                                                                                            | Exact next external action                                                                                        |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| EB-01 | P37    | No Vercel project, no DNS control for `tryggsignal.se`, no TLS issuance                                                                                        | Domain data model, activation constraint, provisioning and rollback runbook, resolver and proxy                                | Create the Vercel project, point `*.tryggsignal.se` at it, then run `docs/runbooks/custom-domain-provisioning.md` |
| EB-02 | P1/P39 | Production Supabase projects per municipality do not exist; one project currently holds both the control plane and the reference data plane                    | Migrations are split so `platform` and the data-plane schemas can be applied separately                                        | Provision one project per pilot municipality in `eu-north-1` and record it in `platform.tenant_deployments`       |
| EB-03 | P15    | Lantmäteriet NGP and Geotorget (Fastighet, Byggnad, Belägenhetsadress) require a per-municipality agreement and credentials                                    | Provenance model, data-source classification with licence and caching rights, per-tenant credential reference                  | Municipality orders Geotorget access; register the credential reference per data plane                            |
| EB-04 | P17    | Skatteverket Navet requires municipal authorization and legal basis; Bolagsverket requires an agreement                                                        | Party model with minimized personal data (`person_reference` only)                                                             | Municipality confirms legal basis and provides scoped credentials                                                 |
| EB-05 | P18    | Digital Post and Sweden Connect onboarding not started; OIDC must not be enabled against Sweden Connect before the official connection is available and tested | Identity provider column, per-tenant auth configuration reference, delivery model with correlation ids                         | Start the Digg onboarding process for the pilot municipality                                                      |
| EB-06 | P28    | No named pilot customer, so no vendor product, version or API documentation to build against                                                                   | Generic connector contract and `ExternalBlockedConnector` slots that fail loudly                                               | Name the pilot municipality and obtain the vendor's API documentation and test environment                        |
| EB-07 | P20    | No AI provider decision or credentials, and no data-processing terms                                                                                           | Provider-neutral abstraction, prompt versioning, run and finding audit, injection defence, scope guard                         | Decide provider and data-processing terms, then supply credentials                                                |
| EB-08 | P7     | No malware-scanning provider, so uploads cannot leave quarantine                                                                                               | Quarantine-first ingestion state machine, immutable versions, SHA-256, private buckets, upload policies verified by the matrix | Choose a scanning service (or an on-prem scanner reachable from the worker) and supply credentials                |

## Resolved

| Id   | Blocker                                                                                                                                            | Resolution                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B-01 | The development data plane ran out of disk during the P30 load test and Postgres looped in crash recovery (`No space left on device` writing WAL). | The platform expanded the volume and recovery completed. The synthetic rows were deleted, `tests/rls/authorization_matrix.sql` re-ran GREEN — now covering documents, search and uploads as well — and both Supabase advisors re-ran with zero WARN/ERROR. `docs/performance.md` records what the test found and how it must be run next time. |

## Notes

- The P30 load test is what filled the disk. It ran on the same small project that
  carries the control plane, in one uninterrupted batch. It also found and led to
  the fix of a real RLS performance defect, which is recorded in
  `docs/performance.md` and in migration `20260907140000_p30_rls_performance.sql`.
- No production data has been copied anywhere. The only fixture in the control
  plane is the `demokommun` development tenant, whose domain is deliberately
  `PENDING` because no DNS or TLS verification has taken place.
- The masterplan's `vector` extension is intentionally not enabled: semantic
  search (P20) is not implemented, and masterplan 12 forbids enabling extensions
  without need.
