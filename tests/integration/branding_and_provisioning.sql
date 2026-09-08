-- Tryggsignal — integration test for branding publish/rollback and the tenant
-- provisioning state machine (masterplan 154, 164, 192-194, 167).
--
-- Runs inside one transaction and rolls back.
--   psql "$CONTROL_PLANE_URL" -v ON_ERROR_STOP=1 -f tests/integration/branding_and_provisioning.sql
--
-- Last verified GREEN: 2026-09-07 against the control plane.

begin;

create temporary table t (k text primary key, v uuid) on commit drop;

insert into platform.tenants (slug, display_name, status, canonical_hostname, auth_configuration_reference)
values ('provkommun', 'Provkommun', 'PROVISIONING', 'provkommun.tryggsignal.se', 'auth/prov');
insert into t select 'tenant', id from platform.tenants where slug = 'provkommun';

insert into platform.tenant_provisioning_runs (tenant_id, state)
values ((select v from t where k = 'tenant'), 'REQUESTED');
insert into t select 'run', id from platform.tenant_provisioning_runs
  where tenant_id = (select v from t where k = 'tenant');

-- 1. The state machine refuses to skip a step.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform platform.advance_provisioning((select v from t where k = 'run'), 'READY');
  exception when raise_exception then v_blocked := true;
  end;
  if not v_blocked then raise exception 'Provisioning allowed a skipped step'; end if;
end;
$$;

-- 2. A tenant cannot be READY without an active domain and data plane.
do $$
declare v_run uuid := (select v from t where k = 'run'); v_blocked boolean := false;
begin
  perform platform.advance_provisioning(v_run, 'TENANT_CREATED');
  perform platform.advance_provisioning(v_run, 'DATA_PLANE_PROVISIONED');
  perform platform.advance_provisioning(v_run, 'SCHEMA_APPLIED');
  perform platform.advance_provisioning(v_run, 'BRANDING_DRAFTED');
  perform platform.advance_provisioning(v_run, 'PLATFORM_DOMAIN_ACTIVE');
  begin
    perform platform.advance_provisioning(v_run, 'READY');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'A tenant reached READY without an active domain'; end if;
end;
$$;

-- 3. With a verified domain and an active deployment, READY activates the tenant.
do $$
declare v_status platform.tenant_status;
begin
  insert into platform.tenant_domains (
    tenant_id, hostname, normalized_hostname, domain_type, status, is_canonical,
    ownership_status, dns_status, tls_status
  )
  values ((select v from t where k = 'tenant'), 'provkommun.tryggsignal.se',
          'provkommun.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE', true,
          'VERIFIED', 'OK', 'ISSUED');

  insert into platform.tenant_deployments (
    tenant_id, environment, supabase_project_ref, supabase_url, publishable_key,
    privileged_credential_reference, schema_version, status
  )
  values ((select v from t where k = 'tenant'), 'PRODUCTION', 'provref',
          'https://provref.supabase.co', 'sb_publishable_x', 'tenant/prov/service', '1', 'ACTIVE');

  perform platform.advance_provisioning((select v from t where k = 'run'), 'READY');

  select status into v_status from platform.tenants where id = (select v from t where k = 'tenant');
  if v_status <> 'ACTIVE' then raise exception 'Tenant was not activated, status %', v_status; end if;
end;
$$;

-- 4. Branding: publishing without a passed contrast check is refused.
do $$
declare v_draft uuid; v_blocked boolean := false;
begin
  insert into platform.tenant_branding (tenant_id, version, display_name, primary_color, contrast_validation_status)
  values ((select v from t where k = 'tenant'), 1, 'Provkommun', '#14532d', 'NOT_VALIDATED')
  returning id into v_draft;
  insert into t values ('branding_v1', v_draft);

  begin
    perform platform.publish_branding(v_draft);
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'Branding was published without contrast validation'; end if;
end;
$$;

-- 5. Publishing bumps the tenant branding version so caches invalidate.
do $$
declare v_version integer;
begin
  update platform.tenant_branding set contrast_validation_status = 'PASSED'
  where id = (select v from t where k = 'branding_v1');

  v_version := platform.publish_branding((select v from t where k = 'branding_v1'));
  if v_version <> 1 then raise exception 'Unexpected published version %', v_version; end if;

  if (select branding_version from platform.tenants where id = (select v from t where k = 'tenant')) <> 1 then
    raise exception 'Tenant branding_version was not bumped';
  end if;
end;
$$;

-- 6. A second version supersedes the first, and rollback restores it.
do $$
declare v_v2 uuid; v_restored integer;
begin
  insert into platform.tenant_branding (tenant_id, version, display_name, primary_color, contrast_validation_status)
  values ((select v from t where k = 'tenant'), 2, 'Provkommun', '#1d4ed8', 'PASSED')
  returning id into v_v2;

  perform platform.publish_branding(v_v2);

  if (select status from platform.tenant_branding where id = (select v from t where k = 'branding_v1'))
     <> 'SUPERSEDED' then
    raise exception 'The previous version was not superseded';
  end if;
  if (select branding_version from platform.tenants where id = (select v from t where k = 'tenant')) <> 2 then
    raise exception 'Tenant branding_version was not bumped to 2';
  end if;

  v_restored := platform.rollback_branding((select v from t where k = 'tenant'));
  if v_restored <> 1 then raise exception 'Rollback restored version %, expected 1', v_restored; end if;
  if (select branding_version from platform.tenants where id = (select v from t where k = 'tenant')) <> 1 then
    raise exception 'Rollback did not restore the tenant branding version';
  end if;
  if (select count(*) from platform.branding_events where tenant_id = (select v from t where k = 'tenant')) <> 3 then
    raise exception 'Branding changes were not fully audited';
  end if;
end;
$$;

-- 7. Cross-tenant branding assets are refused even through privileged writes.
do $$
declare
  v_other_tenant uuid;
  v_other_asset uuid;
  v_draft uuid;
  v_blocked boolean := false;
begin
  insert into platform.tenants (
    slug, display_name, status, canonical_hostname, auth_configuration_reference
  )
  values ('annanbranding', 'Annan branding', 'PROVISIONING',
          'annanbranding.tryggsignal.se', 'auth/annan')
  returning id into v_other_tenant;

  insert into platform.branding_assets (
    tenant_id, asset_kind, object_path, sha256, mime_type, width, height, size_bytes
  )
  values (
    v_other_tenant, 'LOGO', v_other_tenant::text || '/asset.png',
    repeat('a', 64), 'image/png', 64, 64, 128
  )
  returning id into v_other_asset;

  select id into v_draft
  from platform.tenant_branding
  where tenant_id = (select v from t where k = 'tenant') and status = 'DRAFT';

  begin
    update platform.tenant_branding set logo_asset_id = v_other_asset where id = v_draft;
  exception when check_violation then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'Cross-tenant branding asset was accepted';
  end if;
end;
$$;

-- 8. Branding service RPCs are not client APIs.
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.resolve_tenant_branding(uuid,integer)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can execute service-only branding resolver';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.resolve_tenant_branding(uuid,integer)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute branding resolver';
  end if;
end;
$$;

-- 9. Offboarding disables the domains and records a tombstone (masterplan 167/194).
do $$
declare v_released integer; v_active integer; v_tombstones integer;
begin
  v_released := platform.offboard_tenant((select v from t where k = 'tenant'),
                                          'Avtalet avslutat enligt overenskommelse');
  if v_released < 1 then raise exception 'No domains were released'; end if;

  select count(*) into v_active from platform.tenant_domains
  where tenant_id = (select v from t where k = 'tenant') and status = 'ACTIVE';
  if v_active <> 0 then raise exception 'A domain kept serving after offboarding'; end if;

  select count(*) into v_tombstones from platform.domain_release_history
  where previous_tenant_id = (select v from t where k = 'tenant');
  if v_tombstones < 1 then raise exception 'No release tombstone was written'; end if;
end;
$$;

-- 10. An offboarding without a recorded reason is refused.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform platform.offboard_tenant((select v from t where k = 'tenant'), 'kort');
  exception when check_violation then v_blocked := true;
  end;
  if not v_blocked then raise exception 'Offboarding was allowed without a reason'; end if;
end;
$$;

select 'BRANDING AND PROVISIONING INTEGRATION: GREEN' as result;

rollback;
