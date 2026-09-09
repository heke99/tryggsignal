-- Phase H / P12. Pending PR migration: no applied migration is rewritten.
-- Transport receipts are NOT successful canonical application.

alter table integration.connectors drop constraint if exists connectors_connector_kind_check;
alter table integration.connectors add constraint connectors_connector_kind_check check (
  connector_kind in ('GENERIC_REST', 'GENERIC_SOAP', 'GENERIC_FILE', 'GENERIC_SFTP',
                    'GENERIC_SQL', 'GENERIC_WEBHOOK', 'VENDOR', 'NATIONAL')
);
insert into integration.connectors (key, name, connector_kind, capabilities, contract_version)
values
  ('generic-rest', 'Generic REST/OpenAPI', 'GENERIC_REST', '["listCases","setStatus"]', '1'),
  ('generic-file', 'Generic file import', 'GENERIC_FILE', '["listCases"]', '1'),
  ('generic-sftp', 'Generic SFTP import', 'GENERIC_SFTP', '["listCases"]', '1'),
  ('generic-sql-read', 'Generic SQL read', 'GENERIC_SQL', '["listCases"]', '1'),
  ('generic-soap', 'Generic SOAP slot', 'GENERIC_SOAP', '[]', '1'),
  ('generic-webhook', 'Generic inbound webhook', 'GENERIC_WEBHOOK', '[]', '1')
on conflict (key) do update set name = excluded.name, connector_kind = excluded.connector_kind,
  capabilities = excluded.capabilities, contract_version = excluded.contract_version;

alter table integration.external_records
  add column mapping_version text not null default '1'
    check (length(mapping_version) between 1 and 100 and mapping_version = trim(mapping_version));
alter table integration.integration_events
  add column source_hash text,
  add column mapping_version text not null default '1'
    check (length(mapping_version) between 1 and 100 and mapping_version = trim(mapping_version)),
  add column duplicate_count integer not null default 0 check (duplicate_count >= 0),
  add column last_duplicate_at timestamptz,
  add constraint integration_events_attempt_nonnegative check (attempt >= 0),
  add constraint integration_events_duplicate_evidence check (
    (duplicate_count = 0 and last_duplicate_at is null)
    or (duplicate_count > 0 and last_duplicate_at is not null)
  );
alter table integration.sync_jobs
  add constraint sync_jobs_attempt_nonnegative check (attempt >= 0);

-- Denormalized authority_id must agree with the immutable connector scope.
-- These constraints validate existing rows; bad historical data stops rollout
-- instead of being silently reassigned, deleted, or accepted with NOT VALID.
alter table integration.connector_instances
  add constraint connector_instances_id_authority_key unique (id, authority_id);
alter table integration.external_records
  add constraint external_records_connector_scope_fk
    foreign key (connector_instance_id, authority_id)
    references integration.connector_instances (id, authority_id) on delete cascade;
alter table integration.sync_jobs
  add constraint sync_jobs_connector_scope_fk
    foreign key (connector_instance_id, authority_id)
    references integration.connector_instances (id, authority_id) on delete cascade;
alter table integration.integration_events
  add constraint integration_events_connector_scope_fk
    foreign key (connector_instance_id, authority_id)
    references integration.connector_instances (id, authority_id) on delete cascade;
-- Replace redundant single-column parent FKs with the scoped versions.
alter table integration.external_records drop constraint external_records_connector_instance_id_fkey;
alter table integration.sync_jobs drop constraint sync_jobs_connector_instance_id_fkey;
alter table integration.integration_events drop constraint integration_events_connector_instance_id_fkey;

-- Full indexes support FK equality lookups and scope-bound operational reads.
-- Existing retry partial indexes and external identity unique indexes are kept.
create index connector_instances_connector_idx on integration.connector_instances (connector_id);
create index external_records_connector_scope_idx
  on integration.external_records (connector_instance_id, authority_id);
create index sync_jobs_connector_scope_idx
  on integration.sync_jobs (connector_instance_id, authority_id);
create index integration_events_scope_received_idx
  on integration.integration_events (connector_instance_id, authority_id, received_at desc, id desc);
create index integration_events_authority_received_idx
  on integration.integration_events (authority_id, received_at desc, id desc);

create table integration.reconciliation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  checked_at timestamptz not null default now(),
  source_count integer not null check (source_count >= 0),
  tracked_count integer not null check (tracked_count >= 0),
  unchanged_count integer not null check (unchanged_count >= 0),
  new_count integer not null check (new_count >= 0),
  changed_count integer not null check (changed_count >= 0),
  missing_internal_count integer not null check (missing_internal_count >= 0),
  missing_source_count integer not null check (missing_source_count >= 0),
  duplicate_source_count integer not null check (duplicate_source_count >= 0),
  result text not null check (result in ('GREEN', 'RED')),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  constraint reconciliation_connector_scope_fk foreign key (connector_instance_id, authority_id)
    references integration.connector_instances (id, authority_id) on delete cascade,
  -- A mapped source row is new, changed, unchanged, or an extra duplicate.
  constraint reconciliation_source_partition check (
    source_count::bigint = new_count::bigint + changed_count + unchanged_count + duplicate_source_count
  ),
  constraint reconciliation_tracked_partition check (
    tracked_count::bigint = changed_count::bigint + unchanged_count + missing_source_count
  ),
  constraint reconciliation_missing_internal_subset check (
    missing_internal_count::bigint <= changed_count::bigint + unchanged_count
  ),
  constraint reconciliation_result_truth check (
    (result = 'GREEN') = (new_count = 0 and changed_count = 0 and missing_internal_count = 0
                         and missing_source_count = 0 and duplicate_source_count = 0)
  )
);
create index integration_reconciliation_instance_idx
  on integration.reconciliation_runs (connector_instance_id, authority_id, checked_at desc, id desc);
create index integration_reconciliation_authority_idx
  on integration.reconciliation_runs (authority_id, checked_at desc, id desc);
alter table integration.reconciliation_runs enable row level security;
grant select on integration.reconciliation_runs to authenticated;
create policy integration_reconciliation_runs_select on integration.reconciliation_runs
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

-- Do not expose raw event bodies or error strings through the browser Data API.
-- RLS still scopes the explicitly granted operational metadata to integration admins.
revoke select on integration.integration_events from authenticated, anon;
grant select (id, connector_instance_id, authority_id, event_type, status, attempt,
  next_retry_at, received_at, processed_at, mapping_version, duplicate_count, last_duplicate_at)
  on integration.integration_events to authenticated;

create or replace function audit.record_service(
  p_action text, p_resource_type text, p_resource_id uuid, p_authority_id uuid,
  p_source_system text, p_purpose text default null, p_correlation_id uuid default null,
  p_before_hash text default null, p_after_hash text default null
)
returns bigint language plpgsql security definer set search_path = '' as $audit_service$
declare v_id bigint;
begin
  if length(trim(coalesce(p_action, ''))) < 2
     or length(trim(coalesce(p_resource_type, ''))) < 2
     or length(trim(coalesce(p_source_system, ''))) < 2 then
    raise exception 'Service audit metadata is incomplete' using errcode = 'check_violation';
  end if;
  insert into audit.events (
    actor, actor_type, authority_id, action, resource_type, resource_id, purpose,
    correlation_id, source_system, before_hash, after_hash, event_hash
  ) values (
    null, 'SERVICE', p_authority_id, trim(p_action), trim(p_resource_type), p_resource_id,
    p_purpose, p_correlation_id, trim(p_source_system), p_before_hash, p_after_hash, ''
  ) returning id into v_id;
  return v_id;
end;
$audit_service$;
revoke all on function audit.record_service(text,text,uuid,uuid,text,text,uuid,text,text)
  from public, anon, authenticated;
grant usage on schema audit, integration to service_role;
grant execute on function audit.record_service(text,text,uuid,uuid,text,text,uuid,text,text) to service_role;

-- One durable receipt per connector and logical delivery key. A repeated key
-- with different content is an integrity conflict, not a harmless duplicate.
create or replace function integration.receive_inbound_event(
  p_connector_instance_id uuid, p_external_event_id text, p_event_type text,
  p_idempotency_key text, p_payload jsonb, p_source_hash text, p_mapping_version text default '1'
)
returns table (event_id bigint, duplicate boolean)
language plpgsql security definer set search_path = '' as $receive_event$
declare
  v_instance integration.connector_instances%rowtype;
  v_existing integration.integration_events%rowtype;
  v_event_id bigint;
  v_key text := trim(coalesce(p_idempotency_key, ''));
  v_type text := trim(coalesce(p_event_type, ''));
  v_external text := trim(coalesce(p_external_event_id, ''));
  v_mapping text := trim(coalesce(p_mapping_version, ''));
  v_correlation uuid := extensions.gen_random_uuid();
begin
  if length(v_type) not between 2 and 200 or length(v_key) not between 16 and 256
     or length(v_external) not between 1 and 500 or length(v_mapping) not between 1 and 100
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Inbound integration event is invalid' using errcode = 'check_violation';
  end if;
  select * into v_instance from integration.connector_instances ci
  where ci.id = p_connector_instance_id and ci.status in ('TESTING', 'ENABLED')
    and ci.direction in ('INBOUND', 'BIDIRECTIONAL') for share;
  if not found then
    raise exception 'Connector instance is unavailable' using errcode = 'no_data_found';
  end if;
  insert into integration.integration_events (
    connector_instance_id, authority_id, external_event_id, event_type,
    idempotency_key, payload, source_hash, mapping_version
  ) values (v_instance.id, v_instance.authority_id, v_external, v_type,
            v_key, p_payload, p_source_hash, v_mapping)
  on conflict (connector_instance_id, idempotency_key) do nothing returning id into v_event_id;
  if v_event_id is not null then
    perform audit.record_service('integration.event.received', 'connector_instance', v_instance.id,
      v_instance.authority_id, 'integration', format('Inbound event %s accepted', v_event_id),
      v_correlation, null, p_source_hash);
    return query select v_event_id, false;
    return;
  end if;
  select * into v_existing from integration.integration_events e
  where e.connector_instance_id = v_instance.id and e.idempotency_key = v_key for update;
  if not found then
    raise exception 'Concurrent event receipt changed; retry transaction' using errcode = 'serialization_failure';
  end if;
  if v_existing.external_event_id is distinct from v_external
     or v_existing.event_type is distinct from v_type or v_existing.payload is distinct from p_payload
     or v_existing.source_hash is distinct from p_source_hash
     or v_existing.mapping_version is distinct from v_mapping then
    raise exception 'IDEMPOTENCY_CONFLICT: same key has different immutable event content'
      using errcode = 'unique_violation';
  end if;
  update integration.integration_events e
  set duplicate_count = e.duplicate_count + 1, last_duplicate_at = now()
  where e.id = v_existing.id;
  perform audit.record_service('integration.event.duplicate', 'connector_instance', v_instance.id,
    v_instance.authority_id, 'integration', format('Duplicate event %s ignored', v_existing.id),
    v_correlation, v_existing.source_hash, p_source_hash);
  return query select v_existing.id, true;
end;
$receive_event$;
revoke all on function integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text) to service_role;

-- Aggregate receipt for FULL-SNAPSHOT reconciliation, not a single fetched page.
-- Counter equations are enforced both here and on the underlying table.
create or replace function integration.record_reconciliation(
  p_connector_instance_id uuid, p_source_count integer, p_tracked_count integer,
  p_unchanged_count integer, p_new_count integer, p_changed_count integer,
  p_missing_internal_count integer, p_missing_source_count integer, p_duplicate_source_count integer,
  p_detail jsonb default '{}'
)
returns uuid language plpgsql security definer set search_path = '' as $reconcile$
declare
  v_instance integration.connector_instances%rowtype;
  v_result text;
  v_id uuid;
  v_evidence jsonb;
begin
  if p_source_count is null or p_tracked_count is null or p_unchanged_count is null
     or p_new_count is null or p_changed_count is null or p_missing_internal_count is null
     or p_missing_source_count is null or p_duplicate_source_count is null
     or least(p_source_count, p_tracked_count, p_unchanged_count, p_new_count, p_changed_count,
              p_missing_internal_count, p_missing_source_count, p_duplicate_source_count) < 0
     or p_source_count::bigint <> p_new_count::bigint + p_changed_count + p_unchanged_count + p_duplicate_source_count
     or p_tracked_count::bigint <> p_changed_count::bigint + p_unchanged_count + p_missing_source_count
     or p_missing_internal_count::bigint > p_changed_count::bigint + p_unchanged_count
     or jsonb_typeof(coalesce(p_detail, '{}')) <> 'object' then
    raise exception 'Reconciliation counts or detail are inconsistent' using errcode = 'check_violation';
  end if;
  select * into v_instance from integration.connector_instances ci
  where ci.id = p_connector_instance_id and ci.status in ('TESTING', 'ENABLED') for update;
  if not found then
    raise exception 'Connector instance is unavailable' using errcode = 'no_data_found';
  end if;
  v_result := case when p_new_count = 0 and p_changed_count = 0 and p_missing_internal_count = 0
    and p_missing_source_count = 0 and p_duplicate_source_count = 0 then 'GREEN' else 'RED' end;
  insert into integration.reconciliation_runs (
    connector_instance_id, authority_id, source_count, tracked_count, unchanged_count, new_count,
    changed_count, missing_internal_count, missing_source_count, duplicate_source_count, result, detail
  ) values (
    v_instance.id, v_instance.authority_id, p_source_count, p_tracked_count, p_unchanged_count,
    p_new_count, p_changed_count, p_missing_internal_count, p_missing_source_count,
    p_duplicate_source_count, v_result, coalesce(p_detail, '{}')
  ) returning id into v_id;
  update integration.connector_instances
  set health_status = case when v_result = 'GREEN' then 'HEALTHY' else 'DEGRADED' end,
      last_health_check_at = now() where id = v_instance.id;
  v_evidence := jsonb_build_object('result', v_result, 'source', p_source_count, 'tracked', p_tracked_count,
    'unchanged', p_unchanged_count, 'new', p_new_count, 'changed', p_changed_count,
    'missing_internal', p_missing_internal_count, 'missing_source', p_missing_source_count,
    'duplicate_source', p_duplicate_source_count);
  perform audit.record_service('integration.reconciliation.completed', 'connector_instance', v_instance.id,
    v_instance.authority_id, 'integration', format('Reconciliation %s result %s', v_id, v_result),
    null, null, encode(extensions.digest(v_evidence::text, 'sha256'), 'hex'));
  return v_id;
end;
$reconcile$;
revoke all on function integration.record_reconciliation(uuid,integer,integer,integer,integer,integer,integer,integer,integer,jsonb)
  from public, anon, authenticated;
grant execute on function integration.record_reconciliation(uuid,integer,integer,integer,integer,integer,integer,integer,integer,jsonb)
  to service_role;
