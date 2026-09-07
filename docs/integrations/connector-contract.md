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
