-- Tryggsignal P2 — Supabase foundation.
-- Masterplan 11 (logical schemas), 12 (extensions), 18 (default deny posture).
--
-- Default posture: `anon` and `authenticated` receive no privileges on a business
-- schema unless a later migration grants them explicitly, table by table, together
-- with RLS policies.

create schema if not exists extensions;

-- Masterplan 12: only extensions that are actually needed are enabled.
-- `vector` is deliberately NOT enabled until semantic search is implemented (P20).
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists postgis with schema extensions;

create schema if not exists platform;      -- control plane: tenants, domains, branding, deployments
create schema if not exists organization;  -- legal entities, authorities, departments, units, teams
create schema if not exists identity;      -- internal users and identity provider mapping
create schema if not exists authz;         -- roles, permissions, assignments, policy functions
create schema if not exists core;          -- cases and the canonical case graph
create schema if not exists property;      -- properties, addresses, buildings, spatial features
create schema if not exists documents;
create schema if not exists workflow;
create schema if not exists rules;
create schema if not exists communication;
create schema if not exists referral;
create schema if not exists decision;
create schema if not exists inspection;
create schema if not exists compliance;
create schema if not exists integration;
create schema if not exists migration;
create schema if not exists search;
create schema if not exists ai;
create schema if not exists audit;
create schema if not exists archive;
create schema if not exists reporting;
create schema if not exists config;

comment on schema platform is 'Control plane. Tenant registry, domains, branding, deployment metadata. Never municipal case content (masterplan 4).';
comment on schema audit is 'Append-only audit trail (masterplan 80). No normal role may UPDATE or DELETE.';

do $$
declare
  target_schema text;
begin
  foreach target_schema in array array[
    'platform','organization','identity','authz','core','property','documents','workflow',
    'rules','communication','referral','decision','inspection','compliance','integration',
    'migration','search','ai','audit','archive','reporting','config'
  ]
  loop
    -- Revoke the implicit CREATE/USAGE that would otherwise reach client roles.
    execute format('revoke all on schema %I from public', target_schema);
    execute format('revoke all on schema %I from anon, authenticated', target_schema);
    -- No blanket table privileges: each table is granted explicitly with its policies.
    execute format(
      'alter default privileges in schema %I revoke all on tables from anon, authenticated',
      target_schema
    );
  end loop;
end
$$;

-- Shared updated_at trigger. Owned by the schema, not by application code.
create or replace function config.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function config.set_updated_at() from public;
