# Connector contract

Masterplan 60, 61, 62, 65, 66, 67, 68, 134, 135.

Every connector — generic or vendor-specific — implements the same internal contract and declares
its capabilities:

```
healthCheck()
listCases()      getCase()      createCase()     updateCase()
listDocuments()  getDocument()  addDocument()
listParties()    listEvents()   addMessage()     setStatus()
exportRecords()
```

## Rules

1. **No assumed fields.** A vendor adapter is written only against verified documentation for a named
   product and version, with contract tests. Missing access is recorded as `EXTERNAL_BLOCKED` in
   `docs/blockers.md` — never as a mocked production response.
2. **Idempotency.** Distributed delivery is at-least-once. Every external write carries an
   idempotency key; a duplicate delivery must not create a duplicate case.
3. **Retries.** Exponential backoff, bounded attempts, dead-letter state, manual replay, reconciliation.
   Failed events are never discarded.
4. **Field ownership.** Ownership is declared per field per integration. There is no general
   last-write-wins.
5. **Credentials.** Per municipality, resolved through the `SecretProvider` by reference. Credentials
   are never shared between municipalities and never logged.

## Before implementing an adapter (masterplan 135)

Check the official documentation, API version, authentication, test environment, rate limits, data
license, caching rights, and whether the object is an original or only a search reference. Record the
answers next to the adapter.


## Generic transport adapters — Phase H

All generic transports map through the same `CaseMapping` and emit canonical records carrying:

- stable `externalId`;
- `sourceVersion` when the source provides one;
- deterministic `sourceHash`;
- explicit `mappingVersion`;
- untouched `raw` source payload for server-side provenance.

Implemented transport contracts:

| Transport | Adapter | Current generic capabilities | Notes |
| --- | --- | --- | --- |
| REST/OpenAPI | `GenericRestConnector` | `listCases`, `setStatus` | HTTP mapping only; no vendor fields in core. |
| File | `GenericFileConnector` | `listCases` | JSON array, JSONL and CSV through an injected file source. |
| SFTP | `GenericSftpConnector` | `listCases` | Uses an injected SFTP client; credentials remain secret references. |
| SQL read | `GenericSqlReadConnector` | `listCases` | Exactly one SELECT. Production credentials **must** also be database-level read-only. |
| SOAP | `GenericSoapConnectorSlot` | none until verified | Fails `EXTERNAL_BLOCKED` until WSDL/auth/operations are verified. |
| Webhook | `GenericInboundWebhookConnector` | inbound receipt | Signature/auth verifier is injected; stable event id/type are required. |

A generic adapter rejects capabilities it does not actually implement.

### Durable inbound receipt

Webhook, polling or batch transports persist inbound events through
`integration.receive_inbound_event(...)`. The function is service-only and uses the unique
`connector_instance_id + idempotency_key` constraint as the duplicate source of truth. Redelivery:

- does not insert a second event;
- increments `duplicate_count`;
- records `last_duplicate_at`;
- appends a SERVICE audit event.

Raw integration payload tables are not browser-readable.

### Reconciliation

`reconcileCases()` compares source hash/version/mapping-version to the tracked external record.
The durable result is written to `integration.reconciliation_runs` and updates connector health:

- exact match → `GREEN / HEALTHY`;
- new/changed/missing/duplicate source identity → `RED / DEGRADED`.

Reconciliation never resolves field conflicts by last-write-wins. Field ownership remains explicit
through `integration.field_ownership` and `resolveInboundChanges()`.

### SQL-read safety

The SQL adapter rejects non-SELECT statements, multiple statements, common mutating keywords and
known side-effecting functions. This parser is defense in depth, **not** the database authorization
boundary. Every production SQL-read integration must use a credential whose database grants are
read-only on an explicitly approved view/schema.
