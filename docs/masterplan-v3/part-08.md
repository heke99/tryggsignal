- se deployment version,
- se schema version,
- se connector health,
- hantera feature flags,
- initiera support access enligt break-glass,
- se säker driftmetadata.

Platform admin ska inte automatiskt ha tillgång till kommunens ärendedokument.

---

# 198. KOMMUNADMIN

Kommunadmin ska kunna:

- hantera användar-/rollkoppling inom tillåtet scope,
- branding,
- custom domain onboarding,
- lokala integrationsinställningar,
- SSO metadata,
- kontaktinformation,
- tenant feature config,
- templates där tillåtet.

Kommunadmin får inte kunna ändra:

- plattformens security invariants,
- andra tenantdata,
- centrala systemroller på ett sätt som kringgår RLS,
- systemets auditlogg.

---

# 199. WHITE-LABEL SEO / INDEXERING

Operativa systemytor ska normalt:

```text
noindex
```

inklusive:

- login,
- handläggning,
- Mina sidor,
- tenant admin.

Publika servicesidor kan indexeras endast enligt explicit produktbeslut.

Undvik duplicate SEO content mellan:

```text
<kommun>.tryggsignal.se
```

och kommunens custom domain.

Custom canonical domain ska styra canonical metadata där public indexing används.

---

# 200. DOMÄNSÄKERHETSHEADERS

Konfigurera lämpligt:

```text
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
Strict-Transport-Security
frame-ancestors
```

CSP ska inte öppnas globalt för att en kommun önskar godtyckligt script.

White-label ska fungera inom samma säkra CSP-modell.

---

# 201. DOMAIN/TENANT TEST MATRIX

Skapa automatiserade testfall minst för:

```text
tryggsignal.se
app.tryggsignal.se
kommuner.tryggsignal.se
tenant-a.tryggsignal.se
tenant-b.tryggsignal.se
verified custom domain A
verified custom domain B
unknown subdomain
disabled subdomain
unverified custom domain
removed custom domain
```

Verifiera:

```text
tenant resolution
branding
Supabase project resolution
auth config
authorization
cache isolation
redirect
canonical
404/error
```

---

# 202. CROSS-TENANT NEGATIVE TESTS

Detta är release-blockerande.

Testa att tenant A aldrig kan få:

- tenant B branding,
- tenant B authconfig,
- tenant B Supabase URL via privileged response,
- tenant B case data,
- tenant B search results,
- tenant B documents,
- tenant B signed URL,
- tenant B cache response,
- tenant B notifications,
- tenant B integration config.

Testa både genom:

```text
URL manipulation
Host manipulation
query parameter
body tenant_id
stale cookie
stale cache
direct API request
```

---

# 203. CUSTOM DOMAIN AUTH TESTS

Testa:

- login,
- logout,
- callback,
- expired state,
- wrong state,
- wrong tenant callback,
- old disabled domain callback,
- custom→fallback redirect,
- fallback→custom redirect,
- multi-tenant staff user.

---

# 204. WHITE-LABEL VISUAL E2E

Efter brandingändring:

Kör browser verification på minst:

- login,
- dashboard,
- case workspace,
- citizen portal,
- mobile viewport.

Kontrollera:

- logotyp,
- favicon,
- färger,
- text,
- contrast,
- layout,
- console errors,
- broken images.

---

# 205. VERCEL PREVIEW STRATEGY FÖR TENANTS

Preview deployments får inte använda produktionskommunens riktiga data plane.

Preview ska kopplas till:

- testdata plane,
- preview Supabase branch/project,
- syntetisk tenant config.

Tenant routing i preview ska testas med dedikerad test-hostmodell eller verifierad preview-routing.

Aldrig:

```text
Preview Vercel
→ Production municipality DB
```

som standard.

---

# 206. DOMAIN DEPLOYMENT GATE

Ingen custom domain får markeras `ACTIVE` förrän:

```text
ownership verified
DNS correct
TLS active
tenant resolution GREEN
auth callback GREEN
branding GREEN
security smoke GREEN
canonical redirect GREEN
```

---

# 207. BRANDING DEPLOYMENT GATE

Ingen brandingversion får publiceras om:

- required asset saknas,
- asset är unsafe,
- färgval bryter kritiska accessibilitykrav,
- URL-fält är ogiltiga,
- text innehåller förbjudet markup.

---

# 208. VERCEL CI/CD FÖRTYDLIGANDE

Deployment pipeline ska:

```text
PR
↓
Vercel Preview
↓
Supabase test/preview
↓
lint
↓
typecheck
↓
unit
↓
DB tests
↓
RLS tests
↓
tenant isolation tests
↓
build
↓
browser verify
↓
integration tests
↓
security gate
↓
GREEN
↓
promote/deploy production
↓
post-deploy smoke
↓
domain health
↓
runtime log scan
```

Direkt production deploy utan gates är förbjudet.

---

# 209. VERCEL ENVIRONMENT VARIABLES

Secrets i Vercel ska scope:as per:

```text
development
preview
production
```

Preview får inte ärva production secrets om det inte är absolut nödvändigt och dokumenterat.

`NEXT_PUBLIC_*` får aldrig innehålla secret.

Committera `.env.example` utan secret values.

---

# 210. AGENTENS OBLIGATORISKA SKILLS

När tillgängliga ska utvecklingsagenten använda relevant skill före implementation.

## Supabase

Vid:

- schema,
- migration,
- Auth,
- RLS,
- Storage,
- Queue,
- Cron

använd:

```text
supabase/supabase
```

Vid:

- query tuning,
- index,
- Postgres schema/performance

använd:

```text
supabase/supabase-postgres-best-practices
```

## Vercel / Next.js

Vid:

- Next.js architecture/routing

använd:

```text
vercel/nextjs
```

Vid:

- deployment/CI

använd:

```text
vercel/deployments-cicd
```

Vid:

- domains,
- live Vercel config,
- deployment state

använd:

```text
vercel/vercel-api
```

Vid:

- env/secrets

använd:

```text
vercel/env-vars
```

Vid:

- production performance/logging

använd:

```text
vercel/observability
```

Vid:

- WAF/rate limiting/platform security

använd:

```text
vercel/vercel-firewall
```

Vid browser/E2E:

```text
vercel/verification
vercel/agent-browser-verify
```

Vid UI:

```text
vercel/react-best-practices
vercel/shadcn
```

Agenten ska inte använda en skill mekaniskt om den inte är relevant, men ska inte hoppa över en relevant installerad expert-skill.

---

# 211. PROJEKTSPECIFIKA SKILLS SOM SKA SKAPAS

Skapa projektlokala agentinstruktioner/skills för:

```text
tryggsignal-architecture
tryggsignal-security-gate
tryggsignal-database-review
tryggsignal-integration-adapter
tryggsignal-migration
tryggsignal-pbl-domain
tryggsignal-document-security
tryggsignal-performance
tryggsignal-e2e-municipality
tryggsignal-masterplan-agent
tryggsignal-whitelabel
```

`tryggsignal-whitelabel` ska alltid kontrollera:

- domain ownership,
- hostname routing,
- tenant resolution,
- cache isolation,
- cookie isolation,
- CSP,
- branding safety,
- accessibility,
- custom domain auth.

---

# 212. MASTERPLAN-AGENTENS STATUSMODELL UTVIDGAS

Utöver tidigare status ska statusfilen även visa:

```text
Branding foundation
Wildcard domain
Tenant resolver
Custom domains
White-label
Tenant auth
Domain health
Tenant provisioning
Tenant isolation E2E
```

Ingen av dessa får markeras GREEN utan test.

---

# 213. NYA BUILD-FASER

Lägg till efter tidigare P33:

## P34 — BRAND / DOMAIN FOUNDATION

Implementera:

- product config,
- reserved hosts,
- wildcard-domain config,
- `tenant_domains`,
- `tenant_branding`.

Gate:

```text
schema GREEN
domain lookup GREEN
reserved domain tests GREEN
```

## P35 — TENANT RESOLVER

Implementera:

- hostname normalization,
- domain lookup,
- TenantContext,
- internal rewrite,
- unknown host handling.

Gate:

```text
tenant A resolves A
tenant B resolves B
unknown blocked
host manipulation blocked
```

## P36 — WHITE-LABEL UI

Implementera:

- branding tokens,
- logo/favicon,
- login branding,
- portal branding,
- admin preview,
- publish/rollback.

Gate:

```text
visual E2E GREEN
accessibility GREEN
cache invalidation GREEN
```

## P37 — CUSTOM DOMAINS

Implementera:

- Vercel domain API abstraction,
- add,
- DNS instructions,
- verification,
- TLS state,
- canonical/fallback.

Gate:

```text
verified custom domain GREEN
unverified blocked
takeover test GREEN
```

## P38 — TENANT AUTH / SESSION ISOLATION

Implementera:

- per-tenant auth config,
- host-only cookies,
- redirect allowlist,
- custom-domain callback flow.

Gate:

```text
cross-tenant cookie leak = 0
open redirect = 0
wrong tenant callback = denied
```

## P39 — TENANT PROVISIONING

Implementera:

- provisioning run,
- Supabase project setup,
- migrations,
- default roles,
- domain,
- branding,
- health.

Gate:

```text
new synthetic municipality provisioned reproducibly
rerun safe
rollback/recovery documented
```

## P40 — TENANT DOMAIN / WHITE-LABEL HARDENING

Kör:

- domain test matrix,
- cross-tenant negative tests,
- cache poisoning attempts,
- session isolation,
- branding asset abuse,
- CSP tests,
- custom domain failure recovery.

Alla critical/high findings ska fixas.

---

# 214. GLOBAL DEFINITION OF DONE — TILLÄGG

Utöver tidigare Global Definition of Done måste följande vara GREEN:

## Branding

- Tryggsignal product config,
- tenant branding,
- versioning,
- accessibility validation.

## Domains

- `tryggsignal.se`,
- `app.tryggsignal.se`,
- `kommuner.tryggsignal.se`,
- wildcard tenant domains,
- custom domain flow.

## White-label

- tenant logo,
- theme tokens,
- favicon,
- login,
- citizen portal,
- staff portal,
- safe email/document branding där aktiverat.

## Isolation

- no cross-tenant route leak,
- no cross-tenant session leak,
- no cross-tenant cache leak,
- no cross-tenant Supabase resolution leak.

## Vercel

- domain health,
- TLS,
- preview isolation,
- deployment verification,
- rollback path.

---

# 215. WHITE-LABEL HUVUDREGEL

White-label får aldrig vara ett presentationslager ovanpå osäker tenantlogik.

Rätt ordning är alltid:

```text
VERIFIED HOST
↓
VERIFIED TENANT
↓
CORRECT DATA PLANE
↓
CORRECT AUTH CONFIG
↓
AUTHORIZED USER
↓
TENANT BRANDING
↓
ROUTE
```

Inte:

```text
logo
↓
tenant guess
↓
database
```

---

# 216. DOMAIN HUVUDREGEL

Hostname är en routingidentitet men inte ensam authorization.

Dataaccess kräver fortfarande:

```text
correct tenant data plane
+
valid session
+
RBAC
+
ABAC
+
RLS
```

---

# 217. PLATFORM HUVUDREGEL

Tryggsignal ska upplevas som ett enda system men vara tekniskt separerat så att:

- en kommun kan få egen data plane,
- samma kodbas används för alla,
- kommunen kan använda Tryggsignal-subdomän,
