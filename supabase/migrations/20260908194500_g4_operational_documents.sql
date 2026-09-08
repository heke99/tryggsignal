-- Tryggsignal Phase G4 — operational document upload and storage hardening.
-- Browser files never pass through Next/Vercel. Metadata is authorized first,
-- Storage grants a short-lived signed upload token for the exact quarantine
-- path, and processing is enqueued only after the object exists.

alter table documents.document_versions
  add column upload_confirmed_at timestamptz,
  add column processing_enqueued_at timestamptz;

create or replace function documents.storage_document_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 2)::uuid
    else null
  end
$$;

create or replace function documents.storage_version_number(p_name text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 3) ~ '^[1-9][0-9]{0,8}$'
      then split_part(p_name, '/', 3)::integer
    else null
  end
$$;

revoke all on function documents.storage_document_id(text) from public;
revoke all on function documents.storage_version_number(text) from public;
grant execute on function documents.storage_document_id(text) to authenticated;
grant execute on function documents.storage_version_number(text) to authenticated;

create or replace function documents.can_upload_document(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
  v_relationship text;
  v_decision jsonb;
begin
  select * into v_document
  from documents.documents d
  where d.id = p_document_id;

  if not found or v_document.case_id is null then
    return false;
  end if;

  select * into v_case
  from core.cases c
  where c.id = v_document.case_id;

  if not found or v_case.authority_id <> v_document.authority_id then
    return false;
  end if;

  select cp.relationship into v_relationship
  from core.case_parties cp
  where cp.case_id = v_case.id
    and cp.identity_user_id = (select authz.current_user_id())
    and cp.verified_at is not null
  order by cp.created_at
  limit 1;

  if authz.is_external_user()
     and v_relationship not in ('APPLICANT', 'REPRESENTATIVE') then
    return false;
  end if;

  v_decision := authz.can('document.upload', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_document.information_class,
    'relationship_to_case', v_relationship
  ));

  return coalesce((v_decision->>'allowed')::boolean, false);
end;
$$;

revoke all on function documents.can_upload_document(uuid) from public;
grant execute on function documents.can_upload_document(uuid) to authenticated;

-- Direct browser table writes are replaced by narrow transaction commands.
revoke insert, update on documents.documents from authenticated;
revoke insert on documents.document_versions from authenticated;

create or replace function documents.prepare_case_document_upload_for_user(
  p_case_id uuid,
  p_document_type text,
  p_title text,
  p_description text,
  p_information_class text,
  p_secrecy_level integer,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_relationship text;
  v_decision jsonb;
  v_document_id uuid;
  v_version_id uuid := extensions.gen_random_uuid();
  v_path text;
  v_document_type text := upper(trim(coalesce(p_document_type, '')));
  v_title text := trim(coalesce(p_title, ''));
  v_description text := nullif(trim(p_description), '');
  v_information_class text := upper(trim(coalesce(p_information_class, '')));
  v_filename text := trim(coalesce(p_original_filename, ''));
  v_mime_type text := lower(trim(coalesce(p_mime_type, '')));
begin
  select * into v_case
  from core.cases c
  where c.id = p_case_id;

  if not found then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if v_case.status in ('CLOSED', 'ARCHIVED') then
    raise exception 'A closed or archived case cannot accept new documents'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select cp.relationship into v_relationship
  from core.case_parties cp
  where cp.case_id = v_case.id
    and cp.identity_user_id = (select authz.current_user_id())
    and cp.verified_at is not null
  order by cp.created_at
  limit 1;

  if authz.is_external_user()
     and v_relationship not in ('APPLICANT', 'REPRESENTATIVE') then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  v_decision := authz.can('document.upload', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_information_class,
    'relationship_to_case', v_relationship
  ));

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if length(v_document_type) < 2 or length(v_document_type) > 80
     or v_document_type !~ '^[A-Z0-9_\-]+$' then
    raise exception 'Invalid document type' using errcode = 'check_violation';
  end if;
  if length(v_title) < 2 or length(v_title) > 240 then
    raise exception 'Document title must contain 2-240 characters'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 10000 then
    raise exception 'Document description is too long' using errcode = 'check_violation';
  end if;
  if v_information_class not in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET') then
    raise exception 'Invalid information class' using errcode = 'check_violation';
  end if;
  if p_secrecy_level is null or p_secrecy_level < 0 or p_secrecy_level > 4 then
    raise exception 'Invalid secrecy level' using errcode = 'check_violation';
  end if;
  if length(v_filename) < 1 or length(v_filename) > 255
     or v_filename ~ '[[:cntrl:]]' then
    raise exception 'Invalid original filename' using errcode = 'check_violation';
  end if;
  if length(v_mime_type) < 3 or length(v_mime_type) > 200
     or v_mime_type ~ '[[:space:]]' then
    raise exception 'Invalid MIME type' using errcode = 'check_violation';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 209715200 then
    raise exception 'Document size must be between 1 byte and 200 MiB'
      using errcode = 'check_violation';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid SHA-256 digest' using errcode = 'check_violation';
  end if;

  insert into documents.documents (
    authority_id,
    case_id,
    department_id,
    document_type,
    title,
    description,
    information_class,
    secrecy_level,
    created_by
  )
  values (
    v_case.authority_id,
    v_case.id,
    v_case.department_id,
    v_document_type,
    v_title,
    v_description,
    v_information_class,
    p_secrecy_level,
    (select authz.current_user_id())
  )
  returning id into v_document_id;

  v_path := format('%s/%s/1/%s', v_case.authority_id, v_document_id, v_version_id);

  insert into documents.document_versions (
    id,
    document_id,
    authority_id,
    version,
    sha256,
    mime_type,
    size_bytes,
    storage_bucket,
    storage_path,
    original_filename,
    source,
    ingestion_status,
    created_by
  )
  values (
    v_version_id,
    v_document_id,
    v_case.authority_id,
    1,
    p_sha256,
    v_mime_type,
    p_size_bytes,
    'quarantine',
    v_path,
    v_filename,
    case when authz.is_external_user() then 'PORTAL_UPLOAD' else 'UPLOAD' end,
    'QUARANTINED',
    (select authz.current_user_id())
  );

  perform audit.record(
    'case.document.upload_prepared',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Document %s version 1 prepared in quarantine', v_document_id)
  );

  return jsonb_build_object(
    'document_id', v_document_id,
    'document_version_id', v_version_id,
    'version', 1,
    'bucket', 'quarantine',
    'path', v_path
  );
end;
$$;

revoke all on function documents.prepare_case_document_upload_for_user(
  uuid, text, text, text, text, integer, text, text, bigint, text
) from public;
revoke all on function documents.prepare_case_document_upload_for_user(
  uuid, text, text, text, text, integer, text, text, bigint, text
) from anon;
grant execute on function documents.prepare_case_document_upload_for_user(
  uuid, text, text, text, text, integer, text, text, bigint, text
) to authenticated;

create or replace function documents.prepare_new_version_upload_for_user(
  p_document_id uuid,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
  v_version integer;
  v_version_id uuid := extensions.gen_random_uuid();
  v_path text;
  v_filename text := trim(coalesce(p_original_filename, ''));
  v_mime_type text := lower(trim(coalesce(p_mime_type, '')));
begin
  select * into v_document
  from documents.documents d
  where d.id = p_document_id
  for update;

  if not found or v_document.case_id is null then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_document.case_id;
  if not found or not documents.can_upload_document(v_document.id) then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  if v_document.archived_at is not null or v_case.status in ('CLOSED', 'ARCHIVED') then
    raise exception 'This document no longer accepts new versions'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if length(v_filename) < 1 or length(v_filename) > 255
     or v_filename ~ '[[:cntrl:]]' then
    raise exception 'Invalid original filename' using errcode = 'check_violation';
  end if;
  if length(v_mime_type) < 3 or length(v_mime_type) > 200
     or v_mime_type ~ '[[:space:]]' then
    raise exception 'Invalid MIME type' using errcode = 'check_violation';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 209715200 then
    raise exception 'Document size must be between 1 byte and 200 MiB'
      using errcode = 'check_violation';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid SHA-256 digest' using errcode = 'check_violation';
  end if;

  select coalesce(max(dv.version), 0) + 1
  into v_version
  from documents.document_versions dv
  where dv.document_id = v_document.id;

  v_path := format(
    '%s/%s/%s/%s',
    v_document.authority_id,
    v_document.id,
    v_version,
    v_version_id
  );

  insert into documents.document_versions (
    id,
    document_id,
    authority_id,
    version,
    sha256,
    mime_type,
    size_bytes,
    storage_bucket,
    storage_path,
    original_filename,
    source,
    ingestion_status,
    created_by
  )
  values (
    v_version_id,
    v_document.id,
    v_document.authority_id,
    v_version,
    p_sha256,
    v_mime_type,
    p_size_bytes,
    'quarantine',
    v_path,
    v_filename,
    case when authz.is_external_user() then 'PORTAL_UPLOAD' else 'UPLOAD' end,
    'QUARANTINED',
    (select authz.current_user_id())
  );

  perform audit.record(
    'case.document.version_prepared',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Document %s version %s prepared in quarantine', v_document.id, v_version)
  );

  return jsonb_build_object(
    'document_id', v_document.id,
    'document_version_id', v_version_id,
    'version', v_version,
    'bucket', 'quarantine',
    'path', v_path
  );
end;
$$;

revoke all on function documents.prepare_new_version_upload_for_user(
  uuid, text, text, bigint, text
) from public;
revoke all on function documents.prepare_new_version_upload_for_user(
  uuid, text, text, bigint, text
) from anon;
grant execute on function documents.prepare_new_version_upload_for_user(
  uuid, text, text, bigint, text
) to authenticated;

create or replace function documents.confirm_document_upload_for_user(
  p_document_version_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version documents.document_versions%rowtype;
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
begin
  select * into v_version
  from documents.document_versions dv
  where dv.id = p_document_version_id
  for update;

  if not found then
    raise exception 'Document version is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_document from documents.documents d where d.id = v_version.document_id;
  if not found or v_document.case_id is null or not documents.can_upload_document(v_document.id) then
    raise exception 'Document version is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_document.case_id;

  if v_version.ingestion_status <> 'QUARANTINED' then
    raise exception 'Only a quarantined version can be confirmed'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = v_version.storage_bucket
      and o.name = v_version.storage_path
  ) then
    raise exception 'Uploaded object is not present in Storage'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update documents.document_versions
  set upload_confirmed_at = coalesce(upload_confirmed_at, now())
  where id = v_version.id;

  if v_version.processing_enqueued_at is null then
    perform config.enqueue_job(
      'document_processing',
      'document_processing',
      v_case.id::text,
      v_version.authority_id,
      format('document-processing:%s', v_version.id),
      jsonb_build_object(
        'case_id', v_case.id,
        'document_id', v_document.id,
        'document_version_id', v_version.id,
        'storage_bucket', v_version.storage_bucket,
        'storage_path', v_version.storage_path,
        'sha256', v_version.sha256,
        'declared_mime_type', v_version.mime_type,
        'size_bytes', v_version.size_bytes
      )
    );

    update documents.document_versions
    set processing_enqueued_at = now()
    where id = v_version.id;

    perform audit.record(
      'case.document.upload_confirmed',
      'case',
      v_case.id,
      v_case.authority_id,
      format('Document %s version %s confirmed and queued', v_document.id, v_version.version)
    );
  end if;
end;
$$;

revoke all on function documents.confirm_document_upload_for_user(uuid) from public;
revoke all on function documents.confirm_document_upload_for_user(uuid) from anon;
grant execute on function documents.confirm_document_upload_for_user(uuid) to authenticated;

create or replace function documents.mark_document_upload_failed_for_user(
  p_document_version_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version documents.document_versions%rowtype;
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
  v_reason text := left(trim(coalesce(p_reason, 'Upload failed')), 1000);
begin
  select * into v_version
  from documents.document_versions dv
  where dv.id = p_document_version_id
  for update;

  if not found then
    raise exception 'Document version is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_document from documents.documents d where d.id = v_version.document_id;
  if not found or v_document.case_id is null or not documents.can_upload_document(v_document.id) then
    raise exception 'Document version is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_document.case_id;

  if v_version.ingestion_status <> 'QUARANTINED' or v_version.upload_confirmed_at is not null then
    raise exception 'Upload failure can only be recorded before confirmation'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  update documents.document_versions
  set ingestion_status = 'FAILED',
      rejection_reason = nullif(v_reason, '')
  where id = v_version.id;

  perform audit.record(
    'case.document.upload_failed',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Document %s version %s upload failed', v_document.id, v_version.version)
  );
end;
$$;

revoke all on function documents.mark_document_upload_failed_for_user(uuid, text) from public;
revoke all on function documents.mark_document_upload_failed_for_user(uuid, text) from anon;
grant execute on function documents.mark_document_upload_failed_for_user(uuid, text) to authenticated;

create or replace function documents.update_document_metadata_for_user(
  p_document_id uuid,
  p_document_type text,
  p_title text,
  p_description text,
  p_information_class text,
  p_secrecy_level integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document documents.documents%rowtype;
  v_case core.cases%rowtype;
  v_decision jsonb;
  v_document_type text := upper(trim(coalesce(p_document_type, '')));
  v_title text := trim(coalesce(p_title, ''));
  v_description text := nullif(trim(p_description), '');
  v_information_class text := upper(trim(coalesce(p_information_class, '')));
begin
  select * into v_document
  from documents.documents d
  where d.id = p_document_id;

  if not found or v_document.case_id is null then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_document.case_id;

  v_decision := authz.can('document.classify', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_document.information_class
  ));

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Document is unavailable' using errcode = 'no_data_found';
  end if;

  if v_document.archived_at is not null or v_case.status = 'ARCHIVED' then
    raise exception 'Archived document metadata is immutable'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if length(v_document_type) < 2 or length(v_document_type) > 80
     or v_document_type !~ '^[A-Z0-9_\-]+$' then
    raise exception 'Invalid document type' using errcode = 'check_violation';
  end if;
  if length(v_title) < 2 or length(v_title) > 240 then
    raise exception 'Document title must contain 2-240 characters'
      using errcode = 'check_violation';
  end if;
  if v_description is not null and length(v_description) > 10000 then
    raise exception 'Document description is too long' using errcode = 'check_violation';
  end if;
  if v_information_class not in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET') then
    raise exception 'Invalid information class' using errcode = 'check_violation';
  end if;
  if p_secrecy_level is null or p_secrecy_level < 0 or p_secrecy_level > 4 then
    raise exception 'Invalid secrecy level' using errcode = 'check_violation';
  end if;

  update documents.documents
  set document_type = v_document_type,
      title = v_title,
      description = v_description,
      information_class = v_information_class,
      secrecy_level = p_secrecy_level
  where id = v_document.id;

  perform audit.record(
    'case.document.metadata_updated',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Document %s metadata updated', v_document.id)
  );
end;
$$;

revoke all on function documents.update_document_metadata_for_user(
  uuid, text, text, text, text, integer
) from public;
revoke all on function documents.update_document_metadata_for_user(
  uuid, text, text, text, text, integer
) from anon;
grant execute on function documents.update_document_metadata_for_user(
  uuid, text, text, text, text, integer
) to authenticated;

-- Storage object access must follow document/case RLS and ingestion status, not
-- merely membership in the same authority.
drop policy if exists "tryggsignal case documents readable in own authority" on storage.objects;
create policy "tryggsignal clean case documents readable through document scope"
  on storage.objects for select to authenticated
  using (
    bucket_id in ('quarantine', 'case-documents', 'generated-documents')
    and documents.storage_authority(name) is not null
    and documents.storage_document_id(name) is not null
    and exists (
      select 1
      from documents.document_versions v
      join documents.documents d on d.id = v.document_id
      where d.id = documents.storage_document_id(storage.objects.name)
        and d.authority_id = documents.storage_authority(storage.objects.name)
        and v.document_id = d.id
        and v.version = documents.storage_version_number(storage.objects.name)
        and v.storage_bucket = storage.objects.bucket_id
        and v.storage_path = storage.objects.name
        and v.ingestion_status = 'CLEAN'
    )
  );

drop policy if exists "tryggsignal uploads land in quarantine only" on storage.objects;
create policy "tryggsignal prepared uploads land in quarantine only"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'quarantine'
    and documents.storage_authority(name) is not null
    and documents.storage_document_id(name) is not null
    and exists (
      select 1
      from documents.document_versions v
      join documents.documents d on d.id = v.document_id
      where d.id = documents.storage_document_id(storage.objects.name)
        and d.authority_id = documents.storage_authority(storage.objects.name)
        and v.document_id = d.id
        and v.version = documents.storage_version_number(storage.objects.name)
        and v.storage_bucket = 'quarantine'
        and v.storage_path = storage.objects.name
        and v.ingestion_status = 'QUARANTINED'
        and documents.can_upload_document(d.id)
    )
  );
