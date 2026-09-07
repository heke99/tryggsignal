-- Tryggsignal P34 — brand/domain foundation (control plane).
-- Masterplan 4 (control plane contents), 162 (tenant_domains), 163 (tenant_branding),
-- 172 (tenant_deployments), 193 (provisioning state), 195 (domain change audit).
--
-- This schema holds tenant registry and deployment metadata only. Municipal case
-- content lives in each municipality's own data plane and never here.

create type platform.tenant_status as enum (
  'PROVISIONING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'OFFBOARDED'
);

create type platform.domain_type as enum (
  'PLATFORM_SUBDOMAIN', 'CUSTOM_DOMAIN', 'PLATFORM_RESERVED'
);

create type platform.domain_status as enum (
  'PENDING', 'AWAITING_DNS', 'VERIFYING', 'VERIFIED', 'ACTIVE', 'FAILED', 'DISABLED', 'REMOVED'
);

create type platform.branding_status as enum ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

create type platform.deployment_status as enum ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DECOMMISSIONED');

create type platform.provisioning_state as enum (
  'REQUESTED',
  'TENANT_CREATED',
  'DATA_PLANE_PROVISIONED',
  'SCHEMA_APPLIED',
  'BRANDING_DRAFTED',
  'PLATFORM_DOMAIN_ACTIVE',
  'CUSTOM_DOMAIN_PENDING',
  'CUSTOM_DOMAIN_ACTIVE',
  'READY',
  'FAILED'
);

-- Masterplan 161: reserved subdomains are data, so the list can be extended
-- without a code deploy, and slug validation is enforced by the database too.
create table platform.reserved_subdomains (
  label text primary key check (label = lower(label) and label ~ '^[a-z0-9-]{1,63}$'),
  reason text not null,
  created_at timestamptz not null default now()
);

insert into platform.reserved_subdomains (label, reason) values
  ('www', 'platform'), ('app', 'platform gateway'), ('kommuner', 'tenant discovery'),
  ('admin', 'platform admin'), ('api', 'platform api'), ('docs', 'documentation'),
  ('status', 'status page'), ('auth', 'authentication'), ('support', 'support'),
  ('mail', 'email infrastructure'), ('notify', 'notifications'), ('assets', 'static assets'),
  ('cdn', 'static assets'), ('test', 'environment'), ('preview', 'environment'),
  ('staging', 'environment'), ('platform', 'platform admin'), ('security', 'platform'),
  ('billing', 'platform'), ('internal', 'platform'), ('metrics', 'platform'),
  ('webhooks', 'platform');

create table platform.tenants (
  id uuid primary key default extensions.gen_random_uuid(),
  slug text not null unique
    check (slug = lower(slug) and slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display_name text not null,
  legal_name text,
  municipality_code text,
  status platform.tenant_status not null default 'PROVISIONING',
  operating_mode text not null default 'OVERLAY'
    check (operating_mode in ('OVERLAY', 'COEXISTENCE', 'SYSTEM_OF_RECORD')),
  canonical_hostname text not null,
  branding_version integer not null default 1 check (branding_version >= 1),
  auth_configuration_reference text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  suspended_at timestamptz,
  offboarded_at timestamptz
);

-- A tenant slug may never collide with a reserved platform subdomain.
create or replace function platform.assert_slug_not_reserved()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from platform.reserved_subdomains r where r.label = new.slug) then
    raise exception 'Tenant slug "%" is a reserved platform subdomain', new.slug
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function platform.assert_slug_not_reserved() from public;

create trigger tenants_slug_not_reserved
  before insert or update of slug on platform.tenants
  for each row execute function platform.assert_slug_not_reserved();

create trigger tenants_set_updated_at
  before update on platform.tenants
  for each row execute function config.set_updated_at();

-- Masterplan 172: one data plane per municipality. Credentials are stored as a
-- SecretProvider reference, never as a value.
create table platform.tenant_deployments (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  environment text not null default 'PRODUCTION'
    check (environment in ('DEV', 'TEST', 'CUSTOMER_TEST', 'PRODUCTION')),
  supabase_project_ref text not null,
  supabase_region text not null default 'eu-north-1',
  supabase_url text not null check (supabase_url ~ '^https://'),
  publishable_key text not null,
  privileged_credential_reference text not null
    check (privileged_credential_reference !~* '^(eyJ|sb_secret|service_role)'),
  schema_version text not null,
  rules_version text,
  application_compatibility_version text,
  status platform.deployment_status not null default 'PROVISIONING',
  health_status text not null default 'UNKNOWN'
    check (health_status in ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  last_health_check_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, environment),
  unique (supabase_project_ref, environment)
);

comment on column platform.tenant_deployments.privileged_credential_reference is
  'SecretProvider reference (masterplan 173). A literal credential here is a security incident.';

create trigger tenant_deployments_set_updated_at
  before update on platform.tenant_deployments
  for each row execute function config.set_updated_at();

-- Masterplan 162.
create table platform.tenant_domains (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  hostname text not null,
  normalized_hostname text not null unique
    check (normalized_hostname = lower(normalized_hostname) and length(normalized_hostname) <= 253),
  domain_type platform.domain_type not null,
  status platform.domain_status not null default 'PENDING',
  is_canonical boolean not null default false,
  is_fallback boolean not null default false,
  vercel_project_id text,
  provider_domain_id text,
  ownership_status text not null default 'UNVERIFIED'
    check (ownership_status in ('UNVERIFIED', 'PENDING', 'VERIFIED', 'FAILED')),
  dns_status text not null default 'UNKNOWN'
    check (dns_status in ('UNKNOWN', 'MISSING', 'MISCONFIGURED', 'OK')),
  tls_status text not null default 'UNKNOWN'
    check (tls_status in ('UNKNOWN', 'PENDING', 'ISSUED', 'FAILED', 'EXPIRING')),
  verification_token_reference text,
  created_at timestamptz not null default now(),
  created_by uuid,
  verified_at timestamptz,
  activated_at timestamptz,
  disabled_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  -- Masterplan 168: a domain may only go ACTIVE once ownership, DNS and TLS hold.
  constraint domain_active_requires_verification check (
    status <> 'ACTIVE'
    or (ownership_status = 'VERIFIED' and dns_status = 'OK' and tls_status = 'ISSUED')
  )
);

-- Exactly one canonical domain per tenant (masterplan 169).
create unique index tenant_domains_one_canonical
  on platform.tenant_domains (tenant_id)
  where is_canonical;

create index tenant_domains_tenant_status_idx
  on platform.tenant_domains (tenant_id, status);

create index tenant_domains_active_lookup_idx
  on platform.tenant_domains (normalized_hostname)
  where status = 'ACTIVE';

-- Masterplan 167: a hostname released by one tenant may not be silently taken
-- over by another. Removal keeps a tombstone that provisioning must check.
create table platform.domain_release_history (
  id uuid primary key default extensions.gen_random_uuid(),
  normalized_hostname text not null,
  previous_tenant_id uuid not null references platform.tenants (id),
  released_at timestamptz not null default now(),
  released_by uuid,
  reason text not null
);

create index domain_release_history_host_idx
  on platform.domain_release_history (normalized_hostname, released_at desc);

-- Masterplan 163: versioned branding.
create table platform.tenant_branding (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  version integer not null check (version >= 1),
  display_name text not null,
  short_name text,
  logo_asset_id uuid,
  logo_dark_asset_id uuid,
  favicon_asset_id uuid,
  primary_color text not null check (primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color text check (secondary_color ~ '^#[0-9a-f]{6}$'),
  accent_color text check (accent_color ~ '^#[0-9a-f]{6}$'),
  surface_variant text check (surface_variant ~ '^#[0-9a-f]{6}$'),
  support_email text,
  support_phone text,
  privacy_url text,
  accessibility_statement_url text,
  terms_url text,
  login_heading text,
  login_subheading text,
  show_tryggsignal_branding boolean not null default true,
  locale text not null default 'sv-SE',
  -- Masterplan 154: a theme may not be published until contrast has been validated.
  contrast_validation_status text not null default 'NOT_VALIDATED'
    check (contrast_validation_status in ('NOT_VALIDATED', 'PASSED', 'FAILED')),
  status platform.branding_status not null default 'DRAFT',
  created_at timestamptz not null default now(),
  created_by uuid,
  published_at timestamptz,
  published_by uuid,
  supersedes_id uuid references platform.tenant_branding (id),
  unique (tenant_id, version),
  constraint branding_published_requires_contrast check (
    status <> 'PUBLISHED' or contrast_validation_status = 'PASSED'
  )
);

create unique index tenant_branding_one_published
  on platform.tenant_branding (tenant_id)
  where status = 'PUBLISHED';

-- Masterplan 193.
create table platform.tenant_provisioning_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  state platform.provisioning_state not null default 'REQUESTED',
  requested_by uuid,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  last_error text,
  correlation_id uuid not null default extensions.gen_random_uuid()
);

create trigger tenant_provisioning_runs_set_updated_at
  before update on platform.tenant_provisioning_runs
  for each row execute function config.set_updated_at();

-- Masterplan 195: every domain and branding change is auditable in the control plane.
create table platform.domain_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  tenant_id uuid not null references platform.tenants (id),
  domain_id uuid references platform.tenant_domains (id),
  event_type text not null,
  actor uuid,
  actor_type text not null default 'USER'
    check (actor_type in ('USER', 'SERVICE', 'SYSTEM')),
  from_status platform.domain_status,
  to_status platform.domain_status,
  detail jsonb not null default '{}'::jsonb,
  correlation_id uuid
);

create index domain_events_tenant_idx on platform.domain_events (tenant_id, occurred_at desc);

create or replace function platform.record_domain_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into platform.domain_events (tenant_id, domain_id, event_type, from_status, to_status, detail)
  values (
    new.tenant_id,
    new.id,
    case when tg_op = 'INSERT' then 'DOMAIN_CREATED' else 'DOMAIN_STATUS_CHANGED' end,
    case when tg_op = 'UPDATE' then old.status else null end,
    new.status,
    jsonb_build_object('hostname', new.normalized_hostname, 'domain_type', new.domain_type)
  );
  return new;
end;
$$;

revoke all on function platform.record_domain_event() from public;

create trigger tenant_domains_audit_insert
  after insert on platform.tenant_domains
  for each row execute function platform.record_domain_event();

create trigger tenant_domains_audit_status
  after update of status on platform.tenant_domains
  for each row when (old.status is distinct from new.status)
  execute function platform.record_domain_event();

-- Control-plane tables are server-side only for now: RLS is enabled and no
-- policy is granted to anon/authenticated, so the tables are unreadable from a
-- client key even if the schema is ever exposed (masterplan 18/174).
alter table platform.tenants enable row level security;
alter table platform.tenant_deployments enable row level security;
alter table platform.tenant_domains enable row level security;
alter table platform.tenant_branding enable row level security;
alter table platform.tenant_provisioning_runs enable row level security;
alter table platform.domain_events enable row level security;
alter table platform.reserved_subdomains enable row level security;
alter table platform.domain_release_history enable row level security;
