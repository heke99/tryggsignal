-- Tryggsignal P37 — custom domain lifecycle integration gate.
-- Synthetic tenants/domains are rolled back.

begin;

create temporary table p37_ids (k text primary key, v uuid) on commit drop;

insert into platform.tenants (
  id, slug, display_name, status, canonical_hostname, auth_configuration_reference
) values
  ('71000000-0000-4000-8000-000000000001', 'domain-a', 'Domain A', 'ACTIVE',
   'domain-a.tryggsignal.se', 'auth/domain-a'),
  ('71000000-0000-4000-8000-000000000002', 'domain-b', 'Domain B', 'ACTIVE',
   'domain-b.tryggsignal.se', 'auth/domain-b');

insert into platform.tenant_domains (
  id, tenant_id, hostname, normalized_hostname, domain_type, status,
  is_canonical, is_fallback, ownership_status, dns_status, tls_status
) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001',
   'domain-a.tryggsignal.se', 'domain-a.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   true, true, 'VERIFIED', 'OK', 'ISSUED'),
  ('72000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002',
   'domain-b.tryggsignal.se', 'domain-b.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   true, true, 'VERIFIED', 'OK', 'ISSUED');

-- 1. Tryggsignal-owned namespace cannot be requested as a custom domain.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.request_custom_domain(
      '71000000-0000-4000-8000-000000000001',
      null,
      'app.tryggsignal.se',
      'app.tryggsignal.se',
      'prj_test'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'P37: platform namespace was claimable'; end if;
end;
$$;

-- 2. Request and provider attachment remain non-servable.
do $$
declare v_domain uuid;
begin
  v_domain := public.request_custom_domain(
    '71000000-0000-4000-8000-000000000001',
    null,
    'bygg.domain-a.example',
    'bygg.domain-a.example',
    'prj_test'
  );
  insert into p37_ids values ('custom', v_domain);

  perform public.attach_custom_domain_provider(
    '71000000-0000-4000-8000-000000000001',
    v_domain,
    'prj_test',
    'bygg.domain-a.example',
    '[{"type":"TXT","domain":"_vercel.bygg.domain-a.example","value":"vc-domain-verify=test"}]'::jsonb,
    null
  );

  if (select status from platform.tenant_domains where id = v_domain) <> 'AWAITING_DNS' then
    raise exception 'P37: attached unverified domain did not remain blocked';
  end if;
end;
$$;

-- 3. An unverified domain cannot be activated.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.activate_custom_domain(
      '71000000-0000-4000-8000-000000000001',
      (select v from p37_ids where k = 'custom'),
      null
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'P37: unverified domain activated'; end if;
end;
$$;

-- 4. Ownership alone is insufficient when DNS/TLS are not healthy.
do $$
declare v_status platform.domain_status;
begin
  v_status := public.sync_custom_domain_provider_state(
    '71000000-0000-4000-8000-000000000001',
    (select v from p37_ids where k = 'custom'),
    'VERIFIED',
    'MISCONFIGURED',
    'PENDING',
    '[]'::jsonb,
    true,
    null,
    null
  );
  if v_status <> 'VERIFYING' then
    raise exception 'P37: misconfigured DNS became verified: %', v_status;
  end if;
end;
$$;

-- 5. Full provider + DNS + TLS verification reaches VERIFIED, never ACTIVE.
do $$
declare v_status platform.domain_status;
begin
  v_status := public.sync_custom_domain_provider_state(
    '71000000-0000-4000-8000-000000000001',
    (select v from p37_ids where k = 'custom'),
    'VERIFIED',
    'OK',
    'ISSUED',
    '[]'::jsonb,
    false,
    null,
    null
  );
  if v_status <> 'VERIFIED' then
    raise exception 'P37: fully verified domain status %, expected VERIFIED', v_status;
  end if;
  if (select status from platform.tenant_domains where id = (select v from p37_ids where k = 'custom')) = 'ACTIVE' then
    raise exception 'P37: provider sync activated a domain without explicit activation';
  end if;
end;
$$;

-- 6. Explicit activation promotes custom canonical and preserves platform fallback.
do $$
declare v_hostname text;
begin
  v_hostname := public.activate_custom_domain(
    '71000000-0000-4000-8000-000000000001',
    (select v from p37_ids where k = 'custom'),
    null
  );
  if v_hostname <> 'bygg.domain-a.example' then
    raise exception 'P37: wrong canonical hostname %', v_hostname;
  end if;

  if not exists (
    select 1 from platform.tenant_domains
    where id = (select v from p37_ids where k = 'custom')
      and status = 'ACTIVE' and is_canonical and not is_fallback
  ) then
    raise exception 'P37: custom domain was not active canonical';
  end if;

  if not exists (
    select 1 from platform.tenant_domains
    where id = '72000000-0000-4000-8000-000000000001'
      and status = 'ACTIVE' and is_fallback and not is_canonical
  ) then
    raise exception 'P37: platform fallback was not preserved';
  end if;

  if (select canonical_hostname from platform.tenants
      where id = '71000000-0000-4000-8000-000000000001') <> 'bygg.domain-a.example' then
    raise exception 'P37: tenant canonical hostname not updated';
  end if;
end;
$$;

-- 7. Disabling canonical custom domain restores platform fallback and tombstones host.
do $$
begin
  perform public.disable_custom_domain(
    '71000000-0000-4000-8000-000000000001',
    (select v from p37_ids where k = 'custom'),
    'Kommunen avslutar den egna domänen',
    null
  );

  if (select canonical_hostname from platform.tenants
      where id = '71000000-0000-4000-8000-000000000001') <> 'domain-a.tryggsignal.se' then
    raise exception 'P37: fallback did not become canonical after disable';
  end if;

  if not exists (
    select 1 from platform.domain_release_history
    where normalized_hostname = 'bygg.domain-a.example'
      and previous_tenant_id = '71000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'P37: released custom domain was not tombstoned';
  end if;
end;
$$;

-- 8. Takeover by a different tenant is blocked by release history.
do $$
declare v_blocked boolean := false;
begin
  begin
    perform public.request_custom_domain(
      '71000000-0000-4000-8000-000000000002',
      null,
      'bygg.domain-a.example',
      'bygg.domain-a.example',
      'prj_test'
    );
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'P37: silent cross-tenant domain takeover succeeded'; end if;
end;
$$;

-- 9. Service RPCs are not client APIs.
do $$
begin
  if has_function_privilege('authenticated', 'public.list_tenant_domains(uuid)', 'EXECUTE') then
    raise exception 'P37: authenticated can list control-plane domains';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.activate_custom_domain(uuid,uuid,uuid)',
    'EXECUTE'
  ) then
    raise exception 'P37: authenticated can activate control-plane domains';
  end if;
  if not has_function_privilege('service_role', 'public.list_tenant_domains(uuid)', 'EXECUTE') then
    raise exception 'P37: service_role cannot list tenant domains';
  end if;
end;
$$;

select 'CUSTOM DOMAIN INTEGRATION: GREEN' as result;

rollback;
