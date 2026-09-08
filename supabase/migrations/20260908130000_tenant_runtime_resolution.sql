-- Tryggsignal — tenant runtime resolution for data-plane binding.
-- Masterplan 171–174, corrected implementation plan phase B/C.
--
-- Routing remains anonymous through public.resolve_tenant_host and returns no
-- connection material. Runtime data-plane and auth configuration are separate
-- service-role-only lookups used by server code after a hostname has already
-- resolved to an ACTIVE tenant/domain/deployment.

create or replace function public.resolve_tenant_runtime(
  p_hostname text,
  p_tenant_id uuid,
  p_deployment_id uuid,
  p_data_plane_reference text
)
returns table (
  deployment_id uuid,
  supabase_project_ref text,
  supabase_region text,
  supabase_url text,
  publishable_key text,
  schema_version text,
  deployment_status text,
  health_status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    dep.id,
    dep.supabase_project_ref,
    dep.supabase_region,
    dep.supabase_url,
    dep.publishable_key,
    dep.schema_version,
    dep.status,
    dep.health_status
  from platform.tenant_domains d
  join platform.tenants t on t.id = d.tenant_id
  join platform.tenant_deployments dep on dep.tenant_id = t.id
  where d.normalized_hostname = lower(p_hostname)
    and d.status = 'ACTIVE'
    and t.id = p_tenant_id
    and t.status = 'ACTIVE'
    and dep.id = p_deployment_id
    and dep.supabase_project_ref = p_data_plane_reference
    and dep.status = 'ACTIVE'
  limit 1;
$$;

comment on function public.resolve_tenant_runtime(text, uuid, uuid, text) is
  'Server-only exact-match resolver for a host-verified tenant deployment. '
  'Returns only user-client connection material, never privileged credential references.';

revoke all on function public.resolve_tenant_runtime(text, uuid, uuid, text) from public;
revoke all on function public.resolve_tenant_runtime(text, uuid, uuid, text) from anon;
revoke all on function public.resolve_tenant_runtime(text, uuid, uuid, text) from authenticated;
grant execute on function public.resolve_tenant_runtime(text, uuid, uuid, text) to service_role;

create or replace function public.resolve_tenant_auth_config(
  p_hostname text,
  p_tenant_id uuid,
  p_reference text,
  p_audience text
)
returns table (
  reference text,
  tenant_id uuid,
  audience text,
  kind text,
  display_name text,
  issuer text,
  metadata_url text,
  credential_reference text,
  allowed_email_domains text[],
  environment text,
  enabled boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    cfg.reference,
    cfg.tenant_id,
    cfg.audience::text,
    cfg.kind::text,
    cfg.display_name,
    cfg.issuer,
    cfg.metadata_url,
    cfg.credential_reference,
    cfg.allowed_email_domains,
    cfg.environment,
    cfg.enabled
  from platform.tenant_domains d
  join platform.tenants t on t.id = d.tenant_id
  join platform.tenant_auth_configurations cfg on cfg.tenant_id = t.id
  where d.normalized_hostname = lower(p_hostname)
    and d.status = 'ACTIVE'
    and t.id = p_tenant_id
    and t.status = 'ACTIVE'
    and cfg.reference = p_reference
    and cfg.audience::text = p_audience
    and cfg.enabled
  limit 1;
$$;

comment on function public.resolve_tenant_auth_config(text, uuid, text, text) is
  'Server-only auth configuration lookup bound to an ACTIVE verified tenant hostname.';

revoke all on function public.resolve_tenant_auth_config(text, uuid, text, text) from public;
revoke all on function public.resolve_tenant_auth_config(text, uuid, text, text) from anon;
revoke all on function public.resolve_tenant_auth_config(text, uuid, text, text) from authenticated;
grant execute on function public.resolve_tenant_auth_config(text, uuid, text, text) to service_role;
