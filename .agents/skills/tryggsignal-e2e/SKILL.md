---
name: tryggsignal-e2e
description: "Use before declaring a Tryggsignal feature/phase GREEN and for complete municipality workflow verification across browser, API, database, integrations and authorization."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal End-to-End Gate

A phase is not GREEN because isolated tests pass. Verify the full user story browser → route/tenant resolver → auth → API/server action → RLS/database/Storage → queue/integration where applicable → rendered response and audit.

Maintain representative flows including:
- municipality staff login and work queue,
- case + property + document upload/versioning,
- completeness finding with evidence,
- completion request and applicant response,
- referral/hearing when relevant,
- decision draft/review/approval boundaries,
- delivery/archive path,
- tenant white-label/custom-domain rendering.

Mandatory negative flow: a user/session/domain from Municipality B attempts Municipality A data and receives no data or metadata leak. Also test stale/wrong cookie, manipulated tenant id, unknown host, unauthorized search and Storage URL access. Capture actual results; never infer success.
