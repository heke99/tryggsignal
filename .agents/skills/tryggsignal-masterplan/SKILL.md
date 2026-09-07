---
name: tryggsignal-masterplan
description: "Use whenever starting, resuming, sequencing, reviewing or completing substantial Tryggsignal implementation work. This skill owns the masterplan execution loop and phase status."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Masterplan Execution

Read `docs/MASTERPLAN_V3.md`, every file referenced by its part index, `docs/master-plan-status.md`, `docs/blockers.md` and relevant ADRs before substantial work. Determine the next non-GREEN phase whose dependencies are satisfied.

For each phase: inspect current state → verify current official docs where external/versioned products are involved → implement the minimum correct delta → run relevant unit/DB/RLS/integration/E2E/performance tests → lint/typecheck/build → fix and rerun → update docs/ADR/status → continue.

Do not stop after one feature or one successful build while executable masterplan work remains. Do not mark a phase GREEN if any required gate is RED. If external credentials/licensing/vendor access is missing, record `EXTERNAL_BLOCKED`, complete interfaces/config/fixtures/error handling that can be built truthfully, then continue independent work.

Never weaken security to make progress, fabricate API behavior, or claim tests passed when they did not.
