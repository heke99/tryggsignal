# P0 — Baseline and gap report

Date: 2026-09-07

## Repository baseline (before this iteration)

The repository contained the masterplan (`docs/MASTERPLAN_V3.md` plus `docs/masterplan-v3/part-01..09.md`),
agent skills under `.agents/skills/`, `AGENTS.md`, `README.md`, an empty pnpm workspace manifest and
placeholder directories. There was **no application code, no packages, no migrations, no tests and no CI**.
`docs/master-plan-status.md` listed every phase as `NOT_STARTED`, which matched reality.

Consequently there were no existing tests or builds to execute, and no legacy or dead code to remove.

## Supabase baseline

- Project `Tryggsignal` (`fjccdslnyyzhdjhkhcya`), region `eu-north-1`, Postgres 17 — matches the
  masterplan's standard region for Swedish municipalities.
- Zero tables in every schema; only Supabase defaults (`pgcrypto`, `uuid-ossp`, `pg_stat_statements`,
  `supabase_vault`) were installed. `postgis`, `pg_trgm`, `pgmq`, `pg_cron` and `vector` were available
  but not enabled.
- Two other projects exist in the same organization (`Kundexa`, `Fastighetsvard`, both `eu-west-1`);
  they are unrelated to Tryggsignal and were not touched.

## Gap list at baseline

Every phase P0–P40 was a gap. The gaps addressed in this iteration are P0–P5 (with the P6 property
anchor), the audit and break-glass foundation, and P34/P35 for domains, branding and tenant
resolution. The remaining phases are listed in `docs/master-plan-status.md` with their current status,
and external dependencies are listed in `docs/blockers.md`.

## Note on control plane vs. data plane in this environment

Only one Supabase project exists today, so it currently carries **both** the control-plane schema
(`platform`) and the reference data-plane schemas (`organization`, `identity`, `authz`, `core`,
`property`, `audit`, …). ADR-001 requires a separate project per municipality in production; the
schema split is already in place so a municipality data plane can be provisioned by applying the
non-`platform` migrations to its own project.
