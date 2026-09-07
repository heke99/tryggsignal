---
name: tryggsignal-performance
description: "Use when Tryggsignal queries, RLS, search, dashboards, imports, queues, file handling or API latency may affect scalability or SLOs."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Performance Gate

Measure representative traffic before and after optimization. Targets from masterplan: normal read p95 <500 ms, simple mutation p95 <700 ms, search p95 <1 s, initial workspace target ~2 s where realistic. AI/background work must not block ordinary case handling.

Check: N+1, selected columns, keyset pagination, RLS query cost, DB connections/pool mode, dashboard fan-out, search index usage, PostGIS predicates, queue backlog, file upload routing and cache scope. Use EXPLAIN ANALYZE and pg_stat_statements for DB changes.

Performance fixes must not weaken authorization or provenance. Prefer read models/materialized summaries for dashboards and async queues for OCR, AI, migration, archive/report generation and heavy geodata sync.
