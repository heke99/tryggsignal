-- Tryggsignal P7 — document engine and storage.
-- Masterplan 35 (immutable versions), 36 (ingestion pipeline), 37 (buckets),
-- 82 (information class), 83 (file security).

create table documents.documents (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  document_type text not null,
  title text not null,
  description text,
  information_class text not null default 'INTERNAL'
    check (information_class in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET')),
  secrecy_level integer not null default 0 check (secrecy_level between 0 and 4),
  current_version integer not null default 0,
  -- Masterplan 21: a document can be owned by a legacy system during overlay.
  system_of_record text not null default 'KOMMUN_OS',
  source_system text,
  source_document_id text,
  source_updated_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index documents_case_idx on documents.documents (case_id);
create index documents_case_type_idx on documents.documents (case_id, document_type);
create index documents_source_idx on documents.documents (source_system, source_document_id);
create index documents_authority_idx on documents.documents (authority_id);

-- Masterplan 35: the original file is an immutable version. A new file is a new
-- version; a version row is never updated in place.
create table documents.document_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  document_id uuid not null references documents.documents (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  version integer not null check (version >= 1),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null,
  detected_mime_type text,
  size_bytes bigint not null check (size_bytes >= 0),
  storage_bucket text not null,
  storage_path text not null,
  original_filename text,
  source text not null default 'UPLOAD',
  source_document_id text,
  -- Masterplan 36: a version is only usable after the pipeline has cleared it.
  ingestion_status text not null default 'QUARANTINED' check (ingestion_status in (
    'QUARANTINED', 'VALIDATING', 'SCANNING', 'CLEAN', 'REJECTED', 'FAILED'
  )),
  rejection_reason text,
  scanned_at timestamptz,
  text_extracted_at timestamptz,
  extracted_text text,
  page_count integer,
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  unique (document_id, version),
  unique (storage_bucket, storage_path)
);

create index document_versions_sha_idx on documents.document_versions (sha256);
create index document_versions_document_idx on documents.document_versions (document_id, version desc);
create index document_versions_status_idx on documents.document_versions (ingestion_status)
  where ingestion_status <> 'CLEAN';
create index document_versions_authority_idx on documents.document_versions (authority_id);

create table documents.document_relations (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  from_document_id uuid not null references documents.documents (id) on delete cascade,
  to_document_id uuid not null references documents.documents (id) on delete cascade,
  relation_type text not null check (relation_type in (
    'REPLACES', 'SUPPLEMENTS', 'ANSWERS', 'ATTACHMENT_OF', 'DERIVED_FROM'
  )),
  created_at timestamptz not null default now(),
  constraint document_relation_not_self check (from_document_id <> to_document_id),
  unique (from_document_id, to_document_id, relation_type)
);

create index document_relations_to_idx on documents.document_relations (to_document_id);

create table documents.document_classifications (
  id uuid primary key default extensions.gen_random_uuid(),
  document_id uuid not null references documents.documents (id) on delete cascade,
  document_version_id uuid references documents.document_versions (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  classification_key text not null,
  value text not null,
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  -- Masterplan 24/77: a classification produced by AI is evidence, not truth.
  determined_by text not null default 'HUMAN'
    check (determined_by in ('HUMAN', 'RULE', 'AI', 'SOURCE_SYSTEM')),
  authoritative_level text not null default 'DERIVED'
    check (authoritative_level in ('AUTHORITATIVE', 'REFERENCE', 'ADVISORY', 'DERIVED', 'AI_DERIVED')),
  accepted_by uuid references identity.users (id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index document_classifications_document_idx
  on documents.document_classifications (document_id);

-- A version's ingestion outcome is the only thing that may change on it, and only
-- forwards. Everything else about a version is immutable (masterplan 35).
create or replace function documents.enforce_version_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.document_id is distinct from old.document_id
     or new.version is distinct from old.version
     or new.sha256 is distinct from old.sha256
     or new.storage_bucket is distinct from old.storage_bucket
     or new.storage_path is distinct from old.storage_path
     or new.size_bytes is distinct from old.size_bytes then
    raise exception 'A document version is immutable; store a new version instead'
      using errcode = 'raise_exception';
  end if;
  if old.ingestion_status in ('CLEAN', 'REJECTED') and new.ingestion_status <> old.ingestion_status then
    raise exception 'Ingestion status % is final', old.ingestion_status
      using errcode = 'raise_exception';
  end if;
  return new;
end;
$$;

revoke all on function documents.enforce_version_immutability() from public;

create trigger document_versions_immutable
  before update on documents.document_versions
  for each row execute function documents.enforce_version_immutability();

create or replace function documents.bump_current_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update documents.documents d
  set current_version = greatest(d.current_version, new.version)
  where d.id = new.document_id;
  return new;
end;
$$;

revoke all on function documents.bump_current_version() from public;

create trigger document_versions_bump
  after insert on documents.document_versions
  for each row execute function documents.bump_current_version();

create trigger documents_set_updated_at before update on documents.documents
  for each row execute function config.set_updated_at();

alter table documents.documents enable row level security;
alter table documents.document_versions enable row level security;
alter table documents.document_relations enable row level security;
alter table documents.document_classifications enable row level security;

grant usage on schema documents to authenticated;
grant select, insert, update on documents.documents to authenticated;
grant select, insert on documents.document_versions to authenticated;
grant select on documents.document_relations, documents.document_classifications to authenticated;

-- A document is visible exactly when its case is visible and the reader holds
-- document.read; a document without a case follows the authority permission.
create policy documents_select on documents.documents
  for select to authenticated
  using (
    (
      authz.can('document.read', jsonb_build_object(
        'authority_id', authority_id,
        'information_class', information_class,
        'relationship_to_case', (
          select cp.relationship from core.case_parties cp
          where cp.case_id = documents.case_id
            and cp.identity_user_id = (select authz.current_user_id())
            and cp.verified_at is not null
          limit 1
        )
      )) ->> 'allowed')::boolean
    and (case_id is null or exists (select 1 from core.cases c where c.id = documents.case_id))
  );

create policy documents_insert on documents.documents
  for insert to authenticated
  with check (authz.has_permission('document.upload', authority_id, null, null));

create policy documents_update on documents.documents
  for update to authenticated
  using (authz.has_permission('document.classify', authority_id, null, null))
  with check (authz.has_permission('document.classify', authority_id, null, null));

create policy document_versions_select on documents.document_versions
  for select to authenticated
  using (exists (select 1 from documents.documents d where d.id = document_versions.document_id));

create policy document_versions_insert on documents.document_versions
  for insert to authenticated
  with check (
    authz.has_permission('document.upload', authority_id, null, null)
    and exists (select 1 from documents.documents d where d.id = document_versions.document_id)
    -- Masterplan 36: a file always enters through quarantine.
    and ingestion_status = 'QUARANTINED'
  );

create policy document_relations_select on documents.document_relations
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy document_classifications_select on documents.document_classifications
  for select to authenticated
  using (exists (select 1 from documents.documents d where d.id = document_classifications.document_id));

-- Masterplan 37: buckets. No authority document is ever in a public bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('quarantine', 'quarantine', false, 209715200, null),
  ('case-documents', 'case-documents', false, 209715200, null),
  ('generated-documents', 'generated-documents', false, 209715200, null),
  ('temporary-uploads', 'temporary-uploads', false, 209715200, null),
  ('migration-source', 'migration-source', false, null, null),
  ('archive-packages', 'archive-packages', false, null, null),
  ('integration-files', 'integration-files', false, null, null)
on conflict (id) do nothing;

-- Storage paths are `<authority_id>/<document_id>/<version>/<filename>`, so the
-- first path segment carries the authority the object belongs to.
create or replace function documents.storage_authority(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f-]{36}$' then split_part(p_name, '/', 1)::uuid
    else null
  end
$$;

revoke all on function documents.storage_authority(text) from public;
grant execute on function documents.storage_authority(text) to authenticated;

create policy "tryggsignal case documents readable in own authority"
  on storage.objects for select to authenticated
  using (
    bucket_id in ('case-documents', 'generated-documents')
    and documents.storage_authority(name) in (select authz.assigned_authority_ids())
  );

create policy "tryggsignal uploads land in quarantine only"
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('quarantine', 'temporary-uploads')
    and authz.has_permission('document.upload', documents.storage_authority(name), null, null)
  );
