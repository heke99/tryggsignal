# Architecture overview

## Shape

Modular monolith + asynchronous workers + municipal edge connector (masterplan 3).

```
tryggsignal.se            apps/marketing-web        public site
app.tryggsignal.se        apps/platform-web         tenant discovery / login gateway
kommuner.tryggsignal.se   apps/platform-web         municipality discovery
<kommun>.tryggsignal.se   apps/platform-web         municipality portal
<custom domain>           apps/platform-web         white-label municipality portal
                                 |
                                 |  proxy.ts: normalize host -> reserved host? -> verified
                                 |  tenant domain -> tenant context (headers) -> rewrite
                                 v
                    control plane (platform schema)
                                 |
                                 |  tenant -> deployment -> data plane
                                 v
                 municipality Supabase project (one per municipality)
                    organization / identity / authz / core / property /
                    documents / workflow / rules / … / audit
```

## Packages

| Package                      | Responsibility                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@tryggsignal/domain`        | Canonical types, provenance and value-conflict resolution (masterplan 20–24)                            |
| `@tryggsignal/authorization` | Permission catalog, role grants and the `can()` ABAC decision (16–17)                                   |
| `@tryggsignal/tenancy`       | Hostname normalization, reserved subdomains, `TenantResolver`, cache/cookie scoping (157–161, 180, 184) |
| `@tryggsignal/database`      | Supabase client factories, data-plane binding, control-plane tenant directory (171–174)                 |
| `@tryggsignal/config`        | Environment validation and the `SecretProvider` abstraction (85, 173)                                   |
| `@tryggsignal/observability` | Correlation/trace context and a redacting logger (86)                                                   |
| `@tryggsignal/worker`        | Queue catalog, job envelope and retry/dead-letter policy (42–44, 67)                                    |

## Request path for a municipality request

1. `proxy.ts` strips any inbound `x-ts-*` header.
2. The hostname is normalized (lowercase, port stripped, trailing dot removed, IDNA, format validated).
3. Reserved platform hosts (`app`, `kommuner`, `platform`, `admin`, apex, `www`) resolve first.
4. Otherwise the normalized hostname must match an **ACTIVE** row in `platform.tenant_domains`
   belonging to an **ACTIVE** tenant with an **ACTIVE** deployment. Anything else renders
   `/domain-not-found`.
5. The tenant context is forwarded as request headers and the request is rewritten into `/t/<slug>/…`,
   so a platform-only path can never be reached from a municipality domain.
6. Server components read the tenant from those headers only, never from query, body or cookie.
7. Data access uses the user's session against the tenant's own data plane, where RBAC/ABAC/RLS decide.

## Authorization

`authz.can(permission, resource)` in the database returns `{allowed, policy_id, reason}` and is used
directly by the RLS policy on `core.cases`. The same decision logic exists in
`@tryggsignal/authorization` for the application layer. Both are covered by tests:
`tests/rls/authorization_matrix.sql` (database) and `tests/unit/authorization.test.ts` (application).
