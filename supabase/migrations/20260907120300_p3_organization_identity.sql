-- Tryggsignal P3 — organization and identity.
-- Masterplan 13 (hierarchy, authority as security boundary), 14 (identity.users),
-- 15 (Entra ID / Sweden Connect identity providers).

create table organization.legal_entities (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  organization_number text unique,
  municipality_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Masterplan 13: `authority` (nämnd) is a security boundary. Nothing may assume
-- that two authorities inside the same municipality share information.
create table organization.authorities (
  id uuid primary key default extensions.gen_random_uuid(),
  legal_entity_id uuid not null references organization.legal_entities (id) on delete restrict,
  key text not null,
  name text not null,
  authority_type text not null default 'NAMND'
    check (authority_type in ('NAMND', 'FORVALTNING', 'KOMMUNSTYRELSE', 'OTHER')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, key)
);

create table organization.departments (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, key)
);

create table organization.units (
  id uuid primary key default extensions.gen_random_uuid(),
  department_id uuid not null references organization.departments (id) on delete restrict,
  -- Denormalized for RLS: policies must not have to walk the hierarchy.
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, key)
);

create table organization.teams (
  id uuid primary key default extensions.gen_random_uuid(),
  unit_id uuid references organization.units (id) on delete restrict,
  department_id uuid not null references organization.departments (id) on delete restrict,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (department_id, key)
);

create index departments_authority_idx on organization.departments (authority_id);
create index units_authority_idx on organization.units (authority_id);
create index teams_authority_idx on organization.teams (authority_id);

-- Masterplan 14: business logic references identity.users, never auth.users directly.
create table identity.users (
  id uuid primary key default extensions.gen_random_uuid(),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  external_subject text,
  identity_provider text not null default 'SUPABASE'
    check (identity_provider in ('SUPABASE', 'ENTRA_ID', 'SAML', 'OIDC', 'SWEDEN_CONNECT', 'SERVICE')),
  email text,
  display_name text not null,
  employee_id text,
  user_type text not null default 'STAFF'
    check (user_type in ('STAFF', 'EXTERNAL', 'SERVICE')),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'DISABLED', 'PENDING')),
  last_login_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (identity_provider, external_subject)
);

create index users_email_idx on identity.users (lower(email));
create index users_status_idx on identity.users (status) where status = 'ACTIVE';

create table identity.user_memberships (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references identity.users (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  department_id uuid references organization.departments (id) on delete restrict,
  unit_id uuid references organization.units (id) on delete restrict,
  team_id uuid references organization.teams (id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, authority_id, department_id, unit_id, team_id)
);

create index user_memberships_user_idx on identity.user_memberships (user_id);
create index user_memberships_authority_idx on identity.user_memberships (authority_id);

create trigger legal_entities_set_updated_at before update on organization.legal_entities
  for each row execute function config.set_updated_at();
create trigger authorities_set_updated_at before update on organization.authorities
  for each row execute function config.set_updated_at();
create trigger departments_set_updated_at before update on organization.departments
  for each row execute function config.set_updated_at();
create trigger units_set_updated_at before update on organization.units
  for each row execute function config.set_updated_at();
create trigger teams_set_updated_at before update on organization.teams
  for each row execute function config.set_updated_at();
create trigger users_set_updated_at before update on identity.users
  for each row execute function config.set_updated_at();

alter table organization.legal_entities enable row level security;
alter table organization.authorities enable row level security;
alter table organization.departments enable row level security;
alter table organization.units enable row level security;
alter table organization.teams enable row level security;
alter table identity.users enable row level security;
alter table identity.user_memberships enable row level security;
