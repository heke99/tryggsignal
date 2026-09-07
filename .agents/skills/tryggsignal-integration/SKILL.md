---
name: tryggsignal-integration
description: "Use for any Tryggsignal external source, national API, vendor adapter, webhook, polling connector, legacy system or Municipal Edge Connector integration."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Integration Contract

Before implementing any source/adapter, verify the provider's current official documentation and record: provider, product/version, auth, legal access, license, data authority level, cache/retention rules, rate limits, test environment, read/write capabilities, webhook vs polling, source ids/version timestamps and failure semantics.

All adapters map through Tryggsignal canonical contracts. Core code must not depend on vendor-specific field names. Store `external_id`, source version, source hash, mapping version and sync timestamps.

Distributed delivery is at-least-once: require idempotency, retries/backoff, dead-letter state, replay and reconciliation. Field ownership/conflict policy must be explicit; never generic last-write-wins for legal state.

If credentials or vendor docs are unavailable, mark `EXTERNAL_BLOCKED`; build only truthful interface/config/health/error scaffolding. Never invent endpoints or payloads.
