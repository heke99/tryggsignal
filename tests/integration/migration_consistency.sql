-- Disposable own fixtures only. Roll back everything, including planner data.
begin;
create temporary table mi_ids (key text primary key, id uuid not null) on commit drop;
create function pg_temp.mi_reject(p_sql text, p_state text) returns void language plpgsql as $test$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then return; end if;
    raise;
  end;
  raise exception 'Expected SQLSTATE %, statement succeeded', p_state;
end;
$test$;

with e as (
  insert into organization.legal_entities (name,organization_number)
  values ('Migration consistency fixture','212000-1234') returning id
), a as (
  insert into organization.authorities (legal_entity_id,key,name)
  select e.id,x.key,x.key from e cross join (values ('mi_a'),('mi_b')) x(key) returning id,key
)
insert into mi_ids select key,id from a;
with s as (
  insert into migration.sources(authority_id,key,system_name,export_format)
  select id,'mi_source','SYNTHETIC','JSON' from mi_ids where key='mi_a' returning id
)
insert into mi_ids select 'source',id from s;
with b as (
  insert into migration.batches(source_id,authority_id,batch_number)
  select s.id,a.id,n from mi_ids s cross join mi_ids a cross join generate_series(1,2) n
  where s.key='source' and a.key='mi_a' returning id,batch_number
)
insert into mi_ids select 'batch_' || batch_number,id from b;
with o as (
  insert into migration.objects(batch_id,authority_id,source_system,source_object,
    source_primary_key,raw_payload,source_hash,source_hash_version)
  select b.id,a.id,'SYNTHETIC','case','case-1','{"title":"Original"}',repeat('a',64),'canonical-json-v1'
  from mi_ids b cross join mi_ids a where b.key='batch_1' and a.key='mi_a' returning id
)
insert into mi_ids select 'object',id from o;

do $scope$
declare
  a uuid := (select id from mi_ids where key='mi_a');
  wrong_a uuid := (select id from mi_ids where key='mi_b');
  s uuid := (select id from mi_ids where key='source');
  b uuid := (select id from mi_ids where key='batch_1');
  wrong_b uuid := (select id from mi_ids where key='batch_2');
  o uuid := (select id from mi_ids where key='object');
begin
  perform pg_temp.mi_reject(format(
    'insert into migration.batches(source_id,authority_id,batch_number) values (%L,%L,3)',s,wrong_a),'23503');
  perform pg_temp.mi_reject(format(
    'insert into migration.objects(batch_id,authority_id,source_system,source_object,source_primary_key,raw_payload,source_hash) values (%L,%L,''TEST'',''case'',''bad'',''{}'',%L)',
    b,wrong_a,repeat('b',64)),'23503');
  perform pg_temp.mi_reject(format(
    'insert into migration.errors(batch_id,object_id,authority_id,stage,error_code,message) values (%L,%L,%L,''MAP'',''TEST'',''Wrong batch'')',wrong_b,o,a),'23503');
  perform pg_temp.mi_reject(format(
    'insert into migration.errors(batch_id,authority_id,stage,error_code,message) values (%L,%L,''MAP'',''TEST'',''Wrong authority'')',b,wrong_a),'23503');
  perform pg_temp.mi_reject(format(
    'insert into migration.reconciliation_runs(batch_id,authority_id,result) values (%L,%L,''GREEN'')',b,wrong_a),'23503');

  -- Positive controls: null object_id is a valid batch-level error, scoped
  -- object errors remain valid and do not require weakening MATCH semantics.
  insert into migration.errors(batch_id,object_id,authority_id,stage,error_code,message)
  values (b,null,a,'MAP','BATCH','Batch error'),(b,o,a,'MAP','OBJECT','Object error');

  perform pg_temp.mi_reject(format(
    'update migration.objects set raw_payload=''{}'' where id=%L',o),'23514');
  perform pg_temp.mi_reject(format(
    'update migration.objects set source_hash=%L where id=%L',repeat('b',64),o),'23514');
  perform pg_temp.mi_reject(format(
    'update migration.objects set source_hash_version=''json-stringify-v1'' where id=%L',o),'23514');
  perform pg_temp.mi_reject(format(
    'update migration.objects set batch_id=%L where id=%L',wrong_b,o),'23514');
  update migration.objects set stage='MAP' where id=o;
  if not exists(select 1 from migration.objects where id=o and raw_payload='{"title":"Original"}'::jsonb) then
    raise exception 'Advancing the stage changed raw evidence';
  end if;

  perform pg_temp.mi_reject(format(
    'insert into migration.reconciliation_runs(batch_id,authority_id,source_case_count,target_case_count,result) values (%L,%L,2,1,''GREEN'')',b,a),'23514');
  perform pg_temp.mi_reject(format(
    'insert into migration.reconciliation_runs(batch_id,authority_id,missing_count,result) values (%L,%L,-1,''RED'')',b,a),'23514');
  perform pg_temp.mi_reject(format(
    'insert into migration.reconciliation_runs(batch_id,authority_id,orphan_document_count,result) values (%L,%L,1,''GREEN'')',b,a),'23514');
  insert into migration.reconciliation_runs(batch_id,authority_id,source_case_count,target_case_count,result)
  values (b,a,2,1,'RED'),(b,a,2,2,'GREEN');

  if has_table_privilege('authenticated','migration.objects','SELECT')
     or has_column_privilege('authenticated','migration.errors','message','SELECT')
     or has_column_privilege('authenticated','migration.errors','detail','SELECT')
     or has_column_privilege('anon','migration.errors','message','SELECT') then
    raise exception 'Unclassified raw/error evidence is exposed to a browser role';
  end if;
  if not has_column_privilege('authenticated','migration.errors','error_code','SELECT') then
    raise exception 'Scoped migration error metadata is unavailable';
  end if;
end;
$scope$;

with m as (
  insert into migration.mappings(source_id,key,entity_type)
  select id,'case','case' from mi_ids where key='source' returning id
), v as (
  insert into migration.mapping_versions(mapping_id,version,definition)
  select id,1,'{"rules":[]}' from m returning id
)
insert into mi_ids select 'mapping_version',id from v;
select pg_temp.mi_reject(format(
  'update migration.mapping_versions set definition=''{}'' where id=%L',
  (select id from mi_ids where key='mapping_version')),'23514');

-- Recorded query plans, no force-index flags and no fabricated p95 claims.
insert into migration.objects(batch_id,authority_id,source_system,source_object,
  source_primary_key,raw_payload,source_hash)
select b.id,a.id,'SYNTHETIC','case','plan-' || n,'{}',repeat('c',64)
from mi_ids b cross join mi_ids a cross join generate_series(1,2000) n
where b.key='batch_1' and a.key='mi_a';
analyze migration.objects;
explain (analyze,buffers)
select id,source_primary_key from migration.objects
where batch_id=(select id from mi_ids where key='batch_1')
  and authority_id=(select id from mi_ids where key='mi_a')
  and source_object='case' order by source_primary_key limit 20;

select 'I foundation: authority/batch/object integrity, immutable evidence and truthful counters passed' as result;
rollback;
