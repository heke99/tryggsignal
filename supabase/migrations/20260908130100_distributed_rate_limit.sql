-- Tryggsignal P38/P29 — distributed rate-limit buckets.
-- The application hashes the subject before it reaches this table; no raw IP
-- address is stored here. The function is service-role-only so browser clients
-- cannot spend another tenant's budget or reset counters.

create table platform.rate_limit_buckets (
  bucket_key text primary key,
  request_count integer not null check (request_count > 0),
  window_started_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table platform.rate_limit_buckets enable row level security;

comment on table platform.rate_limit_buckets is
  'Distributed rate-limit state. Server-only, RLS enabled with no client policy. Subjects are HMAC-hashed before storage.';

create index rate_limit_buckets_expiry_idx
  on platform.rate_limit_buckets (expires_at);

create or replace function public.consume_rate_limit(
  p_bucket_key text,
  p_window_seconds integer,
  p_limit integer
)
returns table (
  allowed boolean,
  remaining integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_expires timestamptz;
begin
  if p_bucket_key is null or length(p_bucket_key) < 16 then
    raise exception 'invalid rate-limit key';
  end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'invalid rate-limit window';
  end if;
  if p_limit < 1 or p_limit > 1000000 then
    raise exception 'invalid rate-limit limit';
  end if;

  insert into platform.rate_limit_buckets (
    bucket_key, request_count, window_started_at, expires_at, updated_at
  )
  values (
    p_bucket_key, 1, v_now, v_now + make_interval(secs => p_window_seconds), v_now
  )
  on conflict (bucket_key) do update
  set
    request_count = case
      when platform.rate_limit_buckets.expires_at <= v_now then 1
      else platform.rate_limit_buckets.request_count + 1
    end,
    window_started_at = case
      when platform.rate_limit_buckets.expires_at <= v_now then v_now
      else platform.rate_limit_buckets.window_started_at
    end,
    expires_at = case
      when platform.rate_limit_buckets.expires_at <= v_now
        then v_now + make_interval(secs => p_window_seconds)
      else platform.rate_limit_buckets.expires_at
    end,
    updated_at = v_now
  returning request_count, expires_at into v_count, v_expires;

  return query
  select
    v_count <= p_limit,
    greatest(0, p_limit - v_count),
    v_expires;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer) from public;
revoke all on function public.consume_rate_limit(text, integer, integer) from anon;
revoke all on function public.consume_rate_limit(text, integer, integer) from authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;
