-- Tryggsignal P6 — property graph.
-- Masterplan 25: properties, identifiers, addresses, buildings, spatial features and
-- relations, all carrying source/version/timestamp provenance and PostGIS geometry.

create table property.property_identifiers (
  id uuid primary key default extensions.gen_random_uuid(),
  property_id uuid not null references property.properties (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  identifier_type text not null check (identifier_type in (
    'FASTIGHETSBETECKNING', 'UUID_LM', 'LEGACY_KEY', 'ORGANIZATION_KEY', 'OTHER'
  )),
  value text not null,
  is_current boolean not null default true,
  valid_from date,
  valid_to date,
  source text not null,
  source_object_id text,
  source_version text,
  source_timestamp timestamptz,
  created_at timestamptz not null default now(),
  unique (property_id, identifier_type, value)
);

create index property_identifiers_value_idx on property.property_identifiers (identifier_type, value);
create index property_identifiers_authority_idx on property.property_identifiers (authority_id);

create table property.addresses (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  property_id uuid references property.properties (id) on delete set null,
  street_name text not null,
  street_number text,
  letter text,
  postal_code text,
  postal_town text,
  municipality_code text,
  point extensions.geometry(Point, 3006),
  source text not null default 'LANTMATERIET',
  source_object_id text,
  source_version text,
  source_timestamp timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index addresses_property_idx on property.addresses (property_id);
create index addresses_authority_idx on property.addresses (authority_id);
create index addresses_point_idx on property.addresses using gist (point);
create index addresses_street_trgm_idx
  on property.addresses using gin (street_name extensions.gin_trgm_ops);

create table property.buildings (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  property_id uuid references property.properties (id) on delete set null,
  building_designation text,
  building_purpose text,
  year_built integer check (year_built is null or year_built between 1000 and 2200),
  gross_floor_area numeric(12, 2),
  floors integer,
  footprint extensions.geometry(MultiPolygon, 3006),
  source text not null default 'LANTMATERIET',
  source_object_id text,
  source_version text,
  source_timestamp timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index buildings_property_idx on property.buildings (property_id);
create index buildings_authority_idx on property.buildings (authority_id);
create index buildings_footprint_idx on property.buildings using gist (footprint);
create index buildings_source_idx on property.buildings (source, source_object_id);

-- Masterplan 33: national reference layers (protected nature, cultural heritage,
-- soil, roads, …). Never authoritative for a decision unless explicitly registered
-- as such in integration.data_sources.
create table property.spatial_features (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid references organization.authorities (id) on delete restrict,
  feature_type text not null,
  layer_key text not null,
  name text,
  geometry extensions.geometry(Geometry, 3006) not null,
  source text not null,
  source_object_id text,
  source_version text,
  source_timestamp timestamptz,
  authoritative_level text not null default 'REFERENCE'
    check (authoritative_level in ('AUTHORITATIVE', 'REFERENCE', 'ADVISORY', 'DERIVED', 'AI_DERIVED')),
  attributes jsonb not null default '{}'::jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (layer_key, source, source_object_id, source_version)
);

create index spatial_features_geometry_idx on property.spatial_features using gist (geometry);
create index spatial_features_layer_idx on property.spatial_features (layer_key, feature_type);
create index spatial_features_authority_idx on property.spatial_features (authority_id);

create table property.property_relations (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  from_property_id uuid not null references property.properties (id) on delete cascade,
  to_property_id uuid not null references property.properties (id) on delete cascade,
  relation_type text not null check (relation_type in (
    'NEIGHBOUR', 'SUBDIVIDED_FROM', 'MERGED_INTO', 'SAMFALLIGHET', 'EASEMENT', 'OTHER'
  )),
  source text not null,
  source_version text,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  constraint relation_not_self check (from_property_id <> to_property_id),
  unique (from_property_id, to_property_id, relation_type)
);

create index property_relations_to_idx on property.property_relations (to_property_id);
create index property_relations_authority_idx on property.property_relations (authority_id);

create trigger addresses_set_updated_at before update on property.addresses
  for each row execute function config.set_updated_at();
create trigger buildings_set_updated_at before update on property.buildings
  for each row execute function config.set_updated_at();

alter table property.property_identifiers enable row level security;
alter table property.addresses enable row level security;
alter table property.buildings enable row level security;
alter table property.spatial_features enable row level security;
alter table property.property_relations enable row level security;

grant select on property.property_identifiers, property.addresses, property.buildings,
  property.spatial_features, property.property_relations to authenticated;

create policy property_identifiers_select on property.property_identifiers
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy addresses_select on property.addresses
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy buildings_select on property.buildings
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy property_relations_select on property.property_relations
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

-- National reference layers with no authority binding are shared reference data
-- inside the municipality's own data plane; a layer bound to an authority stays
-- scoped to it.
create policy spatial_features_select on property.spatial_features
  for select to authenticated
  using (
    authority_id is null
    or authority_id in (select authz.assigned_authority_ids())
  );
