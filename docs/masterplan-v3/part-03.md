**→ file validation**

**→ MIME detection**

**→ malware scan**

**→ SHA-256**

**→ Storage**

**→ metadata extraction**

**→ text/OCR when required**

**→ classification**

**→ search indexing**

**→ AI analysis when allowed**

Dokument ska alltid behandlas som untrusted input.

**37. STORAGE**

Buckets:

**quarantine**

**case-documents**

**generated-documents**

**temporary-uploads**

**migration-source**

**archive-packages**

**integration-files**

Inga myndighetsdokument i public buckets.

Signed URLs ska vara kortlivade.

Storage-operationer ska göras via Storage API, inte genom direkt manipulation av Storage metadata.

**38. STORAGE BACKUP**

Databasbackup är inte dokumentbackup.

Implementera separat backup/reconciliation för Storage.

Måste kunna verifiera:

**expected objects**

**actual objects**

**checksum**

**secondary backup**

**restore test**

Skapa runbook för Storage restore.

**39. WORKFLOW ENGINE**

Implementera versionshanterade:

**workflow_templates**

**workflow_template_versions**

**workflow_instances**

**workflow_tasks**

**workflow_transitions**

**workflow_timers**

Workflowdefinition får inte ligga hårdkodad i frontend.

Gamla ärenden behåller workflowversionen de startade på.

**40. RULE ENGINE**

Implementera separat deterministisk rule engine:

**rule_sets**

**rule_set_versions**

**rules**

**rule_sources**

**rule_evaluations**

Alla evaluations ska spara:

**rule version**

**input snapshot**

**result**

**evidence**

**timestamp**

AI får inte vara regelmotor.

**41. DEADLINE ENGINE**

Separera juridiska tidsfrister från vanliga tasks.

Skapa:

**deadlines**

**deadline_events**

**deadline_calculations**

En handläggare ska kunna förstå exakt varför:

**due_at = YYYY-MM-DD**

**42. QUEUES**

Använd durable Supabase Queues/PGMQ för:

**document-processing**

**search-indexing**

**ai-analysis**

**integration-inbound**

**integration-outbound**

**notifications**

**migration**

**archive-generation**

**report-generation**

**reference-data-sync**

Använd Basic/durable queue för kritiska jobb.

Använd inte unlogged queue för juridiskt kritiska processer.

**43. JOB ENVELOPE**

Alla jobb:

**job_id**

**type**

**tenant_context**

**authority_context**

**correlation_id**

**causation_id**

**idempotency_key**

**payload**

**attempt**

**created_at**

**44. WORKER**

Bygg worker som:

- pollar queues,
- claimar messages,
- heartbeat,
- retry,
- archive on success,
- dead-letter/failure state.

Ingen tung bakgrundsoperation i normal user HTTP request.

**45. CRON**

Använd Supabase Cron endast för små schemalagda triggers.

Cron ska primärt:

- enqueue work,
- start reconciliation,
- kontrollera deadlines,
- starta reference sync.

Kör inte enorma batchmigrationer direkt i cron-jobbet.

**46. SEARCH**

Börja med PostgreSQL.

Använd:

**tsvector**

**GIN**

**pg_trgm**

**PostGIS**

OpenSearch införs endast efter dokumenterad prestandaflaskhals.

**47. SEARCH READ MODEL**

Skapa separat:

**search.entities**

eller motsvarande read model.

Indexera:

**case number**

**title**

**property designation**

**address**

**party organization**

**authorized party/person attributes**

**document extracted text**

**48. SEARCH SECURITY**

Search får aldrig bypassa access control.

Varje indexed entity ska ha:

**authority_id**

**information_class**

**security_scope**

Resultat ska authorization-filtreras.

Semantic search ska scope-filtreras innan resultat skickas till AI.

**49. VECTOR SEARCH**

Använd pgvector först när AI/semantic retrieval implementeras.

Embeddings:

**entity_id**

**document_version_id**

**authority_id**

**embedding_model**

**embedding_version**

Ny dokumentversion invalidierar tidigare embedding.

**50. INDEXERING**

Indexera primärt faktiska querymönster.

Minimum:

**Cases**

**(authority_id, status)**

**(authority_id, assigned_user_id, status)**

**(authority_id, assigned_team_id, status)**

**(authority_id, statutory_due_at)**

**(case_number)**

**(primary_property_id)**

**(source_system, source_record_id)**

**Documents**

**(case_id)**

**(case_id, document_type)**

**(source_system, source_document_id)**

**(sha256)**

**Tasks**

**(assigned_user_id, status, due_at)**

**(assigned_team_id, status, due_at)**

**Integrations**

**(connector_id, external_event_id)**

**(idempotency_key)**

**(status, next_retry_at)**

**Spatial**

GiST geometry.

**FTS**

GIN tsvector.

Använd partial index på exempelvis öppna ärenden.

**51. RLS PERFORMANCE**

Alla RLS-kolumner som används regelbundet ska indexeras.

Analysera:

**EXPLAIN**

**EXPLAIN ANALYZE**

**pg_stat_statements**

Ingen RLS-policy får accepteras utan prestandatest på realistisk datamängd.

**52. CONNECTION/PERFORMANCE MODEL**

Next.js/serverless:

- Data API där lämpligt,
- transaction pooling för native short-lived DB connections.

Worker:

- lämplig pooled/direct modell beroende på runtime.

Migrations:

- direct/native Postgres connection.

Övervaka connection saturation.

**53. PERFORMANCE TARGETS**

Sätt initial SLO:

**Normal read:**

**p95 < 500 ms**

**Simple mutation:**

**p95 < 700 ms**

**Search:**

**p95 < 1 s**

**Initial workspace load:**

**target < 2 s**

AI får vara långsammare men får inte blockera handläggning.

**54. MIGRATION ENGINE**

Bygg permanent produktfunktion.

Pipeline:

**SOURCE**

**→ EXTRACT**

**→ RAW**

**→ PROFILE**

**→ MAP**

**→ VALIDATE**

**→ TRANSFORM**

**→ CANONICAL**

**→ RECONCILE**

**→ IMPORT**

**→ VERIFY**

**55. MIGRATION TABLES**

Skapa:

**migration.sources**

**migration.batches**

**migration.objects**

**migration.mappings**

**migration.mapping_versions**

**migration.errors**

**migration.reconciliation_runs**

**56. RAW DATA**

Originalpayload ska bevaras under migrering.

Exempel:

**source_system**

**source_version**

**source_table/object**

**source_primary_key**

**raw_payload**

**source_hash**

**exported_at**

Gör aldrig irreversible transform innan raw har sparats.

**57. SUPPORTED MIGRATION FORMATS**

Stöd:

**CSV**

**XLSX**

**XML**

**JSON**

**ZIP**

**SQL dump/export**

**PDF**

**PDF/A**

**TIFF**

**JPEG**

**PNG**

**GeoJSON**

**GeoPackage**

**Shapefile**

**FGS**

**SIARD**

**58. FGS**

Implementera adapter/export mot:

**FGS Ärendehantering**

**FGS Paketstruktur**

**FGS Databas/SIARD**

FGS-version ska deklareras.

Agenten ska kontrollera aktuell Riksarkivet-specifikation före implementation.

**59. MIGRATION RECONCILIATION**

Migrationen är inte klar när import-script slutar med exit 0.

Verifiera:

**source case count**

**target case count**

**source document count**

**target document count**

**missing**

**duplicates**

**hash mismatches**

**broken relations**

**unmapped status**

**unmapped classification**

**orphan documents**

**60. GENERIC CONNECTORS**

Bygg först generiska connectors:

**REST/OpenAPI**

**SOAP**

**SFTP**

**file share/export**

**CSV/XML/JSON**

**SQL read**

Dessa återanvänds för legacy.

**61. VENDOR CONNECTORS**

Adapter slots ska finnas för:

**Sokigo Nova**

**Sokigo ByggR**

**Sokigo Ecos**

**EDP Vision**

**Prosona Castor**

**Open ePlatform**

**Tietoevry Plan & Build**

**Public 360**

**W3D3**

MEN:

Implementera aldrig antagna API-fält.

För varje pilot:

1. identifiera exakt produkt,
2. version,
3. licens,
4. API-dokumentation,
5. autentisering,
6. read/write capabilities,
7. webhook/polling,
8. exportformat.

Skapa sedan connector contract tests.

**62. CONNECTOR INTERFACE**

Gemensamt internt contract:

**healthCheck()**

**listCases()**

**getCase()**

**createCase()**

**updateCase()**

**listDocuments()**

**getDocument()**

**addDocument()**

**listParties()**

**listEvents()**

**addMessage()**

**setStatus()**

**exportRecords()**

Connector deklarerar capabilities.

**63. MUNICIPAL EDGE CONNECTOR**

Bygg separat .NET Worker Service.

Installeras som Windows Service.

Ingen Docker.

Stöd:

**REST**

**SOAP**

**SQL read-only view**

**SFTP**

**SMB/export folder**

**local files**

Connector kommunicerar outbound via TLS.

mTLS ska stödjas.

Ingen inbound internetport till kommunens nät ska krävas som standard.

**64. EDGE CONNECTOR SECURITY**

Connector credentials:

- encrypted at rest,
- least privilege,
- per integration,
- no domain admin,
- rotation.

Agenten ska aldrig logga credentials.

**65. SYNC ENGINE**

Implementera:

**connectors**

**connector_instances**

**external_records**

**sync_jobs**

**integration_events**

**sync_checkpoints**

**66. IDEMPOTENCY**

Alla external writes måste ha idempotency strategy.

Distributed integrations antas vara at-least-once.

Dubbel delivery får inte skapa dubbelt ärende.

**67. RETRIES**

Implementera:

- exponential backoff,
- maximum attempts,
- dead-letter state,
- manual replay,
- reconciliation.

Kasta inte failed events.

**68. CONFLICT RESOLUTION**

Field ownership ska deklareras.

Exempel:

**legacy owns:**

**status**

**KommunOS owns:**

**ai_summary**

Ingen generell **last write wins**.

**69. COMMUNICATION**

Implementera:

**messages**

**deliveries**

**templates**

**delivery_events**

Kanaler:

**email**

**digital post**

**SMS**

**portal**

**API**

**physical-post export**

**70. REMISS**

Implementera:

**referrals**

**referral_recipients**

**referral_responses**

Deadlines och reminders.

AI får sammanfatta remissvar.

Originaldokumentet är källa.

**71. GRANNEHÖRANDE**

Separat domain model:

**hearings**

**hearing_recipients**

**hearing_deliveries**

**hearing_responses**

**72. DECISIONS**

Implementera versionshanterade beslut.

AI-genererad text = draft.

Status:

**DRAFT**

**REVIEW**

**APPROVED**

**DECIDED**

**EXPEDITED**

**ARCHIVED**

**73. INSPECTIONS**

Implementera:

**inspections**

**inspection_templates**

**inspection_template_versions**

**inspection_items**

**findings**

**finding_evidence**

**74. COMPLIANCE / OVK**

Implementera:

**obligations**
