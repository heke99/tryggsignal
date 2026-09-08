-- Tryggsignal P39 — reproducible synthetic municipality provisioning gate.
-- Runs in one transaction and rolls back.

begin;

create temporary table p39 (k text primary key, v uuid) on commit drop;

-- 1. First request creates tenant + run + default branding + fallback domain.
do $$
declare
  v_tenant uuid;
  v_run uuid;
  v_host text;
  v_created boolean;
begin
  select tenant_id, run_id, platform_hostname, created
    into v_tenant, v_run, v_host, v_created
  from public.request_tenant_provisioning(
    'syntetisk-kommun',
    'Syntetisk kommun',
    'auth/syntetisk/staff',
    'p39-synthetic-onboarding-0001',
    null
  );

  if not v_created then raise exception 'P39: first provisioning request was not created'; end if;
  if v_host <> 'syntetisk-kommun.tryggsignal.se' then
    raise exception 'P39: unexpected platform hostname %', v_host;
  end if;

  insert into p39 values ('tenant', v_tenant), ('run', v_run);

  if (select count(*) from platform.tenant_branding where tenant_id = v_tenant) <> 1 then
    raise exception 'P39: default branding was not created exactly once';
  end if;
  if (select count(*) from platform.tenant_domains where tenant_id = v_tenant and is_fallback) <> 1 then
    raise exception 'P39: platform fallback domain was not created exactly once';
  end if;
end;
$$;

-- 2. Same idempotency key returns same tenant/run and creates nothing else.
do $$
declare
  v_tenant uuid;
  v_run uuid;
  v_created boolean;
begin
  select tenant_id, run_id, created into v_tenant, v_run, v_created
  from public.request_tenant_provisioning(
    'syntetisk-kommun',
    'Syntetisk kommun',
    'auth/syntetisk/staff',
    'p39-synthetic-onboarding-0001',
    null
  );

  if v_created then raise exception 'P39: rerun created duplicate provisioning'; end if;
  if v_tenant <> (select v from p39 where k = 'tenant') then
    raise exception 'P39: rerun changed tenant id';
  end if;
  if v_run <> (select v from p39 where k = 'run') then
    raise exception 'P39: rerun changed provisioning run id';
  end if;
  if (select count(*) from platform.tenants where slug = 'syntetisk-kommun') <> 1 then
    raise exception 'P39: duplicate tenant exists after rerun';
  end if;
end;
$$;

-- 3. State checkpoint retries are idempotent.
do $$
declare v_run uuid := (select v from p39 where k = 'run');
begin
  perform platform.advance_provisioning(v_run, 'TENANT_CREATED');
  perform platform.advance_provisioning(v_run, 'TENANT_CREATED');
  if (select state from platform.tenant_provisioning_runs where id = v_run) <> 'TENANT_CREATED' then
    raise exception 'P39: idempotent checkpoint did not remain TENANT_CREATED';
  end if;
end;
$$;

-- 4. Exact production data plane registration is idempotent and health-aware.
do $$
declare
  v_tenant uuid := (select v from p39 where k = 'tenant');
  v_first uuid;
  v_second uuid;
begin
  v_first := public.register_tenant_data_plane(
    v_tenant,
    'PRODUCTION',
    'synthetic-project-ref',
    'eu-north-1',
    'https://synthetic-project-ref.supabase.co',
    'sb_publishable_synthetic',
    'tenant/syntetisk-kommun/service',
    'schema-p39-test',
    'HEALTHY'
  );

  v_second := public.register_tenant_data_plane(
    v_tenant,
    'PRODUCTION',
    'synthetic-project-ref',
    'eu-north-1',
    'https://synthetic-project-ref.supabase.co',
    'sb_publishable_synthetic',
    'tenant/syntetisk-kommun/service',
    'schema-p39-test',
    'HEALTHY'
  );

  if v_first <> v_second then raise exception 'P39: rerun changed deployment id'; end if;
  if (select count(*) from platform.tenant_deployments where tenant_id = v_tenant) <> 1 then
    raise exception 'P39: duplicate deployment exists after rerun';
  end if;
end;
$$;

-- 5. READY remains blocked until verified fallback + healthy data plane exist.
do $$
declare
  v_run uuid := (select v from p39 where k = 'run');
  v_tenant uuid := (select v from p39 where k = 'tenant');
  v_blocked boolean := false;
begin
  perform platform.advance_provisioning(v_run, 'DATA_PLANE_PROVISIONED');
  perform platform.advance_provisioning(v_run, 'SCHEMA_APPLIED');
  perform platform.advance_provisioning(v_run, 'BRANDING_DRAFTED');
  perform platform.advance_provisioning(v_run, 'PLATFORM_DOMAIN_ACTIVE');

  begin
    perform platform.advance_provisioning(v_run, 'READY');
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'P39: READY bypassed domain health gate'; end if;

  update platform.tenant_domains
  set status = 'ACTIVE', ownership_status = 'VERIFIED', dns_status = 'OK', tls_status = 'ISSUED',
      activated_at = now()
  where tenant_id = v_tenant and domain_type = 'PLATFORM_SUBDOMAIN';

  perform platform.advance_provisioning(v_run, 'READY');
  perform platform.advance_provisioning(v_run, 'READY');

  if (select status from platform.tenants where id = v_tenant) <> 'ACTIVE' then
    raise exception 'P39: tenant was not activated at READY';
  end if;
end;
$$;

-- 6. FAILED -> REQUESTED recovery increments attempt count and clears completion.
do $$
declare
  v_tenant uuid;
  v_run uuid;
  v_attempts integer;
begin
  select tenant_id, run_id into v_tenant, v_run
  from public.request_tenant_provisioning(
    'syntetisk-recovery',
    'Syntetisk recovery',
    'auth/syntetisk-recovery/staff',
    'p39-synthetic-recovery-0001',
    null
  );

  perform platform.advance_provisioning(v_run, 'FAILED', 'provider timeout during project creation');
  perform platform.advance_provisioning(v_run, 'REQUESTED');
  select attempt_count into v_attempts from platform.tenant_provisioning_runs where id = v_run;
  if v_attempts <> 2 then raise exception 'P39: recovery attempt count %, expected 2', v_attempts; end if;
end;
$$;

-- 7. Service-only provisioning RPCs are never client APIs.
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.request_tenant_provisioning(text,text,text,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'P39: authenticated can request control-plane provisioning';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.register_tenant_data_plane(uuid,text,text,text,text,text,text,text,text)',
    'EXECUTE'
  ) then
    raise exception 'P39: authenticated can register data plane';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.request_tenant_provisioning(text,text,text,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'P39: service role cannot request provisioning';
  end if;
end;
$$;

select 'P39 PROVISIONING REPRODUCIBILITY: GREEN' as result;

rollback;
