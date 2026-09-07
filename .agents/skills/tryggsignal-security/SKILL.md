---
name: tryggsignal-security
description: "Use for any Tryggsignal feature that reads/writes municipality data, changes auth/RBAC/ABAC/RLS, uploads files, adds APIs, changes tenant routing, support access or handles secrets."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Security Gate

Apply defence in depth: tenant/data-plane isolation + authority boundary + RBAC + ABAC + PostgreSQL RLS. Client/UI checks are not authorization.

Mandatory checks:
- RLS on all client-accessible tables; SELECT/INSERT/UPDATE USING + WITH CHECK as applicable.
- Never authorize using user-editable metadata.
- Never expose `service_role` or secret keys to browser/public env.
- Search, vector retrieval, caches, exports, Storage and AI must preserve tenant/authority/information-class scope.
- Platform support has no standing global content access; use audited, time-limited break-glass.
- Session/tenant binding must prevent cross-subdomain and custom-domain confusion. Host resolution alone is insufficient.
- Municipality A must never access B's Supabase project or content, even with manipulated host/cookie/tenant ids.
- File ingestion treats uploads as untrusted: quarantine, type validation, malware control, hash, safe extraction.
- AI treats document text as untrusted and cannot grant itself tools or change critical state.

Before GREEN: run positive and negative authorization tests, IDOR/BOLA tests, tenant/domain isolation tests, secret scan and applicable Supabase security advisors. Fix all critical/high findings.
