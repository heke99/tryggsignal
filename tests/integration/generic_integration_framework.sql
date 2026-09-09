-- Tryggsignal Phase H — generic integration framework persistence gate.
begin;

create temporary table h_ids (k text primary key, v uuid) on commit drop;
create temporary table h_bigints (k text primary key, v bigint) on commit drop;
grant select, insert on h_ids, h_bigints to authenticated;
grant select on h_ids, h_bigints to service_role;

insert into auth.users (id, email, aud, role)
select gen_random_uuid(), k || '@h.invalid', 'authenticated', 'authenticated'
from unnest(array['admin', 'worker']) as k;

insert into organization.legal_entities (name, organization_number)
values ('Phase H kommun', '212000-1200');

insert into organization.authorities (legal_entity_id, key, name)
select le.id, 'h_bygg', 'Phase H byggnadsnämnd'
from organization.legal_entities le
where le.organization_number = '212000-1200';

insert into organization.departments (authority_id, key, name)
select a.id, 'bygglov', 'Bygglov'
from organization.authorities a
where a.key = 'h_bygg';

insert into identity.users (auth_user_id, display_name, email, user_type)
select
  au.id,
  case when au.email like 'admin@%' then 'H Integrationsadmin' else 'H Handläggare' end,
  au.email,
  'STAFF'
from auth.users au
where au.email like '%@h.invalid';

insert into h_ids
select split_part(u.email, '@', 1), u.id
from identity.users u
where u.email like '%@h.invalid';

insert into h_ids
select 'sub_' || split_part(u.email, '@', 1), u.auth_user_id
from identity.users u
where u.email like '%@h.invalid';

insert into h_ids
select 'authority', a.id
from organization.authorities a
where a.key = 'h_bygg';

insert into h_ids
select 'department', d.id
from organization.departments d
join organization.authorities a on a.id = d.authority_id
where a.key = 'h_bygg' and d.key = 'bygglov';

insert into identity.user_memberships (user_id, authority_id, department_id, is_primary)
values
  (
    (select v from h_ids where k='admin'),
    (select v from h_ids where k='authority'),
    (select v from h_ids where k='department'),
    true
  ),
  (
    (select v from h_ids where k='worker'),
    (select v from h_ids where k='authority'),
    (select v from h_ids where k='department'),
    true
  );

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id
)
select
  (select v from h_ids where k='admin'),
  r.id,
  'AUTHORITY',
  (select v from h_ids where k='authority'),
  (select v from h_ids where k='authority')
from authz.roles r
where r.key = 'tenant_admin';

insert into authz.role_assignments (
  user_id, role_id, scope_type, scope_id, authority_id, department_id
)
select
  (select v from h_ids where k='worker'),
  r.id,
  'DEPARTMENT',
  (select v from h_ids where k='department'),
  (select v from h_ids where k='authority'),
  (select v from h_ids where k='department')
from authz.roles r
where r.key = 'building_case_worker';

insert into integration.connectors (
  key, name, connector_kind, capabilities, contract_version
)
values (
  'h-generic-file',
  'H Generic File',
  'GENERIC_FILE',
  '{"listCases":true}'::jsonb,
  '1'
);

insert into h_ids
select 'connector', c.id
from integration.connectors c
where c.key = 'h-generic-file';

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
values (
  (select v from h_ids where k='connector'),
  (select v from h_ids where k='authority'),
  'H fixture connector',
  'secret/h/generic-file',
  'sftp://example.invalid/inbox',
  '{"format":"JSONL","mapping_version":"h-1"}'::jsonb,
  'INBOUND',
  'ENABLED'
);

insert into h_ids
select 'instance', ci.id
from integration.connector_instances ci
where ci.name = 'H fixture connector'
  and ci.authority_id = (select v from h_ids where k='authority');

-- New persistent provenance must carry mapping version.
insert into integration.external_records (
  connector_instance_id,
  authority_id,
  entity_type,
  external_id,
  source_version,
  source_hash,
  mapping_version,
  raw_payload
)
values (
  (select v from h_ids where k='instance'),
  (select v from h_ids where k='authority'),
  'CASE',
  'legacy-1',
  '7',
  repeat('a', 64),
  'h-1',
  '{"id":"legacy-1"}'::jsonb
);

do $$
begin
  if not exists (
    select 1
    from integration.external_records er
    where er.connector_instance_id = (select v from h_ids where k='instance')
      and er.external_id = 'legacy-1'
      and er.mapping_version = 'h-1'
      and er.source_hash = repeat('a', 64)
  ) then
    raise exception 'H provenance did not persist source hash/mapping version';
  end if;

  if has_function_privilege(
    'authenticated',
    'integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'authenticated may execute service-only inbound receipt';
  end if;

  if not has_function_privilege(
    'service_role',
    'integration.receive_inbound_event(uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'service_role cannot execute inbound receipt';
  end if;

  if has_function_privilege(
    'authenticated',
    'integration.record_reconciliation(uuid,integer,integer,integer,integer,integer,integer,integer,integer,jsonb)',
    'EXECUTE'
  ) then
    raise exception 'authenticated may execute service-only reconciliation';
  end if;
end;
$$;

-- At-least-once inbound delivery: exactly one event row, duplicate evidence on replay.
do $$
declare
  v_first bigint;
  v_second bigint;
  v_duplicate boolean;
begin
  set local role service_role;

  select r.event_id, r.duplicate
  into v_first, v_duplicate
  from integration.receive_inbound_event(
    (select v from h_ids where k='instance'),
    'evt-h-1',
    'case.changed',
    repeat('1', 64),
    '{"event":{"id":"evt-h-1"},"case":{"id":"legacy-1"}}'::jsonb,
    repeat('b', 64),
    'h-1'
  ) r;

  if v_duplicate then
    raise exception 'First H inbound event was marked duplicate';
  end if;

  select r.event_id, r.duplicate
  into v_second, v_duplicate
  from integration.receive_inbound_event(
    (select v from h_ids where k='instance'),
    'evt-h-1',
    'case.changed',
    repeat('1', 64),
    '{"event":{"id":"evt-h-1"},"case":{"id":"legacy-1"}}'::jsonb,
    repeat('b', 64),
    'h-1'
  ) r;

  reset role;

  if not v_duplicate or v_first <> v_second then
    raise exception 'Duplicate inbound delivery did not resolve to the original event';
  end if;

  insert into h_bigints values ('event', v_first);
end;
$$;

do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from integration.integration_events e
  where e.connector_instance_id = (select v from h_ids where k='instance')
    and e.idempotency_key = repeat('1', 64)
    and e.mapping_version = 'h-1'
    and e.source_hash = repeat('b', 64)
    and e.duplicate_count = 1
    and e.last_duplicate_at is not null;

  if v_count <> 1 then
    raise exception 'H inbound idempotency evidence expected one event, got %', v_count;
  end if;
end;
$$;

-- Reconciliation records GREEN exact parity and RED drift, updating connector health.
do $$
declare
  v_green uuid;
  v_red uuid;
begin
  set local role service_role;

  select integration.record_reconciliation(
    (select v from h_ids where k='instance'),
    1, 1, 1, 0, 0, 0, 0, 0,
    '{"mapping_version":"h-1"}'::jsonb
  ) into v_green;

  select integration.record_reconciliation(
    (select v from h_ids where k='instance'),
    2, 1, 1, 1, 0, 0, 0, 0,
    '{"new_external_ids":["legacy-2"]}'::jsonb
  ) into v_red;

  reset role;

  insert into h_ids values ('recon_green', v_green), ('recon_red', v_red);
end;
$$;

do $$
begin
  if not exists (
    select 1
    from integration.reconciliation_runs r
    where r.id = (select v from h_ids where k='recon_green')
      and r.result = 'GREEN'
      and r.unchanged_count = 1
  ) then
    raise exception 'H GREEN reconciliation evidence missing';
  end if;

  if not exists (
    select 1
    from integration.reconciliation_runs r
    where r.id = (select v from h_ids where k='recon_red')
      and r.result = 'RED'
      and r.new_count = 1
  ) then
    raise exception 'H RED reconciliation evidence missing';
  end if;

  if not exists (
    select 1
    from integration.connector_instances ci
    where ci.id = (select v from h_ids where k='instance')
      and ci.health_status = 'DEGRADED'
      and ci.last_health_check_at is not null
  ) then
    raise exception 'Connector health did not reflect reconciliation drift';
  end if;
end;
$$;

create or replace function pg_temp.h_set_subject(p_key text)
returns void
language plpgsql
as $$
declare
  v_sub uuid := (select v from h_ids where k = 'sub_' || p_key);
begin
  execute 'set local role authenticated';
  execute format(
    'set local request.jwt.claims = %L',
    json_build_object('sub', v_sub, 'role', 'authenticated')::text
  );
end;
$$;

create or replace function pg_temp.h_clear_subject()
returns void
language plpgsql
as $$
begin
  reset role;
  execute 'set local request.jwt.claims = ' || quote_literal('{}');
end;
$$;

-- RLS: integration admin can inspect reconciliation, ordinary caseworker cannot.
do $$
declare
  v_count integer;
begin
  perform pg_temp.h_set_subject('admin');

  select count(*) into v_count
  from integration.reconciliation_runs
  where connector_instance_id = (select v from h_ids where k='instance');

  perform pg_temp.h_clear_subject();

  if v_count <> 2 then
    raise exception 'Integration admin expected two H reconciliation rows, got %', v_count;
  end if;

  perform pg_temp.h_set_subject('worker');

  select count(*) into v_count
  from integration.reconciliation_runs
  where connector_instance_id = (select v from h_ids where k='instance');

  perform pg_temp.h_clear_subject();

  if v_count <> 0 then
    raise exception 'Caseworker without integration.manage saw H reconciliation data';
  end if;
end;
$$;

-- Service audit chain records receipt, duplicate and reconciliation.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from audit.events e
  where e.authority_id = (select v from h_ids where k='authority')
    and e.actor_type = 'SERVICE'
    and e.source_system = 'integration'
    and e.action in (
      'integration.event.received',
      'integration.event.duplicate',
      'integration.reconciliation.completed'
    );

  if v_count < 4 then
    raise exception 'H service audit evidence incomplete, got %', v_count;
  end if;
end;
$$;

select 'PHASE H GENERIC INTEGRATION (transports/provenance/idempotency/reconciliation): GREEN'
  as result;

rollback;
