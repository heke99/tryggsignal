-- Tryggsignal Phase H — generic integration framework database gate.
begin;

create temporary table h_ids (k text primary key, v uuid) on commit drop;

insert into organization.legal_entities (name, organization_number)
values ('H Integration kommun', '212000-1206');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'h_integration', 'H integrationsmyndighet'
from organization.legal_entities le
where le.organization_number = '212000-1206';

insert into h_ids
select 'authority', a.id
from organization.authorities a
where a.key = 'h_integration';

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from integration.connectors
  where key in (
    'generic-rest',
    'generic-file',
    'generic-sftp',
    'generic-sql-read',
    'generic-soap',
    'generic-webhook'
  );

  if v_count <> 6 then
    raise exception 'H connector catalog expected 6 generic transports, got %', v_count;
  end if;

  if not exists (
    select 1 from integration.connectors
    where key = 'generic-rest'
      and capabilities = '["listCases","setStatus"]'::jsonb
  ) then
    raise exception 'Generic REST catalog capabilities are not truthful';
  end if;

  if not exists (
    select 1 from integration.connectors
    where key in ('generic-file', 'generic-sftp', 'generic-sql-read')
      and capabilities = '["listCases"]'::jsonb
    group by capabilities
    having count(*) = 3
  ) then
    raise exception 'File/SFTP/SQL-read catalog capabilities are incomplete';
  end if;
end;
$$;

insert into integration.connector_instances (
  connector_id,
  authority_id,
  name,
  credential_reference,
  endpoint_url,
  configuration,
  direction,
  status
)
select
  c.id,
  (select v from h_ids where k='authority'),
  'H webhook fixture',
  'secret/h/webhook-signing-key',
  'https://integration.invalid/webhook',
  '{"mapping_version":"h-1"}'::jsonb,
  'INBOUND',
  'TESTING'
from integration.connectors c
where c.key = 'generic-webhook'
returning id;

insert into h_ids
select 'instance', ci.id
from integration.connector_instances ci
where ci.authority_id = (select v from h_ids where k='authority')
  and ci.name = 'H webhook fixture';

-- Raw payloads and service receipt commands are not a browser API.
do $$
begin
  if has_table_privilege('authenticated', 'integration.external_records', 'SELECT') then
    raise exception 'authenticated unexpectedly has SELECT on raw external_records';
  end if;

  if has_function_privilege(
    'authenticated',
    'integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated can execute service-only inbound receipt';
  end if;

  if not has_function_privilege(
    'service_role',
    'integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute inbound receipt';
  end if;
end;
$$;

-- First receipt creates one event. Second delivery with the same idempotency key
-- returns the same event id and increments duplicate evidence instead of
-- inserting another event.
do $$
declare
  v_first_id bigint;
  v_second_id bigint;
  v_first_duplicate boolean;
  v_second_duplicate boolean;
  v_count integer;
begin
  select r.event_id, r.duplicate
  into v_first_id, v_first_duplicate
  from integration.receive_inbound_event(
    (select v from h_ids where k='instance'),
    'evt-h-001',
    'case.changed',
    repeat('a', 64),
    '{"event":{"id":"evt-h-001","type":"case.changed"},"case":{"id":"legacy-h-1"}}'::jsonb,
    repeat('b', 64),
    'h-1'
  ) r;

  select r.event_id, r.duplicate
  into v_second_id, v_second_duplicate
  from integration.receive_inbound_event(
    (select v from h_ids where k='instance'),
    'evt-h-001',
    'case.changed',
    repeat('a', 64),
    '{"case":{"id":"legacy-h-1"},"event":{"type":"case.changed","id":"evt-h-001"}}'::jsonb,
    repeat('b', 64),
    'h-1'
  ) r;

  if v_first_duplicate or not v_second_duplicate then
    raise exception 'H duplicate receipt flags are incorrect';
  end if;

  if v_first_id is distinct from v_second_id then
    raise exception 'Duplicate delivery created a different event identity';
  end if;

  select count(*) into v_count
  from integration.integration_events e
  where e.connector_instance_id = (select v from h_ids where k='instance')
    and e.idempotency_key = repeat('a', 64);

  if v_count <> 1 then
    raise exception 'Duplicate delivery produced % event rows', v_count;
  end if;

  if not exists (
    select 1
    from integration.integration_events e
    where e.id = v_first_id
      and e.duplicate_count = 1
      and e.last_duplicate_at is not null
      and e.mapping_version = 'h-1'
      and e.source_hash = repeat('b', 64)
  ) then
    raise exception 'Duplicate evidence/provenance was not persisted';
  end if;
end;
$$;

-- External record provenance carries the mapping version used to create the
-- canonical record.
insert into integration.external_records (
  connector_instance_id,
  authority_id,
  entity_type,
  external_id,
  internal_id,
  source_version,
  source_updated_at,
  last_synced_at,
  source_hash,
  mapping_version,
  raw_payload
)
values (
  (select v from h_ids where k='instance'),
  (select v from h_ids where k='authority'),
  'CASE',
  'legacy-h-1',
  extensions.gen_random_uuid(),
  '7',
  now() - interval '1 minute',
  now(),
  repeat('c', 64),
  'h-1',
  '{"id":"legacy-h-1","version":"7"}'::jsonb
);

-- A drifted reconciliation is durable and degrades health.
do $$
declare
  v_run uuid;
begin
  select integration.record_reconciliation(
    (select v from h_ids where k='instance'),
    2,
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    '{"reason":"one new source record"}'::jsonb
  ) into v_run;

  if not exists (
    select 1
    from integration.reconciliation_runs r
    where r.id = v_run
      and r.result = 'RED'
      and r.new_count = 1
  ) then
    raise exception 'Drift reconciliation did not persist RED';
  end if;

  if not exists (
    select 1
    from integration.connector_instances ci
    where ci.id = (select v from h_ids where k='instance')
      and ci.health_status = 'DEGRADED'
      and ci.last_health_check_at is not null
  ) then
    raise exception 'RED reconciliation did not degrade connector health';
  end if;
end;
$$;

-- Once source and tracked provenance agree exactly, reconciliation returns GREEN
-- and connector health recovers.
do $$
declare
  v_run uuid;
begin
  select integration.record_reconciliation(
    (select v from h_ids where k='instance'),
    1,
    1,
    1,
    0,
    0,
    0,
    0,
    0,
    '{"source":"synthetic H gate","mapping_version":"h-1"}'::jsonb
  ) into v_run;

  if not exists (
    select 1
    from integration.reconciliation_runs r
    where r.id = v_run
      and r.result = 'GREEN'
      and r.source_count = 1
      and r.tracked_count = 1
      and r.unchanged_count = 1
  ) then
    raise exception 'H reconciliation did not become GREEN';
  end if;

  if not exists (
    select 1
    from integration.connector_instances ci
    where ci.id = (select v from h_ids where k='instance')
      and ci.health_status = 'HEALTHY'
  ) then
    raise exception 'GREEN reconciliation did not restore connector health';
  end if;
end;
$$;

do $$
declare
  v_received integer;
  v_duplicate integer;
  v_reconciled integer;
begin
  select count(*) filter (where action = 'integration.event.received'),
         count(*) filter (where action = 'integration.event.duplicate'),
         count(*) filter (where action = 'integration.reconciliation.completed')
  into v_received, v_duplicate, v_reconciled
  from audit.events
  where resource_id = (select v from h_ids where k='instance')
    and actor_type = 'SERVICE';

  if v_received <> 1 or v_duplicate <> 1 or v_reconciled <> 2 then
    raise exception
      'H service audit expected received=1 duplicate=1 reconciliation=2, got %/%/%',
      v_received, v_duplicate, v_reconciled;
  end if;
end;
$$;

select 'H GENERIC INTEGRATIONS (catalog/duplicate/reconciliation/provenance/audit): GREEN'
  as result;

rollback;
