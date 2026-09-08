-- Tryggsignal P38 — per-tenant identity configuration.
-- Masterplan 15 (Entra ID primary for staff, Sweden Connect for external),
-- 116, 178 (auth per tenant), 173 (credentials by reference only).

create type platform.identity_provider_kind as enum (
  'SUPABASE_PASSWORD', 'ENTRA_ID', 'SAML', 'OIDC', 'SWEDEN_CONNECT'
);

create type platform.auth_audience as enum ('STAFF', 'EXTERNAL');

create table platform.tenant_auth_configurations (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references platform.tenants (id) on delete restrict,
  reference text not null unique,
  audience platform.auth_audience not null,
  kind platform.identity_provider_kind not null,
  display_name text not null,
  issuer text,
  metadata_url text check (metadata_url is null or metadata_url ~ '^https://'),
  -- Masterplan 173/85: a reference into the secret provider, never a secret.
  credential_reference text
    check (credential_reference is null or credential_reference !~* '^(eyJ|sb_secret|Bearer )'),
  allowed_email_domains text[] not null default array[]::text[],
  environment text not null default 'PRODUCTION'
    check (environment in ('DEV', 'TEST', 'CUSTOMER_TEST', 'PRODUCTION')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, audience, kind, environment),
  -- A federated provider is unusable without a credential; saying so here stops a
  -- half-configured provider from ever being marked enabled.
  constraint federated_provider_needs_credential check (
    not enabled
    or kind = 'SUPABASE_PASSWORD'
    or credential_reference is not null
  ),
  -- Masterplan 15: Sweden Connect must not be enabled in production before the
  -- official connection is available and tested.
  constraint sweden_connect_not_in_production check (
    kind <> 'SWEDEN_CONNECT' or environment <> 'PRODUCTION' or not enabled
  )
);

create index tenant_auth_configurations_tenant_idx
  on platform.tenant_auth_configurations (tenant_id, audience)
  where enabled;

create trigger tenant_auth_configurations_set_updated_at
  before update on platform.tenant_auth_configurations
  for each row execute function config.set_updated_at();

-- Control plane: server-side only, like the rest of platform.*
alter table platform.tenant_auth_configurations enable row level security;

comment on table platform.tenant_auth_configurations is
  'Per-tenant identity configuration. Server-side only: RLS is enabled with no policy and no client grant (masterplan 174).';

-- Masterplan 14: signing in must never create a second identity for the same
-- person. The link between the auth user and the internal user is made once,
-- explicitly, and an unknown subject is rejected rather than provisioned.
create or replace function identity.link_auth_user(
  p_auth_user_id uuid,
  p_external_subject text,
  p_identity_provider text,
  p_email text,
  p_display_name text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select u.id into v_user_id
  from identity.users u
  where u.identity_provider = p_identity_provider
    and u.external_subject = p_external_subject;

  if v_user_id is null and p_email is not null then
    select u.id into v_user_id
    from identity.users u
    where lower(u.email) = lower(p_email)
      and u.external_subject is null;
  end if;

  if v_user_id is null then
    -- No pre-provisioned account: the municipality decides who may work in the
    -- system, so a stranger with a valid federated token is still not a user.
    return null;
  end if;

  update identity.users
  set auth_user_id = p_auth_user_id,
      external_subject = coalesce(external_subject, p_external_subject),
      identity_provider = p_identity_provider,
      email = coalesce(p_email, email),
      display_name = coalesce(nullif(p_display_name, ''), display_name),
      last_login_at = now()
  where id = v_user_id
    and status = 'ACTIVE';

  if not found then
    return null;
  end if;

  return v_user_id;
end;
$$;

revoke all on function identity.link_auth_user(uuid, text, text, text, text) from public;
