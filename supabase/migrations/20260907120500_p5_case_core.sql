-- Tryggsignal P5/P6 — canonical case core and the property anchor it needs.
-- Masterplan 20 (case model), 21 (system of record), 25 (property graph),
-- 32 (versioned classification), 50 (index the real query patterns).

create table core.classifications (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  process_type text not null,
  source text not null default 'TRYGGSIGNAL'
    check (source in ('TRYGGSIGNAL', 'BOVERKET', 'LOCAL', 'LEGACY')),
  created_at timestamptz not null default now()
);

create table core.classification_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  classification_id uuid not null references core.classifications (id) on delete restrict,
  version integer not null check (version >= 1),
  valid_from date not null,
  valid_to date,
  definition jsonb not null default '{}'::jsonb,
  source_version text,
  created_at timestamptz not null default now(),
  unique (classification_id, version),
  constraint classification_version_dates check (valid_to is null or valid_to > valid_from)
);

-- Masterplan 32: legacy/local/canonical/Boverket mapping, kept as data.
create table core.classification_mappings (
  id uuid primary key default extensions.gen_random_uuid(),
  classification_id uuid not null references core.classifications (id) on delete cascade,
  legacy_code text,
  local_code text,
  canonical_code text not null,
  boverket_code text,
  mapping_version text not null,
  created_at timestamptz not null default now()
);

create table property.properties (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  designation text not null,
  municipality_code text,
  -- Masterplan 25: every geodata object records where it came from.
  source text not null default 'LANTMATERIET',
  source_object_id text,
  source_version text,
  source_timestamp timestamptz,
  geometry extensions.geometry(MultiPolygon, 3006),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, designation)
);

create index properties_geometry_idx on property.properties using gist (geometry);
create index properties_designation_trgm_idx
  on property.properties using gin (designation extensions.gin_trgm_ops);
create index properties_source_idx on property.properties (source, source_object_id);

create trigger properties_set_updated_at before update on property.properties
  for each row execute function config.set_updated_at();

create table core.cases (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  department_id uuid references organization.departments (id) on delete restrict,
  case_number text not null,
  external_case_number text,
  classification_id uuid references core.classifications (id),
  classification_version integer,
  case_type text not null,
  process_type text not null check (process_type in (
    'BYGGLOV', 'ANMALAN', 'FORHANDSBESKED', 'RIVNINGSLOV', 'MARKLOV', 'PBL_TILLSYN', 'OVK'
  )),
  measure_type text,
  title text not null,
  description text,
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'RECEIVED', 'REGISTERED', 'AWAITING_COMPLETION', 'IN_REVIEW',
    'AWAITING_DECISION', 'DECIDED', 'CLOSED', 'ARCHIVED'
  )),
  phase text not null default 'INTAKE' check (phase in (
    'INTAKE', 'COMPLETENESS', 'REVIEW', 'DECISION', 'EXECUTION', 'FINAL_CLEARANCE', 'ARCHIVE'
  )),
  priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  assigned_user_id uuid references identity.users (id) on delete set null,
  assigned_team_id uuid references organization.teams (id) on delete set null,
  primary_property_id uuid references property.properties (id) on delete set null,
  information_class text not null default 'INTERNAL'
    check (information_class in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET')),
  secrecy_level integer not null default 0 check (secrecy_level between 0 and 4),
  -- Masterplan 21: overlay vs. cutover is a data property, not a deployment flag.
  source_system text,
  source_record_id text,
  source_updated_at timestamptz,
  last_synced_at timestamptz,
  system_of_record text not null default 'KOMMUN_OS',
  received_at timestamptz,
  registered_at timestamptz,
  complete_at timestamptz,
  started_at timestamptz,
  decided_at timestamptz,
  closed_at timestamptz,
  statutory_due_at timestamptz,
  effective_due_at timestamptz,
  workflow_version_id uuid,
  rule_set_version_id uuid,
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  updated_at timestamptz not null default now(),
  updated_by uuid references identity.users (id),
  archived_at timestamptz,
  archive_package_id uuid,
  unique (authority_id, case_number)
);

-- Masterplan 50: index the actual query patterns, including the RLS predicates.
create index cases_authority_status_idx on core.cases (authority_id, status);
create index cases_authority_assignee_status_idx
  on core.cases (authority_id, assigned_user_id, status);
create index cases_authority_team_status_idx
  on core.cases (authority_id, assigned_team_id, status);
create index cases_authority_due_idx on core.cases (authority_id, statutory_due_at)
  where status not in ('CLOSED', 'ARCHIVED');
create index cases_case_number_idx on core.cases (case_number);
create index cases_primary_property_idx on core.cases (primary_property_id);
create index cases_source_record_idx on core.cases (source_system, source_record_id);
create index cases_department_idx on core.cases (department_id);

create trigger cases_set_updated_at before update on core.cases
  for each row execute function config.set_updated_at();

create table core.case_status_history (
  id bigint generated always as identity primary key,
  case_id uuid not null references core.cases (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  from_status text,
  to_status text not null,
  from_phase text,
  to_phase text,
  changed_at timestamptz not null default now(),
  changed_by uuid references identity.users (id),
  reason text
);

create index case_status_history_case_idx on core.case_status_history (case_id, changed_at desc);

create or replace function core.record_case_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into core.case_status_history (case_id, authority_id, to_status, to_phase, changed_by)
    values (new.id, new.authority_id, new.status, new.phase, new.created_by);
  elsif new.status is distinct from old.status or new.phase is distinct from old.phase then
    insert into core.case_status_history (
      case_id, authority_id, from_status, to_status, from_phase, to_phase, changed_by
    )
    values (new.id, new.authority_id, old.status, new.status, old.phase, new.phase, new.updated_by);
  end if;
  return new;
end;
$$;

revoke all on function core.record_case_status_change() from public;

create trigger cases_status_history_insert
  after insert on core.cases
  for each row execute function core.record_case_status_change();

create trigger cases_status_history_update
  after update of status, phase on core.cases
  for each row execute function core.record_case_status_change();

create table core.case_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null references core.cases (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  assigned_user_id uuid references identity.users (id) on delete set null,
  assigned_team_id uuid references organization.teams (id) on delete set null,
  role_in_case text not null default 'HANDLAGGARE',
  assigned_at timestamptz not null default now(),
  assigned_by uuid references identity.users (id),
  unassigned_at timestamptz,
  constraint assignment_requires_target check (
    assigned_user_id is not null or assigned_team_id is not null
  )
);

create index case_assignments_case_idx on core.case_assignments (case_id)
  where unassigned_at is null;

create table core.parties (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  party_type text not null check (party_type in ('PERSON', 'ORGANIZATION')),
  display_name text not null,
  organization_number text,
  -- Personal identity numbers are minimized: only a reference is stored here and
  -- the value lives in the population-register adapter scope (masterplan 30).
  person_reference text,
  contact_email text,
  contact_phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index parties_authority_idx on core.parties (authority_id);
create index parties_org_number_idx on core.parties (organization_number);

create table core.case_parties (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null references core.cases (id) on delete cascade,
  party_id uuid not null references core.parties (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  relationship text not null check (relationship in (
    'APPLICANT', 'REPRESENTATIVE', 'PROPERTY_OWNER', 'NEIGHBOUR', 'CONTROL_RESPONSIBLE', 'OTHER'
  )),
  -- Masterplan 17/96: the verified link that lets an external user reach a case.
  identity_user_id uuid references identity.users (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (case_id, party_id, relationship)
);

create index case_parties_case_idx on core.case_parties (case_id);
create index case_parties_identity_idx on core.case_parties (identity_user_id)
  where identity_user_id is not null;

create table core.case_properties (
  case_id uuid not null references core.cases (id) on delete cascade,
  property_id uuid not null references property.properties (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (case_id, property_id)
);

create index case_properties_property_idx on core.case_properties (property_id);

create trigger parties_set_updated_at before update on core.parties
  for each row execute function config.set_updated_at();

alter table core.classifications enable row level security;
alter table core.classification_versions enable row level security;
alter table core.classification_mappings enable row level security;
alter table core.cases enable row level security;
alter table core.case_status_history enable row level security;
alter table core.case_assignments enable row level security;
alter table core.parties enable row level security;
alter table core.case_parties enable row level security;
alter table core.case_properties enable row level security;
alter table property.properties enable row level security;
