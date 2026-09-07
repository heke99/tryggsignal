
Hierarki:

**Municipality**

**  → Legal Entity**

**    → Authority / Nämnd**

**      → Department**

**        → Unit**

**          → Team**

**authority** är en säkerhetsgräns.

Anta aldrig att alla nämnder automatiskt får dela all information.

**14. IDENTITY**

Skapa intern **identity.users**.

Affärslogik ska inte referera direkt till **auth.users** som enda användarrepresentation.

Minimum:

**id**

**auth_user_id**

**external_subject**

**identity_provider**

**email**

**display_name**

**employee_id**

**status**

**last_login_at**

**disabled_at**

**created_at**

**updated_at**

**15. PERSONALIDENTITET**

Personal:

- Microsoft Entra ID är primär integrationsväg.
- SAML/OIDC abstraction ska finnas.

Externa användare:

- identity broker layer,
- Sweden Connect adapter,
- SAML idag,
- OIDC-ready för framtida aktivering.

OIDC får inte aktiveras i produktion mot Sweden Connect innan den officiella anslutningen faktiskt är tillgänglig och testad.

**16. RBAC**

Implementera tabeller:

**roles**

**permissions**

**role_permissions**

**role_assignments**

Permissions ska vara granular:

**case.read**

**case.create**

**case.update**

**case.assign**

**case.close**

**document.read**

**document.upload**

**document.classify**

**decision.prepare**

**decision.approve**

**inspection.create**

**inspection.complete**

**audit.read**

**integration.manage**

**security.manage**

Roller:

**tenant_admin**

**security_admin**

**registrar**

**building_case_worker**

**senior_case_worker**

**building_inspector**

**environmental_inspector**

**planning_officer**

**decision_maker**

**board_secretary**

**archivist**

**records_manager**

**finance_officer**

**gis_officer**

**auditor**

**external_applicant**

**external_representative**

**integration_service**

**17. ABAC**

Implementera policykontroll med attribut som:

**authority**

**department**

**unit**

**case_type**

**assigned_user**

**assigned_team**

**information_class**

**secrecy_level**

**relationship_to_case**

**geographic_scope**

**purpose**

Central function/service:

**can(user, permission, resource)**

Result:

**allowed**

**policy_id**

**reason**

**18. RLS**

RLS ska aktiveras på alla klientåtkomliga tabeller.

För varje tabell:

- SELECT policy
- INSERT policy
- UPDATE USING
- UPDATE WITH CHECK
- DELETE endast om domänen faktiskt tillåter delete.

Använd inte endast:

**TO authenticated**

som authorization.

Scope måste kontrolleras.

Authorization får aldrig bygga på **user_metadata**.

Använd inte SECURITY DEFINER för att lösa RLS-problem.

Om SECURITY DEFINER absolut krävs:

- private schema,
- explicit auth check,
- explicit search_path,
- revoke PUBLIC execute,
- security review,
- test.

**19. RLS TEST MATRIX**

För varje känslig tabell testa:

**anonymous**

**external applicant**

**external representative**

**case worker**

**worker other department**

**worker other authority**

**senior worker**

**decision maker**

**tenant admin**

**auditor**

**service account**

För varje:

**SELECT**

**INSERT**

**UPDATE**

**DELETE**

Alla negativa testfall är lika viktiga som positiva.

**20. CORE CASE MODEL**

Implementera minst:

**cases**

**case_status_history**

**case_assignments**

**case_properties**

**parties**

**case_parties**

**classifications**

**classification_versions**

**cases**:

**id**

**authority_id**

**department_id**

**case_number**

**external_case_number**

**classification_id**

**classification_version**

**case_type**

**process_type**

**measure_type**

**title**

**description**

**status**

**phase**

**priority**

**assigned_user_id**

**assigned_team_id**

**primary_property_id**

**information_class_id**

**secrecy_level**

**source_system**

**source_record_id**

**system_of_record**

**received_at**

**registered_at**

**complete_at**

**started_at**

**decided_at**

**closed_at**

**statutory_due_at**

**effective_due_at**

**workflow_version_id**

**rule_set_version_id**

**created_at**

**created_by**

**updated_at**

**updated_by**

**archived_at**

**archive_package_id**

**21. SYSTEM OF RECORD**

Varje external/canonical record ska veta:

**system_of_record**

**source_system**

**source_record_id**

**source_updated_at**

**last_synced_at**

Overlay:

**system_of_record = EDP_VISION**

Efter cutover:

**system_of_record = KOMMUN_OS**

**22. PROVENIENS**

Skapa modell som kan svara:

**Var kom värdet ifrån?**

**Vilken API-version?**

**Vilket external record?**

**Vilket datum?**

**Vilken mapping-version?**

**Har informationen ändrats hos oss?**

**Av vem?**

Detta gäller både:

- migration,
- integration,
- AI extraction,
- national data APIs.

**23. DATA SOURCE REGISTRY**

Skapa:

**integration.data_sources**

Fält:

**id**

**key**

**provider**

**dataset**

**protocol**

**authority_level**

**authoritative_level**

**license**

**legal_access_requirement**

**credential_type**

**cache_policy**

**refresh_policy**

**rate_limit_policy**

**source_version**

**enabled**

**authoritative_level** exempel:

**AUTHORITATIVE**

**REFERENCE**

**ADVISORY**

**DERIVED**

**AI_DERIVED**

**24. EXTERNAL API RULE**

En AI-genererad datapunkt får aldrig ersätta en auktoritativ datapunkt.

Prioritet:

**AUTHORITATIVE SOURCE**

**>**

**LOCAL SYSTEM OF RECORD**

**>**

**OFFICIAL REFERENCE SOURCE**

**>**

**ADVISORY SOURCE**

**>**

**AI DERIVATION**

Konflikt ska visas, inte tyst lösas.

**25. PROPERTY GRAPH**

Implementera:

**properties**

**property_identifiers**

**addresses**

**buildings**

**spatial_features**

**property_relations**

**case_properties**

PostGIS geometry.

Alla geodataobjekt ska ha:

**source**

**source_object_id**

**source_version**

**source_timestamp**

**geometry**

**attributes**

**26. LANTMÄTERIET NGP ADAPTER**

Använd NGP för:

- detaljplan,
- planbeskrivning,
- relevanta nationella geodatamängder.

Stöd:

- STAC discovery
- OGC API Features
- OAuth/Bearer
- pagination
- rate limits
- retries
- cache
- source version.

VIKTIGT:

NGP-referensobjekt som endast är sökindex får inte behandlas som juridiskt original.

När relevant:

1. sök referens,
2. identifiera domänobjekt,
3. hämta original-domänobjekt,
4. lagra provenance.

**27. LANTMÄTERIET GEOTORGET ADAPTER**

Skapa separata adapters för:

**Fastighet och samfällighet Direkt**

**Byggnad Direkt**

**Belägenhetsadress Direkt**

Använd aldrig credentials centralt mellan kommuner.

Varje kommun/data plane ska ha egen credential reference.

Behörighets-/licensstatus ska registreras.

Om API saknas p.g.a. avtal:

**EXTERNAL_BLOCKED**, inte mock production response.

**28. BOVERKET ADAPTER**

Separera:

**energy-declarations**

**concept-bank**

**regulations**

**purpose-catalog**

**climate-data**

Energideklarationer ska få lokal caching för att respektera rate limits.

Skapa:

**compliance.energy_declarations**

med:

**property_id**

**building_id**

**source_id**

**energy_class**

**primary_energy**

**specific_energy**

**radon_measurement_status**

**ventilation_check_status**

**performed_at**

**source_fetched_at**

**source_payload_hash**

**29. BOlAGSVERKET ADAPTER**

Använd för organisationer som är part i ärendet.

Skapa snapshot, inte egen kopia av hela Bolagsverket.

Exempel:

**organization_verifications**

med:

**organization_number**

**registered_name**

**status**

**registered_address**

**verified_at**

**source_version**

**source_record_hash**

Använd notifieringar när det skapar konkret nytta.

**30. SKATTEVERKET NAVET**

Navet ska bara aktiveras för kommun som:

- är behörig,
- har avtal/åtkomst,
- har rättslig grund.

Credentials ska ägas/scope:as till kommunen.

Central SaaS får inte bygga upp ett eget generellt Navet-register.

Minimera datan.

Logga access purpose.

**31. DIGITAL POST**

Implementera:

**recipient check**

**message creation**

**attachments**

**correlation id**

**send**

**receipt**

**failed delivery**

**retry**

**reconciliation**

All extern post ska kopplas till:

**case_id**

**message_id**

**document_version_id**

**correlation_id**

**32. BOVERKETS NATIONELLA PBL-KLASSIFICERING**

Skapa versionerad canonical classification.

Data ska kunna importeras från framtida officiell fil/API.

Hårdkoda inte dagens struktur permanent.

Skapa:

**classifications**

**classification_versions**

**classification_mappings**

Mapping:

**legacy code**

**local municipality code**

**canonical code**

**Boverket code**

**33. EXTERNA GEODATAKÄLLOR**

Implementera source adapters stegvis:

**Naturvårdsverket**

- skyddad natur
- Natura 2000
- relevanta miljölager.

**Riksantikvarieämbetet**

- kulturmiljö
- byggnadsminnen
- kulturarvsobjekt.

**SGU**

- jordarter
- geologiska lager
- andra planeringsunderlag.

**Länsstyrelsen**

- relevanta regionala planeringslager
- riksintressen
- VISS
- skydd.

**Trafikverket**

- NVDB
- väg
- väghållare
- väggeometri.

**SMHI**

- klimat/hydrologisk information när användningsfallet kräver det.

Alla dessa ska i första hand klassas som:

**REFERENCE**

**eller**

**ADVISORY**

om de inte uttryckligen är auktoritativ registerinformation för det aktuella beslutet.

**34. DATA LICENSERING**

För varje data source lagra:

**license**

**attribution_requirement**

**redistribution_allowed**

**caching_allowed**

**retention**

**legal_access_requirement**

Bygg inte cache/publik funktion som bryter datakällans villkor.

**35. DOCUMENT ENGINE**

Implementera:

**documents**

**document_versions**

**document_relations**

**document_classifications**

Originaldokument är immutable version.

Ny fil = ny version.

Spara:

**sha256**

**mime_type**

**detected_mime_type**

**size**

**storage_path**

**source**

**source_document_id**

**created_at**

**36. DOCUMENT INGESTION**

Pipeline:

**upload**

**→ quarantine**
