# Exit plan

Masterplan 90: vendor lock-in is not the product strategy.

## What the municipality gets back

| Asset                                         | Format                                                                       | How                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Cases, parties, properties, decisions, events | Canonical JSON                                                               | Export from the municipality's own Supabase project    |
| Full database                                 | PostgreSQL dump (`pg_dump`)                                                  | Direct connection to the municipality's project        |
| Documents                                     | Original files with SHA-256 manifest                                         | Storage export per bucket                              |
| Archive packages                              | FGS (Riksarkivet)                                                            | `archive.archive_exports` with `export_format = 'FGS'` |
| Database archive                              | SIARD where the municipality's archive requires it                           | `export_format = 'SIARD'`                              |
| Audit trail                                   | CSV/JSON including the hash chain                                            | `audit.events` export                                  |
| Configuration                                 | Workflow versions, rule sets, classifications, mappings — all stored as data | Included in the database export                        |
| Schema                                        | SQL migrations                                                               | The repository                                         |

## Guarantees

1. The municipality's data lives in the municipality's own Supabase project. A
   Tryggsignal contract ending does not move it.
2. No export requires Tryggsignal to run code the municipality cannot inspect;
   the migrations and the canonical model are in the repository.
3. Export formats are open and documented. The FGS version used is recorded on
   every archive package.
4. Deletion after exit follows the municipality's retention decision, not a
   supplier's default.

## Exit runbook (outline)

1. Freeze new intake; let in-flight cases reach a stable state.
2. Produce and verify the full export set above, including a checksum manifest.
3. Municipality verifies the export against its own counts (the reconciliation
   report in `migration.reconciliation_runs` works in this direction too).
4. Hand over credentials to the municipality's own project; Tryggsignal access is
   removed and the removal is audited.
5. Confirm in writing what was exported, what was deleted and when.
