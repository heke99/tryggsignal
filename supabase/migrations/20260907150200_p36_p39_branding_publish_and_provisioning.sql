-- Tryggsignal P36/P39 — branding publish/rollback and tenant provisioning.
-- Masterplan 154 (contrast validated before publish), 164 (draft → preview →
-- validate → publish → rollback, audited), 192/193 (provisioning workflow and
-- state), 194 (offboarding), 195 (audit).

-- ---------------------------------------------------------------------------
-- Branding (masterplan 164)
--
-- Publishing is a function, not an UPDATE, because three things must happen
-- together: the previous version is superseded, the tenant's branding_version is
-- bumped so caches invalidate (masterplan 142/184), and the change is audited.
-- ---------------------------------------------------------------------------

create table platform.branding_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references platform.tenants (id) on delete cascade,
  branding_id uuid references platform.tenant_branding (id) on delete set null,
  event_type text not null check (event_type in ('DRAFTED', 'VALIDATED', 'PUBLISHED', 'ROLLED_BACK')),
  version integer,
  actor uuid,
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);

create index branding_events_tenant_idx on platform.branding_events (tenant_id, occurred_at desc);

alter table platform.branding_events enable row level security;

create or replace function platform.publish_branding(
  p_branding_id uuid,
  p_actor uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_branding platform.tenant_branding%rowtype;
  v_previous platform.tenant_branding%rowtype;
begin
  select * into v_branding from platform.tenant_branding b where b.id = p_branding_id for update;
  if not found then
    raise exception 'Unknown branding version %', p_branding_id using errcode = 'no_data_found';
  end if;
  if v_branding.status <> 'DRAFT' then
    raise exception 'Only a DRAFT may be published; this version is %', v_branding.status
      using errcode = 'raise_exception';
  end if;
  -- Masterplan 154: the accessibility gate is not advisory.
  if v_branding.contrast_validation_status <> 'PASSED' then
    raise exception 'Branding version % has not passed contrast validation', v_branding.version
      using errcode = 'check_violation';
  end if;

  select * into v_previous from platform.tenant_branding b
  where b.tenant_id = v_branding.tenant_id and b.status = 'PUBLISHED'
  for update;

  if found then
    update platform.tenant_branding set status = 'SUPERSEDED' where id = v_previous.id;
    update platform.tenant_branding set supersedes_id = v_previous.id where id = p_branding_id;
  end if;

  update platform.tenant_branding
  set status = 'PUBLISHED', published_at = now(), published_by = p_actor
  where id = p_branding_id;

  -- The version bump is what invalidates every cache key that carries it, so a
  -- session in flight sees the new profile without a broken intermediate state.
  update platform.tenants
  set branding_version = v_branding.version
  where id = v_branding.tenant_id;

  insert into platform.branding_events (tenant_id, branding_id, event_type, version, actor, detail)
  values (v_branding.tenant_id, p_branding_id, 'PUBLISHED', v_branding.version, p_actor,
          jsonb_build_object('supersedes', v_previous.id));

  return v_branding.version;
end;
$$;

revoke all on function platform.publish_branding(uuid, uuid) from public;

create or replace function platform.rollback_branding(
  p_tenant_id uuid,
  p_actor uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current platform.tenant_branding%rowtype;
  v_target platform.tenant_branding%rowtype;
begin
  select * into v_current from platform.tenant_branding b
  where b.tenant_id = p_tenant_id and b.status = 'PUBLISHED' for update;
  if not found then
    raise exception 'Tenant % has no published branding to roll back', p_tenant_id
      using errcode = 'no_data_found';
  end if;

  select * into v_target from platform.tenant_branding b
  where b.id = v_current.supersedes_id for update;
  if not found then
    raise exception 'There is no previous branding version to roll back to'
      using errcode = 'no_data_found';
  end if;

  update platform.tenant_branding set status = 'DRAFT', published_at = null, published_by = null
  where id = v_current.id;
  update platform.tenant_branding set status = 'PUBLISHED' where id = v_target.id;
  update platform.tenants set branding_version = v_target.version where id = p_tenant_id;

  insert into platform.branding_events (tenant_id, branding_id, event_type, version, actor, detail)
  values (p_tenant_id, v_target.id, 'ROLLED_BACK', v_target.version, p_actor,
          jsonb_build_object('from_version', v_current.version));

  return v_target.version;
end;
$$;

revoke all on function platform.rollback_branding(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- Provisioning (masterplan 192, 193, 194)
--
-- The state machine is explicit so a half-provisioned tenant is visible rather
-- than silently serving. A tenant may only become ACTIVE from READY.
-- ---------------------------------------------------------------------------

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
  select * into v_run from platform.tenant_provisioning_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'Unknown provisioning run %', p_run_id using errcode = 'no_data_found';
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

  -- A tenant only becomes servable once the platform domain is actually active.
  if p_to_state = 'READY' then
    if not exists (
      select 1 from platform.tenant_domains d
      where d.tenant_id = v_run.tenant_id and d.status = 'ACTIVE'
    ) then
      raise exception 'A tenant cannot be READY without an ACTIVE domain'
        using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from platform.tenant_deployments dep
      where dep.tenant_id = v_run.tenant_id and dep.status = 'ACTIVE'
    ) then
      raise exception 'A tenant cannot be READY without an ACTIVE data plane'
        using errcode = 'check_violation';
    end if;
  end if;

  update platform.tenant_provisioning_runs
  set state = p_to_state,
      last_error = p_error,
      completed_at = case when p_to_state = 'READY' then now() else completed_at end
  where id = p_run_id;

  if p_to_state = 'READY' then
    update platform.tenants set status = 'ACTIVE', activated_at = coalesce(activated_at, now())
    where id = v_run.tenant_id;
  end if;

  return p_to_state;
end;
$$;

revoke all on function platform.advance_provisioning(uuid, platform.provisioning_state, text) from public;

-- Masterplan 194: offboarding stops the tenant serving and releases its
-- hostnames with a tombstone, so no one else can quietly take them over.
create or replace function platform.offboard_tenant(
  p_tenant_id uuid,
  p_reason text,
  p_actor uuid default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  if p_reason is null or length(p_reason) < 10 then
    raise exception 'Offboarding requires a recorded reason' using errcode = 'check_violation';
  end if;

  update platform.tenants
  set status = 'OFFBOARDING'
  where id = p_tenant_id and status in ('ACTIVE', 'SUSPENDED');

  insert into platform.domain_release_history (normalized_hostname, previous_tenant_id, released_by, reason)
  select d.normalized_hostname, d.tenant_id, p_actor, p_reason
  from platform.tenant_domains d
  where d.tenant_id = p_tenant_id and d.status <> 'REMOVED';

  update platform.tenant_domains
  set status = 'DISABLED', disabled_at = now(), is_canonical = false
  where tenant_id = p_tenant_id and status <> 'REMOVED';
  get diagnostics v_released = row_count;

  return v_released;
end;
$$;

revoke all on function platform.offboard_tenant(uuid, text, uuid) from public;
