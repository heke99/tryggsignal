---
name: supabase
description: "Use for any Supabase Database, Auth, RLS, Storage, Queues, Cron, Edge Function, migration or Supabase platform work in Tryggsignal."
metadata:
  short-description: "Tryggsignal router for supabase"
---

# supabase

Official source: `skills://plugins/supabase/supabase/skill.md`

Before implementation, read the installed official Supabase skill if available and verify current Supabase docs/changelog. Apply Tryggsignal security rules: one data plane per municipality, RLS on exposed tables, never expose service_role, never authorize with user_metadata, and run advisors after DB/security changes.

## Tryggsignal gate

User instructions and `docs/MASTERPLAN_V3.md` take precedence over generic defaults. If the installed source skill is unavailable, consult the current official product documentation before version-sensitive implementation. Never fabricate unavailable capabilities or successful verification.
