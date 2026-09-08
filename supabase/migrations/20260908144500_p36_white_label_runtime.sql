-- Tryggsignal P36 — production white-label runtime.
-- Masterplan 152-154, 163-164: tenant-level branding permission, isolated
-- branding assets, versioned draft/publish/rollback and service-only control-plane
-- RPCs. Municipal users never receive control-plane credentials.

-- ---------------------------------------------------------------------------
-- Tenant-level authorization
-- ---------------------------------------------------------------------------
insert into authz.permissions (key, description)
values ('branding.manage', 'Manage tenant branding and public brand assets')
on conflict (key) do nothing;

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from authz.roles r
join authz.permissions p on p.key = 'branding.manage'
where r.key = 'tenant_admin'
on conflict do nothing;

create or replace function authz.has_tenant_permission(p_permission text)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from authz.role_assignments ra
    join authz.role_permissions rp on rp.role_id = ra.role_id
    join authz.permissions perm on perm.id = rp.permission_id
    where ra.user_id = (select authz.current_user_id())
      and perm.key = p_permission
      and ra.scope_type = 'TENANT'
      and (ra.valid_from is null or ra.valid_from <= now())
      and (ra.valid_to is null or ra.valid_to > now())
  )
$$;

revoke all on function authz.has_tenant_permission(text) from public;
grant execute on function authz.has_tenant_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Public branding assets. Public means readable as a brand asset; all writes
-- remain service-side. No storage.objects write policy is granted to clients.
-- ---------------------------------------------------------------------------
create table platform.branding_assets (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  asset_kind text not null check (asset_kind in ('LOGO', 'LOGO_DARK', 'FAVICON')),
  storage_bucket text not null default 'branding-assets'
    check (storage_bucket = 'branding-assets'),
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check (mime_type in ('image/png', 'image/webp')),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  size_bytes bigint not null check (size_bytes between 1 and 2097152),
  created_at timestamptz not null default now(),
  created_by uuid
);

create index branding_assets_tenant_idx
  on platform.branding_assets (tenant_id, created_at desc);

alter table platform.branding_assets enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branding-assets',
  'branding-assets',
  true,
  2097152,
  array['image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table platform.tenant_branding
  add constraint tenant_branding_logo_asset_fk
    foreign key (logo_asset_id) references platform.branding_assets (id) on delete restrict,
  add constraint tenant_branding_logo_dark_asset_fk
    foreign key (logo_dark_asset_id) references platform.branding_assets (id) on delete restrict,
  add constraint tenant_branding_favicon_asset_fk
    foreign key (favicon_asset_id) references platform.branding_assets (id) on delete restrict;

create unique index tenant_branding_one_draft
  on platform.tenant_branding (tenant_id)
  where status = 'DRAFT';

create or replace function platform.assert_branding_asset_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.logo_asset_id is not null and not exists (
    select 1 from platform.branding_assets a
    where a.id = new.logo_asset_id and a.tenant_id = new.tenant_id and a.asset_kind = 'LOGO'
  ) then
    raise exception 'logo asset does not belong to the branding tenant'
      using errcode = 'check_violation';
  end if;

  if new.logo_dark_asset_id is not null and not exists (
    select 1 from platform.branding_assets a
    where a.id = new.logo_dark_asset_id and a.tenant_id = new.tenant_id and a.asset_kind = 'LOGO_DARK'
  ) then
    raise exception 'dark logo asset does not belong to the branding tenant'
      using errcode = 'check_violation';
  end if;

  if new.favicon_asset_id is not null and not exists (
    select 1 from platform.branding_assets a
    where a.id = new.favicon_asset_id and a.tenant_id = new.tenant_id and a.asset_kind = 'FAVICON'
  ) then
    raise exception 'favicon asset does not belong to the branding tenant'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function platform.assert_branding_asset_tenant() from public;

create trigger tenant_branding_asset_tenant
  before insert or update of tenant_id, logo_asset_id, logo_dark_asset_id, favicon_asset_id
  on platform.tenant_branding
  for each row execute function platform.assert_branding_asset_tenant();

-- ---------------------------------------------------------------------------
-- Service-only Data API. The platform schema remains unexposed. These narrow
-- RPCs are the only branding surface used by the Vercel server.
-- ---------------------------------------------------------------------------
create or replace function public.resolve_tenant_branding(
  p_tenant_id uuid,
  p_version integer
)
returns table (
  branding_id uuid,
  version integer,
  display_name text,
  short_name text,
  primary_color text,
  secondary_color text,
  accent_color text,
  surface_variant text,
  support_email text,
  privacy_url text,
  accessibility_statement_url text,
  terms_url text,
  login_heading text,
  login_subheading text,
  show_tryggsignal_branding boolean,
  locale text,
  logo_path text,
  logo_dark_path text,
  favicon_path text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.version,
    b.display_name,
    b.short_name,
    b.primary_color,
    b.secondary_color,
    b.accent_color,
    b.surface_variant,
    b.support_email,
    b.privacy_url,
    b.accessibility_statement_url,
    b.terms_url,
    b.login_heading,
    b.login_subheading,
    b.show_tryggsignal_branding,
    b.locale,
    logo.object_path,
    logo_dark.object_path,
    favicon.object_path
  from platform.tenant_branding b
  left join platform.branding_assets logo on logo.id = b.logo_asset_id
  left join platform.branding_assets logo_dark on logo_dark.id = b.logo_dark_asset_id
  left join platform.branding_assets favicon on favicon.id = b.favicon_asset_id
  where b.tenant_id = p_tenant_id
    and b.version = p_version
    and b.status = 'PUBLISHED'
$$;

revoke all on function public.resolve_tenant_branding(uuid, integer) from public;
grant execute on function public.resolve_tenant_branding(uuid, integer) to service_role;

create or replace function public.list_tenant_branding_versions(p_tenant_id uuid)
returns table (
  branding_id uuid,
  version integer,
  status text,
  contrast_validation_status text,
  display_name text,
  short_name text,
  primary_color text,
  secondary_color text,
  accent_color text,
  surface_variant text,
  support_email text,
  privacy_url text,
  accessibility_statement_url text,
  terms_url text,
  login_heading text,
  login_subheading text,
  show_tryggsignal_branding boolean,
  locale text,
  logo_path text,
  logo_dark_path text,
  favicon_path text,
  published_at timestamptz,
  supersedes_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    b.id,
    b.version,
    b.status::text,
    b.contrast_validation_status,
    b.display_name,
    b.short_name,
    b.primary_color,
    b.secondary_color,
    b.accent_color,
    b.surface_variant,
    b.support_email,
    b.privacy_url,
    b.accessibility_statement_url,
    b.terms_url,
    b.login_heading,
    b.login_subheading,
    b.show_tryggsignal_branding,
    b.locale,
    logo.object_path,
    logo_dark.object_path,
    favicon.object_path,
    b.published_at,
    b.supersedes_id
  from platform.tenant_branding b
  left join platform.branding_assets logo on logo.id = b.logo_asset_id
  left join platform.branding_assets logo_dark on logo_dark.id = b.logo_dark_asset_id
  left join platform.branding_assets favicon on favicon.id = b.favicon_asset_id
  where b.tenant_id = p_tenant_id
  order by b.version desc
$$;

revoke all on function public.list_tenant_branding_versions(uuid) from public;
grant execute on function public.list_tenant_branding_versions(uuid) to service_role;

create or replace function public.save_tenant_branding_draft(
  p_tenant_id uuid,
  p_actor uuid,
  p_display_name text,
  p_short_name text,
  p_primary_color text,
  p_secondary_color text,
  p_accent_color text,
  p_surface_variant text,
  p_support_email text,
  p_privacy_url text,
  p_accessibility_statement_url text,
  p_terms_url text,
  p_login_heading text,
  p_login_subheading text,
  p_show_tryggsignal_branding boolean,
  p_locale text,
  p_contrast_passed boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_draft platform.tenant_branding%rowtype;
  v_id uuid;
  v_version integer;
begin
  if not exists (select 1 from platform.tenants t where t.id = p_tenant_id) then
    raise exception 'Unknown tenant %', p_tenant_id using errcode = 'no_data_found';
  end if;
  if p_display_name is null or length(trim(p_display_name)) not between 1 and 120 then
    raise exception 'Invalid branding display name' using errcode = 'check_violation';
  end if;
  if p_primary_color is null or p_primary_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'Invalid primary colour' using errcode = 'check_violation';
  end if;
  if p_secondary_color is not null and p_secondary_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'Invalid secondary colour' using errcode = 'check_violation';
  end if;
  if p_accent_color is not null and p_accent_color !~ '^#[0-9a-f]{6}$' then
    raise exception 'Invalid accent colour' using errcode = 'check_violation';
  end if;
  if p_surface_variant is not null and p_surface_variant !~ '^#[0-9a-f]{6}$' then
    raise exception 'Invalid surface colour' using errcode = 'check_violation';
  end if;
  if p_locale is null or p_locale !~ '^[a-z]{2}(-[A-Z]{2})?$' then
    raise exception 'Invalid locale' using errcode = 'check_violation';
  end if;
  if p_support_email is not null and p_support_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid support email' using errcode = 'check_violation';
  end if;
  if (p_privacy_url is not null and p_privacy_url !~ '^https?://[^[:space:]]+$')
     or (p_accessibility_statement_url is not null and p_accessibility_statement_url !~ '^https?://[^[:space:]]+$')
     or (p_terms_url is not null and p_terms_url !~ '^https?://[^[:space:]]+$') then
    raise exception 'Invalid branding URL' using errcode = 'check_violation';
  end if;

  select * into v_draft
  from platform.tenant_branding b
  where b.tenant_id = p_tenant_id and b.status = 'DRAFT'
  for update;

  if found then
    update platform.tenant_branding
    set display_name = trim(p_display_name),
        short_name = nullif(trim(p_short_name), ''),
        primary_color = p_primary_color,
        secondary_color = p_secondary_color,
        accent_color = p_accent_color,
        surface_variant = p_surface_variant,
        support_email = nullif(trim(p_support_email), ''),
        privacy_url = nullif(trim(p_privacy_url), ''),
        accessibility_statement_url = nullif(trim(p_accessibility_statement_url), ''),
        terms_url = nullif(trim(p_terms_url), ''),
        login_heading = nullif(trim(p_login_heading), ''),
        login_subheading = nullif(trim(p_login_subheading), ''),
        show_tryggsignal_branding = p_show_tryggsignal_branding,
        locale = p_locale,
        contrast_validation_status = case when p_contrast_passed then 'PASSED' else 'FAILED' end
    where id = v_draft.id
    returning id, version into v_id, v_version;
  else
    select coalesce(max(b.version), 0) + 1 into v_version
    from platform.tenant_branding b
    where b.tenant_id = p_tenant_id;

    insert into platform.tenant_branding (
      tenant_id, version, display_name, short_name, primary_color, secondary_color,
      accent_color, surface_variant, support_email, privacy_url,
      accessibility_statement_url, terms_url, login_heading, login_subheading,
      show_tryggsignal_branding, locale, contrast_validation_status, created_by
    ) values (
      p_tenant_id, v_version, trim(p_display_name), nullif(trim(p_short_name), ''),
      p_primary_color, p_secondary_color, p_accent_color, p_surface_variant,
      nullif(trim(p_support_email), ''), nullif(trim(p_privacy_url), ''),
      nullif(trim(p_accessibility_statement_url), ''), nullif(trim(p_terms_url), ''),
      nullif(trim(p_login_heading), ''), nullif(trim(p_login_subheading), ''),
      p_show_tryggsignal_branding, p_locale,
      case when p_contrast_passed then 'PASSED' else 'FAILED' end,
      p_actor
    )
    returning id into v_id;
  end if;

  insert into platform.branding_events (tenant_id, branding_id, event_type, version, actor, detail)
  values (
    p_tenant_id,
    v_id,
    'DRAFTED',
    v_version,
    p_actor,
    jsonb_build_object('contrast_passed', p_contrast_passed)
  );

  if p_contrast_passed then
    insert into platform.branding_events (tenant_id, branding_id, event_type, version, actor)
    values (p_tenant_id, v_id, 'VALIDATED', v_version, p_actor);
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_tenant_branding_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text,
  boolean, text, boolean
) from public;
grant execute on function public.save_tenant_branding_draft(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text,
  boolean, text, boolean
) to service_role;

create or replace function public.register_branding_asset(
  p_tenant_id uuid,
  p_actor uuid,
  p_asset_kind text,
  p_object_path text,
  p_sha256 text,
  p_mime_type text,
  p_width integer,
  p_height integer,
  p_size_bytes bigint
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_asset_kind not in ('LOGO', 'LOGO_DARK', 'FAVICON') then
    raise exception 'Invalid branding asset kind' using errcode = 'check_violation';
  end if;
  if p_object_path not like p_tenant_id::text || '/%' then
    raise exception 'Branding asset path is outside tenant prefix'
      using errcode = 'check_violation';
  end if;

  insert into platform.branding_assets (
    tenant_id, asset_kind, object_path, sha256, mime_type, width, height, size_bytes, created_by
  )
  values (
    p_tenant_id, p_asset_kind, p_object_path, p_sha256, p_mime_type,
    p_width, p_height, p_size_bytes, p_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_branding_asset(
  uuid, uuid, text, text, text, text, integer, integer, bigint
) from public;
grant execute on function public.register_branding_asset(
  uuid, uuid, text, text, text, text, integer, integer, bigint
) to service_role;

create or replace function public.discard_branding_asset(
  p_tenant_id uuid,
  p_asset_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $
declare
  v_deleted integer;
begin
  delete from platform.branding_assets a
  where a.id = p_asset_id
    and a.tenant_id = p_tenant_id
    and not exists (
      select 1 from platform.tenant_branding b
      where b.logo_asset_id = a.id
         or b.logo_dark_asset_id = a.id
         or b.favicon_asset_id = a.id
    );
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$;

revoke all on function public.discard_branding_asset(uuid, uuid) from public;
grant execute on function public.discard_branding_asset(uuid, uuid) to service_role;

create or replace function public.set_tenant_branding_asset(
  p_tenant_id uuid,
  p_branding_id uuid,
  p_asset_kind text,
  p_asset_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
begin
  if not exists (
    select 1 from platform.branding_assets a
    where a.id = p_asset_id
      and a.tenant_id = p_tenant_id
      and a.asset_kind = p_asset_kind
  ) then
    raise exception 'Branding asset does not belong to tenant'
      using errcode = 'check_violation';
  end if;

  select b.version into v_version
  from platform.tenant_branding b
  where b.id = p_branding_id and b.tenant_id = p_tenant_id and b.status = 'DRAFT'
  for update;

  if not found then
    raise exception 'Branding asset may only be attached to the tenant draft'
      using errcode = 'check_violation';
  end if;

  if p_asset_kind = 'LOGO' then
    update platform.tenant_branding set logo_asset_id = p_asset_id where id = p_branding_id;
  elsif p_asset_kind = 'LOGO_DARK' then
    update platform.tenant_branding set logo_dark_asset_id = p_asset_id where id = p_branding_id;
  elsif p_asset_kind = 'FAVICON' then
    update platform.tenant_branding set favicon_asset_id = p_asset_id where id = p_branding_id;
  else
    raise exception 'Invalid branding asset kind' using errcode = 'check_violation';
  end if;

  insert into platform.branding_events (tenant_id, branding_id, event_type, version, actor, detail)
  values (
    p_tenant_id, p_branding_id, 'DRAFTED', v_version, p_actor,
    jsonb_build_object('asset_kind', p_asset_kind, 'asset_id', p_asset_id)
  );
end;
$$;

revoke all on function public.set_tenant_branding_asset(uuid, uuid, text, uuid, uuid) from public;
grant execute on function public.set_tenant_branding_asset(uuid, uuid, text, uuid, uuid) to service_role;

create or replace function public.publish_tenant_branding(
  p_tenant_id uuid,
  p_branding_id uuid,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from platform.tenant_branding b
    where b.id = p_branding_id and b.tenant_id = p_tenant_id and b.status = 'DRAFT'
  ) then
    raise exception 'Unknown tenant branding draft' using errcode = 'no_data_found';
  end if;

  return platform.publish_branding(p_branding_id, p_actor);
end;
$$;

revoke all on function public.publish_tenant_branding(uuid, uuid, uuid) from public;
grant execute on function public.publish_tenant_branding(uuid, uuid, uuid) to service_role;

create or replace function public.rollback_tenant_branding(
  p_tenant_id uuid,
  p_actor uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  return platform.rollback_branding(p_tenant_id, p_actor);
end;
$$;

revoke all on function public.rollback_tenant_branding(uuid, uuid) from public;
grant execute on function public.rollback_tenant_branding(uuid, uuid) to service_role;
