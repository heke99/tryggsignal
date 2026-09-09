# Integration data contracts and consistency gate

Scope: Phase H, `integration.*`, its privileged receipt/reconciliation RPCs and the inbound worker. This is not a production-wide certification of every business schema.

## One source of truth

`ExternalCase` is the normalized **source DTO**, not a second canonical case table. Source status remains source data; it must not directly overwrite `core.cases.status`, a workflow projection, or any human decision. Applying a source record requires the verified domain adapter, explicit field ownership and the canonical command transaction. `SHARED_MANUAL` conflicts require resolution; there is no implicit last-write-wins.

A transport receipt is not application success. The default inbound worker now validates connector **and** authority, preserves legitimately `PROCESSED` replays, and otherwise reports `EB-06` without changing the receipt when no verified application adapter exists. Canonical import, link validation, checkpoint advancement and event completion must commit together when that adapter is implemented. Source polling/transport tests do not establish live vendor availability.

## Table contract matrix

| Table                 | Identity and scope                       | Consistency / access                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data_sources`        | Global source registry, stable key       | Licensing/cache-rights constraints; catalog metadata only; RLS enabled.                                                                                                                                                                                         |
| `connectors`          | Global connector key                     | Explicit capabilities, no capabilities claimed by unimplemented transports; RLS enabled.                                                                                                                                                                        |
| `connector_instances` | Authority + connector + name             | Parent `(id, authority_id)` is unique; credentials are references; indexed connector FK.                                                                                                                                                                        |
| `field_ownership`     | Connector + entity + field               | Inherits authority through its single connector FK; unique ownership rule; no duplicate authority column.                                                                                                                                                       |
| `external_records`    | Connector + entity type + external ID    | Composite connector/authority FK; mapping/source provenance; raw payload is not browser-readable. `internal_id` is a provenance reference, not a new canonical entity. Its entity-type/authority/target validation belongs to the canonical import transaction. |
| `sync_jobs`           | Connector + idempotency key              | Composite connector/authority FK; nonnegative attempts; existing retry index retained.                                                                                                                                                                          |
| `integration_events`  | Connector + logical delivery key         | Composite scope FK; duplicate evidence consistency; raw payload/error columns are not granted to browser roles.                                                                                                                                                 |
| `sync_checkpoints`    | Connector + checkpoint key               | Inherits authority via connector FK; unique checkpoint identity; only successful complete processing may advance it.                                                                                                                                            |
| `reconciliation_runs` | Append-only run ID + connector/authority | Composite scope FK; full-snapshot counter partitions and GREEN truth enforced on the table and RPC; scope-bound history indexes.                                                                                                                                |

Every table in the integration schema is checked for a primary key, RLS and full FK-supporting indexes by `tests/integration/integration_consistency.sql`. The test fails on a new table/FK that does not meet the contract; it does not blindly create indexes for every column. Existing external identity, retry and history indexes remain in place. The gate also records an actual `EXPLAIN (ANALYZE, BUFFERS)` for the scope-bound event history query without disabling sequential scans or setting fragile timing thresholds.

## Canonical mapping and hashing

All collection readers reject malformed pages and missing identities before advancing a cursor. Invalid records are not silently discarded, and a missing collection is not treated as an empty source.

The H hash format serializes plain JSON with recursively sorted, locale-independent UTF-16 object-key ordering. Array order is significant. Unsupported values (undefined, non-finite or unsafe integer numbers, bigint, class instances, sparse arrays and cycles) are rejected rather than silently coerced. Source identifiers above JavaScript's safe integer range must be strings. This is a project-specific JSON hash format, **not** a claim of RFC 8785/JCS compliance. Mapping versions and historical hashes must not be silently rewritten on a future deployed format change.

SQL-read pages use an explicit outer order by the mapped external-ID column and strict integer cursors/page sizes. A production transport must hold a consistent source snapshot and use a database-enforced read-only account on approved views; keyword checks are defense in depth, not SQL authorization. SFTP lexical confinement requires a trusted/chrooted server-side export directory; it does not claim protection against a remote server changing symlinks between checks.

## RPC boundaries

`integration.receive_inbound_event` and `integration.record_reconciliation` are service-only, use a fixed empty search path, derive the authority from the selected connector and reject inactive connectors. Browser roles cannot call them. Privileged callers still cannot insert a child row for another authority: composite FKs enforce that below the RPC layer.

A receipt key replay must match the original event ID, event type, payload, source hash and mapping version. A mismatch raises `IDEMPOTENCY_CONFLICT`, does not mutate the original payload, and does not increment harmless duplicate evidence. Changing a mapping release does not create a new logical webhook event identity; reprocessing needs an explicit replay policy rather than an accidental duplicate insert.

A generic HTTP `409` is a conflict, not evidence that a write was previously applied. Only a verified source-specific contract can make that distinction.

## Reconciliation partitions

Full snapshots are required, scoped to one connector and one entity type. A partial page must not be submitted as a complete reconciliation. Duplicate tracked external IDs are rejected rather than collapsed into a Map.

```text
source_count = new_count + changed_count + unchanged_count + duplicate_source_count
tracked_count = changed_count + unchanged_count + missing_source_count
missing_internal_count <= changed_count + unchanged_count
```

All counters are nonnegative, non-null integers. `GREEN` is possible only when all drift/missing/duplicate counters are zero and the partitions hold. Reconciliation evidence is hashed into the service audit trail. Historical receipt is distinct from operational connector health and from verified canonical application.

## Rollout and verification

The H migration was merged in PR #22 (baseline `aa7ad5fe683c1e717864b115adfc7e414eb262db`). Follow-up consistency corrections are separate changes; historical migrations are not rewritten. Composite FKs validate pre-existing rows; inconsistent historical scopes block rollout instead of being repaired by guessing, deleted, or left `NOT VALID`. No production database is modified by these repository changes. Re-run the full clean Supabase replay, previous G gates, H gate, consistency gate, source verification and Playwright on the exact PR head before merge.

## Immutable receipt and history

Incoming H webhooks use a version-tagged JSON tuple event key (`event:v1:`), not separator-concatenated identifiers. Mapping version is separate provenance, never a new logical event identity. Existing legacy write-key generation is unchanged for backwards compatibility. A trigger prevents in-place modification of receipt identity, scope, original payload, hash, mapping version and receipt timestamp; retries may only update operational metadata. Reconciliation updates are rejected: each new result is a new historical run. Retention/deletion remains a separate privileged policy, not a client operation.

Signature verifiers receive optional unmodified `rawBody` bytes. A provider that signs raw HTTP bytes must require that buffer and reject its absence; reserializing parsed JSON is not equivalent. No live provider signature contract is invented here. The CSV adapter preserves quoted multiline records and escaped quotes, and rejects malformed quoting rather than shifting row boundaries.
