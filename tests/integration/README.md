# Integration tests

SQL integration tests that exercise the database runtime end to end. Each script
runs inside one transaction and rolls back, so it leaves no fixtures behind.

| Script                          | Covers                                                                                                                                                                         | Last verified    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `runtime.sql`                   | search indexing by trigger, workflow start/advance/materialize with an undeclared transition refused, OVK due-date computation, metrics rollup                                 | 2026-09-07 GREEN |
| `branding_and_provisioning.sql` | provisioning state machine including the READY preconditions, branding publish blocked without contrast validation, supersede and rollback, offboarding with domain tombstones | 2026-09-07 GREEN |

Run them against a development data plane:

```bash
psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/runtime.sql
psql "$CONTROL_PLANE_URL"  -v ON_ERROR_STOP=1 -f tests/integration/branding_and_provisioning.sql
```

The authorization matrix lives separately in `tests/rls/authorization_matrix.sql`.
