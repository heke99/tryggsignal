-- Continue phase I without duplicating its existing scope migration.
-- This service-only, private-schema RPC derives authority from the batch and
-- computes the persisted result. The caller cannot assert an unearned GREEN.
set lock_timeout = '5s';

alter table migration.mappings drop constraint mappings_source_id_fkey;
alter table migration.mappings add constraint migration_mappings_source_fk
  foreign key (source_id) references migration.sources(id) on delete restrict;
alter table migration.mapping_versions drop constraint mapping_versions_mapping_id_fkey;
alter table migration.mapping_versions add constraint migration_mapping_versions_mapping_fk
  foreign key (mapping_id) references migration.mappings(id) on delete restrict;

create function migration.record_reconciliation(
  p_batch_id uuid,
  p_authority_id uuid,
  p_counts jsonb,
  p_detail jsonb default '{}'::jsonb
)
returns table (reconciliation_id uuid, result text)
language plpgsql security invoker set search_path = '' as $record$
declare
  v_authority uuid;
  v_key text;
  v_value numeric;
  v_result text;
  v_keys constant text[] := array[
    'source_case_count', 'target_case_count', 'source_document_count', 'target_document_count',
    'missing_count', 'duplicate_count', 'hash_mismatch_count', 'broken_relation_count',
    'unmapped_status_count', 'unmapped_classification_count', 'orphan_document_count'
  ];
begin
  if p_batch_id is null or p_authority_id is null
     or p_counts is null or jsonb_typeof(p_counts) <> 'object'
     or p_detail is null or jsonb_typeof(p_detail) <> 'object' then
    raise exception 'Invalid migration reconciliation envelope' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_counts)) <> cardinality(v_keys) then
    raise exception 'Reconciliation counts must match the exact contract' using errcode = '22023';
  end if;
  foreach v_key in array v_keys loop
    if jsonb_typeof(p_counts -> v_key) is distinct from 'number' then
      raise exception 'Reconciliation count must be a JSON number: %', v_key using errcode = '22023';
    end if;
    v_value := (p_counts ->> v_key)::numeric;
    if v_value < 0 or v_value > 2147483647 or trunc(v_value) <> v_value then
      raise exception 'Reconciliation count outside nonnegative int32 range: %', v_key using errcode = '22023';
    end if;
  end loop;
  select b.authority_id into v_authority from migration.batches b
  where b.id = p_batch_id and b.authority_id = p_authority_id;
  if not found then
    raise exception 'Migration batch not found in the expected authority' using errcode = '22023';
  end if;
  v_result := case when
    (p_counts ->> 'source_case_count')::integer = (p_counts ->> 'target_case_count')::integer
    and (p_counts ->> 'source_document_count')::integer = (p_counts ->> 'target_document_count')::integer
    and not exists (
      select 1 from jsonb_each(p_counts) item
      where item.key not in ('source_case_count','target_case_count','source_document_count','target_document_count')
        and item.value::text::numeric <> 0
    ) then 'GREEN' else 'RED' end;
  return query insert into migration.reconciliation_runs as r (
    batch_id, authority_id, source_case_count, target_case_count,
    source_document_count, target_document_count, missing_count, duplicate_count,
    hash_mismatch_count, broken_relation_count, unmapped_status_count,
    unmapped_classification_count, orphan_document_count, result, detail
  ) values (
    p_batch_id, v_authority,
    (p_counts ->> 'source_case_count')::integer, (p_counts ->> 'target_case_count')::integer,
    (p_counts ->> 'source_document_count')::integer, (p_counts ->> 'target_document_count')::integer,
    (p_counts ->> 'missing_count')::integer, (p_counts ->> 'duplicate_count')::integer,
    (p_counts ->> 'hash_mismatch_count')::integer, (p_counts ->> 'broken_relation_count')::integer,
    (p_counts ->> 'unmapped_status_count')::integer, (p_counts ->> 'unmapped_classification_count')::integer,
    (p_counts ->> 'orphan_document_count')::integer, v_result, p_detail
  ) returning r.id, r.result;
end;
$record$;

revoke all on function migration.record_reconciliation(uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
grant usage on schema migration to service_role;
grant select on migration.batches to service_role;
grant select, insert on migration.reconciliation_runs to service_role;
grant execute on function migration.record_reconciliation(uuid,uuid,jsonb,jsonb) to service_role;

-- Diagnostic detail may contain unclassified source values; browser operators
-- retain scoped counters and identifiers, never arbitrary diagnostic payloads.
revoke select on migration.reconciliation_runs from authenticated, anon;
grant select (id, batch_id, authority_id, run_at, source_case_count, target_case_count,
  source_document_count, target_document_count, missing_count, duplicate_count,
  hash_mismatch_count, broken_relation_count, unmapped_status_count,
  unmapped_classification_count, orphan_document_count, result)
  on migration.reconciliation_runs to authenticated;

notify pgrst, 'reload schema';
reset lock_timeout;
