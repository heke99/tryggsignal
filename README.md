# Tryggsignal

Tryggsignal är ett kommunalt Samhällsbyggnad OS för bygglov, PBL-tillsyn, OVK, dokument, workflow,
regler, integrationer, migration, AI-stöd och white-label kommunportaler.

## Låsta teknikval

- Next.js + TypeScript (strict)
- Vercel för webblagret
- Hosted Supabase per kommun/data plane
- PostgreSQL + PostGIS
- Supabase Auth, Storage, Queues/PGMQ och Cron
- RBAC + ABAC + RLS
- `.NET Worker Service` för on-prem/legacy connector
- Ingen Docker som krav i normal utveckling eller drift

## Domäner

| Domän                             | Yta                                        |
| --------------------------------- | ------------------------------------------ |
| `tryggsignal.se`                  | publik webbplats (`apps/marketing-web`)    |
| `app.tryggsignal.se`              | central app-/inloggningsgateway            |
| `kommuner.tryggsignal.se`         | kommunportal/tenant discovery              |
| `<kommun>.tryggsignal.se`         | standarddomän per kommun                   |
| t.ex. `samhallsbyggnad.mjolby.se` | verifierad custom domain, full white-label |

Allt serveras av en gemensam kodbas (`apps/platform-web`). Hostnamnet avgör tenant; se
`docs/architecture/overview.md`.

## Struktur

```
apps/        marketing-web, platform-web
packages/    domain, authorization, tenancy, database, config, observability
services/    worker
connectors/  municipal-edge-dotnet
supabase/    migrations, seed
tests/       unit, rls, database, integration, security, e2e, performance, migration
docs/        architecture, adr, api, integrations, migration, security, runbooks, procurement
```

## Kom igång

```bash
pnpm install
pnpm verify        # lint + typecheck + test
pnpm build         # bygger båda Next.js-apparna
```

Kopiera `.env.example` till `.env.local` och fyll i control plane-konfigurationen. Utveckling sker mot
hostade Supabase-projekt — inget steg kräver Docker eller `supabase start`.

### Databas

Migrationer ligger i `supabase/migrations/` och är forward-only. Se
`docs/runbooks/database-migrations.md`. Auktorisationsmatrisen körs med:

```bash
psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/rls/authorization_matrix.sql
```

## Agentstyrning

Läs `AGENTS.md` först. Den bindande masterplanen finns i `docs/MASTERPLAN_V3.md`.
Repo-skills finns under `.agents/skills/` och låses i `skills-lock.json`.

## Status

`docs/master-plan-status.md` visar fas-status och de gates som faktiskt körts.
Externa blockerare listas i `docs/blockers.md`. En fas blir aldrig `GREEN` utan verifierade tester.
