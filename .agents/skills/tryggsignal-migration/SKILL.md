---
name: tryggsignal-migration
description: "Use for importing, converting, reconciling, archiving or cutting over data from legacy municipality systems into Tryggsignal."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Migration Gate

Migration is a permanent product capability, not a disposable script. Use: SOURCE → EXTRACT → RAW → PROFILE → MAP → VALIDATE → TRANSFORM → CANONICAL → RECONCILE → IMPORT → VERIFY.

Preserve raw payload, source system/version/table/key, export timestamp and source hash before irreversible transformation. Version every mapping. Support overlay, coexistence and full migration.

A migration is GREEN only after reconciliation covers counts, missing/duplicate records, document counts/hashes, broken relations, orphan files, unmapped statuses/classifications and rerun/idempotency. Simulate interruption/restart. Never report success merely because an import command exited 0.
