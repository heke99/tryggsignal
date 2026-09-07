# Runbook — database changes

Masterplan 6, 100, 136, 137.

1. Connect to the **development** data plane (hosted; no Docker, no `supabase start`).
2. Iterate the SQL against development and inspect the result.
3. Check the current Supabase CLI syntax with `--help` before generating anything — never guess the
   command.
4. Write the migration into `supabase/migrations/<timestamp>_<name>.sql` and commit it. Migrations are
   forward-only and idempotent where possible.
5. Apply it to development, then run:
   - `pnpm test` (application),
   - `psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/rls/authorization_matrix.sql`,
   - the Supabase security and performance advisors.
6. Fix every high-severity security finding before proceeding. Performance findings are triaged:
   index the predicates that RLS and the work queues actually use, not every foreign key.
7. Roll out to test, then to each municipality data plane, recording `schema_version` in
   `platform.tenant_deployments`.

Never run manual production-only SQL, and never disable RLS to make a migration pass.
