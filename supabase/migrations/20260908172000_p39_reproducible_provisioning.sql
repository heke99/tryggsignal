-- Tryggsignal P39 — reproducible tenant provisioning.
-- Masterplan 192-194 / P39: idempotent request, data-plane registration,
-- migration/schema checkpointing, default platform domain/branding, health gate,
-- rerun safety and explicit recovery metadata.

alter table platform.tenant_provisioning_runs
  add column if not exists idempotency_key text,
  add column if not exists attempt_count integer not null default 1 check (attempt_count >= 1),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists tenant_provisioning_runs_idempotency_idx
  on platform.tenant_provisioning_runs (idempotency_key)
  where idempotency_key is not null;

create index if not exists tenant_provisioning_runs_tenant_requested_idx
  on platform.tenant_provisioning_runs (tenant_id, requested_at desc);

-- Requesting the same provisioning operation twice must return the same tenant
-- and run instead of creating duplicate infrastructure.
create or replace function public.request_tenant_provisioning(
  p_slug text,
  p_display_name text,
  p_auth_configuration_reference text,
  p_idempotency_key text,
  p_requested_by uuid default null
)
returns table (
  tenant_id uuid,
  run_id uuid,
  platform_hostname text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(trim(p_slug));
  v_hostname text;
  v_tenant platform.tenants%rowtype;
  v_run platform.tenant_provisioning_runs%rowtype;
begin
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 12 then
    raise exception 'Provisioning requires a stable idempotency key'
      using errcode = 'check_violation';
  end if;
  if p_display_name is null or length(trim(p_display_name)) < 2 then
    raise exception 'Provisioning requires a display name'
      using errcode = 'check_violation';
  end if;
  if p_auth_configuration_reference is null or length(trim(p_auth_configuration_reference)) < 3 then
    raise exception 'Provisioning requires an auth configuration reference'
      using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(trim(p_idempotency_key), 0));

  select r.* into v_run
  from platform.tenant_provisioning_runs r
  where r.idempotency_key = trim(p_idempotency_key);

  if found then
    select t.* into v_tenant from platform.tenants t where t.id = v_run.tenant_id;
    return query select v_tenant.id, v_run.id, v_tenant.canonical_hostname, false;
    return;
  end if;

  if v_slug !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' then
    raise exception 'Invalid tenant slug' using errcode = 'check_violation';
  end if;
  if exists (select 1 from platform.reserved_subdomains r where r.label = v_slug) then
    raise exception 'Tenant slug is reserved' using errcode = 'check_violation';
  end if;

  v_hostname := v_slug || '.tryggsignal.se';

  select t.* into v_tenant from platform.tenants t where t.slug = v_slug for update;
  if found then
    if v_tenant.status in ('OFFBOARDING', 'OFFBOARDED') then
      raise exception 'An offboarded tenant slug cannot be silently reprovisioned'
        using errcode = 'check_violation';
    end if;
  else
    insert into platform.tenants (
      slug, display_name, status, canonical_hostname, auth_configuration_reference, created_by
    ) values (
      v_slug, trim(p_display_name), 'PROVISIONING', v_hostname,
      trim(p_auth_configuration_reference), p_requested_by
    ) returning * into v_tenant;
  end if;

  insert into platform.tenant_branding (
    tenant_id, version, display_name, primary_color, secondary_color,
    accent_color, surface_variant, locale, contrast_validation_status, status, created_by
  )
  select
    v_tenant.id, 1, trim(p_display_name), '#14532d', '#1f2937',
    '#b45309', '#f8fafc', 'sv-SE', 'PASSED', 'DRAFT', p_requested_by
  where not exists (
    select 1 from platform.tenant_branding b where b.tenant_id = v_tenant.id
  );

  insert into platform.tenant_domains (
    tenant_id, hostname, normalized_hostname, domain_type, status,
    is_canonical, is_fallback, ownership_status, dns_status, tls_status, created_by
  )
  select
    v_tenant.id, v_hostname, v_hostname, 'PLATFORM_SUBDOMAIN', 'PENDING',
    true, true, 'PENDING', 'UNKNOWN', 'UNKNOWN', p_requested_by
  where not exists (
    select 1 from platform.tenant_domains d
    where d.tenant_id = v_tenant.id and d.domain_type = 'PLATFORM_SUBDOMAIN'
  );

  insert into platform.tenant_provisioning_runs (
    tenant_id, state, requested_by, idempotency_key, metadata
  ) values (
    v_tenant.id,
    'REQUESTED',
    p_requested_by,
    trim(p_idempotency_key),
    jsonb_build_object('slug', v_slug, 'platform_hostname', v_hostname)
  ) returning * into v_run;

  return query select v_tenant.id, v_run.id, v_hostname, true;
end;
$$;

revoke all on function public.request_tenant_provisioning(text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.request_tenant_provisioning(text, text, text, text, uuid)
  to service_role;

-- The external Supabase Management API creates the project. Once healthy keys
-- are available, this idempotent registration binds that exact project to the
-- tenant. A rerun updates health/schema metadata but cannot create a second
-- production deployment because tenant_deployments is unique per environment.
create or replace function public.register_tenant_data_plane(
  p_tenant_id uuid,
  p_environment text,
  p_project_ref text,
  p_region text,
  p_supabase_url text,
  p_publishable_key text,
  p_privileged_credential_reference text,
  p_schema_version text,
  p_health_status text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_environment not in ('DEV', 'TEST', 'CUSTOMER_TEST', 'PRODUCTION') then
    raise exception 'Invalid deployment environment' using errcode = 'check_violation';
  end if;
  if p_health_status not in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE') then
    raise exception 'Invalid health status' using errcode = 'check_violation';
  end if;

  insert into platform.tenant_deployments (
    tenant_id, environment, supabase_project_ref, supabase_region, supabase_url,
    publishable_key, privileged_credential_reference, schema_version,
    status, health_status, last_health_check_at
  ) values (
    p_tenant_id, p_environment, p_project_ref, p_region, p_supabase_url,
    p_publishable_key, p_privileged_credential_reference, p_schema_version,
    'ACTIVE', p_health_status, now()
  )
  on conflict (tenant_id, environment) do update
  set supabase_project_ref = excluded.supabase_project_ref,
      supabase_region = excluded.supabase_region,
      supabase_url = excluded.supabase_url,
      publishable_key = excluded.publishable_key,
      privileged_credential_reference = excluded.privileged_credential_reference,
      schema_version = excluded.schema_version,
      status = excluded.status,
      health_status = excluded.health_status,
      last_health_check_at = excluded.last_health_check_at
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.register_tenant_data_plane(
  uuid, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.register_tenant_data_plane(
  uuid, text, text, text, text, text, text, text, text
) to service_role;

-- Make existing provisioning transitions idempotent. A crashed worker may safely
-- retry the same checkpoint after losing its response.
create or replace function platform.advance_provisioning(
  p_run_id uuid,
  p_to_state platform.provisioning_state,
  p_error text default null
)
returns platform.provisioning_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run platform.tenant_provisioning_runs%rowtype;
  v_allowed platform.provisioning_state[];
begin
  select * into v_run
  from platform.tenant_provisioning_runs r
  where r.id = p_run_id
  for update;

  if not found then
    raise exception 'Unknown provisioning run %', p_run_id using errcode = 'no_data_found';
  end if;

  if v_run.state = p_to_state then
    return v_run.state;
  end if;

  v_allowed := case v_run.state
    when 'REQUESTED' then array['TENANT_CREATED', 'FAILED']::platform.provisioning_state[]
    when 'TENANT_CREATED' then array['DATA_PLANE_PROVISIONED', 'FAILED']::platform.provisioning_state[]
    when 'DATA_PLANE_PROVISIONED' then array['SCHEMA_APPLIED', 'FAILED']::platform.provisioning_state[]
    when 'SCHEMA_APPLIED' then array['BRANDING_DRAFTED', 'FAILED']::platform.provisioning_state[]
    when 'BRANDING_DRAFTED' then array['PLATFORM_DOMAIN_ACTIVE', 'FAILED']::platform.provisioning_state[]
    when 'PLATFORM_DOMAIN_ACTIVE' then
      array['CUSTOM_DOMAIN_PENDING', 'READY', 'FAILED']::platform.provisioning_state[]
    when 'CUSTOM_DOMAIN_PENDING' then
      array['CUSTOM_DOMAIN_ACTIVE', 'READY', 'FAILED']::platform.provisioning_state[]
    when 'CUSTOM_DOMAIN_ACTIVE' then array['READY', 'FAILED']::platform.provisioning_state[]
    when 'READY' then array[]::platform.provisioning_state[]
    when 'FAILED' then array['REQUESTED']::platform.provisioning_state[]
  end;

  if not (p_to_state = any (v_allowed)) then
    raise exception 'Provisioning cannot go from % to %', v_run.state, p_to_state
      using errcode = 'raise_exception';
  end if;

  if p_to_state = 'FAILED' and (p_error is null or length(trim(p_error)) < 8) then
    raise exception 'Failed provisioning requires a diagnostic reason'
      using errcode = 'check_violation';
  end if;

  if p_to_state = 'READY' then
    if not exists (
      select 1 from platform.tenant_domains d
      where d.tenant_id = v_run.tenant_id
        and d.domain_type = 'PLATFORM_SUBDOMAIN'
        and d.status = 'ACTIVE'
        and d.is_fallback
        and d.ownership_status = 'VERIFIED'
        and d.dns_status = 'OK'
        and d.tls_status = 'ISSUED'
    ) then
      raise exception 'A tenant cannot be READY without a verified ACTIVE platform fallback domain'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from platform.tenant_deployments dep
      where dep.tenant_id = v_run.tenant_id
        and dep.environment = 'PRODUCTION'
        and dep.status = 'ACTIVE'
        and dep.health_status = 'HEALTHY'
        and length(dep.schema_version) > 0
    ) then
      raise exception 'A tenant cannot be READY without a HEALTHY production data plane'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from platform.tenant_branding b where b.tenant_id = v_run.tenant_id
    ) then
      raise exception 'A tenant cannot be READY without branding configuration'
        using errcode = 'check_violation';
    end if;
  end if;

  update platform.tenant_provisioning_runs
  set state = p_to_state,
      last_error = case when p_to_state = 'FAILED' then trim(p_error) else null end,
      attempt_count = case
        when v_run.state = 'FAILED' and p_to_state = 'REQUESTED' then attempt_count + 1
        else attempt_count
      end,
      completed_at = case
        when p_to_state = 'READY' then now()
        when p_to_state = 'REQUESTED' then null
        else completed_at
      end
  where id = p_run_id;

  if p_to_state = 'READY' then
    update platform.tenants
    set status = 'ACTIVE', activated_at = coalesce(activated_at, now())
    where id = v_run.tenant_id;
  end if;

  return p_to_state;
end;
$$;

revoke all on function platform.advance_provisioning(uuid, platform.provisioning_state, text)
  from public, anon, authenticated;
