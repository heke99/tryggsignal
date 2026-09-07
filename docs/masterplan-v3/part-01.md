# MASTERPLAN V3 — TRYGGSIGNAL — EXECUTABLE BUILD PLAN

> **V3-bevarandeprincip:** Den tidigare MASTERPLAN V2 nedan ska behållas i sin helhet. Inga av punkterna 0–148 har tagits bort. Punkterna 149 och framåt är bindande tillägg och förtydliganden för produktnamn, Vercel-domänarkitektur, tenant-routing, white-label, custom domains, sessionsäkerhet, branding, provisionering och verifiering. Om en ny punkt uttryckligen förtydligar en äldre punkt ska den nya punkten styra implementationen utan att den äldre punkten raderas ur dokumentet.
>
> **Produktnamn:** Tryggsignal.
>
> **Funktionsbeskrivning:** “Kommunalt Samhällsbyggnad OS” / “Samhällsbyggnad OS” är fortsatt den funktionella produktbeskrivningen.
>
> **Primära domäner från start:**
>
> - `tryggsignal.se` — publik webbplats och produktinformation.
> - `app.tryggsignal.se` — central applikationsgateway, tenantval och generell inloggningsentré.
> - `kommuner.tryggsignal.se` — kommunportal/tenant discovery för kommuner; får inte vara system-of-record för kommunernas ärendedata.
> - `<kommun>.tryggsignal.se` — standarddomän för respektive kommun.
> - Kommunens egen custom domain, t.ex. `samhallsbyggnad.mjolby.se`, ska kunna bli canonical white-label-domän.
>
> **Vercel:** Webbplattformen ska hostas på Vercel och byggas för Vercels multi-tenant/custom-domain-modell med en gemensam kodbas. Wildcard-domän och custom domains ska stödjas utan separat kodbas per kommun.

---

**MASTERPLAN V2 — EXECUTABLE BUILD PLAN**

**0. DITT UPPDRAG**

Du är huvudansvarig utvecklingsagent för **Kommunalt Samhällsbyggnad OS**.

Du ska inte endast analysera, föreslå arkitektur eller skapa enstaka features.

Du ska:

1. inspektera befintligt repo och befintlig Supabase-miljö,
2. jämföra nuläget mot denna masterplan,
3. skapa en konkret gap-lista,
4. implementera planen fas för fas,
5. köra tester efter varje fas,
6. rätta alla fel som uppstår,
7. köra säkerhets-, migrations- och prestandakontroller,
8. dokumentera det som implementeras,
9. fortsätta till nästa oberoende steg,
10. fortsätta tills samtliga möjliga delar av masterplanen är implementerade och verifierade.

Stanna inte efter en enskild feature.

Stanna inte efter en lyckad build.

Stanna inte för att skriva en sammanfattning om mer genomförbart arbete återstår.

Arbetet är färdigt först när masterplanens **Global Definition of Done** är uppfylld eller när ett moment kräver en extern credential, licens, leverantörsåtkomst eller mänskligt beslut som agenten faktiskt inte kan erhålla.

Vid extern blocker:

- dokumentera exakt blocker,
- skapa adapter/interface/test-fixtures där det går,
- markera momentet EXTERNAL_BLOCKED,
- fortsätt med allt annat som inte blockeras.

Hitta aldrig på credentials, API-endpoints, leverantörsfält eller testresultat.

**1. ÖVERGRIPANDE PRODUKTMÅL**

Bygg ett kommunalt operativt system för samhällsbyggnadsprocesser.

Systemet ska initialt täcka:

- bygglov,
- anmälningar,
- förhandsbesked,
- rivningslov,
- marklov,
- PBL-tillsyn,
- OVK,
- inspektion,
- tekniskt samråd,
- startbesked,
- slutsamråd,
- slutbesked,
- remisser,
- grannehöranden,
- dokument,
- kommunikation,
- deadlines,
- beslut,
- arkiv,
- statistik.

Arkitekturen ska senare kunna stödja:

- miljö,
- hälsoskydd,
- detaljplan,
- livsmedel,
- bostadsanpassning,
- markupplåtelse,
- schakt,
- trafik,
- andra kommunala ärendeprocesser.

**2. PRODUKTSTRATEGI**

Systemet ska kunna användas i tre lägen:

**MODE A — OVERLAY**

Kommunens befintliga system är system-of-record.

KommunOS läser data och lägger ovanpå:

- intelligent workspace,
- sök,
- AI,
- kompletteringsanalys,
- deadlines,
- geodata,
- tillsyn,
- rapportering.

Detta är standard för första pilot.

**MODE B — COEXISTENCE**

Vissa processer eller nya ärenden hanteras av KommunOS.

Historiska eller andra ärenden ligger kvar i legacy.

**MODE C — SYSTEM OF RECORD**

KommunOS blir canonical system-of-record för aktuella processer.

Legacydata har migrerats eller arkiverats.

Alla tre modes måste stödjas av samma kodbas.

**3. TEKNISK STACK — LÅST**

Använd:

- TypeScript
- Next.js
- React
- Hosted Supabase
- PostgreSQL
- PostGIS
- Supabase Storage
- Supabase Auth
- RLS
- Supabase Queues / PGMQ
- pg_cron / Supabase Cron
- Vercel för webblagret där kunden tillåter
- .NET Worker Service för kommunal on-prem connector
- OpenAPI för externa REST-kontrakt.

Använd inte Docker som krav för normal lokal utveckling.

Använd inte Kubernetes.

Använd inte Kafka.

Använd inte Temporal i första arkitekturen.

Inför inte microservices enbart för att arkitekturen ska se enterprise ut.

Börja som:

**modular monolith + asynchronous workers + municipal edge connector.**

**4. SUPABASE-STRATEGI**

Varje kommun ska som huvudregel få eget Supabase project/data plane.

Exempel:

**Control Plane**

**     │**

**     ├── Municipality A → Supabase Project A**

**     ├── Municipality B → Supabase Project B**

**     └── Municipality C → Supabase Project C**

Kommuner får inte dela verksamhetsdata i samma produktionsdatabas som standard.

Control plane får innehålla:

- tenant registry,
- subscription,
- deployment metadata,
- feature flags,
- supported connector catalog,
- software versions.

Control plane får inte innehålla kommunernas myndighetsdokument.

Standardregion för svensk kommun:

**eu-north-1**.

Verifiera alltid aktuell Supabase-dokumentation före provisionering.

**5. MILJÖER**

Skapa minst:

**DEV**

**TEST**

**PRODUCTION**

Per pilotkund vid behov:

**CUSTOMER_TEST**

**CUSTOMER_PRODUCTION**

Ingen produktionsdata får kopieras osanitiserad till DEV/TEST.

Testdata ska vara:

- syntetisk,
- anonymiserad,
- eller godkänt pseudonymiserad.

**6. NO-DOCKER DEVELOPMENT**

Utvecklingsflödet får inte bero på **supabase start**.

Använd hosted development/test projects.

För databasarbete:

- anslut remote,
- iterera SQL,
- verifiera,
- skapa migration med aktuell Supabase CLI,
- commit migrationen.

När migration ska skapas ska agenten först kontrollera aktuell Supabase CLI syntax via **--help**.

Gissa aldrig migration command syntax.

**7. SUPABASE CONNECTIONS**

Använd:

**Application / serverless**

Supabase Data API eller transaction pooler beroende på operation.

**Migrations / pg_dump / administrativa native Postgres-operationer**

Direct Postgres connection när nätverk stödjer detta.

**Permanent worker på IPv4-only nät**

Session pooler där direkt anslutning inte är lämplig.

Prepared statements får inte antas fungera i transaction pooling.

Verifiera aktuell Supabase-dokumentation.

**8. REPOSTRUKTUR**

Skapa/normalisera till:

**apps/**

**  staff-web/**

**  citizen-web/**

**  admin-web/**

**packages/**

**  config/**

**  database/**

**  domain/**

**  authorization/**

**  validation/**

**  ui/**

**  observability/**

**  organization/**

**  identity/**

**  cases/**

**  properties/**

**  documents/**

**  workflow/**

**  rules/**

**  deadlines/**

**  communication/**

**  referrals/**

**  decisions/**

**  inspections/**

**  compliance/**

**  archive/**

**  search/**

**  ai/**

**  reporting/**

**  migration/**

**  integrations/**

**    core/**

**    generic-rest/**

**    generic-soap/**

**    generic-file/**

**    generic-sftp/**

**    generic-sql/**

**    lantmateriet-ngp/**

**    lantmateriet-property/**

**    boverket/**

**    bolagsverket/**

**    skatteverket-navet/**

**    digital-post/**

**    naturvardsverket/**

**    raa/**

**    sgu/**

**    trafikverket/**

**    scb/**

**    smhi/**

**    edp-vision/**

**    sokigo-byggr/**

**    sokigo-nova/**

**    sokigo-ecos/**

**    castor/**

**    open-e/**

**    public360/**

**    w3d3/**

**services/**

**  worker/**

**connectors/**

**  municipal-edge-dotnet/**

**supabase/**

**  migrations/**

**  seed/**

**tests/**

**  unit/**

**  database/**

**  rls/**

**  integration/**

**  migration/**

**  security/**

**  e2e/**

**  performance/**

**docs/**

**  architecture/**

**  adr/**

**  api/**

**  integrations/**

**  migration/**

**  security/**

**  procurement/**

**  runbooks/**

Anpassa endast om befintligt repo har en dokumenterat bättre struktur.

Skapa inte duplicerade domäner bara för att matcha denna struktur ordagrant.

**9. STATUSFILER FÖR AGENTEN**

Skapa:

**docs/master-plan-status.md**

**docs/blockers.md**

**docs/architecture-decisions.md**

**master-plan-status.md** ska innehålla för varje fas:

**P0 Foundation           GREEN**

**P1 Security Core        GREEN**

**P2 Case Core            IN_PROGRESS**

**...**

Status får endast vara:

**NOT_STARTED**

**IN_PROGRESS**

**BLOCKED**

**EXTERNAL_BLOCKED**

**RED**

**GREEN**

En fas får bara bli **GREEN** när dess tester/gates har passerat.

**10. ARCHITECTURE DECISION RECORDS**

Skapa ADR för större beslut.

Minst:

**ADR-001 Supabase per municipality**

**ADR-002 Canonical data model**

**ADR-003 No-Docker normal workflow**

**ADR-004 RBAC + ABAC + RLS**

**ADR-005 Human-in-the-loop AI**

**ADR-006 Adapter-based integration**

**ADR-007 Overlay/coexistence/full migration**

**ADR-008 System-of-record provenance**

**ADR-009 Postgres-first search**

**ADR-010 Durable jobs with PGMQ**

**11. POSTGRES SCHEMAS**

Använd logiska schemas:

**organization**

**identity**

**authz**

**core**

**property**

**documents**

**workflow**

**rules**

**communication**

**referral**

**decision**

**inspection**

**compliance**

**integration**

**migration**

**search**

**ai**

**audit**

**archive**

**reporting**

**config**

Undvik onödig användning av **public**.

Exponera endast de schemas/views/functions som klienterna faktiskt behöver.

**12. EXTENSIONS**

Verifiera att följande finns/kan aktiveras:

**postgis**

**pg_trgm**

**pgcrypto**

**pgmq**

**pg_cron**

**vector**

Använd **vector** först när semantic search faktiskt implementeras.

Aktivera inte extensions utan behov.

**13. ORGANISATIONSMODELL**

Implementera:

**legal_entities**

**authorities**

**departments**

**units**

**teams**
