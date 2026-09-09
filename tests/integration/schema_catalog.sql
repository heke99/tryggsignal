-- Cross-module structural gate. Only catalogs are read; no production values
-- or function bodies are logged. Index/scope candidates require review and
-- measurement, not indiscriminate index creation or automatic tenant repair.
begin;
create temporary view reviewed_tables as
select c.oid,c.relname,c.relnamespace,c.relrowsecurity,n.nspname
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where c.relkind in ('r','p') and n.nspname in (
  'platform','organization','identity','authz','core','property','documents',
  'workflow','rules','communication','referral','decision','inspection','compliance',
  'integration','migration','search','ai','audit','archive','reporting','config','public'
) and not exists (
  select 1 from pg_depend d where d.classid='pg_class'::regclass
    and d.objid=c.oid and d.deptype='e'
);

do $catalog$
declare missing text;
begin
  if not exists(select 1 from reviewed_tables) then
    raise exception 'Schema catalog is empty; a missing replay is not a passing audit';
  end if;
  select string_agg(t.oid::regclass::text,', ' order by t.oid::regclass::text) into missing
  from reviewed_tables t where not t.relrowsecurity or not exists (
    select 1 from pg_constraint p where p.conrelid=t.oid and p.contype='p'
  );
  if missing is not null then raise exception 'Project table PK/RLS contract failed: %',missing; end if;

  select string_agg(f.conrelid::regclass::text || '.' || f.conname,', ') into missing
  from pg_constraint f join reviewed_tables t on t.oid=f.conrelid
  where f.contype in ('f','c') and not f.convalidated;
  if missing is not null then raise exception 'Unvalidated integrity constraints: %',missing; end if;

  select string_agg(i.indexrelid::regclass::text,', ') into missing
  from pg_index i join reviewed_tables t on t.oid=i.indrelid
  where not i.indisvalid or not i.indisready;
  if missing is not null then raise exception 'Invalid/unready project indexes: %',missing; end if;

  select string_agg(p.oid::regprocedure::text,', ') into missing
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where p.prosecdef and n.nspname in (select distinct nspname from reviewed_tables)
    and not coalesce('search_path=""'=any(p.proconfig),false)
    and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass
      and d.objid=p.oid and d.deptype='e');
  if missing is not null then raise exception 'Unpinned privileged RPC search_path: %',missing; end if;
end;
$catalog$;

select nspname,count(*) as tables,
  count(*) filter(where relrowsecurity) as rls_enabled
from reviewed_tables group by nspname order by nspname;

-- This exact predicate excludes partial, invalid, expression-only and
-- non-btree indexes as universal FK-equality coverage. A partial index may
-- still be appropriate for a measured application query, but not every FK row.
select 'FK_INDEX_REVIEW' as category,f.conrelid::regclass::text as relation,
  f.conname,pg_get_constraintdef(f.oid) as definition
from pg_constraint f join reviewed_tables t on t.oid=f.conrelid
where f.contype='f' and not exists (
  select 1 from pg_index i join pg_class ix on ix.oid=i.indexrelid
    join pg_am am on am.oid=ix.relam
  where i.indrelid=f.conrelid and i.indisvalid and i.indisready and i.indpred is null
    and am.amname='btree' and i.indnkeyatts>=cardinality(f.conkey)
    and f.conkey <@ array(
      select k.attnum from unnest(i.indkey) with ordinality k(attnum,position)
      where k.position<=cardinality(f.conkey)
    )
) order by relation,f.conname;

-- A candidate, not an automatic repair: some relations intentionally refer to
-- shared rules or another receiving authority. Review semantic ownership.
select 'AUTHORITY_SCOPE_REVIEW' as category,f.conrelid::regclass::text as relation,
  f.conname,pg_get_constraintdef(f.oid) as definition,
  child.attnotnull as child_scope_required,parent.attnotnull as parent_scope_required
from pg_constraint f join reviewed_tables t on t.oid=f.conrelid
join pg_attribute child on child.attrelid=f.conrelid and child.attname='authority_id'
  and child.attnum>0 and not child.attisdropped
join pg_attribute parent on parent.attrelid=f.confrelid and parent.attname='authority_id'
  and parent.attnum>0 and not parent.attisdropped
where f.contype='f' and not child.attnum=any(f.conkey) and not exists (
  select 1 from pg_constraint scoped where scoped.conrelid=f.conrelid
    and scoped.confrelid=f.confrelid and scoped.contype='f' and scoped.convalidated
    and child.attnum=any(scoped.conkey) and parent.attnum=any(scoped.confkey)
    and f.conkey <@ scoped.conkey and f.confkey <@ scoped.confkey
) order by relation,f.conname;

-- Logical/polymorphic identifiers must be documented, not blindly constrained
-- to the wrong entity. This inventory makes previously hidden ID columns visible.
select 'LOGICAL_ID_REVIEW' as category,t.oid::regclass::text as relation,
  a.attname as column_name,format_type(a.atttypid,a.atttypmod) as data_type
from reviewed_tables t join pg_attribute a on a.attrelid=t.oid
where a.attnum>0 and not a.attisdropped and a.attname like '%\_id' escape '\'
  and not exists (select 1 from pg_constraint f where f.conrelid=t.oid
    and f.contype in ('p','f') and a.attnum=any(f.conkey))
order by relation,column_name;

select 'SCHEMA_CATALOG_BASELINE_PASS: PK/RLS/validated constraints/valid indexes/pinned RPCs; review inventories are not production certification' as result;
rollback;
