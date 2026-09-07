# Tryggsignal Agent Instructions

## Source of truth

1. User instructions always take precedence.
2. Read `docs/MASTERPLAN_V3.md` and every referenced masterplan part before substantial architecture or implementation work.
3. Read `docs/master-plan-status.md`, `docs/blockers.md`, and relevant ADRs before changing an existing phase.
4. Repository skills live under `.agents/skills/`.
5. Do not declare work complete while a relevant test gate is RED or executable masterplan work remains.

## Mandatory skill routing

Before Supabase/Auth/RLS/Storage/Queues/Cron work:
- `.agents/skills/supabase/SKILL.md`
- `.agents/skills/supabase-postgres-best-practices/SKILL.md`
- `.agents/skills/tryggsignal-database/SKILL.md`
- `.agents/skills/tryggsignal-security/SKILL.md`

Before Next.js/App Router work:
- `.agents/skills/nextjs/SKILL.md`
- `.agents/skills/react-best-practices/SKILL.md`

Before Vercel deployment or environment changes:
- `.agents/skills/deployments-cicd/SKILL.md`
- `.agents/skills/vercel-api/SKILL.md`
- `.agents/skills/env-vars/SKILL.md`

Before tenant routing, wildcard domains, custom domains or branding:
- `.agents/skills/tryggsignal-whitelabel/SKILL.md`
- `.agents/skills/tryggsignal-security/SKILL.md`
- `.agents/skills/vercel-api/SKILL.md`

Before external API/legacy integration work:
- `.agents/skills/tryggsignal-integration/SKILL.md`

Before legacy migration/import/export:
- `.agents/skills/tryggsignal-migration/SKILL.md`

Before PBL/OVK/process-rule changes:
- `.agents/skills/tryggsignal-pbl/SKILL.md`

After user-facing UI changes:
- `.agents/skills/agent-browser-verify/SKILL.md`
- `.agents/skills/verification/SKILL.md`
- `.agents/skills/react-best-practices/SKILL.md`

Before a phase may turn GREEN:
- `.agents/skills/tryggsignal-e2e/SKILL.md`
- `.agents/skills/tryggsignal-security/SKILL.md`
- `.agents/skills/tryggsignal-performance/SKILL.md` when performance-sensitive code changed

## Execution loop

For each masterplan phase:
1. Inspect current state.
2. Verify current official documentation for changing external products/APIs.
3. Identify delta.
4. Implement the minimum correct change.
5. Run relevant unit/database/RLS/integration/E2E/performance tests.
6. Run lint, typecheck and build.
7. Fix failures and rerun until GREEN.
8. Update ADR/docs/status.
9. Continue to the next independent phase without asking whether to continue.

If external credentials, licenses or vendor access are missing, record `EXTERNAL_BLOCKED`, build everything that can be correctly built without fabricating live behavior, and continue with independent work.

## Hard prohibitions

Never disable RLS as a workaround. Never expose service-role keys. Never fabricate API results, legal rules, migration success or test success. Never use cross-tenant shared cache keys for tenant-specific data. Never trust hostname alone without resolving it to a verified active tenant and its assigned data plane.
