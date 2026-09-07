# Runbook — backup, recovery, RPO and RTO

Masterplan 131. Targets below are the design targets for the pilot; each one is
marked with whether it has been verified.

| Asset           | Mechanism                                                                                                  | RPO target                  | RTO target  | Verified                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- | ----------- | -------------------------------------------------- |
| Database        | Supabase automated backups + PITR where the plan provides it                                               | 5 min (PITR) / 24 h (daily) | 2 h         | Not yet — needs a restore drill on a pilot project |
| Storage objects | Separate reconciliation and secondary copy (`docs/runbooks/storage-restore.md`)                            | 24 h                        | 4 h         | Not yet — pipeline not implemented                 |
| Queue state     | PGMQ lives in the database, so it is covered by the database backup                                        | as database                 | as database | Not yet                                            |
| Control plane   | Same as database, on the control-plane project                                                             | 5 min                       | 1 h         | Not yet                                            |
| Configuration   | In Git (`supabase/migrations`, workflow and rule definitions are data and are backed up with the database) | 0                           | minutes     | Yes — migrations replay from the repository        |

## Restore drill (to be run per pilot municipality before go-live)

1. Restore the database to a scratch project at a chosen point in time.
2. Replay `supabase/migrations` on an empty project and confirm the schema matches
   the restored one (`migration replay GREEN`).
3. Restore Storage per `storage-restore.md` and run the reconciliation report.
4. Replay the queues: confirm that jobs archived before the restore point are not
   reprocessed into duplicates — the idempotency key makes this safe.
5. Run `tests/rls/authorization_matrix.sql` against the restored database.
6. Record the actual RPO and RTO achieved, and update the table above.

## Rollback of a bad migration

Migrations are forward-only. A bad migration is corrected by a new migration
(expand/contract), never by editing a released one. If data was lost, restore to
a point in time before the migration and replay.
