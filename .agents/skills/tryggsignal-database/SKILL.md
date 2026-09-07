---
name: tryggsignal-database
description: "Use before and after any Tryggsignal Postgres/PostGIS schema, migration, query, function, trigger, index or RLS change."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Database Gate

Use versioned SQL migrations only. Prefer constraints/FKs/checks/unique rules in Postgres for deterministic integrity. Keep business schemas separate from `public` where practical.

For every change verify:
1. ownership/source-of-truth and provenance requirements,
2. RLS and grants,
3. FK/index requirements,
4. query patterns and EXPLAIN/EXPLAIN ANALYZE where relevant,
5. migration replay/idempotent rollout,
6. rollback/expand-contract implications,
7. audit/history preservation,
8. migration/export portability.

Index real predicates, especially authority/user/team/status/deadline/source-id columns used by RLS and work queues. Use GiST for PostGIS, GIN for FTS, BRIN only for suitable large ordered event tables. Avoid blind over-indexing. Run Supabase advisors after DB/security changes.
