# Runbook — security and operational incidents

1. **Detect.** Sources: Supabase advisors, failed-job and dead-letter counts in the
   control tower, `audit.events` anomalies, domain health checks, customer report.
2. **Classify.** Severity 1 (municipal data exposed or lost), 2 (service down for a
   municipality), 3 (degraded), 4 (cosmetic).
3. **Contain.** For a suspected cross-tenant exposure: set the affected
   `platform.tenant_domains` row to `DISABLED`, which stops the host from
   resolving, and suspend the tenant if the data plane itself is implicated.
   Never disable RLS as a containment step.
4. **Preserve evidence.** `audit.events` is append-only and hash-chained; export
   the window before any remediation. Record the chain head hash in the incident
   record.
5. **Notify.** The affected municipality is the data controller. Personal-data
   breaches are reported by the municipality to IMY within 72 hours; Tryggsignal
   supplies the technical account without delay.
6. **Remediate and verify.** Fix, then re-run `tests/rls/authorization_matrix.sql`,
   the Supabase advisors and the affected phase's gates before reopening.
7. **Post-incident.** Written review within 5 working days: timeline, cause,
   contributing factors, corrective actions with owners, and a regression test
   that would have caught it.
