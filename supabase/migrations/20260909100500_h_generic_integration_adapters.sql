-- Tryggsignal Phase H / P12 — complete generic integration framework.
-- Adds transport-neutral provenance, idempotent inbound receipt and durable
-- connector reconciliation without exposing raw payloads to browser roles.

alter table integration.connectors
  drop constraint if exists connectors_connector_kind_check;

alter table integration.connectors
  add constraint connectors_connector_kind_check
  check (connector_kind in (
    'GENERIC_REST',
    'GENERIC_SOAP',
    'GENERIC_FILE',
    'GENERIC_SFTP',
    'GENERIC_SQL',
    'GENERIC_WEBHOOK',
    'VENDOR',
    'NATIONAL'
  ));

insert into integration.connectors (
  key, name, connector_kind, capabilities, contract_version
)
values
  ('generic-rest', 'Generic REST/OpenAPI', 'GENERIC_REST',
   '["listCases","setStatus"]'::jsonb, '1'),
  ('generic-file', 'Generic file import', 'GENERIC_FILE',
   '["listCases"]'::jsonb, '1'),
  ('generic-sftp', 'Generic SFTP import', 'GENERIC_SFTP',
   '["listCases"]'::jsonb, '1'),
  ('generic-sql-read', 'Generic SQL read', 'GENERIC_SQL',
   '["listCases"]'::jsonb, '1'),
  ('generic-soap', 'Generic SOAP slot', 'GENERIC_SOAP',
   '[]'::jsonb, '1'),
  ('generic-webhook', 'Generic inbound webhook', 'GENERIC_WEBHOOK',
   '[]'::jsonb, '1')
on conflict (key) do update
set name = excluded.name,
    connector_kind = excluded.connector_kind,
    capabilities = excluded.capabilities,
    contract_version = excluded.contract_version;

alter table integration.external_records
  add column mapping_version text not null default '1'
    check (length(trim(mapping_version)) between 1 and 100);

alter table integration.integration_events
  add column source_hash text,
  add column mapping_version text not null default '1'
    check (length(trim(mapping_version)) between 1 and 100),
  add column duplicate_count integer not null default 0
    check (duplicate_count >= 0),
  add column last_duplicate_at timestamptz;

create table integration.reconciliation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  connector_instance_id uuid not null references integration.connector_instances (id) on delete cascade,
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
  detail jsonb not null default '{}'::jsonb
);

create index integration_reconciliation_instance_idx
  on integration.reconciliation_runs (connector_instance_id, checked_at desc);
create index integration_reconciliation_authority_idx
  on integration.reconciliation_runs (authority_id, checked_at desc);

alter table integration.reconciliation_runs enable row level security;

grant select on integration.reconciliation_runs to authenticated;

create policy integration_reconciliation_runs_select
  on integration.reconciliation_runs
  for select to authenticated
  using (authz.has_permission('integration.manage', authority_id, null, null));

-- Service-originated integration events must still enter the append-only audit
-- chain. The service role can call this helper, while browser roles cannot forge
-- SERVICE actors.
create or replace function audit.record_service(
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_authority_id uuid,
  p_source_system text,
  p_purpose text default null,
  p_correlation_id uuid default null,
  p_before_hash text default null,
  p_after_hash text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if length(trim(coalesce(p_action, ''))) < 2
     or length(trim(coalesce(p_resource_type, ''))) < 2
     or length(trim(coalesce(p_source_system, ''))) < 2 then
    raise exception 'Service audit metadata is incomplete'
      using errcode = 'check_violation';
  end if;

  insert into audit.events (
    actor,
    actor_type,
    authority_id,
    action,
    resource_type,
    resource_id,
    purpose,
    correlation_id,
    source_system,
    before_hash,
    after_hash,
    event_hash
  )
  values (
    null,
    'SERVICE',
    p_authority_id,
    trim(p_action),
    trim(p_resource_type),
    p_resource_id,
    p_purpose,
    p_correlation_id,
    trim(p_source_system),
    p_before_hash,
    p_after_hash,
    ''
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function audit.record_service(
  text, text, uuid, uuid, text, text, uuid, text, text
) from public, anon, authenticated;
grant usage on schema audit, integration to service_role;
grant execute on function audit.record_service(
  text, text, uuid, uuid, text, text, uuid, text, text
) to service_role;

-- One durable receipt boundary for webhook/file/SFTP/SQL-poll-derived events.
-- The unique connector_instance_id + idempotency_key constraint remains the
-- source of truth; duplicate delivery increments evidence instead of inserting
-- another event.
create or replace function integration.receive_inbound_event(
  p_connector_instance_id uuid,
  p_external_event_id text,
  p_event_type text,
  p_idempotency_key text,
  p_payload jsonb,
  p_source_hash text,
  p_mapping_version text default '1'
)
returns table (
  event_id bigint,
  duplicate boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance integration.connector_instances%rowtype;
  v_event_id bigint;
  v_correlation uuid := extensions.gen_random_uuid();
begin
  if length(trim(coalesce(p_event_type, ''))) < 2
     or length(trim(coalesce(p_idempotency_key, ''))) < 16
     or length(trim(coalesce(p_mapping_version, ''))) < 1
     or p_payload is null then
    raise exception 'Inbound integration event is invalid'
      using errcode = 'check_violation';
  end if;

  select * into v_instance
  from integration.connector_instances ci
  where ci.id = p_connector_instance_id
    and ci.status in ('TESTING', 'ENABLED')
  for share;

  if not found then
    raise exception 'Connector instance is unavailable'
      using errcode = 'no_data_found';
  end if;

  insert into integration.integration_events (
    connector_instance_id,
    authority_id,
    external_event_id,
    event_type,
    idempotency_key,
    payload,
    source_hash,
    mapping_version
  )
  values (
    v_instance.id,
    v_instance.authority_id,
    nullif(trim(coalesce(p_external_event_id, '')), ''),
    trim(p_event_type),
    trim(p_idempotency_key),
    p_payload,
    nullif(trim(coalesce(p_source_hash, '')), ''),
    trim(p_mapping_version)
  )
  on conflict (connector_instance_id, idempotency_key) do nothing
  returning id into v_event_id;

  if v_event_id is not null then
    perform audit.record_service(
      'integration.event.received',
      'connector_instance',
      v_instance.id,
      v_instance.authority_id,
      'integration',
      format('Inbound event %s accepted', v_event_id),
      v_correlation,
      null,
      p_source_hash
    );
    return query select v_event_id, false;
    return;
  end if;

  update integration.integration_events e
  set duplicate_count = e.duplicate_count + 1,
      last_duplicate_at = now()
  where e.connector_instance_id = v_instance.id
    and e.idempotency_key = trim(p_idempotency_key)
  returning e.id into v_event_id;

  perform audit.record_service(
    'integration.event.duplicate',
    'connector_instance',
    v_instance.id,
    v_instance.authority_id,
    'integration',
    format('Duplicate inbound event %s ignored', v_event_id),
    v_correlation,
    p_source_hash,
    p_source_hash
  );

  return query select v_event_id, true;
end;
$$;

revoke all on function integration.receive_inbound_event(
  uuid, text, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function integration.receive_inbound_event(
  uuid, text, text, text, jsonb, text, text
) to service_role;

create or replace function integration.record_reconciliation(
  p_connector_instance_id uuid,
  p_source_count integer,
  p_tracked_count integer,
  p_unchanged_count integer,
  p_new_count integer,
  p_changed_count integer,
  p_missing_internal_count integer,
  p_missing_source_count integer,
  p_duplicate_source_count integer,
  p_detail jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_instance integration.connector_instances%rowtype;
  v_result text;
  v_id uuid;
begin
  if p_source_count is null
     or p_tracked_count is null
     or p_unchanged_count is null
     or p_new_count is null
     or p_changed_count is null
     or p_missing_internal_count is null
     or p_missing_source_count is null
     or p_duplicate_source_count is null
     or least(
       p_source_count,
       p_tracked_count,
       p_unchanged_count,
       p_new_count,
       p_changed_count,
       p_missing_internal_count,
       p_missing_source_count,
       p_duplicate_source_count
     ) < 0 then
    raise exception 'Reconciliation counts cannot be negative'
      using errcode = 'check_violation';
  end if;

  select * into v_instance
  from integration.connector_instances ci
  where ci.id = p_connector_instance_id
  for update;

  if not found then
    raise exception 'Connector instance is unavailable'
      using errcode = 'no_data_found';
  end if;

  v_result := case
    when p_new_count = 0
      and p_changed_count = 0
      and p_missing_internal_count = 0
      and p_missing_source_count = 0
      and p_duplicate_source_count = 0
    then 'GREEN'
    else 'RED'
  end;

  insert into integration.reconciliation_runs (
    connector_instance_id,
    authority_id,
    source_count,
    tracked_count,
    unchanged_count,
    new_count,
    changed_count,
    missing_internal_count,
    missing_source_count,
    duplicate_source_count,
    result,
    detail
  )
  values (
    v_instance.id,
    v_instance.authority_id,
    p_source_count,
    p_tracked_count,
    p_unchanged_count,
    p_new_count,
    p_changed_count,
    p_missing_internal_count,
    p_missing_source_count,
    p_duplicate_source_count,
    v_result,
    coalesce(p_detail, '{}'::jsonb)
  )
  returning id into v_id;

  update integration.connector_instances
  set health_status = case when v_result = 'GREEN' then 'HEALTHY' else 'DEGRADED' end,
      last_health_check_at = now()
  where id = v_instance.id;

  perform audit.record_service(
    'integration.reconciliation.completed',
    'connector_instance',
    v_instance.id,
    v_instance.authority_id,
    'integration',
    format('Connector reconciliation %s result %s', v_id, v_result),
    null,
    null,
    v_result
  );

  return v_id;
end;
$$;

revoke all on function integration.record_reconciliation(
  uuid, integer, integer, integer, integer, integer, integer, integer, integer, jsonb
) from public, anon, authenticated;
grant execute on function integration.record_reconciliation(
  uuid, integer, integer, integer, integer, integer, integer, integer, integer, jsonb
) to service_role;
