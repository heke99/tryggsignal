-- Tryggsignal P40 — domain / white-label hardening integration matrix.
-- Synthetic rows are rolled back.

begin;

create temporary table p40_ids (k text primary key, v uuid) on commit drop;

insert into platform.tenants (
  id, slug, display_name, status, canonical_hostname, auth_configuration_reference
) values
  ('81000000-0000-4000-8000-000000000001', 'hard-a', 'Hardening A', 'ACTIVE',
   'hard-a.tryggsignal.se', 'auth/hard-a'),
  ('81000000-0000-4000-8000-000000000002', 'hard-b', 'Hardening B', 'ACTIVE',
   'hard-b.tryggsignal.se', 'auth/hard-b');

insert into platform.tenant_domains (
  id, tenant_id, hostname, normalized_hostname, domain_type, status,
  is_canonical, is_fallback, ownership_status, dns_status, tls_status
) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001',
   'hard-a.tryggsignal.se', 'hard-a.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   true, true, 'VERIFIED', 'OK', 'ISSUED'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002',
   'hard-b.tryggsignal.se', 'hard-b.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   true, true, 'VERIFIED', 'OK', 'ISSUED');

-- 1. Feature flags are isolated product capabilities per tenant.
do $$
declare
  v_a boolean;
  v_b boolean;
begin
  perform public.set_tenant_feature_flag(
    '81000000-0000-4000-8000-000000000001', 'custom_domain', true,
    '{"source":"p40"}'::jsonb, null
  );
  perform public.set_tenant_feature_flag(
    '81000000-0000-4000-8000-000000000002', 'custom_domain', false,
    '{}'::jsonb, null
  );

  select enabled into v_a from public.list_tenant_feature_flags(
    '81000000-0000-4000-8000-000000000001'
  ) where feature_key = 'custom_domain';
  select enabled into v_b from public.list_tenant_feature_flags(
    '81000000-0000-4000-8000-000000000002'
  ) where feature_key = 'custom_domain';

  if v_a is not true or v_b is not false then
    raise exception 'P40: tenant feature flags crossed tenant boundary';
  end if;
end;
$$;

-- 2. Feature flags are service-only and therefore cannot replace RBAC/RLS.
do $$
begin
  if has_function_privilege(
    'authenticated', 'public.list_tenant_feature_flags(uuid)', 'EXECUTE'
  ) then
    raise exception 'P40: authenticated can read control-plane feature flags';
  end if;
  if has_function_privilege(
    'authenticated', 'public.set_tenant_feature_flag(uuid,text,boolean,jsonb,uuid)', 'EXECUTE'
  ) then
    raise exception 'P40: authenticated can mutate control-plane feature flags';
  end if;
  if not has_function_privilege(
    'service_role', 'public.list_tenant_feature_flags(uuid)', 'EXECUTE'
  ) then
    raise exception 'P40: service role cannot resolve feature flags';
  end if;
end;
$$;

-- 3. A tenant cannot register a branding asset under another tenant's path.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.register_branding_asset(
      '81000000-0000-4000-8000-000000000001',
      null,
      'LOGO',
      '81000000-0000-4000-8000-000000000002/stolen.png',
      repeat('a', 64),
      'image/png',
      64, 64, 128
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'P40: cross-tenant branding object path was accepted';
  end if;
end;
$$;

-- 4. Custom-domain provider failure can recover without becoming servable early.
do $$
declare
  v_domain uuid;
  v_status platform.domain_status;
begin
  v_domain := public.request_custom_domain(
    '81000000-0000-4000-8000-000000000001', null,
    'bygg.hard-a.example', 'bygg.hard-a.example', 'prj_p40'
  );
  insert into p40_ids values ('custom', v_domain);

  perform public.attach_custom_domain_provider(
    '81000000-0000-4000-8000-000000000001', v_domain, 'prj_p40',
    'provider-domain-p40', '[]'::jsonb, null
  );

  v_status := public.sync_custom_domain_provider_state(
    '81000000-0000-4000-8000-000000000001', v_domain,
    'FAILED', 'UNKNOWN', 'UNKNOWN', '[]'::jsonb, null,
    'provider verification failed', null
  );
  if v_status <> 'FAILED' then
    raise exception 'P40: provider failure did not persist FAILED';
  end if;

  perform public.attach_custom_domain_provider(
    '81000000-0000-4000-8000-000000000001', v_domain, 'prj_p40',
    'provider-domain-p40', '[]'::jsonb, null
  );

  v_status := public.sync_custom_domain_provider_state(
    '81000000-0000-4000-8000-000000000001', v_domain,
    'VERIFIED', 'OK', 'ISSUED', '[]'::jsonb, false, null, null
  );
  if v_status <> 'VERIFIED' then
    raise exception 'P40: recovered provider state did not reach VERIFIED';
  end if;
  if (select status from platform.tenant_domains where id = v_domain) = 'ACTIVE' then
    raise exception 'P40: provider recovery auto-activated custom domain';
  end if;
end;
$$;

-- 5. Cross-tenant provider-state mutation is denied.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.sync_custom_domain_provider_state(
      '81000000-0000-4000-8000-000000000002',
      (select v from p40_ids where k = 'custom'),
      'VERIFIED', 'OK', 'ISSUED', '[]'::jsonb, false, null, null
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'P40: tenant B mutated tenant A domain';
  end if;
end;
$$;

-- 6. After activation, provider sync is immutable and disable restores fallback.
do $$
declare
  v_domain uuid := (select v from p40_ids where k = 'custom');
  v_blocked boolean := false;
begin
  perform public.activate_custom_domain(
    '81000000-0000-4000-8000-000000000001', v_domain, null
  );

  begin
    perform public.sync_custom_domain_provider_state(
      '81000000-0000-4000-8000-000000000001', v_domain,
      'FAILED', 'MISCONFIGURED', 'FAILED', '[]'::jsonb, true,
      'late provider error', null
    );
  exception when no_data_found then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'P40: ACTIVE domain provider state was mutated behind activation gate';
  end if;

  perform public.disable_custom_domain(
    '81000000-0000-4000-8000-000000000001', v_domain,
    'P40 recovery fallback verification', null
  );

  if (select canonical_hostname from platform.tenants
      where id = '81000000-0000-4000-8000-000000000001') <> 'hard-a.tryggsignal.se' then
    raise exception 'P40: disabling canonical custom domain did not restore fallback';
  end if;
  if (select status from platform.tenant_domains where id = v_domain) <> 'DISABLED' then
    raise exception 'P40: disabled custom domain remained servable';
  end if;
end;
$$;

select 'P40 DOMAIN / WHITE-LABEL HARDENING: GREEN' as result;

rollback;
