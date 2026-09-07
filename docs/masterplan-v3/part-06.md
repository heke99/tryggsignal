- publika tenantmetadata kan läsas.

Den ska inte bli en gemensam “superdatabas” för kommunernas ärenden.

## `<kommun>.tryggsignal.se`

Ska vara kommunens standard white-label entry point.

Exempel:

```text
mjolby.tryggsignal.se
motala.tryggsignal.se
odeshog.tryggsignal.se
```

Den ska kunna bära:

- kommunens logotyp,
- kommunens färgtema,
- kommunnamn,
- kommunens login/SSO,
- handläggarportal,
- kommunadmin,
- medborgarportal,
- Mina sidor.

## Custom domain

Exempel:

```text
samhallsbyggnad.mjolby.se
bygglov.motala.se
```

När verifierad och aktiverad kan den vara kommunens canonical domain.

---

# 152. WHITE-LABEL MÅLBILD

White-label ska inte bara vara färgbyte.

En tenant ska kunna konfigurera:

- kommunnamn,
- produktvisningsnamn,
- logotyp,
- mörk/loggvariant vid behov,
- favicon,
- primär färg,
- sekundär färg,
- accent,
- sidhuvud,
- sidfot,
- supportkontakt,
- kontaktadress,
- integritetslänk,
- tillgänglighetsredogörelse,
- eventuell egen portaltext,
- login-sida,
- e-postbranding,
- dokument-/PDF-header där verksamhetsprocessen tillåter,
- kommunens custom domain,
- kommunens SSO-konfiguration,
- kommunens public portal routes.

White-label ska vara **token-baserad**.

Tillåt inte godtycklig JavaScript, godtycklig HTML eller godtycklig CSS från tenant.

---

# 153. WHITE-LABEL SÄKERHET

Förbjud:

```text
tenant_custom_javascript
tenant_arbitrary_html
tenant_unvalidated_css
```

Skäl:

- XSS,
- layoutmanipulation,
- accessibility degradation,
- CSP-bypass,
- supply-chain-risk.

Tillåt istället:

```text
design_tokens
approved_images
approved_text_fields
approved_layout_options
```

Alla brandingfält ska valideras server-side.

SVG ska antingen:

- förbjudas i första version,
- eller saneras med verifierad säker pipeline.

PNG/WebP föredras för logotyper i första version.

---

# 154. WHITE-LABEL ACCESSIBILITY

Tenant får inte konfigurera ett tema som gör portalen otillgänglig.

Vid publicering av branding ska systemet kontrollera:

- text/background contrast,
- focus contrast,
- länktydlighet,
- error state contrast,
- button contrast.

Om kommunens valda färg inte klarar tillgänglighetskrav ska systemet:

1. varna,
2. föreslå närliggande tillgänglig färg,
3. eller blockera publicering av just den otillgängliga kombinationen.

Kommunens varumärke får inte användas som ursäkt för att bryta tillgänglighetskrav.

---

# 155. VERCEL DEPLOYMENT MODEL

Använd Vercel som host för webblagret.

Rekommenderad struktur:

```text
Vercel Project A:
tryggsignal-marketing
→ tryggsignal.se

Vercel Project B:
tryggsignal-platform
→ app.tryggsignal.se
→ kommuner.tryggsignal.se
→ *.tryggsignal.se
→ verifierade custom domains
```

Detta ger separation mellan publik marknadswebb och kommunernas operativa applikation.

Om befintligt repo redan har en annan fungerande Vercel-struktur får agenten behålla den endast om:

- tenant routing är korrekt,
- domain isolation är korrekt,
- deployments kan testas oberoende,
- säkerheten inte försämras.

Dokumentera i ADR.

---

# 156. FÖRTYDLIGANDE AV WEBBAPPAR I REPOSTRUKTUREN

De tidigare delarna `staff-web`, `citizen-web` och `admin-web` ska betraktas som logiska produktytor.

För första produktionsarkitekturen ska man undvika att skapa tre separata Vercel-projekt om det skapar onödig multi-domain-routing.

Standard för ny implementation:

```text
apps/
  marketing-web/
  platform-web/
```

I `platform-web` kan ytorna vara route groups:

```text
/handlaggning/*
/mina-sidor/*
/kommunadmin/*
/platform/*
```

Domän- och route-guard avgör vilken yta som får visas.

Om `staff-web`, `citizen-web` och `admin-web` redan existerar och fungerar får de behållas som kodmoduler/packages, men deployment ska inte splittras utan ADR som visar tydlig nytta.

Ingen microfrontend-arkitektur ska introduceras enbart för strukturens skull.

---

# 157. VERCEL MULTI-TENANT ROUTING

Bygg en gemensam kodbas som kan svara för många subdomäner/custom domains.

Använd Vercels stöd för:

- wildcard domains,
- custom domains,
- automatisk TLS/SSL,
- domain verification,
- programmatisk domain management.

Wildcard:

```text
*.tryggsignal.se
```

ska peka mot Tryggsignals plattformsprojekt.

Reserverade exakta hosts ska behandlas före wildcard tenant-resolution.

---

# 158. NEXT.JS HOSTNAME ROUTING

Använd aktuell Next.js/Vercel-rekommenderad routingmekanism.

För Next.js-version där `middleware` är ersatt av `proxy`, använd korrekt aktuell konvention.

Hostname resolution:

```text
request
  ↓
normalize hostname
  ↓
reserved host?
  ├─ yes → platform route
  └─ no
      ↓
lookup verified tenant domain
      ↓
tenant context
      ↓
internal rewrite
      ↓
route + authorization
```

Routinglagret får inte vara enda säkerhetsbarriär.

Alla dataoperationer ska dessutom kontrollera rätt tenant/data plane och RBAC/ABAC/RLS.

---

# 159. TENANT RESOLVER

Bygg en central `TenantResolver`.

Input:

```text
hostname
request environment
```

Output:

```text
tenant_id
tenant_slug
domain_id
domain_type
canonical_domain
branding_version
deployment_id
data_plane_reference
auth_configuration_reference
```

Resolver får aldrig lita på `tenant_id` från query, body eller en godtycklig header som auktoritativ tenantidentitet.

Hostname måste först matcha en aktiv/verifierad domän i control plane.

---

# 160. HOSTNAME NORMALIZATION

Innan lookup:

- lowercase,
- ta bort port,
- hantera trailing dot korrekt,
- normalisera internationella domännamn säkert,
- validera hostnameformat,
- avvisa ogiltiga hosts.

`Host`/forwarded host ska hanteras enligt Vercels dokumenterade proxy/runtime-modell.

Acceptera aldrig användarkontrollerad forwarded-host-information utan att den kommer från betrodd plattformsinfrastruktur.

---

# 161. RESERVERADE SUBDOMÄNER

Skapa reserverad lista som minst innehåller:

```text
www
app
kommuner
admin
api
docs
status
auth
support
mail
notify
assets
cdn
test
preview
staging
```

En kommun får inte välja en reserverad slug.

Slug ska valideras:

- lowercase,
- `a-z`,
- `0-9`,
- bindestreck,
- ingen whitespace,
- ingen punkt,
- inget ledande/slutande bindestreck.

Slug ska vara unik.

---

# 162. TENANT DOMAIN DATA MODEL

Skapa i control plane:

```text
platform.tenant_domains
```

Minimumfält:

```text
id
tenant_id

hostname
normalized_hostname

domain_type
status

is_canonical
is_fallback

vercel_project_id
provider_domain_id

ownership_status
dns_status
tls_status

verification_token_reference

created_at
created_by

verified_at
activated_at
disabled_at

last_checked_at
last_error
```

`domain_type`:

```text
PLATFORM_SUBDOMAIN
CUSTOM_DOMAIN
PLATFORM_RESERVED
```

`status`:

```text
PENDING
AWAITING_DNS
VERIFYING
VERIFIED
ACTIVE
FAILED
DISABLED
REMOVED
```

Unique constraint på `normalized_hostname`.

---

# 163. TENANT BRANDING DATA MODEL

Skapa:

```text
platform.tenant_branding
```

Minimum:

```text
id
tenant_id
version

display_name
short_name

logo_asset_id
logo_dark_asset_id
favicon_asset_id

primary_color
secondary_color
accent_color
surface_variant

support_email
support_phone

privacy_url
accessibility_statement_url
terms_url

login_heading
login_subheading

show_tryggsignal_branding
locale

status
created_at
created_by
published_at
published_by
supersedes_id
```

Status:

```text
DRAFT
PUBLISHED
SUPERSEDED
```

Branding ska versionshanteras.

---

# 164. BRANDING PREVIEW OCH PUBLICERING

Kommunadmin ska kunna:

1. ändra branding i draft,
2. förhandsgranska,
3. köra accessibility validation,
4. publicera,
5. rollback till tidigare version.

Publicering ska auditloggas.

Pågående sessioner ska inte få trasig state om branding byts.

Cache ska invalidieras versionsstyrt.

---

# 165. BRANDING I GENERERADE DOKUMENT

Om branding används i genererade PDF:er/brev:

- dokumentversionen ska spara branding-version som användes,
- senare brandingändring får inte ändra historiskt genererat dokument,
- juridiskt innehåll ska vara separat från presentationstemplate,
- originalbeslut ska förbli immutable version.

---

# 166. CUSTOM DOMAIN PROVISIONING

Kommunadmin eller Tryggsignal platform admin ska kunna initiera custom domain onboarding.

Workflow:

```text
user enters domain
↓
validate hostname
↓
check unique ownership
↓
create tenant_domain PENDING
↓
add domain to Vercel project through supported API/SDK
↓
obtain DNS instructions / verification status
↓
show required DNS records
↓
poll/check verification
↓
verify ownership
↓
verify TLS ready
↓
activate
↓
optional set canonical
```

Aktivera aldrig domänen före verifiering.

---

# 167. CUSTOM DOMAIN TAKEOVER-SKYDD

Förhindra domain takeover.

Krav:

- domänen får endast kopplas till en tenant,
- ägarskap måste verifieras,
- Vercel/provider verification måste vara klar,
- TLS ska vara aktiv,
- gammal tenant-binding ska vara borttagen före ny binding,
- disabled tenant får inte behålla aktiv custom-domain-routing utan uttryckligt beslut.

Alla domain ownership events auditloggas.

---

# 168. TLS / HTTPS

All trafik ska använda HTTPS.

Vercel får hantera TLS/certifikat där plattformens modell stödjer det.

Krav:

```text
HTTP → HTTPS redirect
```

HSTS ska användas där lämpligt.

Var försiktig med `includeSubDomains` på custom domain som kommunen äger; Tryggsignal ska inte tvinga en policy på andra kommunala subdomäner som inte ligger i vår kontroll.

---

# 169. CANONICAL DOMAIN

Varje tenant ska ha:

```text
canonical_domain_id
fallback_domain_id
```

Exempel:

```text
canonical:
samhallsbyggnad.mjolby.se

fallback:
mjolby.tryggsignal.se
```

När custom domain är frisk:

- canonical URL används i portal-länkar,
- e-post,
- redirect.

Fallbackdomänen ska kunna hållas tillgänglig enligt tenantens policy.

Ingen redirect-loop får kunna uppstå.

---

# 170. DOMÄNHEALTH

Bygg domain health checks.

Mät:

```text
DNS
ownership
TLS
Vercel configuration
HTTP response
tenant resolution
auth callback health
canonical redirect
```

Skapa status:

```text
HEALTHY
DEGRADED
BROKEN
```

Visa i platform-admin.

---

# 171. TENANT DATA PLANE RESOLUTION
