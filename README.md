# Tryggsignal

Tryggsignal är ett kommunalt Samhällsbyggnad OS för bygglov, PBL-tillsyn, OVK, dokument, workflow, regler, integrationer, migration, AI-stöd och white-label kommunportaler.

## Låsta teknikval

- Next.js + TypeScript
- Vercel för webblagret
- Hosted Supabase per kommun/data plane
- PostgreSQL + PostGIS
- Supabase Auth, Storage, Queues/PGMQ och Cron
- RBAC + ABAC + RLS
- `.NET Worker Service` för on-prem/legacy connector
- Ingen Docker som krav i normal utveckling eller drift

## Domäner

- `tryggsignal.se` — publik webbplats
- `app.tryggsignal.se` — central app/inloggningsgateway
- `kommuner.tryggsignal.se` — kommunportal/tenant discovery
- `<kommun>.tryggsignal.se` — standarddomän per kommun
- custom domain, t.ex. `samhallsbyggnad.mjolby.se` — full white-label

## Agentstyrning

Läs `AGENTS.md` först. Den bindande masterplanen finns i `docs/MASTERPLAN_V3.md`.
Repo-skills finns under `.agents/skills/` och låses i `skills-lock.json`.

## Status

Utvecklingen ska följa masterplanens fas-gates och `docs/master-plan-status.md`. En fas blir aldrig `GREEN` utan verifierade tester.
