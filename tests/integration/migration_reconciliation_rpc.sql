-- Real PostgreSQL contract; entirely synthetic fixtures and rolled back.
begin;
create temporary table mr_ids (key text primary key, id uuid not null) on commit drop;
grant select on mr_ids to service_role;
create function pg_temp.mr_reject(p_sql text, p_state text) returns void language plpgsql as $test$
begin
  begin execute p_sql;
  exception when others then if sqlstate = p_state then return; end if; raise; end;
  raise exception 'Expected SQLSTATE %, statement succeeded', p_state;
end;
$test$;
with e as (
  insert into organization.legal_entities(name,organization_number)
  values ('Reconciliation RPC fixture','212000-5678') returning id
), a as (
  insert into organization.authorities(legal_entity_id,key,name)
  select e.id,x.key,x.key from e cross join (values ('mr_a'),('mr_b')) x(key) returning id,key
) insert into mr_ids select key,id from a;
with s as (
  insert into migration.sources(authority_id,key,system_name,export_format)
  select id,'rpc','SYNTHETIC','JSON' from mr_ids where key='mr_a' returning id
), b as (
  insert into migration.batches(source_id,authority_id,batch_number)
  select s.id,a.id,1 from s cross join mr_ids a where a.key='mr_a' returning id
) insert into mr_ids select 'batch',id from b;

do $catalog$
declare p oid := to_regprocedure('migration.record_reconciliation(uuid,uuid,jsonb,jsonb)');
begin
  if p is null or not exists(select 1 from pg_proc where oid=p and not prosecdef and 'search_path=""'=any(proconfig)) then
    raise exception 'Reconciliation RPC is missing or violates the invoker/search_path contract';
  end if;
  if has_function_privilege('anon',p,'EXECUTE') or has_function_privilege('authenticated',p,'EXECUTE')
    or not has_function_privilege('service_role',p,'EXECUTE') then
    raise exception 'Reconciliation RPC must remain service-only';
  end if;
  if has_column_privilege('authenticated','migration.reconciliation_runs','detail','SELECT')
     or has_column_privilege('anon','migration.reconciliation_runs','detail','SELECT')
     or not has_column_privilege('authenticated','migration.reconciliation_runs','result','SELECT') then
    raise exception 'Reconciliation browser metadata/detail boundary is inconsistent';
  end if;
end;
$catalog$;
set local role service_role;
do $rpc$
declare
  b uuid := (select id from mr_ids where key='batch');
  a uuid := (select id from mr_ids where key='mr_a');
  wrong_a uuid := (select id from mr_ids where key='mr_b');
  c jsonb := '{"source_case_count":2,"target_case_count":2,"source_document_count":3,"target_document_count":3,"missing_count":0,"duplicate_count":0,"hash_mismatch_count":0,"broken_relation_count":0,"unmapped_status_count":0,"unmapped_classification_count":0,"orphan_document_count":0}';
  r record;
  v jsonb;
  k text;
begin
  select * into strict r from migration.record_reconciliation(b,a,c);
  if r.result <> 'GREEN' or not exists (
    select 1 from migration.reconciliation_runs where id=r.reconciliation_id and authority_id=a
  ) then raise exception 'Valid scoped reconciliation was not persisted'; end if;
  select * into strict r from migration.record_reconciliation(b,a,c || '{"missing_count":1}');
  if r.result <> 'RED' then raise exception 'RPC incorrectly accepted missing records as GREEN'; end if;
  foreach k in array array['missing_count','duplicate_count','hash_mismatch_count','broken_relation_count','unmapped_status_count','unmapped_classification_count','orphan_document_count'] loop
    select * into strict r from migration.record_reconciliation(b,a,c || jsonb_build_object(k,1));
    if r.result <> 'RED' then raise exception 'RPC ignored defect counter %',k; end if;
  end loop;
  foreach v in array array['-1'::jsonb,'1.5'::jsonb,'2147483648'::jsonb,'"2"'::jsonb,'null'::jsonb] loop
    perform pg_temp.mr_reject(format('select * from migration.record_reconciliation(%L,%L,%L::jsonb)',b,a,c || jsonb_build_object('missing_count',v)),'22023');
  end loop;
  perform pg_temp.mr_reject(format('select * from migration.record_reconciliation(%L,%L,%L::jsonb)',b,wrong_a,c),'22023');
  perform pg_temp.mr_reject(format('select * from migration.record_reconciliation(%L,%L,%L::jsonb)',b,a,c - 'missing_count'),'22023');
  perform pg_temp.mr_reject(format('select * from migration.record_reconciliation(%L,%L,%L::jsonb)',b,a,c || '{"result":"GREEN"}'),'22023');
  perform pg_temp.mr_reject(format('select * from migration.record_reconciliation(%L,%L,%L::jsonb,''[]''::jsonb)',b,a,c),'22023');
end;
$rpc$;
reset role;
select 'Migration reconciliation RPC: real service invocation, counter parity, scope, grants and invalid-input rejection passed' as result;
rollback;
