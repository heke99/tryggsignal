-- Tryggsignal operational db:status RPC.
-- Read-only and service-role-only. It exposes health metadata, never tenant case
-- data, secrets or credential references.

create or replace function public.tryggsignal_db_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with
  latest_migration as (
    select version, name
    from supabase_migrations.schema_migrations
    order by version desc
    limit 1
  ),
  deployment_counts as (
    select status::text as status, count(*)::integer as count
    from platform.tenant_deployments
    group by status
  ),
  rls_gap as (
    select count(*)::integer as count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname = any(array[
        'identity','authz','core','property','documents','workflow','rules',
        'search','integration','migration','communication','referral','decision',
        'inspection','compliance','ai','archive','reporting','config','platform'
      ])
      and not c.relrowsecurity
  )
  select jsonb_build_object(
    'ok', true,
    'checked_at', clock_timestamp(),
    'latest_migration', (
      select jsonb_build_object('version', version, 'name', name)
      from latest_migration
    ),
    'tenant_count', (select count(*) from platform.tenants),
    'tenant_deployments', coalesce(
      (select jsonb_object_agg(status, count) from deployment_counts),
      '{}'::jsonb
    ),
    'schema_versions', coalesce(
      (select jsonb_agg(distinct schema_version order by schema_version)
       from platform.tenant_deployments),
      '[]'::jsonb
    ),
    'queues', jsonb_build_object(
      'document_processing', to_regclass('pgmq.q_document_processing') is not null,
      'search_indexing', to_regclass('pgmq.q_search_indexing') is not null,
      'ai_analysis', to_regclass('pgmq.q_ai_analysis') is not null,
      'integration_inbound', to_regclass('pgmq.q_integration_inbound') is not null,
      'integration_outbound', to_regclass('pgmq.q_integration_outbound') is not null,
      'notifications', to_regclass('pgmq.q_notifications') is not null,
      'migration', to_regclass('pgmq.q_migration') is not null,
      'archive_generation', to_regclass('pgmq.q_archive_generation') is not null,
      'report_generation', to_regclass('pgmq.q_report_generation') is not null,
      'reference_data_sync', to_regclass('pgmq.q_reference_data_sync') is not null
    ),
    'required_rpcs', jsonb_build_object(
      'resolve_tenant_host', to_regprocedure('public.resolve_tenant_host(text)') is not null,
      'resolve_tenant_runtime', to_regprocedure('public.resolve_tenant_runtime(text,uuid,uuid,text)') is not null,
      'resolve_tenant_auth_config', to_regprocedure('public.resolve_tenant_auth_config(text,uuid,text,text)') is not null,
      'consume_rate_limit', to_regprocedure('public.consume_rate_limit(text,integer,integer)') is not null
    ),
    'rls_unprotected_tables', (select count from rls_gap),
    'advisor_readiness', 'RUN_SUPABASE_SECURITY_AND_PERFORMANCE_ADVISORS_EXTERNALLY'
  );
$$;

comment on function public.tryggsignal_db_status() is
  'Server-only read-only readiness summary used by scripts/db-status.mjs.';

revoke all on function public.tryggsignal_db_status() from public;
revoke all on function public.tryggsignal_db_status() from anon;
revoke all on function public.tryggsignal_db_status() from authenticated;
grant execute on function public.tryggsignal_db_status() to service_role;
