-- Exact H schema contract. Run AFTER clean Supabase replay with ON_ERROR_STOP=1.
-- Complements integration_consistency.sql; does not replace its behavior tests.
-- Pure catalog reads. No application rows, grants, functions or schemas changed.
begin read only;
set local statement_timeout = '15s';
set local lock_timeout = '1s';

do $catalog_contract$
declare
  v_name text;
  v_relation oid;
  v_proc oid;
  v_missing text;
begin
  -- A missing table must fail, not disappear from a pg_class-based assertion.
  foreach v_name in array array[
    'data_sources', 'connectors', 'connector_instances', 'field_ownership',
    'external_records', 'sync_jobs', 'integration_events', 'sync_checkpoints',
    'reconciliation_runs'
  ] loop
    v_relation := pg_catalog.to_regclass('integration.' || v_name);
    if v_relation is null or not exists (
      select 1 from pg_catalog.pg_class c
      where c.oid = v_relation and c.relkind in ('r', 'p') and c.relrowsecurity
        and exists (select 1 from pg_catalog.pg_constraint p
                    where p.conrelid = c.oid and p.contype = 'p')
    ) then
      raise exception 'Required integration table, PK or RLS missing: %', v_name;
    end if;
  end loop;

  -- Check the actual column pairing, not just "some two-column FK".
  foreach v_name in array array[
    'external_records', 'sync_jobs', 'integration_events', 'reconciliation_runs'
  ] loop
    v_relation := pg_catalog.to_regclass('integration.' || v_name);
    if not exists (
      select 1 from pg_catalog.pg_constraint f
      where f.conrelid = v_relation and f.contype = 'f' and f.convalidated
        and f.confrelid = pg_catalog.to_regclass('integration.connector_instances')
        and f.confdeltype::text = case
          when v_name = 'reconciliation_runs' then 'r' else 'c' end
        and array(
          select a.attname::text
          from pg_catalog.unnest(f.conkey) with ordinality k(attnum, position)
          join pg_catalog.pg_attribute a on a.attrelid = f.conrelid and a.attnum = k.attnum
          order by k.position
        ) = array['connector_instance_id', 'authority_id']
        and array(
          select a.attname::text
          from pg_catalog.unnest(f.confkey) with ordinality k(attnum, position)
          join pg_catalog.pg_attribute a on a.attrelid = f.confrelid and a.attnum = k.attnum
          order by k.position
        ) = array['id', 'authority_id']
    ) then
      raise exception 'Exact connector/authority FK contract missing: integration.%', v_name;
    end if;
    if exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = v_relation and a.attname in ('connector_instance_id', 'authority_id')
        and not a.attnotnull and not a.attisdropped
    ) then
      raise exception 'Scope columns must not be nullable: integration.%', v_name;
    end if;
  end loop;

  -- Signature lookup prevents a dropped/renamed RPC from passing a zero-row test.
  foreach v_name in array array[
    'integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)',
    'integration.record_reconciliation(uuid,integer,integer,integer,integer,integer,integer,integer,integer,jsonb)',
    'audit.record_service(text,text,uuid,uuid,text,text,uuid,text,text)'
  ] loop
    v_proc := pg_catalog.to_regprocedure(v_name);
    if v_proc is null then
      raise exception 'Required exact RPC signature missing: %', v_name;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_proc p
      where p.oid = v_proc and p.prosecdef
        and 'search_path=""' = any(coalesce(p.proconfig, array[]::text[]))
    ) then
      raise exception 'RPC security-definer/search-path contract missing: %', v_name;
    end if;
    if pg_catalog.has_function_privilege('anon', v_proc, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_proc, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_proc, 'EXECUTE') then
      raise exception 'RPC effective service-only grants are incorrect: %', v_name;
    end if;
  end loop;

  -- INCLUDE attributes are not searchable keys; partial indexes do not support
  -- every FK lookup. This is a structural check, not a query-plan/SLO claim.
  select pg_catalog.string_agg(f.conrelid::regclass::text || '.' || f.conname, ', ')
  into v_missing
  from pg_catalog.pg_constraint f
  join pg_catalog.pg_namespace n on n.oid = f.connamespace
  where n.nspname = 'integration' and f.contype = 'f'
    and not exists (
      select 1 from pg_catalog.pg_index i
      join pg_catalog.pg_class index_class on index_class.oid = i.indexrelid
      join pg_catalog.pg_am am on am.oid = index_class.relam
      where i.indrelid = f.conrelid and am.amname = 'btree'
        and i.indisvalid and i.indisready and i.indislive and i.indpred is null
        and i.indnkeyatts >= pg_catalog.cardinality(f.conkey)
        and f.conkey <@ array(
          select k.attnum from pg_catalog.unnest(i.indkey) with ordinality k(attnum, position)
          where k.position <= pg_catalog.cardinality(f.conkey)
        )
    );
  if v_missing is not null then
    raise exception 'Integration FK lacks full live B-tree key-prefix support: %', v_missing;
  end if;
end;
$catalog_contract$;

select 'H exact catalog contract passed (not a production readiness certificate)' as result;
rollback;
