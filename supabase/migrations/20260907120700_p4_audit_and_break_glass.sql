-- Tryggsignal — audit trail and break-glass support access.
-- Masterplan 80 (append-only audit with hash chaining), 81 (no standing platform
-- superadmin read access), 82 (information classification).

create table audit.events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor uuid references identity.users (id),
  actor_type text not null default 'USER'
    check (actor_type in ('USER', 'SERVICE', 'SYSTEM', 'SUPPORT')),
  authority_id uuid references organization.authorities (id),
  action text not null,
  resource_type text not null,
  resource_id uuid,
  purpose text,
  ip inet,
  session_id text,
  correlation_id uuid,
  trace_id uuid,
  source_system text,
  before_hash text,
  after_hash text,
  previous_event_hash text,
  event_hash text not null
);

create index audit_events_authority_idx on audit.events (authority_id, occurred_at desc);
create index audit_events_resource_idx on audit.events (resource_type, resource_id, occurred_at desc);
create index audit_events_actor_idx on audit.events (actor, occurred_at desc);

-- Masterplan 80: each event is chained to the previous one, so a silent deletion
-- or edit of history is detectable.
create or replace function audit.chain_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text;
begin
  select e.event_hash into v_previous
  from audit.events e
  order by e.id desc
  limit 1;

  new.previous_event_hash := v_previous;
  new.event_hash := encode(
    extensions.digest(
      coalesce(v_previous, '') ||
      coalesce(new.actor::text, '') || new.actor_type || new.action || new.resource_type ||
      coalesce(new.resource_id::text, '') || coalesce(new.before_hash, '') ||
      coalesce(new.after_hash, '') || new.occurred_at::text,
      'sha256'
    ),
    'hex'
  );
  return new;
end;
$$;

revoke all on function audit.chain_event() from public;

create trigger audit_events_chain
  before insert on audit.events
  for each row execute function audit.chain_event();

-- Append-only: no role receives UPDATE or DELETE, and the revoke is explicit so
-- a future default-privilege change cannot re-grant it silently.
revoke update, delete, truncate on audit.events from public;
revoke update, delete, truncate on audit.events from anon, authenticated;

alter table audit.events enable row level security;
grant usage on schema audit to authenticated;
grant select on audit.events to authenticated;

create policy audit_events_select on audit.events
  for select to authenticated
  using (
    authority_id is not null
    and authz.has_permission('audit.read', authority_id, null, null)
  );

-- Writing an audit event is a privileged operation performed on behalf of the
-- caller; the caller may never choose the actor or forge the chain.
create or replace function audit.record(
  p_action text,
  p_resource_type text,
  p_resource_id uuid,
  p_authority_id uuid,
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
  insert into audit.events (
    actor, actor_type, authority_id, action, resource_type, resource_id,
    purpose, correlation_id, before_hash, after_hash, event_hash
  )
  values (
    (select authz.current_user_id()), 'USER', p_authority_id, p_action, p_resource_type,
    p_resource_id, p_purpose, p_correlation_id, p_before_hash, p_after_hash, ''
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function audit.record(text, text, uuid, uuid, text, uuid, text, text) from public;
grant execute on function audit.record(text, text, uuid, uuid, text, uuid, text, text) to authenticated;

-- Masterplan 81: support access is requested, approved, time-limited and audited.
create table audit.break_glass_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  requested_by uuid not null references identity.users (id),
  authority_id uuid not null references organization.authorities (id),
  reason text not null check (length(reason) >= 20),
  requested_at timestamptz not null default now(),
  approved_by uuid references identity.users (id),
  approved_at timestamptz,
  mfa_verified boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED', 'APPROVED', 'DENIED', 'EXPIRED', 'REVOKED')),
  constraint approval_requires_mfa_and_expiry check (
    status <> 'APPROVED' or (mfa_verified and expires_at is not null and approved_by is not null)
  ),
  constraint approval_window_is_bounded check (
    expires_at is null or expires_at <= requested_at + interval '8 hours'
  )
);

create index break_glass_active_idx on audit.break_glass_requests (authority_id, expires_at)
  where status = 'APPROVED';

alter table audit.break_glass_requests enable row level security;
grant select on audit.break_glass_requests to authenticated;

create policy break_glass_select on audit.break_glass_requests
  for select to authenticated
  using (
    requested_by = (select authz.current_user_id())
    or authz.has_permission('security.manage', authority_id, null, null)
  );
