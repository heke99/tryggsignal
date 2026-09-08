-- Tryggsignal P37 — custom domain lifecycle and takeover hardening.
-- Masterplan 213 / P37: Vercel provider state, DNS instructions, verification,
-- TLS state, canonical/fallback handling and explicit takeover protection.

-- ---------------------------------------------------------------------------
-- Tenant-level authorization
-- ---------------------------------------------------------------------------
insert into authz.permissions (key, description)
values ('domain.manage', 'Manage tenant custom domains and domain lifecycle')
on conflict (key) do nothing;

insert into authz.role_permissions (role_id, permission_id)
select r.id, p.id
from authz.roles r
join authz.permissions p on p.key = 'domain.manage'
where r.key = 'tenant_admin'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Provider state persisted on each custom domain.
-- Verification challenges are public DNS instructions, not credentials.
-- ---------------------------------------------------------------------------
alter table platform.tenant_domains
  add column if not exists verification_challenges jsonb not null default '[]'::jsonb,
  add column if not exists provider_misconfigured boolean,
  add column if not exists provider_checked_at timestamptz;

alter table platform.tenant_domains
  add constraint tenant_domains_verification_challenges_array
  check (jsonb_typeof(verification_challenges) = 'array');

-- ---------------------------------------------------------------------------
-- Service-only RPCs. Tenant users authorize in their municipality data plane;
-- the platform server performs the corresponding control-plane write.
-- ---------------------------------------------------------------------------
create or replace function public.list_tenant_domains(p_tenant_id uuid)
returns table (
  domain_id uuid,
  hostname text,
  normalized_hostname text,
  domain_type text,
  status text,
  is_canonical boolean,
  is_fallback boolean,
  vercel_project_id text,
  provider_domain_id text,
  ownership_status text,
  dns_status text,
  tls_status text,
  verification_challenges jsonb,
  provider_misconfigured boolean,
  last_checked_at timestamptz,
  last_error text,
  verified_at timestamptz,
  activated_at timestamptz,
  disabled_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    d.id,
    d.hostname,
    d.normalized_hostname,
    d.domain_type::text,
    d.status::text,
    d.is_canonical,
    d.is_fallback,
    d.vercel_project_id,
    d.provider_domain_id,
    d.ownership_status,
    d.dns_status,
    d.tls_status,
    d.verification_challenges,
    d.provider_misconfigured,
    d.last_checked_at,
    d.last_error,
    d.verified_at,
    d.activated_at,
    d.disabled_at
  from platform.tenant_domains d
  where d.tenant_id = p_tenant_id
  order by d.is_canonical desc, d.is_fallback desc, d.created_at asc;
$$;

revoke all on function public.list_tenant_domains(uuid) from public, anon, authenticated;
grant execute on function public.list_tenant_domains(uuid) to service_role;

create or replace function public.request_custom_domain(
  p_tenant_id uuid,
  p_actor uuid,
  p_hostname text,
  p_normalized_hostname text,
  p_vercel_project_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_normalized_hostname is null
     or p_normalized_hostname <> lower(trim(p_normalized_hostname))
     or length(p_normalized_hostname) > 253
     or p_normalized_hostname !~ '^[a-z0-9.-]+$' then
    raise exception 'Custom domain must already be a normalized DNS hostname'
      using errcode = 'check_violation';
  end if;

  if p_normalized_hostname = 'tryggsignal.se'
     or p_normalized_hostname like '%.tryggsignal.se' then
    raise exception 'Tryggsignal platform namespace cannot be registered as a custom domain'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from platform.tenants t
    where t.id = p_tenant_id and t.status in ('PROVISIONING', 'ACTIVE', 'SUSPENDED')
  ) then
    raise exception 'Unknown or offboarded tenant'
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1
    from platform.domain_release_history h
    where h.normalized_hostname = p_normalized_hostname
      and h.previous_tenant_id <> p_tenant_id
  ) then
    raise exception 'Released domain belongs to another tenant history and requires platform reassignment review'
      using errcode = 'check_violation';
  end if;

  insert into platform.tenant_domains (
    tenant_id,
    hostname,
    normalized_hostname,
    domain_type,
    status,
    is_canonical,
    is_fallback,
    vercel_project_id,
    ownership_status,
    dns_status,
    tls_status,
    created_by
  )
  values (
    p_tenant_id,
    p_hostname,
    p_normalized_hostname,
    'CUSTOM_DOMAIN',
    'PENDING',
    false,
    false,
    nullif(trim(p_vercel_project_id), ''),
    'PENDING',
    'UNKNOWN',
    'UNKNOWN',
    p_actor
  )
  returning id into v_id;

  insert into platform.domain_events (
    tenant_id, domain_id, event_type, actor, actor_type, to_status, detail
  )
  values (
    p_tenant_id,
    v_id,
    'CUSTOM_DOMAIN_REQUESTED',
    p_actor,
    'USER',
    'PENDING',
    jsonb_build_object('hostname', p_normalized_hostname)
  );

  return v_id;
end;
$$;

revoke all on function public.request_custom_domain(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.request_custom_domain(uuid, uuid, text, text, text)
  to service_role;

create or replace function public.attach_custom_domain_provider(
  p_tenant_id uuid,
  p_domain_id uuid,
  p_vercel_project_id text,
  p_provider_domain_id text,
  p_verification_challenges jsonb,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(coalesce(p_verification_challenges, '[]'::jsonb)) <> 'array' then
    raise exception 'Verification challenges must be an array'
      using errcode = 'check_violation';
  end if;

  update platform.tenant_domains d
  set vercel_project_id = nullif(trim(p_vercel_project_id), ''),
      provider_domain_id = nullif(trim(p_provider_domain_id), ''),
      verification_challenges = coalesce(p_verification_challenges, '[]'::jsonb),
      status = 'AWAITING_DNS',
      ownership_status = 'PENDING',
      dns_status = 'MISSING',
      tls_status = 'PENDING',
      provider_checked_at = now(),
      last_checked_at = now(),
      last_error = null
  where d.id = p_domain_id
    and d.tenant_id = p_tenant_id
    and d.domain_type = 'CUSTOM_DOMAIN'
    and d.status in ('PENDING', 'AWAITING_DNS', 'VERIFYING', 'FAILED');

  if not found then
    raise exception 'Unknown or non-editable custom domain'
      using errcode = 'no_data_found';
  end if;

  insert into platform.domain_events (
    tenant_id, domain_id, event_type, actor, actor_type, to_status, detail
  )
  values (
    p_tenant_id,
    p_domain_id,
    'PROVIDER_ATTACHED',
    p_actor,
    'SERVICE',
    'AWAITING_DNS',
    jsonb_build_object('vercel_project_id', p_vercel_project_id)
  );
end;
$$;

revoke all on function public.attach_custom_domain_provider(uuid, uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.attach_custom_domain_provider(uuid, uuid, text, text, jsonb, uuid)
  to service_role;

create or replace function public.sync_custom_domain_provider_state(
  p_tenant_id uuid,
  p_domain_id uuid,
  p_ownership_status text,
  p_dns_status text,
  p_tls_status text,
  p_verification_challenges jsonb,
  p_provider_misconfigured boolean,
  p_last_error text,
  p_actor uuid
)
returns platform.domain_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status platform.domain_status;
begin
  if p_ownership_status not in ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED') then
    raise exception 'Invalid ownership status' using errcode = 'check_violation';
  end if;
  if p_dns_status not in ('UNKNOWN', 'MISSING', 'MISCONFIGURED', 'OK') then
    raise exception 'Invalid DNS status' using errcode = 'check_violation';
  end if;
  if p_tls_status not in ('UNKNOWN', 'PENDING', 'ISSUED', 'FAILED', 'EXPIRING') then
    raise exception 'Invalid TLS status' using errcode = 'check_violation';
  end if;
  if jsonb_typeof(coalesce(p_verification_challenges, '[]'::jsonb)) <> 'array' then
    raise exception 'Verification challenges must be an array'
      using errcode = 'check_violation';
  end if;

  v_status := case
    when p_ownership_status = 'FAILED' then 'FAILED'::platform.domain_status
    when p_ownership_status <> 'VERIFIED' then 'AWAITING_DNS'::platform.domain_status
    when p_dns_status <> 'OK' then 'VERIFYING'::platform.domain_status
    when p_tls_status <> 'ISSUED' then 'VERIFYING'::platform.domain_status
    else 'VERIFIED'::platform.domain_status
  end;

  update platform.tenant_domains d
  set ownership_status = p_ownership_status,
      dns_status = p_dns_status,
      tls_status = p_tls_status,
      verification_challenges = coalesce(p_verification_challenges, '[]'::jsonb),
      provider_misconfigured = p_provider_misconfigured,
      status = v_status,
      verified_at = case
        when p_ownership_status = 'VERIFIED' then coalesce(d.verified_at, now())
        else null
      end,
      provider_checked_at = now(),
      last_checked_at = now(),
      last_error = nullif(trim(p_last_error), '')
  where d.id = p_domain_id
    and d.tenant_id = p_tenant_id
    and d.domain_type = 'CUSTOM_DOMAIN'
    and d.status not in ('ACTIVE', 'DISABLED', 'REMOVED');

  if not found then
    raise exception 'Unknown or immutable custom domain'
      using errcode = 'no_data_found';
  end if;

  insert into platform.domain_events (
    tenant_id, domain_id, event_type, actor, actor_type, to_status, detail
  )
  values (
    p_tenant_id,
    p_domain_id,
    'PROVIDER_STATE_SYNCED',
    p_actor,
    'SERVICE',
    v_status,
    jsonb_build_object(
      'ownership_status', p_ownership_status,
      'dns_status', p_dns_status,
      'tls_status', p_tls_status,
      'misconfigured', p_provider_misconfigured
    )
  );

  return v_status;
end;
$$;

revoke all on function public.sync_custom_domain_provider_state(
  uuid, uuid, text, text, text, jsonb, boolean, text, uuid
) from public, anon, authenticated;
grant execute on function public.sync_custom_domain_provider_state(
  uuid, uuid, text, text, text, jsonb, boolean, text, uuid
) to service_role;

create or replace function public.activate_custom_domain(
  p_tenant_id uuid,
  p_domain_id uuid,
  p_actor uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain platform.tenant_domains%rowtype;
  v_fallback_hostname text;
begin
  select * into v_domain
  from platform.tenant_domains d
  where d.id = p_domain_id
    and d.tenant_id = p_tenant_id
    and d.domain_type = 'CUSTOM_DOMAIN'
  for update;

  if not found then
    raise exception 'Unknown custom domain' using errcode = 'no_data_found';
  end if;

  if v_domain.status <> 'VERIFIED'
     or v_domain.ownership_status <> 'VERIFIED'
     or v_domain.dns_status <> 'OK'
     or v_domain.tls_status <> 'ISSUED' then
    raise exception 'Custom domain is not fully verified and cannot activate'
      using errcode = 'check_violation';
  end if;

  select d.normalized_hostname into v_fallback_hostname
  from platform.tenant_domains d
  where d.tenant_id = p_tenant_id
    and d.domain_type = 'PLATFORM_SUBDOMAIN'
    and d.status = 'ACTIVE'
  order by d.is_fallback desc, d.created_at asc
  limit 1
  for update;

  if v_fallback_hostname is null then
    raise exception 'A custom domain cannot become canonical without an ACTIVE platform fallback'
      using errcode = 'check_violation';
  end if;

  update platform.tenant_domains
  set is_canonical = false
  where tenant_id = p_tenant_id and is_canonical;

  update platform.tenant_domains
  set is_fallback = true
  where tenant_id = p_tenant_id
    and domain_type = 'PLATFORM_SUBDOMAIN'
    and status = 'ACTIVE'
    and normalized_hostname = v_fallback_hostname;

  update platform.tenant_domains
  set status = 'ACTIVE',
      is_canonical = true,
      is_fallback = false,
      activated_at = coalesce(activated_at, now()),
      last_error = null
  where id = p_domain_id;

  update platform.tenants
  set canonical_hostname = v_domain.normalized_hostname
  where id = p_tenant_id;

  insert into platform.domain_events (
    tenant_id, domain_id, event_type, actor, actor_type,
    from_status, to_status, detail
  )
  values (
    p_tenant_id,
    p_domain_id,
    'CUSTOM_DOMAIN_ACTIVATED',
    p_actor,
    'USER',
    'VERIFIED',
    'ACTIVE',
    jsonb_build_object('fallback_hostname', v_fallback_hostname)
  );

  return v_domain.normalized_hostname;
end;
$$;

revoke all on function public.activate_custom_domain(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.activate_custom_domain(uuid, uuid, uuid)
  to service_role;

create or replace function public.disable_custom_domain(
  p_tenant_id uuid,
  p_domain_id uuid,
  p_reason text,
  p_actor uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain platform.tenant_domains%rowtype;
  v_fallback_hostname text;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'Disabling a custom domain requires a recorded reason'
      using errcode = 'check_violation';
  end if;

  select * into v_domain
  from platform.tenant_domains d
  where d.id = p_domain_id
    and d.tenant_id = p_tenant_id
    and d.domain_type = 'CUSTOM_DOMAIN'
  for update;

  if not found then
    raise exception 'Unknown custom domain' using errcode = 'no_data_found';
  end if;

  if v_domain.status in ('DISABLED', 'REMOVED') then
    return v_domain.normalized_hostname;
  end if;

  if v_domain.is_canonical then
    select d.normalized_hostname into v_fallback_hostname
    from platform.tenant_domains d
    where d.tenant_id = p_tenant_id
      and d.domain_type = 'PLATFORM_SUBDOMAIN'
      and d.status = 'ACTIVE'
    order by d.is_fallback desc, d.created_at asc
    limit 1
    for update;

    if v_fallback_hostname is null then
      raise exception 'Canonical custom domain cannot be disabled without an ACTIVE platform fallback'
        using errcode = 'check_violation';
    end if;

    update platform.tenant_domains
    set is_canonical = false
    where tenant_id = p_tenant_id and is_canonical;

    update platform.tenant_domains
    set is_canonical = true, is_fallback = true
    where tenant_id = p_tenant_id
      and normalized_hostname = v_fallback_hostname;

    update platform.tenants
    set canonical_hostname = v_fallback_hostname
    where id = p_tenant_id;
  end if;

  insert into platform.domain_release_history (
    normalized_hostname, previous_tenant_id, released_by, reason
  )
  values (v_domain.normalized_hostname, p_tenant_id, p_actor, trim(p_reason));

  update platform.tenant_domains
  set status = 'DISABLED',
      is_canonical = false,
      is_fallback = false,
      disabled_at = now(),
      last_error = trim(p_reason)
  where id = p_domain_id;

  insert into platform.domain_events (
    tenant_id, domain_id, event_type, actor, actor_type,
    from_status, to_status, detail
  )
  values (
    p_tenant_id,
    p_domain_id,
    'CUSTOM_DOMAIN_DISABLED',
    p_actor,
    'USER',
    v_domain.status,
    'DISABLED',
    jsonb_build_object('reason', trim(p_reason), 'fallback_hostname', v_fallback_hostname)
  );

  return v_domain.normalized_hostname;
end;
$$;

revoke all on function public.disable_custom_domain(uuid, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.disable_custom_domain(uuid, uuid, text, uuid)
  to service_role;
