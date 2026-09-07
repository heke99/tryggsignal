# Runbook — break-glass support access

Masterplan 81.

There is no standing platform-superadmin read access to municipal content. Support access is
requested, approved, time-limited and audited.

1. Support engineer creates a row in `audit.break_glass_requests` with the affected
   `authority_id` and a reason of at least 20 characters describing the incident and the case scope.
2. A municipality approver (a user holding `security.manage` in that authority) reviews it.
3. Approval requires MFA and an explicit expiry; the schema rejects an `APPROVED` row without
   `mfa_verified`, `approved_by` and `expires_at`, and refuses any window longer than 8 hours.
4. Every read performed under break glass is written to `audit.events` with
   `actor_type = 'SUPPORT'` and the request's purpose.
5. When the incident is closed, set `status = 'REVOKED'` with `revoked_at`. Expired grants are swept
   to `EXPIRED` by the scheduled job.
6. The municipality receives the audit extract for the window.
