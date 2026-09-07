# Runbook — Storage backup and restore

Masterplan 37, 38, 131.

A database backup is **not** a document backup. Storage needs its own verified copy.

## Backup

- Buckets: `quarantine`, `case-documents`, `generated-documents`, `temporary-uploads`,
  `migration-source`, `archive-packages`, `integration-files`. None of them is public.
- A scheduled job enumerates `documents.document_versions` and reconciles the expected object list
  against the bucket listing, comparing SHA-256 for each object.
- Objects are copied to a secondary location under the municipality's own agreement.

## Reconciliation report

| Check            | Source                            | Expectation                     |
| ---------------- | --------------------------------- | ------------------------------- |
| Expected objects | `documents.document_versions`     | every row has a stored object   |
| Actual objects   | Storage listing                   | no object without a version row |
| Checksum         | `sha256` column vs. stored object | identical                       |
| Secondary copy   | backup target                     | present and identical           |

## Restore

1. Freeze ingestion for the affected municipality (pause the `document-processing` queue consumer).
2. Restore objects from the secondary copy into the target bucket via the Storage API — never by
   editing Storage metadata directly.
3. Re-run the reconciliation report; it must be clean before ingestion resumes.
4. Record RPO/RTO actually achieved in the incident report.

## Status

The pipeline described here is specified but **not yet implemented** — the document engine is P7 and
has not been built. This runbook is the contract the implementation must satisfy.
