-- Tryggsignal P35 — hostname resolution as one RPC.
-- Masterplan 158, 159, 172, 173, 185.
--
-- The proxy used to read `platform.tenant_domains` and `platform.tenants`
-- directly through PostgREST. That had two problems, and an end-to-end test
-- against a configured control plane found the first of them:
--
--   1. PostgREST does not expose the `platform` schema, so every lookup failed
--      with "Invalid schema: platform" and every unknown hostname returned 500
--      instead of the refusal page. Exposing the schema would have fixed the
--      error and made it worse: the whole control plane would then be reachable
--      from the browser key, including `tenant_deployments`.
--
--   2. `tenant_deployments` carries a publishable key and a privileged
--      credential *reference* per municipality. Routing does not need either.
--
-- This function returns exactly the fields the resolver decides on, in one round
-- trip, and nothing else. The decision itself stays in TypeScript, where it is
-- covered by the resolver's unit tests: the function reports the statuses, it
-- does not interpret them.

create or replace function public.resolve_tenant_host(p_hostname text)
returns table (
  domain_id uuid,
  domain_type text,
  domain_status text,
  tenant_id uuid,
  tenant_slug text,
  tenant_status text,
  canonical_hostname text,
  branding_version integer,
  auth_configuration_reference text,
  deployment_id uuid,
  deployment_status text,
  deployment_health_status text,
  data_plane_reference text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.id,
    d.domain_type,
    d.status,
    t.id,
    t.slug,
    t.status,
    t.canonical_hostname,
    t.branding_version,
    t.auth_configuration_reference,
    dep.id,
    dep.status,
    dep.health_status,
    dep.supabase_project_ref
  from platform.tenant_domains d
  left join platform.tenants t on t.id = d.tenant_id
  left join platform.tenant_deployments dep on dep.tenant_id = t.id
  where d.normalized_hostname = lower(p_hostname)
  limit 1;
$$;

comment on function public.resolve_tenant_host(text) is
  'Routing-only view of one hostname. Returns no row for an unknown hostname; '
  'returns statuses for a known one so the caller can refuse with the right reason. '
  'Never returns a key or a credential reference.';

revoke all on function public.resolve_tenant_host(text) from public;
grant execute on function public.resolve_tenant_host(text) to anon, authenticated;
