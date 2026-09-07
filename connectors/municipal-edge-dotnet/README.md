# Municipal edge connector (.NET Worker Service)

Masterplan 63, 64, 125.

## Status

`NOT_STARTED` (P27). This directory holds the contract the implementation must satisfy so that the
requirements are not rediscovered later.

## Requirements

- .NET Worker Service installed as a Windows Service. **No Docker.**
- Outbound TLS only. mTLS must be supported. No inbound internet port into the municipal network may
  be required as standard.
- Source support: REST, SOAP, read-only SQL views, SFTP, SMB/export folders, local files.
- Credentials: encrypted at rest, least privilege, one credential per integration, never a domain
  admin, rotatable. Credentials are never written to logs.
- Delivery: at-least-once with an idempotency key per message, exponential backoff, dead-letter state
  and manual replay. Failed events are never discarded.

## Tests required before this phase may turn GREEN (masterplan 125)

Offline operation, retry after connectivity loss, corrupted input, service restart mid-batch, and
credential expiry.
