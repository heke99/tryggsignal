# Performance — P30

## SLO targets (masterplan 53)

| Operation              | Target       |
| ---------------------- | ------------ |
| Normal read            | p95 < 500 ms |
| Simple mutation        | p95 < 700 ms |
| Search                 | p95 < 1 s    |
| Initial workspace load | < 2 s        |

AI may be slower but must never block case handling; heavy work is queued
(masterplan 144).

## What happened, in order

**Attempt 1 — dry run.** 120 000 synthetic cases generated inside a transaction
and rolled back. Clean.

**Attempt 2 — committed run.** The 120 000 cases were committed, then 480 000
document rows and 120 000 search rows were inserted in the same batch. This
**exhausted the project's disk**: `could not write to file
"pg_wal/xlogtemp.NNNN": No space left on device`, the startup process exited, and
Postgres entered a crash-recovery loop. The platform expanded the volume and
recovery completed about fifteen minutes later; the 120 000 cases survived, the
documents and search rows did not.

That was a mistake in how the test was run — one uninterrupted batch, on the same
small project that carries the control plane, without checking free space first.
No production data existed and nothing unrecoverable was lost.

**Attempt 3 — measurement on the surviving 120 000 cases.** This is what the
numbers below come from.

## Finding: the RLS policy did not scale (masterplan 51)

The first measured query timed out at 55 s. Cause: `cases_select` called
`authz.can()` **once per candidate row**. `can()` is a PL/pgSQL function running
several sub-queries, so the planner cannot inline it and must execute it per row.

Fix, in `supabase/migrations/20260907140000_p30_rls_performance.sql`:

1. The caller's grants are resolved **once per statement** into a `text[]` of
   scope keys (`authz.scope_keys(permission)`), and the policy does a cheap array
   overlap per row against `authz.case_scope_keys(...)`. `authz.can()` is
   unchanged and is still the explainable decision used by the API layer — the
   policy mirrors it, and `tests/rls/authorization_matrix.sql` proves the two
   agree across all eleven subject types.
2. The work queues got the partial indexes their predicates actually use.

## Measurements

120 000 cases, two authorities, senior caseworker with an AUTHORITY-scoped grant
(96 000 cases visible to them, 24 000 correctly invisible). Single run, warm
cache, measured server-side with `clock_timestamp()` under `role authenticated`.

| Query                                                          | Before              | After      | SLO                       |
| -------------------------------------------------------------- | ------------------- | ---------- | ------------------------- |
| Control tower — deadlines within 5 days (25 rows)              | —                   | **6.3 ms** | < 500 ms                  |
| Control tower — unassigned queue (25 rows)                     | timeout > 55 000 ms | **427 ms** | < 500 ms                  |
| Case lookup by case number                                     | —                   | **2.5 ms** | < 500 ms                  |
| Paginated work list, page 11 (limit 50 offset 500)             | —                   | **7.6 ms** | < 500 ms                  |
| My cases (25 rows)                                             | —                   | **2.8 ms** | < 500 ms                  |
| Count of all visible cases (deliberate full scan, 96 000 rows) | —                   | 728 ms     | not a user-facing pattern |

The RLS filter is visible in the result: the full-scan count returned 96 000 of
120 000 rows, and the lookup for `PERF-98765` — a case in the other authority —
returned zero.

## Caveats, stated plainly

- Single-run timings, not a p95 over a load profile. They show the order of
  magnitude and that the policy fix works; they are not a load test.
- The unassigned queue at 427 ms is inside the SLO but is the slowest real query.
  It sorts by `created_at` across the whole visible set; if a municipality's
  backlog grows, this is the first query to revisit.
- Documents and search were **not** measured at volume — that is the batch that
  filled the disk.
- No concurrency was tested. No mutation throughput was tested.

## How this test must be run next time

1. On a **separate, disposable project**, never the one carrying the control plane.
2. Check `pg_database_size()` and the disk allocation first, and size the target
   so the data plus WAL fits with margin.
3. Insert in batches of ~20 000 rows with a checkpoint between them.
4. Measure with `EXPLAIN (ANALYZE, BUFFERS)` and repeat runs for a p95, including
   documents, search and concurrent sessions.

## Status

P30 is `IN_PROGRESS`: the policy defect it was meant to find was found and fixed,
and the case-side queries now measure inside the SLO. It is not GREEN, because
documents, search, mutations and concurrency remain unmeasured.
