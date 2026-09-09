# H–I consistency follow-up — 2026-09-09

## Scope and baseline

Baseline: merged PR #22, `aa7ad5fe683c1e717864b115adfc7e414eb262db`.
The corrections below preserve existing receipt/idempotency keys and migration hash formats.
No existing SQL migration is changed. This review is not a declaration that H–T or production is complete.

## Corrections

- File/SFTP readers validate an entire listing before reading files, reject missing array entries,
  invalid paths/sizes and empty or non-advancing cursors. Large mapped record batches are appended
  iteratively, avoiding the JavaScript argument-count overflow reproduced with 150,000 records.
  File contents are still buffered; this is not a streaming importer.
- Source mapping rejects sparse case collections rather than silently dropping records.
- Webhook input rejects array payloads and event types shorter than the database contract permits;
  original signature bytes and existing logical event identity are retained.
- Legacy migration mapping reads own properties only, rejects reserved output fields and does not
  mistake inherited lookup members for configured mappings.
- Migration reconciliation rejects negative, fractional, non-finite and unsafe integer counts.
  Equality of invalid counts must never establish a green result.
- The H catalog gate asserts exact composite scope references, delete policies, non-null scope,
  primary keys, RLS, expected RPC overloads, privileges and full FK-supporting btree indexes.
- Release verification now executes and retains a read-only inventory of all business schemas.
  Candidate missing/overlapping indexes are review findings, not automatic DDL or proof of a
  production performance problem. The report identifies its checked commit and disposable scope.
- Local Supabase runtime credentials are masked in CI and its complete credential-bearing status
  is no longer printed on error.
- Integration rollout documentation now distinguishes merged H from this follow-up.

## Verification contract

The 27 regression cases live in `tests/support/h-i-consistency-cases.ts` and are exercised by
`tests/unit/h-i-consistency-regressions.test.ts`. The prior isolated replay showed 18 newly written
regression cases failing on the original source and all 27 passing on the corrected source.
Those are regression comparisons, not a historical GitHub CI failure count.

Required before merge: formatter, lint, strict workspace typecheck, complete unit suite, both
Next.js builds, SQL guard, clean Supabase migration replay, all previous G/H/RLS/runtime matrices,
the new catalog gate and Playwright. The authoritative execution result is the Release Gate on
the proposed head, not this document. Missing or failing gates must not be represented as passed.

## Further work and unverified boundaries

The connected Supabase project list does not expose Tryggsignal in this session. No other
project is used as a substitute. Hosted catalog drift, production query plans and workload
measurements therefore remain unverified. Clean CI replay is useful but not a hosted database audit.

Phase I still requires durable RAW capture, rerunnable canonical import and a golden-dataset
reconciliation through actual database command boundaries. The legacy in-memory helpers alone do
not establish persistence, cutover safety or successful import. Production file streaming, source
snapshot consistency and vendor-specific application remain separate gates.

The municipal .NET transport must also be reviewed for consistency with H: a generic HTTP 409 is
not proof of prior successful delivery, and receipt acceptance is not canonical application.
Physical tenant isolation, vendor licences, AI provider/DPA, production scanner deployment,
DB plus Storage restore drills, accessibility and pilot acceptance retain their own gates.
