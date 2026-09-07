Efter TenantResolver:

```text
tenant
↓
tenant deployment
↓
tenant Supabase project
↓
tenant-scoped Supabase client
```

Browsern får endast sådan publik klientkonfiguration som är säker att exponera.

Privilegierade nycklar/service-role får aldrig skickas till browsern.

---

# 172. TENANT DEPLOYMENT CONFIG

Utöka:

```text
platform.tenant_deployments
```

med exempelvis:

```text
supabase_project_ref
supabase_region
supabase_url
publishable_key
privileged_credential_reference

schema_version
rules_version
application_compatibility_version

status
health_status
last_health_check_at
```

`privileged_credential_reference` är en referens till säker hemlighet, aldrig credential i klartext.

---

# 173. SECRET PROVIDER ABSTRACTION

Bygg:

```text
SecretProvider
```

Exempelinterface:

```text
getSecret(reference)
rotateSecret(reference)
healthCheck()
```

För pilot kan Vercel encrypted environment användas för ett litet antal plattformshemligheter.

För per-tenant-hemligheter ska lösningen skalas så att hundratals service credentials inte behöver hårdkodas som separata source-code/env-konstanter.

Implementationen ska vara utbytbar.

---

# 174. SERVICE ROLE MINIMERING

Använd service-role/privilegierade credentials så lite som möjligt.

Normal användardataaccess ska i första hand ske med:

```text
user session
+
tenant data plane
+
RLS
```

Privilegierade serviceoperationer ska:

- vara server-only,
- explicit authorization,
- minsta scope,
- auditloggas där relevant.

---

# 175. `app.tryggsignal.se` TENANT DISCOVERY

`app.tryggsignal.se` ska inte öppna valfri kommun genom en godtycklig `tenant_id`.

Flow för kommunpersonal:

```text
app.tryggsignal.se
↓
identify / choose municipality
↓
resolve authorized tenant
↓
redirect to:
<kommun>.tryggsignal.se
or verified custom domain
↓
tenant-specific auth
```

Om användare tillhör flera tenants får launcher visa endast tenants där användaren har verifierad relation/behörighet.

---

# 176. `kommuner.tryggsignal.se`

Denna domän ska kunna fungera som:

- kommunlista,
- tenant discovery,
- kommunal login launcher,
- onboarding,
- pilotstatus,
- integrations-/supportinformation som är trygg att exponera.

Den får inte ge en användare access till ärendedata enbart för att kommunen valts i UI.

Slutlig dataaccess sker först i rätt tenant/data plane.

---

# 177. TENANT STANDARDROUTES

På tenantdomän:

```text
/
```

ska visa konfigurerad tenant-entry.

Rekommenderade routes:

```text
/login

/handlaggning
/handlaggning/arenden
/handlaggning/tillsyn
/handlaggning/inspektioner

/kommunadmin

/mina-sidor
/mina-sidor/ansokan
/mina-sidor/arenden

/auth/callback
```

`/platform` ska endast vara tillgänglig på Tryggsignals interna/godkända host, inte på kommunernas custom domains.

---

# 178. AUTH PER TENANT

Varje kommun har separat Supabase data plane och ska kunna ha egen auth-konfiguration.

Skapa:

```text
platform.tenant_auth_configs
```

Metadata:

```text
tenant_id
staff_identity_provider
external_identity_provider

entra_tenant_identifier
sso_connection_reference

supabase_project_ref

allowed_login_methods

status
last_verified_at
```

Secrets ska lagras separat via secret reference.

---

# 179. SSO OCH CUSTOM DOMAIN

SSO redirect/callback URLs ska vara explicit allowlistade.

När custom domain aktiveras:

1. verifiera domain,
2. lägg till godkänd auth redirect URL där nödvändigt,
3. verifiera callback,
4. testa PKCE/state/nonce,
5. aktivera canonical redirect först därefter.

Ingen generisk:

```text
redirect_to=<arbitrary-user-url>
```

får accepteras.

---

# 180. COOKIE ISOLATION

Extremt viktigt:

Sätt inte autentiseringscookies som:

```text
Domain=.tryggsignal.se
```

om det gör att sessionscookies automatiskt delas mellan kommunernas subdomäner.

Default ska vara host-only cookies.

Exempel:

```text
mjolby.tryggsignal.se
```

ska inte automatiskt få sessionscookie från:

```text
motala.tryggsignal.se
```

Cross-tenant SSO måste vara en explicit säker broker/handoff-process, inte en bred wildcardcookie.

---

# 181. CENTRAL LOGIN HANDOFF

Om central launcher ska skicka användaren från:

```text
app.tryggsignal.se
```

till tenantdomänen ska den använda:

- verifierad tenant,
- kortlivad signed state,
- nonce,
- CSRF-skydd,
- one-time handoff när sådan modell behövs.

Återanvänd aldrig ett permanent tenant-token i URL.

---

# 182. CORS

CORS ska vara deny-by-default för känsliga API:er.

Allow origins ska genereras från:

- verifierade aktiva tenant domains,
- Tryggsignals reserverade hosts,
- explicit development/test configuration.

Använd aldrig:

```text
Access-Control-Allow-Origin: *
```

tillsammans med känslig authenticated data.

---

# 183. CSRF

State-changing cookie-authenticated operations ska vara CSRF-skyddade enligt vald Next.js/Supabase-modell.

Custom domains ska ingå i threat model.

Testa särskilt:

- cross-subdomain request,
- malicious custom domain,
- stale old domain,
- redirected login.

---

# 184. CACHE ISOLATION

Tenant-specifik data får aldrig använda en global cache key.

Cache keys måste minst omfatta:

```text
tenant_id
authority_id där relevant
resource
version
```

Brandingcache:

```text
tenant_id + branding_version
```

Domain registry cache:

```text
normalized_hostname + registry_version
```

En cache-hit från kommun A får aldrig kunna användas för kommun B.

---

# 185. TENANT ROUTING PERFORMANCE

Hostname resolution sker på varje request och måste vara snabb.

Source-of-truth:

```text
Control Plane
```

Tillåt kort, säkert read-through cache för domain→tenant resolution.

Om skalan senare kräver Edge Config eller annat Vercel-accelerationslager:

- control plane förblir source-of-truth,
- cacheversion måste kunna invalidieras,
- stale domain mapping får inte fortsätta efter security-sensitive domain removal längre än definierad max-TTL.

Inför inte separat routingdatabas före mätning.

---

# 186. BRANDING ASSETS

Brandingfiler ska lagras säkert.

Metadata:

```text
asset_id
tenant_id
type
mime_type
size
sha256
storage_path
created_at
created_by
status
```

Tillåt endast godkända filtyper.

Logotyp får inte hämtas från godtycklig extern URL vid varje sidladdning.

---

# 187. WHITE-LABEL EMAIL

Skapa:

```text
platform.tenant_communication_branding
```

Minimum:

```text
sender_display_name
reply_to
logo_asset_id
footer_text
support_email
sending_domain_reference
```

Initialt kan Tryggsignals verifierade sändningsdomän användas med kommunens display name där juridiskt/operativt lämpligt.

Egen kommunal sending domain får endast användas efter DNS-/providerverifiering.

Spoofa aldrig kommunens domän.

---

# 188. DIGITAL POST ÄR INTE E-POST WHITE-LABEL

Digital Post ska använda den offentliga aktörens korrekta avsändaridentitet enligt den nationella tjänstens krav.

Visuell branding får inte ersätta eller förvanska juridisk avsändaridentitet.

---

# 189. TENANT DOCUMENT BRANDING

Templates ska skilja mellan:

```text
legal sender identity
visual branding
Tryggsignal platform metadata
```

Kommunens namn/nämnd måste visas enligt processen.

Tryggsignal-branding får kunna döljas i white-label output om avtal/policy anger det.

Audit och interna metadata ska fortsatt kunna visa vilken programvaruversion som genererade dokumentet.

---

# 190. VERCEL CUSTOM DOMAIN API

När custom domain-funktionalitet implementeras ska agenten använda aktuell officiell Vercel-dokumentation/API/SDK.

Funktioner ska täcka:

```text
add domain
read domain status
return required DNS records
verify
activate
remove
recheck
```

Gissa aldrig endpoints från minne.

Live write-operationer ska verifieras genom read-back efteråt.

---

# 191. CUSTOM DOMAIN ROLLBACK

Om custom domain går sönder:

- tenantdata ska inte påverkas,
- `<kommun>.tryggsignal.se` ska kunna fungera som fallback om tenantpolicy tillåter,
- health alert skapas,
- canonical redirect ska kunna inaktiveras,
- admin ska få tydliga DNS-instruktioner.

Data plane är helt oberoende av custom domain lifecycle.

---

# 192. TENANT PROVISIONING WORKFLOW

Ny kommun ska kunna provisioneras med ett reproducerbart workflow:

```text
CREATE TENANT
↓
RESERVE SLUG
↓
CREATE TENANT DEPLOYMENT
↓
CREATE SUPABASE PROJECT
↓
WAIT UNTIL READY
↓
APPLY BASE MIGRATIONS
↓
ENABLE REQUIRED EXTENSIONS
↓
APPLY RLS / RBAC / ABAC
↓
SEED SYSTEM ROLES
↓
CREATE TENANT BRANDING DRAFT
↓
ENABLE <slug>.tryggsignal.se
↓
CONFIGURE AUTH
↓
RUN HEALTH CHECK
↓
RUN SECURITY SMOKE TEST
↓
RUN TENANT ISOLATION TEST
↓
MARK CUSTOMER_TEST READY
↓
PROMOTE ONLY AFTER GATE
```

Varje steg ska vara idempotent eller ha tydlig recovery.

---

# 193. TENANT PROVISIONING STATE

Skapa:

```text
platform.provisioning_runs
platform.provisioning_steps
```

Status:

```text
PENDING
RUNNING
SUCCEEDED
FAILED
EXTERNAL_BLOCKED
ROLLED_BACK
```

Spara:

```text
correlation_id
started_at
completed_at
error
retry_count
```

---

# 194. TENANT OFFBOARDING

Offboarding får aldrig innebära omedelbar delete.

Workflow:

```text
contract/end trigger
↓
disable new access according to policy
↓
export
↓
verify export
↓
archive/retention checks
↓
revoke integrations
↓
remove custom domain
↓
revoke secrets
↓
final customer sign-off
↓
scheduled deletion only when legally/contractually allowed
```

Auditlogga alla steg.

---

# 195. DOMAIN CHANGE AUDIT

Audit events ska inkludera:

```text
tenant.domain.created
tenant.domain.verification_requested
tenant.domain.verified
tenant.domain.activated
tenant.domain.canonical_changed
tenant.domain.failed
tenant.domain.disabled
tenant.domain.removed

tenant.branding.published
tenant.branding.rolled_back
```

---

# 196. WHITE-LABEL FEATURE FLAGS

White-label features ska kunna aktiveras per tenant:

```text
custom_domain
custom_logo
custom_colors
custom_email_branding
hide_tryggsignal_brand
custom_document_branding
custom_login_content
```

Feature flags får inte användas för authorization.

---

# 197. PLATFORM ADMIN

Tryggsignals interna admin ska kunna:

- skapa tenant,
- se provisioning health,
- se domain health,
