- RLS audit,
- permission audit,
- secret scan,
- dependency scan,
- OWASP test,
- upload abuse,
- IDOR/BOLA,
- CSRF,
- XSS,
- SSRF,
- service account audit,
- AI prompt injection tests.

Alla kritiska/höga findings fixas.

**128. P30 — PERFORMANCE**

Generera syntetiskt:

**100,000+ cases**

**1,000,000+ document metadata rows**

**millions of events**

Testa:

- dashboards,
- search,
- RLS,
- pagination,
- sync,
- worker,
- imports.

Optimera queries/index.

**129. P31 — BACKUP / RECOVERY**

Verifiera:

- database restore,
- Storage restore,
- migration rollback strategy,
- queue replay,
- corrupted integration recovery.

Dokumentera RPO/RTO.

**130. P32 — ACCESSIBILITY**

Automated + manual accessibility verification.

**131. P33 — PILOT READINESS**

Skapa:

**architecture document**

**security document**

**data-flow diagrams**

**DPIA support material**

**subprocessor information**

**backup/DR**

**RPO/RTO**

**RBAC matrix**

**AI governance**

**accessibility**

**incident process**

**exit plan**

**API catalog**

**integration catalog**

**SLA draft**

**132. AGENTENS EXECUTION LOOP**

För VARJE fas:

**1. READ CURRENT STATE**

**2. VERIFY RELEVANT CURRENT OFFICIAL DOCS**

**3. IDENTIFY DELTA**

**4. IMPLEMENT MINIMUM CORRECT CHANGE**

**5. CREATE/APPLY MIGRATION IF NEEDED**

**6. RUN UNIT TESTS**

**7. RUN DB TESTS**

**8. RUN RLS/SECURITY TESTS IF RELEVANT**

**9. RUN INTEGRATION TESTS IF RELEVANT**

**10. RUN TYPECHECK**

**11. RUN LINT**

**12. RUN BUILD**

**13. RUN E2E IF USER-FACING**

**14. RUN PERFORMANCE CHECK IF QUERY CHANGED**

**15. RUN SUPABASE ADVISORS IF DATABASE CHANGED**

**16. FIX FAILURES**

**17. RE-RUN UNTIL GREEN**

**18. UPDATE ADR/DOCS**

**19. UPDATE master-plan-status.md**

**20. CONTINUE TO NEXT PHASE**

**133. FAILURE RULE**

Om test är rött:

Agenten får inte bara dokumentera felet och fortsätta som om steget var färdigt.

Agenten ska:

**inspect failure**

**identify root cause**

**fix**

**retest**

Efter 2–3 misslyckade försök med samma strategi:

- ändra strategi,
- läs aktuell dokumentation,
- kontrollera logs,
- kontrollera schema/API-kontrakt.

Loop inte blint.

**134. EXTERNAL BLOCKER RULE**

Om exempelvis Lantmäteriet API-key saknas:

Gör:

**connector interface**

**configuration model**

**credential reference**

**contract tests**

**recorded fixtures if legally available**

**error handling**

**health checks**

**documentation**

Markera:

**EXTERNAL_BLOCKED:**

**live credential/access required**

Fortsätt sedan.

**135. API IMPLEMENTATION RULE**

Innan extern adapter byggs:

1. kontrollera officiell dokumentation,
2. kontrollera API-version,
3. kontrollera auth,
4. kontrollera testmiljö,
5. kontrollera rate limit,
6. kontrollera datalicens,
7. kontrollera rätt att cacha,
8. kontrollera original vs reference-data,
9. skapa OpenAPI/schema fixture,
10. implementera.

Hårdkoda aldrig ett API utifrån gamla blogginlägg.

**136. DATABASE CHANGE RULE**

Varje databasändring:

**inspect**

**prototype**

**test**

**advisor**

**security review**

**create clean migration**

**replay**

**commit**

Ingen manuell prod-only SQL.

**137. INDEX RULE**

När query tillkommer:

1. mät query,
2. analysera plan,
3. lägg index om motiverat,
4. mät igen.

Indexera inte allt slentrianmässigt.

**138. SECURITY RULE**

Om agenten står mellan:

**quick fix**

och

**correct authorization**

ska korrekt authorization alltid väljas.

Disable RLS är aldrig acceptabel lösning.

**139. TEST RULE**

Förbjud:

- skip:a test för att CI ska bli grönt,
- ändra assertion bara för att passa buggen,
- mocka bort viktig security,
- gömma exceptions,
- returnera dummy success.

**140. DATA RULE**

Förbjud production use av:

- fabricated API response,
- fabricated permit rule,
- fabricated legal deadline,
- fabricated property data,
- fabricated migration success.

**141. SOURCE FRESHNESS**

National reference sources ska ha:

**last_checked_at**

**last_successful_sync**

**source_version**

**source_updated_at**

Visa stale warning när källan inte kunnat uppdateras enligt dess policy.

**142. CACHE STRATEGY**

Cache per datakälla.

Exempel:

**Boverket energy**

**→ long cache, respect daily limits**

**property reference**

**→ source-specific TTL**

**active case**

**→ no unsafe cross-user cache**

**rules**

**→ version cache**

**classification**

**→ version cache**

Cache key ska alltid inkludera relevant tenant/authority när informationen inte är global.

**143. UI RULE**

Ingen viktig process får bara vara möjlig genom AI-chat.

All kritisk funktion ska ha strukturerad UI/state.

AI är assistent.

Systemet är produkten.

**144. PERFORMANCE RULE**

För user request:

ingen:

**OCR**

**AI**

**mass import**

**archive generation**

**huge geodata sync**

inline.

Queue:a och visa status.

**145. GLOBAL DEFINITION OF DONE**

Systemet är inte färdigt förrän:

**Architecture**

- canonical model implementerad,
- tenant/data-plane modell implementerad,
- system-of-record/provenance implementerad.

**Security**

- RBAC GREEN,
- ABAC GREEN,
- RLS GREEN,
- no cross-authority leaks,
- no service key leak,
- security high severity = 0.

**Core**

- case,
- property,
- document,
- workflow,
- rules,
- deadlines,
- communication,
- audit fungerar.

**Integration**

- generic integration framework GREEN,
- migration framework GREEN,
- minst en verklig national source integration GREEN,
- minst en real/representative municipal connector path verifierad.

**AI**

- auditable,
- evidence-based,
- human-in-loop,
- prompt-injection tested.

**Search**

- authorization-safe,
- performant.

**Migration**

- rerunnable,
- reconciled,
- provenance-preserving.

**Backup**

- database restore tested,
- Storage restore tested.

**Performance**

- agreed SLO materially met under representative load.

**Accessibility**

- critical flows verified.

**Documentation**

- architecture,
- API,
- security,
- migration,
- runbooks,
- procurement package current.

**CI**

All required checks GREEN.

**146. AGENTENS SLUTRAPPORT**

Först när allt genomförbart är färdigt får agenten skapa slutrapport.

Den ska innehålla:

**GREEN phases**

**EXTERNAL_BLOCKED phases**

**remaining technical debt**

**remaining external credentials**

**security state**

**migration state**

**performance measurements**

**test results**

**production readiness**

**exact next external action**

Skriv inte:

"Allt är klart"

om externa blockers eller röda gates finns.

**147. HUVUDREGEL**

Målet är inte att producera mycket kod.

Målet är att producera:

**ett säkert, testat, migrerbart, integrationsbart, revisionsbart och snabbt kommunalt produktionssystem.**

Varje ny feature ska bedömas mot:

**security**

**authorization**

**data ownership**

**provenance**

**migration**

**integration**

**performance**

**indexing**

**audit**

**archive**

**accessibility**

**observability**

**testability**

innan den betraktas som färdig.

**148. FORTSÄTT TILLS PLANEN ÄR KLAR**

Efter varje GREEN fas:

gå automatiskt vidare till nästa.

Be inte användaren:

**"Vill du att jag fortsätter?"**

så länge nästa steg redan definieras av denna masterplan och agenten har nödvändiga verktyg/åtkomst.

Vid blocker:

dokumentera den och fortsätt med andra oberoende delar.

Masterplanen är den primära exekveringsordningen.

Avvik endast när:

- en blocker kräver annan ordning,
- ett säkerhetsproblem måste lösas först,
- befintlig arkitektur kräver en dependency tidigare,
- eller aktuell officiell dokumentation visar att ett tidigare antagande blivit felaktigt.

Dokumentera då avvikelsen i ADR och fortsätt.

---

# 149. PRODUKTNAMN OCH BRANDING — LÅST

Produktnamnet är **Tryggsignal**.

Använd följande begrepp konsekvent:

- **Tryggsignal** = produkt/varumärke.
- **Tryggsignal Samhällsbyggnad OS** = produktens fulla funktionsnamn.
- **Kommunalt Samhällsbyggnad OS** = funktionell/systemmässig beskrivning som får finnas kvar i tekniska dokument och tidigare delar av masterplanen.
- **Tenant** = en kundorganisation/kommun.
- **Authority** = en nämnd/myndighetsgren inom kommunen och fortsatt säkerhetsgräns.
- **Data plane** = kommunens separata Supabase-projekt.
- **Control plane** = Tryggsignals centrala konfigurations- och provisioneringslager utan kommunens myndighetsdokument.

Produktnamn får inte hårdkodas över hela koden. Lägg produktmetadata i konfiguration så att white-label och framtida produktvarianter kan hanteras utan fork.

---

# 150. DOMÄNMODELL — LÅST

Följande domänstruktur ska byggas:

```text
tryggsignal.se
www.tryggsignal.se             → redirect till tryggsignal.se

app.tryggsignal.se             → central app-gateway / tenantval
kommuner.tryggsignal.se        → kommunportal / tenant discovery

<kommun>.tryggsignal.se        → kommunens standardtenant-domän

custom domain:
samhallsbyggnad.<kommun>.se
bygglov.<kommun>.se
eller annan verifierad kommunägd domän
```

`www.tryggsignal.se` är inte en separat applikation utan endast redirect/canonicalisering.

`app.tryggsignal.se` och `kommuner.tryggsignal.se` är reserverade plattformsdomäner.

`<kommun>.tryggsignal.se` ska vara standarddomän och fallback även när kommunen använder egen custom domain.

---

# 151. DOMÄNERNAS ANSVAR

## `tryggsignal.se`

Ska innehålla:

- publik produktwebb,
- kommuninformation,
- säkerhets-/integrationsöversikt,
- kontakt,
- upphandlingsinformation,
- eventuell statuslänk,
- integritets-/juridiska dokument.

Den får inte exponera kommunernas ärendedata.

## `app.tryggsignal.se`

Ska vara:

- central applikationsentré,
- tenant discovery,
- tenantval för användare med flera behörigheter,
- generisk login gateway,
- Tryggsignals interna platform-admin-route där detta är lämpligt.

Den ska normalt inte läsa kommunala ärendedata innan tenant har identifierats.

## `kommuner.tryggsignal.se`

Ska vara en kommunfokuserad entry point där:

- kommun kan hittas/väljas,
- användare kan dirigeras till rätt tenantdomän,
- kommunal onboarding/status kan visas,
