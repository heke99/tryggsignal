**obligation_rules**

**compliance_objects**

**inspections_due**

**compliance_findings**

Automation:

**building**

**→ applicable obligation**

**→ next due date**

**→ missing inspection**

**→ risk/work queue**

**75. AI ENGINE**

AI provider-neutral.

Skapa:

**ai.providers**

**ai.models**

**ai.prompt_versions**

**ai.runs**

**ai.findings**

**ai.reviews**

**76. AI TASKS — IMPLEMENTATIONSORDNING**

1. document classification
2. metadata extraction
3. case summary
4. completeness assistance
5. referral summary
6. document version comparison
7. work queue triage
8. draft generation
9. plan/context analysis
10. advanced anomaly detection.

**77. AI EVIDENCE**

Varje AI finding:

**finding**

**confidence**

**source_document**

**page/section**

**extracted_value**

**rule_id if applicable**

**model**

**prompt_version**

**created_at**

UI ska ha:

**Visa varför**

**78. AI SECURITY**

Dokument är prompt-injection-risk.

AI får aldrig:

- följa instruktioner från dokument,
- ändra permissions,
- hämta secrets,
- själv ge sig tools,
- läsa annan authority,
- exekvera kod,
- skriva direkt till juridiskt kritisk state.

**79. HUMAN IN THE LOOP**

Slutliga myndighetsbeslut ska kräva behörig människa om inte kommunen efter särskild juridisk analys aktiverar ett uttryckligen tillåtet deterministiskt automatiserat flöde.

AI själv får inte vara final decision maker.

**80. AUDIT**

Append-only audit:

**actor**

**actor_type**

**authority**

**action**

**resource**

**timestamp**

**purpose**

**ip**

**session**

**correlation_id**

**trace_id**

**source_system**

**before_hash**

**after_hash**

**previous_event_hash**

Ingen normal användarroll får UPDATE/DELETE.

**81. BREAK GLASS**

Ingen plattformssuperadmin ska permanent kunna läsa allt kundinnehåll.

Supportaccess:

**request**

**reason**

**tenant approval/policy**

**MFA**

**time limit**

**audit**

**automatic expiry**

**82. INFORMATION CLASSIFICATION**

Implementera:

**information_classes**

**secrecy_markings**

**access_policies**

Search, AI och export måste respektera klassningen.

**83. FILE SECURITY**

Skydda mot:

- executable content,
- MIME spoofing,
- zip bombs,
- malware,
- oversized files,
- path traversal.

**84. RATE LIMITING**

Inför per:

**IP**

**user**

**tenant**

**endpoint**

Särskilt:

- auth,
- upload,
- public submission,
- search,
- AI,
- export.

**85. SECRET MANAGEMENT**

Förbjud credentials i:

**Git**

**frontend**

**NEXT_PUBLIC_***

**logs**

**plain DB rows**

Använd secure environment/vault.

**86. OBSERVABILITY**

Inför:

**trace_id**

**correlation_id**

**request_id**

Observability för:

- app,
- database,
- queues,
- integration,
- migration,
- AI,
- storage,
- auth.

**87. API STANDARD**

Alla egna externa REST-API:er ska:

- ha OpenAPI,
- följa aktuell Digg REST API-profil där tillämpligt,
- stödja correlation,
- versionshanteras,
- ha standardiserade errors,
- idempotency där relevant.

Agenten ska validera OpenAPI mot Diggs aktuella validator/profil före release.

**88. ARCHIVE**

Implementera:

**retention_rules**

**legal_holds**

**archive_packages**

**archive_exports**

**archive_events**

Archive package ska inkludera:

- metadata,
- case,
- parties,
- events,
- document versions,
- decisions,
- checksums,
- manifest.

**89. GALLRING**

Ingen generell delete för myndighetsärenden.

Använd:

**retention decision**

**legal hold check**

**approved disposition**

**audit**

**90. EXITABILITY**

Kommunen ska kunna exportera sina data.

Stöd:

- canonical JSON
- PostgreSQL export
- documents
- FGS
- SIARD där relevant
- audit
- configuration.

Vendor lock-in får inte vara produktstrategin.

**91. REPORTING**

Skapa reporting read models.

Rapporter:

- inflöde,
- backlog,
- deadline,
- processing time,
- case type,
- workload,
- inspection,
- automation.

**92. ROI ENGINE**

Mät faktisk resursbesparing.

Minimum:

**manual touches**

**automated actions**

**AI suggestions**

**accepted AI**

**rejected AI**

**time per phase**

**completion rounds**

**case throughput**

**inspection time**

**backlog**

**deadline misses**

**93. SCB**

SCB PxWeb används för extern statistik/benchmarking.

SCB-data ska inte blandas med transaktionell case state.

**94. STAFF UI**

Case workspace:

Header:

**case number**

**property**

**applicant**

**status**

**assigned worker**

**deadline**

**completeness**

**risk**

Tabs:

**Overview**

**Documents**

**Parties**

**Property**

**Process**

**Messages**

**Referrals**

**Decisions**

**Inspections**

**AI**

**Audit**

**95. CONTROL TOWER**

Dashboard:

**deadlines < 5 days**

**incomplete**

**unassigned**

**referrals overdue**

**inspections upcoming**

**high-risk supervision**

**failed integrations**

**failed jobs**

Dashboard ska vara operativ, inte bara grafer.

**96. CITIZEN PORTAL**

Stöd:

- login/eID,
- draft application,
- structured forms,
- document upload,
- applicant/representative,
- status,
- request for completion,
- messages,
- decisions.

**97. ACCESSIBILITY**

Bygg WCAG/public-sector accessibility-first.

Testa:

- keyboard,
- screen reader,
- semantic HTML,
- labels,
- errors,
- focus,
- contrast,
- responsive.

**98. BUILD PLAN — P0**

**P0 — DISCOVERY & BASELINE**

Agenten ska:

1. inspect repo,
2. inspect current Supabase projects,
3. inspect schema,
4. inspect auth,
5. inspect deployed app,
6. run current tests,
7. run current build,
8. identify legacy/dead code,
9. identify current security risks,
10. create master-plan gap report.

Gate:

**baseline documented**

**existing tests executed**

**current failures documented**

**99. P1 — PROJECT FOUNDATION**

Implementera:

- repo structure,
- TypeScript strict mode,
- lint,
- formatter,
- CI,
- env validation,
- error handling,
- observability base,
- dependency pinning.

Gate:

**lint GREEN**

**typecheck GREEN**

**build GREEN**

**unit GREEN**

**100. P2 — SUPABASE FOUNDATION**

Implementera:

- schemas,
- extensions,
- grants,
- default security posture,
- dev/test/prod strategy,
- migrations.

Kör Supabase advisors.

Gate:

**migration replay GREEN**

**security advisor high severity = 0**

**101. P3 — ORGANIZATION / IDENTITY**

Implementera:

- organizations,
- authority,
- departments,
- units,
- teams,
- users,
- identity mapping.

Tests.

**102. P4 — RBAC / ABAC / RLS**

Implementera hela security model.

Kör authorization matrix.

Ingen fortsatt produktionsfeature får kallas production-ready innan denna är GREEN.

**103. P5 — CASE CORE**

Implementera canonical case model.

Test:

- create,
- read,
- assign,
- status,
- history,
- cross-authority denial.

**104. P6 — PROPERTY CORE**

Implementera property/postgis model.

Testa spatial queries och index.

**105. P7 — DOCUMENT ENGINE**

Implementera:

- upload,
- quarantine,
- metadata,
- version,
- hash,
- storage policies.

Security test.

**106. P8 — WORKFLOW / DEADLINES**

Implementera durable state.

Test:

- normal path,
- pause,
- resume,
- overdue,
- workflow version retention.

**107. P9 — RULE ENGINE**

Implementera deterministic rule engine.

Test:

- effective dates,
- old rule version,
- new version,
- explanation/evidence.

**108. P10 — QUEUES / WORKER / CRON**

Implementera durable queues.

Test:

- duplicate job,
- retry,
- worker crash,
- visibility timeout,
- replay.

**109. P11 — SEARCH**

Implementera FTS/trigram/PostGIS search.

Test:

- relevance,
- pagination,
- unauthorized result never leaks.

**110. P12 — GENERIC INTEGRATION FRAMEWORK**

Implementera:

- connector contract,
- REST,
- file,
- SFTP,
- SQL read,
- external mappings,
- sync,
- reconciliation.

**111. P13 — MIGRATION ENGINE**

Implementera RAW → canonical pipeline.

Golden migration dataset.

Test rerun/idempotency.

**112. P14 — NATIONAL SOURCE REGISTRY**

Implementera source registry, licensing, provenance och source refresh framework.

**113. P15 — LANTMÄTERIET**

Implementera NGP först.

Därefter Geotorget APIs när access finns.

Test mot verifierings/testmiljö där leverantören erbjuder sådan.

**114. P16 — BOVERKET**

Implementera:

- energy declarations,
- public reference APIs.

Rate-limit tests.

Cache tests.

**115. P17 — BOLAGSVERKET / NAVET**

Implementera organization verification.

Navet endast när kommunåtkomst finns.

**116. P18 — DIGITAL POST / IDENTITY**

Implementera Digital Post adapter.

Implementera Sweden Connect-compatible identity interface.

SAML integration först om faktiskt kundbehov.

**117. P19 — GEODATA ENRICHMENT**

Implementera adapters:

- Naturvårdsverket,
- RAÄ,
- SGU,
- Länsstyrelsen,
- Trafikverket.

Alla data source-classified.

**118. P20 — AI FOUNDATION**

Implementera:

- provider abstraction,
- run audit,
- prompt versioning,
- classification,
- extraction,
- summary.

Security gate.

**119. P21 — BUILDING PERMIT WORKSPACE**

Sätt ihop:

**case**

**property**

**documents**

**workflow**

**rules**

**deadlines**

**communications**

**AI**

till första kompletta verksamhetsmodulen.

**120. P22 — COMPLETENESS ENGINE**

Input:

**case classification**

**property context**

**rules**

**documents**

**extracted metadata**

Output:

**COMPLETE**

**INCOMPLETE**

**HUMAN_REVIEW**

Alltid med evidence.

**121. P23 — PBL SUPERVISION**

Implementera:

- supervision cases,
- risk queue,
- inspections,
- findings,
- actions,
- follow-up.

**122. P24 — OVK**

Implementera:

- objects,
- obligations,
- next due,
- protocol,
- findings,
- supervision queue.

**123. P25 — ARCHIVE / FGS**

Implementera export.

Verifiera output.

**124. P26 — ROI / ANALYTICS**

Implementera operational metrics.

**125. P27 — LEGACY EDGE CONNECTOR**

Implementera .NET Windows Service.

Testa:

- offline,
- retry,
- corrupted input,
- service restart,
- credential expiry.

**126. P28 — FIRST REAL VENDOR CONNECTOR**

Välj baserat på första pilotkund.

Implementera inte fem halvfärdiga adapters före första riktiga kundintegration.

**127. P29 — SECURITY HARDENING**

Utför:
