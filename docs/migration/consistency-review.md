# Phase I foundation and cross-module consistency review

Status: IN_PROGRESS. This change is based on phase H commit `c2cc56df73c12d1292ae208bff0137b38a8fdc60`. It does not certify H–T, activate a provider, apply a live migration, or complete the golden dataset import.

## Corrected contracts

Migration batches, raw objects, errors and reconciliation runs previously held independent parent and authority foreign keys. Valid IDs could therefore still describe incompatible scopes. Forward migration `20260909121500_i_migration_consistency.sql` enforces source/authority, batch/authority and object/batch/authority together. A batch-level error with a null object ID remains valid. Existing inconsistent rows stop rollout; no ownership is guessed and no evidence is deleted.

Raw captures now own a detached immutable JSON snapshot and verify the checksum before mapping. Integration and migration share a single JSON codec in the domain package, without adding a Node-only dependency to that shared package. Valid phase H JSON hashes retain their bytes. Prototype properties, accessors, lossy values, duplicate mapping targets and provenance overwrites are rejected.

New captures explicitly use `canonical-json-v1`. Historical captures without a codec use `json-stringify-v1` for verification only. Historical hashes are not automatically rewritten. A historical payload whose original serialized order cannot be recovered must remain blocked for explicit evidence recovery, not silently recertified. Persistent writers must store the returned codec alongside the checksum. The capture helper is not proof that a database write happened.

The database guards raw identity, payload, checksum and codec against updates, and mapping versions against in-place edits. Stage and canonical linkage may advance independently. The database enforces checksum syntax, not an independent reimplementation of the JavaScript JSON codec. Raw hash verification remains mandatory at the import boundary.

Reconciliation rejects negative, fractional or unsafe counts in TypeScript. Database counters are nonnegative and GREEN must agree with counts, hashes, missing records, broken relations, unmapped values and orphan documents. Raw migration error messages and details are no longer browser-readable; scoped operational metadata remains available under the existing RLS policy.

## Verification and indexes

The release workflow retains every existing G/H, authorization, worker, tenant, domain, build and Playwright gate. It additionally runs `migration_consistency.sql` and `schema_catalog.sql` against the disposable clean Supabase replay.

Migration tests use synthetic fixtures, valid and invalid scope relationships, immutable evidence checks, counter checks and browser grant checks. The fixtures and planner data are rolled back. EXPLAIN ANALYZE BUFFERS records the actual plan for a bounded source-identity query; no index is forced and no production latency is inferred.

The catalog gate checks project tables for primary keys, RLS, validated constraints, valid indexes and pinned privileged RPC search paths. It also prints explicit review inventories for foreign-key index coverage, authority relationships and logical IDs. Those inventories are candidates requiring semantic review and measured queries, not automatic repair instructions. Extension-owned tables are excluded. A passing structural baseline is not a claim that every logical ID or production query is optimal.

The new indexes cover scoped batch/object/error/reconciliation access and the mapping author foreign key. Existing identity, canonical and hash indexes are preserved. Before live rollout, review actual volumes, lock duration, query plans and redundant-index candidates. The migration has a bounded lock acquisition timeout; large installations need an approved maintenance or expand/contract rollout rather than an unreviewed daytime schema change.

## Remaining phase I and H–T work

Phase I still requires the persistent golden dataset pipeline, interrupted import/restart, idempotent canonical application, document-byte hash verification, relation checks and a complete reconciliation report. Provider-dependent phases remain separate: real national data, AI/provider approval, FGS validation, municipal edge integration, production security and performance, restore drill, accessibility and the pilot/global definition of done.

The connected Supabase project list did not expose Tryggsignal during this review. No other project's database is a substitute. Live schema parity, real data consistency and Supabase advisors require the correct Tryggsignal data plane before they can be marked verified.

Verification evidence belongs to the exact PR head. The earlier green phase H run is not evidence for these changes. Do not mark this phase GREEN until its new gates and the retained regression suite have actually passed.
