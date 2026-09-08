-- Gate B/C: exact tenant runtime/auth resolution and distributed rate limiting.
-- Synthetic rows are always rolled back.

begin;

do $$
begin
  if has_function_privilege('anon', 'public.resolve_tenant_runtime(text,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'anon must not execute resolve_tenant_runtime';
  end if;
  if has_function_privilege('authenticated', 'public.resolve_tenant_runtime(text,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'authenticated must not execute resolve_tenant_runtime';
  end if;
  if not has_function_privilege('service_role', 'public.resolve_tenant_runtime(text,uuid,uuid,text)', 'EXECUTE') then
    raise exception 'service_role must execute resolve_tenant_runtime';
  end if;
  if has_function_privilege('anon', 'public.resolve_tenant_auth_config(text,uuid,text,text)', 'EXECUTE') then
    raise exception 'anon must not execute resolve_tenant_auth_config';
  end if;
  if has_function_privilege('anon', 'public.consume_rate_limit(text,integer,integer)', 'EXECUTE') then
    raise exception 'anon must not execute consume_rate_limit';
  end if;
end
$$;

insert into platform.tenants (
  id, slug, display_name, status, canonical_hostname, auth_configuration_reference
) values
  ('10000000-0000-4000-8000-000000000001', 'matrix-a', 'Matrix A', 'ACTIVE',
   'matrix-a.tryggsignal.se', 'auth/matrix-a/staff'),
  ('10000000-0000-4000-8000-000000000002', 'matrix-b', 'Matrix B', 'ACTIVE',
   'matrix-b.tryggsignal.se', 'auth/matrix-b/staff');

insert into platform.tenant_deployments (
  id, tenant_id, environment, supabase_project_ref, supabase_region, supabase_url,
  publishable_key, privileged_credential_reference, schema_version, status, health_status
) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'TEST', 'matrix-project-a', 'eu-north-1', 'https://matrix-project-a.supabase.co',
   'sb_publishable_matrix_a', 'tenant/matrix-a/service', 'test-v1', 'ACTIVE', 'HEALTHY'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'TEST', 'matrix-project-b', 'eu-north-1', 'https://matrix-project-b.supabase.co',
   'sb_publishable_matrix_b', 'tenant/matrix-b/service', 'test-v1', 'ACTIVE', 'HEALTHY');

insert into platform.tenant_domains (
  id, tenant_id, hostname, normalized_hostname, domain_type, status,
  is_canonical, is_fallback, ownership_status, dns_status, tls_status
) values
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'matrix-a.tryggsignal.se', 'matrix-a.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   false, true, 'VERIFIED', 'OK', 'ISSUED'),
  ('30000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001',
   'bygg.matrix-a.example', 'bygg.matrix-a.example', 'CUSTOM_DOMAIN', 'ACTIVE',
   true, false, 'VERIFIED', 'OK', 'ISSUED'),
  ('30000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002',
   'matrix-b.tryggsignal.se', 'matrix-b.tryggsignal.se', 'PLATFORM_SUBDOMAIN', 'ACTIVE',
   true, true, 'VERIFIED', 'OK', 'ISSUED');

insert into platform.tenant_auth_configurations (
  id, tenant_id, reference, audience, kind, display_name, environment, enabled
) values
  ('40000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'auth/matrix-a/staff', 'STAFF', 'SUPABASE_PASSWORD', 'Matrix A password', 'TEST', true),
  ('40000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002',
   'auth/matrix-b/staff', 'STAFF', 'SUPABASE_PASSWORD', 'Matrix B password', 'TEST', true);

do $$
declare
  v_count integer;
  v_project text;
  v_auth_tenant uuid;
  v_allowed boolean;
begin
  select count(*), max(supabase_project_ref)
    into v_count, v_project
  from public.resolve_tenant_runtime(
    'matrix-a.tryggsignal.se',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'matrix-project-a'
  );
  if v_count <> 1 or v_project <> 'matrix-project-a' then
    raise exception 'A fallback host did not resolve to project A';
  end if;

  select count(*), max(supabase_project_ref)
    into v_count, v_project
  from public.resolve_tenant_runtime(
    'bygg.matrix-a.example',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'matrix-project-a'
  );
  if v_count <> 1 or v_project <> 'matrix-project-a' then
    raise exception 'A custom host did not resolve to project A';
  end if;

  select count(*) into v_count
  from public.resolve_tenant_runtime(
    'matrix-a.tryggsignal.se',
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'matrix-project-b'
  );
  if v_count <> 0 then
    raise exception 'A host + B context crossed tenant boundary';
  end if;

  select count(*) into v_count
  from public.resolve_tenant_runtime(
    'matrix-a.tryggsignal.se',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'matrix-project-b'
  );
  if v_count <> 0 then
    raise exception 'manipulated data-plane reference was accepted';
  end if;

  select count(*) into v_count
  from public.resolve_tenant_runtime(
    'matrix-b.tryggsignal.se',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'matrix-project-a'
  );
  if v_count <> 0 then
    raise exception 'B host resolved to A project';
  end if;

  select tenant_id into v_auth_tenant
  from public.resolve_tenant_auth_config(
    'matrix-a.tryggsignal.se',
    '10000000-0000-4000-8000-000000000001',
    'auth/matrix-a/staff',
    'STAFF'
  );
  if v_auth_tenant <> '10000000-0000-4000-8000-000000000001' then
    raise exception 'A auth configuration did not resolve to tenant A';
  end if;

  select count(*) into v_count
  from public.resolve_tenant_auth_config(
    'matrix-a.tryggsignal.se',
    '10000000-0000-4000-8000-000000000002',
    'auth/matrix-b/staff',
    'STAFF'
  );
  if v_count <> 0 then
    raise exception 'A host resolved B auth configuration';
  end if;

  select allowed into v_allowed
  from public.consume_rate_limit('matrix:auth:subject-0123456789abcdef', 60, 2);
  if not v_allowed then raise exception 'rate limit attempt 1 should be allowed'; end if;
  select allowed into v_allowed
  from public.consume_rate_limit('matrix:auth:subject-0123456789abcdef', 60, 2);
  if not v_allowed then raise exception 'rate limit attempt 2 should be allowed'; end if;
  select allowed into v_allowed
  from public.consume_rate_limit('matrix:auth:subject-0123456789abcdef', 60, 2);
  if v_allowed then raise exception 'rate limit attempt 3 should be denied'; end if;
end
$$;

rollback;
