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

## Load test attempt 2026-09-07 — ABORTED, and what it cost

A synthetic load was generated directly in the development data plane:

1. 120 000 cases across two authorities with a realistic status/phase/deadline
   mix — **succeeded**, inserted and rolled back cleanly in a first dry run.
2. A second run committed the 120 000 cases, then inserted 480 000 document rows
   and 120 000 search-index rows in the same statement batch.

The second step **exhausted the project's disk**. Postgres logged
`could not write to file "pg_wal/xlogtemp.NNNN": No space left on device`, the
startup process exited, and the instance entered a crash-recovery loop that it
cannot complete without free space.

**This was a mistake in how the test was run, not a finding about the schema.**
The load was applied to the same small project that carries the control plane,
in one uninterrupted batch, without checking the available disk first and without
staging the inserts. No production data existed on the project, and no data was
lost that is not reproducible from `supabase/migrations` plus the dev seed.

## What must change before this test is repeated

1. Run the load test on a **separate, disposable project**, never on the project
   that carries the control plane.
2. Check `pg_database_size()` and the plan's disk allocation before starting, and
   size the target so the generated volume plus WAL fits with margin.
3. Insert in batches of ~20 000 rows with a checkpoint between batches, so WAL
   does not grow without bound in one transaction.
4. Measure with `EXPLAIN (ANALYZE, BUFFERS)` per query under an `authenticated`
   role with realistic RLS context, and record the plans here.

## Status

P30 is **RED**, not merely unstarted: the test was attempted and failed for
operational reasons, and the measurements the masterplan requires do not exist.
The index design it was meant to validate (masterplan 50/51) is in place and is
listed in `docs/architecture/overview.md`, but it is unmeasured under load.
