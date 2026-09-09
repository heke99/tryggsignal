-- Tryggsignal catalog-only inventory, PostgreSQL 15+.
-- Run separately for the VERIFIED control/data plane being reviewed.
-- Does not scan case/document/customer rows. No CREATE/ALTER/DROP/UPDATE/DELETE.
-- Results are diagnostics, NOT automatic index-drop/create recommendations.
-- A zero-row diagnostic is not proof of complete RLS, integrity or performance.
-- Save output with the project reference, migration ledger and deployed commit.
begin read only;
set local statement_timeout = '15s';
set local lock_timeout = '1s';
set local search_path = pg_catalog;
set local tryggsignal.audit_schemas =
  'organization,identity,authz,core,property,documents,workflow,rules,communication,referral,decision,inspection,compliance,integration,migration,search,ai,audit,archive,reporting,config,platform';

select current_database() as database_name, current_user as reviewed_as,
       current_setting('server_version') as postgres_version,
       current_setting('transaction_read_only') as read_only,
       transaction_timestamp() as captured_at;

-- 1. Report existing AND absent requested schemas (absence can be intentional).
select requested.schema_name, n.oid is not null as schema_present,
       count(c.oid) as base_table_count
from unnest(string_to_array(current_setting('tryggsignal.audit_schemas'), ',')) requested(schema_name)
left join pg_namespace n on n.nspname = requested.schema_name
left join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p')
group by requested.schema_name, n.oid
order by requested.schema_name;

-- 2. Table identity, RLS and size. Rows are planner estimates, not live counts.
select n.nspname as schema_name, c.relname as table_name, c.relkind,
       c.reltuples::bigint as estimated_rows,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       pk.conname as primary_key, pg_get_constraintdef(pk.oid) as primary_key_definition,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
       c.relreplident as replica_identity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_constraint pk on pk.conrelid = c.oid and pk.contype = 'p'
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and c.relkind in ('r', 'p')
order by n.nspname, c.relname;

-- 3. Unvalidated foreign keys/checks require an explicit rollout decision.
select n.nspname as schema_name, c.relname as table_name,
       k.conname, k.contype, pg_get_constraintdef(k.oid) as definition
from pg_constraint k
join pg_class c on c.oid = k.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and k.contype in ('f', 'c') and not k.convalidated
order by n.nspname, c.relname, k.conname;

-- 4. Candidate FK indexes. Measure actual equality/read/delete queries before DDL.
-- No INCLUDE-only, partial, invalid, unready or dropping index counts as full support.
select n.nspname as schema_name, c.relname as table_name,
       f.conname, pg_get_constraintdef(f.oid) as foreign_key,
       c.reltuples::bigint as estimated_rows,
       'REVIEW: no full live B-tree prefix; confirm operator class and query plan' as finding
from pg_constraint f
join pg_class c on c.oid = f.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and f.contype = 'f'
  and not exists (
    select 1 from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_am am on am.oid = ic.relam
    where i.indrelid = f.conrelid and am.amname = 'btree'
      and i.indisvalid and i.indisready and i.indislive and i.indpred is null
      and i.indnkeyatts >= cardinality(f.conkey)
      and f.conkey <@ array(
        select k.attnum from unnest(i.indkey) with ordinality k(attnum, position)
        where k.position <= cardinality(f.conkey)
      )
  )
order by n.nspname, c.relname, f.conname;

-- 5. Exact FK column pairing and types: inspect authority/tenant scope here.
-- Compatible-but-different types are review candidates, not automatically errors.
select n.nspname as schema_name, c.relname as table_name, f.conname,
       source.attname as source_column, format_type(source.atttypid, source.atttypmod) as source_type,
       source.attnotnull as source_not_null,
       parent_ns.nspname as target_schema, parent.relname as target_table,
       target.attname as target_column, format_type(target.atttypid, target.atttypmod) as target_type,
       source.atttypid = target.atttypid as identical_type_oid,
       f.confmatchtype as match_type, f.confdeltype as on_delete, f.convalidated
from pg_constraint f
join pg_class c on c.oid = f.conrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_class parent on parent.oid = f.confrelid
join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
cross join lateral unnest(f.conkey, f.confkey) with ordinality k(source_num, target_num, position)
join pg_attribute source on source.attrelid = f.conrelid and source.attnum = k.source_num
join pg_attribute target on target.attrelid = f.confrelid and target.attnum = k.target_num
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and f.contype = 'f'
order by n.nspname, c.relname, f.conname, k.position;

-- 6. *_id columns without local PK or FK. Provenance/polymorphic IDs can be valid.
-- Do NOT invent a target table or blindly convert external IDs to UUIDs.
select n.nspname as schema_name, c.relname as table_name, a.attname as column_name,
       format_type(a.atttypid, a.atttypmod) as column_type, a.attnotnull,
       'REVIEW: reference ownership or polymorphic validation must be documented' as finding
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
  and right(a.attname, 3) = '_id'
  and not exists (
    select 1 from pg_constraint k
    where k.conrelid = c.oid and k.contype in ('f', 'p') and a.attnum = any(k.conkey)
  )
order by n.nspname, c.relname, a.attname;

-- 7. Structurally matching index pairs. No automatic removal: constraints,
-- replica identity, operator classes, usage and production queries still matter.
select n.nspname as schema_name, t.relname as table_name,
       a.indexrelid::regclass as first_index, b.indexrelid::regclass as second_index,
       a.indisprimary or a.indisexclusion or a.indisreplident
         or exists (select 1 from pg_constraint k where k.conindid = a.indexrelid)
         as first_protected_role,
       b.indisprimary or b.indisexclusion or b.indisreplident
         or exists (select 1 from pg_constraint k where k.conindid = b.indexrelid)
         as second_protected_role,
       pg_get_indexdef(a.indexrelid) as first_definition,
       pg_get_indexdef(b.indexrelid) as second_definition
from pg_index a
join pg_index b on b.indrelid = a.indrelid and b.indexrelid > a.indexrelid
join pg_class t on t.oid = a.indrelid
join pg_namespace n on n.oid = t.relnamespace
join pg_class ac on ac.oid = a.indexrelid
join pg_class bc on bc.oid = b.indexrelid
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and ac.relam = bc.relam and a.indkey = b.indkey
  and a.indclass = b.indclass and a.indcollation = b.indcollation and a.indoption = b.indoption
  and a.indnkeyatts = b.indnkeyatts and a.indnatts = b.indnatts
  and a.indisunique = b.indisunique and a.indnullsnotdistinct = b.indnullsnotdistinct
  and a.indimmediate = b.indimmediate
  and a.indexprs::text is not distinct from b.indexprs::text
  and a.indpred::text is not distinct from b.indpred::text
  and a.indisvalid and b.indisvalid and a.indisready and b.indisready
  and a.indislive and b.indislive
order by n.nspname, t.relname, a.indexrelid;

-- 8. Invalid index state and usage. Low/zero usage alone is NOT a drop criterion.
select n.nspname as schema_name, t.relname as table_name, ic.relname as index_name,
       i.indisvalid, i.indisready, i.indislive, i.indisprimary, i.indisunique,
       s.idx_scan, s.idx_tup_read, s.idx_tup_fetch,
       pg_size_pretty(pg_relation_size(i.indexrelid)) as index_size
from pg_index i
join pg_class t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
join pg_class ic on ic.oid = i.indexrelid
left join pg_stat_user_indexes s on s.indexrelid = i.indexrelid
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
order by n.nspname, t.relname, ic.relname;

-- 9. Definer RPC inventory. Authorization is contract-specific, not inferred
-- from naming. Effective grants include PUBLIC inheritance.
select n.nspname as schema_name, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as signature, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = any(string_to_array(current_setting('tryggsignal.audit_schemas'), ','))
  and p.prosecdef
order by n.nspname, p.proname, p.oid;

rollback;
