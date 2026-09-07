# API contracts

Masterplan 87.

External REST APIs published by Tryggsignal must:

- ship an OpenAPI description in this directory,
- follow the current Digg REST API profile where applicable (validate against Digg's current
  validator before release — do not assume an older profile version),
- be versioned, carry correlation ids, return standardized errors, and support idempotency where the
  operation is not naturally idempotent.

No external API has been published yet. The internal connector contract (masterplan 62) is defined in
`docs/integrations/connector-contract.md`.
