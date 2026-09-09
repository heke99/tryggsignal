-- Phase I foundation: repair previously independent authority/batch references.
-- Forward-only; existing inconsistent rows STOP rollout. Never guess an owner,
-- delete evidence, disable RLS, or rewrite an already applied migration.
set lock_timeout = '5s';

alter table migration.sources
  add constraint migration_sources_id_authority_key unique (id, authority_id);
alter table migration.batches
  add constraint migration_batches_id_authority_key unique (id, authority_id),
  add constraint migration_batches_source_scope_fk foreign key (source_id, authority_id)
    references migration.sources (id, authority_id) on delete restrict,
  add constraint migration_batches_counts_check check (object_count >= 0 and error_count >= 0);
alter table migration.batches drop constraint batches_source_id_fkey;

alter table migration.objects
  add column source_hash_version text not null default 'json-stringify-v1'
    check (source_hash_version in ('json-stringify-v1', 'canonical-json-v1')),
  add constraint migration_objects_id_batch_authority_key unique (id, batch_id, authority_id),
  add constraint migration_objects_batch_scope_fk foreign key (batch_id, authority_id)
    references migration.batches (id, authority_id) on delete restrict,
  add constraint migration_objects_sha256_check check (source_hash ~ '^[a-f0-9]{64}$');
alter table migration.objects drop constraint objects_batch_id_fkey;

alter table migration.errors
  add constraint migration_errors_batch_scope_fk foreign key (batch_id, authority_id)
    references migration.batches (id, authority_id) on delete restrict,
  -- MATCH SIMPLE is deliberate: a batch-level error may have no object_id.
  add constraint migration_errors_object_scope_fk foreign key (object_id, batch_id, authority_id)
    references migration.objects (id, batch_id, authority_id) on delete restrict;
alter table migration.errors drop constraint errors_batch_id_fkey;
alter table migration.errors drop constraint errors_object_id_fkey;

alter table migration.reconciliation_runs
  add constraint migration_reconciliation_batch_scope_fk foreign key (batch_id, authority_id)
    references migration.batches (id, authority_id) on delete restrict,
  add constraint migration_reconciliation_counts_check check (
    source_case_count >= 0 and target_case_count >= 0
    and source_document_count >= 0 and target_document_count >= 0
    and missing_count >= 0 and duplicate_count >= 0 and hash_mismatch_count >= 0
    and broken_relation_count >= 0 and unmapped_status_count >= 0
    and unmapped_classification_count >= 0 and orphan_document_count >= 0
  ),
  add constraint migration_reconciliation_result_truth check (
    (result = 'GREEN') = (
      source_case_count = target_case_count and source_document_count = target_document_count
      and missing_count = 0 and duplicate_count = 0 and hash_mismatch_count = 0
      and broken_relation_count = 0 and unmapped_status_count = 0
      and unmapped_classification_count = 0 and orphan_document_count = 0
    )
  );
alter table migration.reconciliation_runs drop constraint reconciliation_runs_batch_id_fkey;

-- Index actual scope-bound batch/object/error/verification reads. Existing
-- source identity, canonical lookup and checksum indexes remain untouched.
create index migration_batches_source_scope_idx on migration.batches (source_id, authority_id);
create index migration_batches_authority_started_idx
  on migration.batches (authority_id, started_at desc, id desc);
create index migration_objects_batch_scope_idx on migration.objects (batch_id, authority_id);
create index migration_objects_authority_idx on migration.objects (authority_id);
create index migration_errors_object_scope_idx on migration.errors (object_id, batch_id, authority_id);
create index migration_errors_batch_scope_idx
  on migration.errors (batch_id, authority_id, occurred_at desc, id desc);
create index migration_errors_authority_idx on migration.errors (authority_id);
create index migration_reconciliation_batch_scope_idx
  on migration.reconciliation_runs (batch_id, authority_id, run_at desc, id desc);
create index migration_reconciliation_authority_idx on migration.reconciliation_runs (authority_id);
create index migration_mapping_versions_created_by_idx on migration.mapping_versions (created_by);

-- Raw data and its checksum/identity/codec are one immutable piece of evidence.
-- Canonical link/stage may advance; verification always uses the original codec.
create or replace function migration.guard_raw_evidence()
returns trigger language plpgsql security invoker set search_path = '' as $raw_guard$
begin
  if row(new.id, new.batch_id, new.authority_id, new.source_system, new.source_version,
         new.source_object, new.source_primary_key, new.raw_payload, new.source_hash,
         new.source_hash_version, new.exported_at, new.created_at)
     is distinct from
     row(old.id, old.batch_id, old.authority_id, old.source_system, old.source_version,
         old.source_object, old.source_primary_key, old.raw_payload, old.source_hash,
         old.source_hash_version, old.exported_at, old.created_at) then
    raise exception 'Raw migration evidence is immutable; capture a new source version'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$raw_guard$;
revoke all on function migration.guard_raw_evidence() from public, anon, authenticated;
create trigger migration_objects_raw_immutable before update on migration.objects
  for each row execute function migration.guard_raw_evidence();

create or replace function migration.guard_mapping_version()
returns trigger language plpgsql security invoker set search_path = '' as $mapping_guard$
begin
  if new is distinct from old then
    raise exception 'Migration mapping versions are immutable; append a new version'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$mapping_guard$;
revoke all on function migration.guard_mapping_version() from public, anon, authenticated;
create trigger migration_mapping_versions_immutable before update on migration.mapping_versions
  for each row execute function migration.guard_mapping_version();

-- Error messages/detail may contain unclassified source payloads. Browser
-- operators get scoped operational metadata, not raw source/error content.
revoke select on migration.errors from authenticated, anon;
grant select (id, batch_id, object_id, authority_id, stage, error_code, occurred_at, resolved_at)
  on migration.errors to authenticated;
reset lock_timeout;
