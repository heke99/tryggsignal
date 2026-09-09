-- H consistency gate: validates catalog contracts and adversarial own-fixture
-- inputs, never production data. Existing positive H/G gates remain unchanged.
begin;
create temporary table hq_ids (key text primary key, id uuid not null) on commit drop;
grant select on hq_ids to service_role;

create function pg_temp.hq_reject(p_statement text, p_state text) returns void
language plpgsql as $test$
begin
  begin
    execute p_statement;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE %, but command succeeded', p_state;
end;
$test$;

-- Every integration table must have a primary key, RLS and usable FK indexes.
do $catalog$
declare v_missing text;
begin
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'integration' and c.relkind in ('r','p')
    and (not c.relrowsecurity or not exists (
      select 1 from pg_constraint p where p.conrelid = c.oid and p.contype = 'p'
    ));
  if v_missing is not null then raise exception 'Integration PK/RLS missing: %', v_missing; end if;

  select string_agg(f.conrelid::regclass::text || '.' || f.conname, ', ') into v_missing
  from pg_constraint f join pg_namespace n on n.oid = f.connamespace
  where n.nspname = 'integration' and f.contype = 'f' and not exists (
    select 1 from pg_index i
    where i.indrelid = f.conrelid and i.indisvalid and i.indisready and i.indpred is null
      and i.indnkeyatts >= cardinality(f.conkey)
      and f.conkey <@ array(
        select k.attnum from unnest(i.indkey) with ordinality k(attnum, position)
        where k.position <= cardinality(f.conkey)
      )
  );
  if v_missing is not null then raise exception 'Integration FK index missing: %', v_missing; end if;

  select string_agg(c.relname, ', ') into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'integration' and c.relname in (
    'external_records','sync_jobs','integration_events','reconciliation_runs'
  ) and not exists (
    select 1 from pg_constraint f where f.conrelid = c.oid and f.contype = 'f'
      and f.confrelid = 'integration.connector_instances'::regclass
      and cardinality(f.conkey) = 2 and f.convalidated
  );
  if v_missing is not null then raise exception 'Connector/authority FK missing: %', v_missing; end if;

  if has_column_privilege('authenticated','integration.integration_events','payload','SELECT')
     or has_column_privilege('authenticated','integration.integration_events','error','SELECT')
     or has_table_privilege('authenticated','integration.external_records','SELECT') then
    raise exception 'Browser roles can access raw integration payload/error data';
  end if;
  if not has_column_privilege('authenticated','integration.integration_events','status','SELECT') then
    raise exception 'Scoped event metadata is not readable';
  end if;

  select string_agg(p.oid::regprocedure::text, ', ') into v_missing
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname, p.proname) in (
    ('integration','receive_inbound_event'),('integration','record_reconciliation'),('audit','record_service')
  ) and (
    not p.prosecdef or not coalesce('search_path=""' = any(p.proconfig), false)
    or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    or has_function_privilege('anon', p.oid, 'EXECUTE')
    or not has_function_privilege('service_role', p.oid, 'EXECUTE')
  );
  if v_missing is not null then raise exception 'Privileged RPC contract failed: %', v_missing; end if;
end;
$catalog$;

with e as (
  insert into organization.legal_entities (name,organization_number)
  values ('H consistency fixtures','212000-1226') returning id
), a as (
  insert into organization.authorities (legal_entity_id,key,name)
  select e.id, x.key, x.key from e cross join (values ('hq_a'),('hq_b')) x(key)
  returning id,key
)
insert into hq_ids select key,id from a;
with c as (
  insert into integration.connector_instances (connector_id,authority_id,name,direction,status)
  select c.id,a.id,'HQ receiver','INBOUND','ENABLED'
  from integration.connectors c cross join hq_ids a
  where c.key='generic-webhook' and a.key='hq_a' returning id
)
insert into hq_ids select 'instance',id from c;

-- All four denormalized tables reject a valid but wrong authority, even as owner.
do $scope$
declare
  v_instance uuid := (select id from hq_ids where key='instance');
  v_authority uuid := (select id from hq_ids where key='hq_b');
begin
  perform pg_temp.hq_reject(format(
    'insert into integration.external_records(connector_instance_id,authority_id,entity_type,external_id) values (%L,%L,''CASE'',''mismatch'')',
    v_instance,v_authority),'23503');
  perform pg_temp.hq_reject(format(
    'insert into integration.sync_jobs(connector_instance_id,authority_id,job_type,direction,idempotency_key) values (%L,%L,''test'',''INBOUND'',''mismatch'')',
    v_instance,v_authority),'23503');
  perform pg_temp.hq_reject(format(
    'insert into integration.integration_events(connector_instance_id,authority_id,event_type,idempotency_key,payload) values (%L,%L,''test'',''mismatch'',''{}'')',
    v_instance,v_authority),'23503');
  perform pg_temp.hq_reject(format(
    'insert into integration.reconciliation_runs(connector_instance_id,authority_id,source_count,tracked_count,unchanged_count,new_count,changed_count,missing_internal_count,missing_source_count,duplicate_source_count,result) values (%L,%L,0,0,0,0,0,0,0,0,''GREEN'')',
    v_instance,v_authority),'23503');
end;
$scope$;

-- Real service_role calls, not owner-only successful RPC tests.
do $receipts$
declare
  v_instance uuid := (select id from hq_ids where key='instance');
  v_first bigint;
  v_second bigint;
  v_duplicate boolean;
begin
  set local role service_role;
  select event_id,duplicate into v_first,v_duplicate from integration.receive_inbound_event(
    v_instance,'hq-event','case.changed',repeat('a',64),'{"id":"hq-event","version":1}',repeat('b',64),'1');
  if v_duplicate then raise exception 'First receipt is incorrectly a duplicate'; end if;
  select event_id,duplicate into v_second,v_duplicate from integration.receive_inbound_event(
    v_instance,'hq-event','case.changed',repeat('a',64),'{"version":1,"id":"hq-event"}',repeat('b',64),'1');
  if not v_duplicate or v_first <> v_second then raise exception 'Identical receipt was not deduplicated'; end if;

  perform pg_temp.hq_reject(format(
    'select * from integration.receive_inbound_event(%L,''hq-event'',''case.changed'',%L,''{"id":"hq-event","version":2}'',%L,''1'')',
    v_instance,repeat('a',64),repeat('c',64)),'23505');
  perform pg_temp.hq_reject(format(
    'select * from integration.receive_inbound_event(%L,''hq-event'',''case.changed'',%L,''{"id":"hq-event","version":1}'',%L,''2'')',
    v_instance,repeat('a',64),repeat('b',64)),'23505');
  perform pg_temp.hq_reject(format(
    'select * from integration.receive_inbound_event(%L,''bad-hash'',''case.changed'',%L,''{}'',''not-a-sha256'',''1'')',
    v_instance,repeat('d',64)),'23514');
  perform pg_temp.hq_reject(format(
    'select * from integration.receive_inbound_event(%L,''bad-body'',''case.changed'',%L,''null'',%L,''1'')',
    v_instance,repeat('e',64),repeat('b',64)),'23514');
  reset role;

  if (select count(*) from integration.integration_events where connector_instance_id=v_instance) <> 1
     or not exists (select 1 from integration.integration_events where id=v_first
       and duplicate_count=1 and status='RECEIVED' and processed_at is null
       and payload='{"id":"hq-event","version":1}'::jsonb) then
    raise exception 'Receipt/collision corrupted immutable payload or falsely processed an event';
  end if;
end;
$receipts$;

-- Direct privileged writes must not corrupt immutable receipt evidence.
do $immutability$
declare v_instance uuid := (select id from hq_ids where key='instance');
begin
  perform pg_temp.hq_reject(format(
    'update integration.integration_events set payload=''{}'' where connector_instance_id=%L', v_instance),'23514');
  perform pg_temp.hq_reject(format(
    'update integration.integration_events set mapping_version=''replaced'' where connector_instance_id=%L', v_instance),'23514');
end;
$immutability$;

-- Same validation in RPC and table: no impossible GREEN or negative/subset counts.
do $counts$
declare v_instance uuid := (select id from hq_ids where key='instance');
begin
  set local role service_role;
  perform pg_temp.hq_reject(format(
    'select integration.record_reconciliation(%L,5,1,0,0,0,0,0,0,''{}'')',v_instance),'23514');
  perform pg_temp.hq_reject(format(
    'select integration.record_reconciliation(%L,1,1,1,0,0,2,0,0,''{}'')',v_instance),'23514');
  perform pg_temp.hq_reject(format(
    'select integration.record_reconciliation(%L,1,1,1,0,0,0,0,0,''[]'')',v_instance),'23514');
  perform pg_temp.hq_reject(format(
    'select integration.record_reconciliation(%L,null,1,1,0,0,0,0,0,''{}'')',v_instance),'23514');
  perform integration.record_reconciliation(v_instance,1,1,1,0,0,0,0,0,'{"scope":"full"}');
  reset role;
  perform pg_temp.hq_reject(format(
    'update integration.reconciliation_runs set source_count=20 where connector_instance_id=%L',v_instance),'23514');
  if not exists (select 1 from audit.events where resource_id=v_instance
    and action='integration.reconciliation.completed' and after_hash ~ '^[a-f0-9]{64}$') then
    raise exception 'Reconciliation audit after_hash is not a digest';
  end if;
end;
$counts$;

-- Inbound APIs reject outbound/disabled connectors; no fake recovery of disabled health.
update integration.connector_instances set direction='OUTBOUND'
where id=(select id from hq_ids where key='instance');
do $direction$
declare v_instance uuid := (select id from hq_ids where key='instance');
begin
  set local role service_role;
  perform pg_temp.hq_reject(format(
    'select * from integration.receive_inbound_event(%L,''wrong-direction'',''case.changed'',%L,''{}'',%L,''1'')',
    v_instance,repeat('f',64),repeat('b',64)),'P0002');
  reset role;
end;
$direction$;
update integration.connector_instances set status='DISABLED'
where id=(select id from hq_ids where key='instance');
do $disabled$
declare v_instance uuid := (select id from hq_ids where key='instance');
begin
  set local role service_role;
  perform pg_temp.hq_reject(format(
    'select integration.record_reconciliation(%L,0,0,0,0,0,0,0,0,''{}'')',v_instance),'P0002');
  reset role;
end;
$disabled$;

-- Record the actual planner choice, without forcing an index or fragile timing limits.
insert into integration.integration_events(connector_instance_id,authority_id,event_type,idempotency_key,payload)
select c.id,c.authority_id,'fixture', 'plan-' || g.i, '{}'::jsonb
from integration.connector_instances c cross join generate_series(1,2000) g(i)
where c.id=(select id from hq_ids where key='instance');
analyze integration.integration_events;
explain (analyze, buffers)
select id,status,received_at from integration.integration_events
where connector_instance_id=(select id from hq_ids where key='instance')
  and authority_id=(select id from hq_ids where key='hq_a')
order by received_at desc,id desc limit 20;

select 'H CONSISTENCY: all integration tables / FK indexes / scope / RPC / raw access / reconciliation GREEN' as result;
rollback;
