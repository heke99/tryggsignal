---
name: tryggsignal-architecture
description: "Use before modifying Tryggsignal system boundaries, tenancy, data planes, domains, services, queues, canonical models, source-of-truth rules or deployment architecture."
metadata:
  short-description: "Tryggsignal project skill"
---

# Tryggsignal Architecture Guard

Locked principles:
- One Hosted Supabase data plane/project per municipality by default.
- A separate control plane may hold tenant/deployment/feature metadata, never municipality case documents.
- Vercel hosts the shared Next.js codebase.
- Domains: `tryggsignal.se`, `app.tryggsignal.se`, `kommuner.tryggsignal.se`, `<kommun>.tryggsignal.se`, plus verified municipality custom domains.
- Modular monolith + async workers + .NET Municipal Edge Connector; no Docker/Kubernetes/Kafka/Temporal as initial requirements.
- PostgreSQL/PostGIS canonical data; explicit `system_of_record`, source/provenance and mapping versions.
- Overlay → coexistence → full migration are first-class modes.
- AI is an evidence-backed assistance layer; deterministic legal state/rules remain versioned and auditable.

Before changing architecture, identify security, migration, integration, portability and white-label effects. Record material changes in an ADR. Never introduce a per-municipality code fork.
