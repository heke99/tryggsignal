# RLS / authorization test matrix

`authorization_matrix.sql` implements the masterplan 19 matrix: for every sensitive
table it asserts SELECT/INSERT/UPDATE/DELETE for anonymous, external applicant,
external representative, case worker, worker in another department, worker in
another authority, senior worker, decision maker, tenant admin, auditor and
service account.

The script runs entirely inside one transaction and rolls back, so it can be run
against a development data plane without leaving fixtures behind. It impersonates
roles the same way PostgREST does: `set local role authenticated` plus a JWT claim
carrying `sub`.

Run it against the development data plane:

```
psql "$DEV_DATA_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/rls/authorization_matrix.sql
```

Every assertion raises an exception on failure, so a non-zero exit means RED.
