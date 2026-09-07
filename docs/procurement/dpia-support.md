# DPIA support material

The municipality is the data controller; Tryggsignal is the processor. This
document supplies the technical facts a DPIA needs. It is not itself a DPIA.

## Processing overview

| Question                              | Answer                                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                               | Handling of building permits, notifications, PBL supervision, OVK and related municipal processes                                                                                                                                       |
| Legal basis (controller's assessment) | Exercise of official authority (GDPR art. 6.1 e) under PBL and förvaltningslagen                                                                                                                                                        |
| Categories of data subjects           | Applicants, property owners, representatives, neighbours, control officers, municipal staff                                                                                                                                             |
| Categories of personal data           | Name, contact details, property connection, case correspondence, decisions. A personal identity number is stored only as a reference (`core.parties.person_reference`); the value itself stays in the population-register adapter scope |
| Special categories                    | Not by design. Case content may incidentally contain health data (e.g. accessibility adaptations); it is covered by the information-class model                                                                                         |
| Retention                             | Per `archive.retention_rules`; no general delete exists (masterplan 89)                                                                                                                                                                 |
| Data location                         | Sweden/EU — Supabase project in `eu-north-1`, Vercel deployment in the EU region                                                                                                                                                        |
| Sub-processors                        | Supabase (database, auth, storage), Vercel (web hosting). An AI provider is not yet selected; no AI processing takes place until one is contracted                                                                                      |
| Transfers outside the EU/EEA          | None by design. Any provider that would introduce one requires a controller decision first                                                                                                                                              |

## Technical and organisational measures

- One database per municipality; no shared production data plane (ADR-001).
- Authority (nämnd) is a hard boundary enforced in the database by RLS.
- Access is role- and attribute-based, deny by default, with an explainable
  decision (`authz.can` returns policy id and reason).
- Append-only, hash-chained audit trail; no normal role can update or delete it.
- No standing platform access to municipal content; support access is requested,
  approved, MFA-verified, time-limited to at most 8 hours, and audited.
- Secrets are held by reference in a secret provider, never in Git, never in
  client-visible environment variables.
- Documents are treated as untrusted input: quarantine first, immutable versions,
  SHA-256 for every version.
- AI (when enabled) never receives content from another authority, never follows
  instructions inside documents, and never makes the final decision.

## Data subject rights

- Access and rectification: the case and its history are queryable per data
  subject through the case-party link.
- Erasure: restricted by law for authority records; handled through retention and
  disposition decisions, not ad-hoc deletion.
- Portability and exit: `docs/procurement/exit-plan.md`.
