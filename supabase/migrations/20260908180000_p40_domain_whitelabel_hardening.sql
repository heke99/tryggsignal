-- Tryggsignal P40 / masterplan 196 — white-label feature capabilities.
-- Feature flags control product availability only. They are server-side control-plane
-- configuration and are never consulted as authorization; RBAC/ABAC/RLS remain mandatory.

create table platform.tenant_feature_flags (
  tenant_id uuid not null references platform.tenants (id) on delete cascade,
  feature_key text not null check (feature_key in (
    'custom_domain',
    'custom_logo',
    'custom_colors',
    'custom_email_branding',
    'hide_tryggsignal_brand',
    'custom_document_branding',
    'custom_login_content'
  )),
  enabled boolean not null default false,
  configuration jsonb not null default '{}'::jsonb
    check (jsonb_typeof(configuration) = 'object'),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feature_key)
);

alter table platform.tenant_feature_flags enable row level security;

comment on table platform.tenant_feature_flags is
  'White-label product capability switches. Never an authorization source; no client policies or grants.';

create trigger tenant_feature_flags_set_updated_at
  before update on platform.tenant_feature_flags
  for each row execute function config.set_updated_at();

create or replace function public.list_tenant_feature_flags(p_tenant_id uuid)
returns table (
  feature_key text,
  enabled boolean,
  configuration jsonb,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.feature_key, f.enabled, f.configuration, f.updated_at
  from platform.tenant_feature_flags f
  where f.tenant_id = p_tenant_id
  order by f.feature_key;
$$;

revoke all on function public.list_tenant_feature_flags(uuid)
  from public, anon, authenticated;
grant execute on function public.list_tenant_feature_flags(uuid) to service_role;

create or replace function public.set_tenant_feature_flag(
  p_tenant_id uuid,
  p_feature_key text,
  p_enabled boolean,
  p_configuration jsonb default '{}'::jsonb,
  p_actor uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from platform.tenants t where t.id = p_tenant_id) then
    raise exception 'Unknown tenant %', p_tenant_id using errcode = 'no_data_found';
  end if;

  if p_feature_key not in (
    'custom_domain', 'custom_logo', 'custom_colors', 'custom_email_branding',
    'hide_tryggsignal_brand', 'custom_document_branding', 'custom_login_content'
  ) then
    raise exception 'Unknown white-label feature %', p_feature_key
      using errcode = 'check_violation';
  end if;

  if jsonb_typeof(coalesce(p_configuration, '{}'::jsonb)) <> 'object' then
    raise exception 'Feature configuration must be a JSON object'
      using errcode = 'check_violation';
  end if;

  insert into platform.tenant_feature_flags (
    tenant_id, feature_key, enabled, configuration, updated_by
  ) values (
    p_tenant_id, p_feature_key, p_enabled, coalesce(p_configuration, '{}'::jsonb), p_actor
  )
  on conflict (tenant_id, feature_key) do update
  set enabled = excluded.enabled,
      configuration = excluded.configuration,
      updated_by = excluded.updated_by,
      updated_at = now();

  return p_enabled;
end;
$$;

revoke all on function public.set_tenant_feature_flag(uuid, text, boolean, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.set_tenant_feature_flag(uuid, text, boolean, jsonb, uuid)
  to service_role;
