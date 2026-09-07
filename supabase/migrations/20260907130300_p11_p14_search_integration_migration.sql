-- Tryggsignal P11/P12/P13/P14 — search read model, integration framework,
-- migration engine and the national data-source registry.
-- Masterplan 23, 34, 46–48, 54–59, 65–68, 141, 142.

-- ---------------------------------------------------------------------------
-- P11 Search (masterplan 46–48)
-- ---------------------------------------------------------------------------

create table search.entities (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete cascade,
  entity_type text not null check (entity_type in ('CASE', 'DOCUMENT', 'PROPERTY', 'PARTY')),
  entity_id uuid not null,
  case_id uuid references core.cases (id) on delete cascade,
  title text not null,
  subtitle text,
  body text,
  -- Masterplan 48: every indexed entity carries its own access scope so search can
  -- never return something the reader may not open.
  information_class text not null default 'INTERNAL'
    check (information_class in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET')),
  security_scope text not null default 'AUTHORITY'
    check (security_scope in ('AUTHORITY', 'DEPARTMENT', 'CASE_PARTIES')),
  department_id uuid references organization.departments (id) on delete set null,
  search_vector tsvector,
  indexed_at timestamptz not null default now(),
  unique (entity_type, entity_id)
);

create index search_entities_vector_idx on search.entities using gin (search_vector);
create index search_entities_authority_type_idx on search.entities (authority_id, entity_type);
create index search_entities_title_trgm_idx
  on search.entities using gin (title extensions.gin_trgm_ops);
create index search_entities_case_idx on search.entities (case_id);

create or replace function search.refresh_vector()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_vector :=
    setweight(to_tsvector('simple', coalesce(new.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(new.subtitle, '')), 'B') ||
    setweight(to_tsvector('swedish', coalesce(new.body, '')), 'C');
  new.indexed_at := now();
  return new;
end;
$$;

revoke all on function search.refresh_vector() from public;

create trigger search_entities_vector
  before insert or update of title, subtitle, body on search.entities
  for each row execute function search.refresh_vector();

alter table search.entities enable row level security;
grant usage on schema search to authenticated;
grant select on search.entities to authenticated;

-- Masterplan 48: search results are authorization filtered, never post-filtered
-- in the UI. A CASE-scoped row is visible only when the underlying case is.
create policy search_entities_select on search.entities
  for select to authenticated
  using (
    case
      when case_id is not null then exists (select 1 from core.cases c where c.id = entities.case_id)
      when security_scope = 'DEPARTMENT' then
        authz.has_permission('case.read', authority_id, department_id, null)
      else authz.has_permission('case.read', authority_id, null, null)
    end
    and (information_class <> 'SECRET' or authz.has_permission('security.manage', authority_id, null, null))
  );

-- ---------------------------------------------------------------------------
-- P14 Data source registry (masterplan 23, 34, 141, 142)
-- ---------------------------------------------------------------------------

create table integration.data_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique,
  provider text not null,
  dataset text not null,
  protocol text not null check (protocol in ('REST', 'SOAP', 'OGC_API', 'STAC', 'WFS', 'SFTP', 'FILE', 'SQL')),
  authority_level text,
  authoritative_level text not null
    check (authoritative_level in ('AUTHORITATIVE', 'REFERENCE', 'ADVISORY', 'DERIVED', 'AI_DERIVED')),
  license text not null,
  attribution_requirement text,
  redistribution_allowed boolean not null default false,
  caching_allowed boolean not null default false,
  retention text,
  legal_access_requirement text,
  credential_type text not null default 'NONE'
    check (credential_type in ('NONE', 'API_KEY', 'OAUTH2', 'MTLS', 'BASIC', 'CERTIFICATE')),
  cache_policy jsonb not null default '{}'::jsonb,
  refresh_policy jsonb not null default '{}'::jsonb,
  rate_limit_policy jsonb not null default '{}'::jsonb,
  source_version text,
  documentation_url text,
  enabled boolean not null default false,
  -- Masterplan 141: freshness is visible, and a stale source is flagged, not hidden.
  last_checked_at timestamptz,
  last_successful_sync timestamptz,
  source_updated_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table integration.data_sources is
  'Registry of external data sources with licence, caching rights and authoritative level (masterplan 23/34).';

create trigger data_sources_set_updated_at before update on integration.data_sources
  for each row execute function config.set_updated_at();

-- A source may only be cached locally when its licence allows it.
create or replace function integration.assert_cache_rights()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not new.caching_allowed and (new.cache_policy ? 'ttl_seconds') then
    raise exception 'Data source % declares a cache TTL but caching is not permitted by its licence', new.key
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function integration.assert_cache_rights() from public;

create trigger data_sources_cache_rights
  before insert or update on integration.data_sources
  for each row execute function integration.assert_cache_rights();

-- ---------------------------------------------------------------------------
-- P12 Integration framework (masterplan 65–68)
-- ---------------------------------------------------------------------------

create table integration.connectors (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique,
  name text not null,
  vendor text,
  product text,
  connector_kind text not null check (connector_kind in (
    'GENERIC_REST', 'GENERIC_SOAP', 'GENERIC_FILE', 'GENERIC_SFTP', 'GENERIC_SQL', 'VENDOR', 'NATIONAL'
  )),
  -- Declared, not assumed: an unverified capability is simply absent.
  capabilities jsonb not null default '{}'::jsonb,
  contract_version text not null default '1',
  documentation_url text,
  created_at timestamptz not null default now()
);

create table integration.connector_instances (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_id uuid not null references integration.connectors (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  name text not null,
  -- Masterplan 27/64/85: a credential reference, never a credential.
  credential_reference text,
  endpoint_url text,
  configuration jsonb not null default '{}'::jsonb,
  direction text not null default 'INBOUND'
    check (direction in ('INBOUND', 'OUTBOUND', 'BIDIRECTIONAL')),
  status text not null default 'DISABLED'
    check (status in ('DISABLED', 'TESTING', 'ENABLED', 'EXTERNAL_BLOCKED', 'FAILED')),
  health_status text not null default 'UNKNOWN'
    check (health_status in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  last_health_check_at timestamptz,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, connector_id, name),
  constraint credential_reference_is_not_a_secret check (
    credential_reference is null or credential_reference !~* '^(eyJ|sb_secret|Bearer |[A-Za-z0-9+/]{60,}=*$)'
  )
);

create index connector_instances_authority_idx on integration.connector_instances (authority_id);

-- Masterplan 68: field ownership is declared; there is no general last-write-wins.
create table integration.field_ownership (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
  entity_type text not null,
  field_name text not null,
  owner text not null check (owner in ('LEGACY', 'KOMMUN_OS', 'SHARED_MANUAL')),
  created_at timestamptz not null default now(),
  unique (connector_instance_id, entity_type, field_name)
);

create table integration.external_records (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  entity_type text not null,
  external_id text not null,
  internal_id uuid,
  source_version text,
  source_updated_at timestamptz,
  last_synced_at timestamptz,
  source_hash text,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  unique (connector_instance_id, entity_type, external_id)
);

create index external_records_internal_idx on integration.external_records (internal_id);
create index external_records_authority_idx on integration.external_records (authority_id);

create table integration.sync_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  job_type text not null,
  direction text not null check (direction in ('INBOUND', 'OUTBOUND')),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  attempt integer not null default 0,
  next_retry_at timestamptz,
  correlation_id uuid not null default extensions.gen_random_uuid(),
  idempotency_key text not null,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (connector_instance_id, idempotency_key)
);

create index sync_jobs_retry_idx on integration.sync_jobs (status, next_retry_at)
  where status in ('PENDING', 'FAILED');
create index sync_jobs_authority_idx on integration.sync_jobs (authority_id, created_at desc);

create table integration.integration_events (
  id bigint generated always as identity primary key,
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  external_event_id text,
  event_type text not null,
  -- Masterplan 66: at-least-once delivery must not create duplicates.
  idempotency_key text not null,
  status text not null default 'RECEIVED'
    check (status in ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED', 'DEAD_LETTER')),
  attempt integer not null default 0,
  next_retry_at timestamptz,
  payload jsonb not null,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (connector_instance_id, idempotency_key)
);

create index integration_events_external_idx
  on integration.integration_events (connector_instance_id, external_event_id);
create index integration_events_retry_idx on integration.integration_events (status, next_retry_at)
  where status in ('RECEIVED', 'FAILED');

create table integration.sync_checkpoints (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
  checkpoint_key text not null,
  cursor_value text,
  checkpoint_at timestamptz not null default now(),
  unique (connector_instance_id, checkpoint_key)
);

create trigger connector_instances_set_updated_at before update on integration.connector_instances
  for each row execute function config.set_updated_at();

-- ---------------------------------------------------------------------------
-- P13 Migration engine (masterplan 54–59)
-- ---------------------------------------------------------------------------

create table migration.sources (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  system_name text not null,
  system_version text,
  export_format text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (authority_id, key)
);

create table migration.batches (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null references migration.sources (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  batch_number integer not null,
  stage text not null default 'EXTRACT' check (stage in (
    'EXTRACT', 'RAW', 'PROFILE', 'MAP', 'VALIDATE', 'TRANSFORM', 'CANONICAL',
    'RECONCILE', 'IMPORT', 'VERIFY', 'COMPLETED', 'FAILED'
  )),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  object_count integer not null default 0,
  error_count integer not null default 0,
  notes text,
  unique (source_id, batch_number)
);

-- Masterplan 56: the original payload is preserved before any transform.
create table migration.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null references migration.batches (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  source_system text not null,
  source_version text,
  source_object text not null,
  source_primary_key text not null,
  raw_payload jsonb not null,
  source_hash text not null,
  exported_at timestamptz,
  canonical_entity_type text,
  canonical_id uuid,
  stage text not null default 'RAW',
  created_at timestamptz not null default now(),
  unique (batch_id, source_object, source_primary_key)
);

create index migration_objects_canonical_idx on migration.objects (canonical_entity_type, canonical_id);
create index migration_objects_hash_idx on migration.objects (source_hash);

create table migration.mappings (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null references migration.sources (id) on delete cascade,
  key text not null,
  entity_type text not null,
  description text,
  created_at timestamptz not null default now(),
  unique (source_id, key)
);

create table migration.mapping_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  mapping_id uuid not null references migration.mappings (id) on delete cascade,
  version integer not null check (version >= 1),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  unique (mapping_id, version)
);

create table migration.errors (
  id bigint generated always as identity primary key,
  batch_id uuid not null references migration.batches (id) on delete cascade,
  object_id uuid references migration.objects (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  stage text not null,
  error_code text not null,
  message text not null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index migration_errors_batch_idx on migration.errors (batch_id, occurred_at desc);

-- Masterplan 59: a migration is not done because a script exited 0.
create table migration.reconciliation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  batch_id uuid not null references migration.batches (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  run_at timestamptz not null default now(),
  source_case_count integer not null default 0,
  target_case_count integer not null default 0,
  source_document_count integer not null default 0,
  target_document_count integer not null default 0,
  missing_count integer not null default 0,
  duplicate_count integer not null default 0,
  hash_mismatch_count integer not null default 0,
  broken_relation_count integer not null default 0,
  unmapped_status_count integer not null default 0,
  unmapped_classification_count integer not null default 0,
  orphan_document_count integer not null default 0,
  result text not null check (result in ('GREEN', 'RED')),
  detail jsonb not null default '{}'::jsonb
);

create index reconciliation_runs_batch_idx on migration.reconciliation_runs (batch_id, run_at desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table integration.data_sources enable row level security;
alter table integration.connectors enable row level security;
alter table integration.connector_instances enable row level security;
alter table integration.field_ownership enable row level security;
alter table integration.external_records enable row level security;
alter table integration.sync_jobs enable row level security;
alter table integration.integration_events enable row level security;
alter table integration.sync_checkpoints enable row level security;
alter table migration.sources enable row level security;
alter table migration.batches enable row level security;
alter table migration.objects enable row level security;
alter table migration.mappings enable row level security;
alter table migration.mapping_versions enable row level security;
alter table migration.errors enable row level security;
alter table migration.reconciliation_runs enable row level security;

grant usage on schema integration, migration to authenticated;
grant select on integration.data_sources, integration.connectors to authenticated;
grant select on integration.connector_instances, integration.field_ownership,
  integration.sync_jobs, integration.integration_events to authenticated;
grant select on migration.sources, migration.batches, migration.errors,
  migration.reconciliation_runs, migration.mappings, migration.mapping_versions to authenticated;

-- The source and connector catalogs describe capabilities, not municipal content.
create policy data_sources_select on integration.data_sources
  for select to authenticated using (true);
create policy connectors_select on integration.connectors
  for select to authenticated using (true);

-- Everything carrying municipal configuration or payloads requires integration.manage.
create policy connector_instances_select on integration.connector_instances
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy field_ownership_select on integration.field_ownership
  for select to authenticated
  using (exists (
    select 1 from integration.connector_instances ci
    where ci.id = field_ownership.connector_instance_id
  ));

create policy sync_jobs_select on integration.sync_jobs
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy integration_events_select on integration.integration_events
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

-- Raw external records and migration payloads may contain personal data that has
-- not yet passed classification, so they are never exposed to a client key.
create policy migration_sources_select on migration.sources
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy migration_batches_select on migration.batches
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy migration_errors_select on migration.errors
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy migration_reconciliation_select on migration.reconciliation_runs
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

create policy migration_mappings_select on migration.mappings
  for select to authenticated
  using (exists (select 1 from migration.sources s where s.id = mappings.source_id));

create policy migration_mapping_versions_select on migration.mapping_versions
  for select to authenticated
  using (exists (select 1 from migration.mappings m where m.id = mapping_versions.mapping_id));
