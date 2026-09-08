-- Tryggsignal Phase G2 — operational case parties.
-- Plan G2: applicant, property owner, representative, organization/contact and
-- role in case. Client tables remain read-only; all writes go through narrow,
-- audited SECURITY DEFINER commands with parent-case authorization.

create or replace function core.add_case_party_for_user(
  p_case_id uuid,
  p_party_type text,
  p_display_name text,
  p_relationship text,
  p_organization_number text default null,
  p_person_reference text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_party_id uuid;
  v_relation_id uuid;
  v_decision jsonb;
  v_email text := nullif(trim(p_contact_email), '');
  v_phone text := nullif(trim(p_contact_phone), '');
  v_org text := nullif(trim(p_organization_number), '');
  v_person_ref text := nullif(trim(p_person_reference), '');
begin
  select * into v_case from core.cases c where c.id = p_case_id;

  if not found then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));

  -- BOLA/IDOR: an inaccessible case is indistinguishable from a missing case.
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if p_party_type not in ('PERSON', 'ORGANIZATION') then
    raise exception 'Invalid party type' using errcode = 'check_violation';
  end if;

  if p_relationship not in (
    'APPLICANT', 'REPRESENTATIVE', 'PROPERTY_OWNER', 'NEIGHBOUR',
    'CONTROL_RESPONSIBLE', 'OTHER'
  ) then
    raise exception 'Invalid case relationship' using errcode = 'check_violation';
  end if;

  if length(trim(coalesce(p_display_name, ''))) < 2
     or length(trim(p_display_name)) > 200 then
    raise exception 'Display name must contain 2-200 characters'
      using errcode = 'check_violation';
  end if;

  if v_email is not null and (
    length(v_email) > 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'Invalid email address' using errcode = 'check_violation';
  end if;

  if v_phone is not null and length(v_phone) > 50 then
    raise exception 'Phone number is too long' using errcode = 'check_violation';
  end if;

  if v_org is not null and length(v_org) > 50 then
    raise exception 'Organization number is too long' using errcode = 'check_violation';
  end if;

  if v_person_ref is not null and length(v_person_ref) > 200 then
    raise exception 'Person reference is too long' using errcode = 'check_violation';
  end if;

  -- Keep deterministic data minimization: organization number is only meaningful
  -- for organizations, person_reference only for persons.
  if p_party_type = 'PERSON' then
    v_org := null;
  else
    v_person_ref := null;
  end if;

  insert into core.parties (
    authority_id,
    party_type,
    display_name,
    organization_number,
    person_reference,
    contact_email,
    contact_phone
  )
  values (
    v_case.authority_id,
    p_party_type,
    trim(p_display_name),
    v_org,
    v_person_ref,
    v_email,
    v_phone
  )
  returning id into v_party_id;

  insert into core.case_parties (
    case_id,
    party_id,
    authority_id,
    relationship
  )
  values (
    p_case_id,
    v_party_id,
    v_case.authority_id,
    p_relationship
  )
  returning id into v_relation_id;

  perform audit.record(
    'case.party.added',
    'case',
    p_case_id,
    v_case.authority_id,
    format('Party %s added as %s', v_party_id, p_relationship)
  );

  return v_relation_id;
end;
$$;

revoke all on function core.add_case_party_for_user(
  uuid, text, text, text, text, text, text, text
) from public;
revoke all on function core.add_case_party_for_user(
  uuid, text, text, text, text, text, text, text
) from anon;
grant execute on function core.add_case_party_for_user(
  uuid, text, text, text, text, text, text, text
) to authenticated;


create or replace function core.update_case_party_relationship_for_user(
  p_case_party_id uuid,
  p_relationship text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_relation core.case_parties%rowtype;
  v_case core.cases%rowtype;
  v_decision jsonb;
begin
  select * into v_relation
  from core.case_parties cp
  where cp.id = p_case_party_id;

  if not found then
    raise exception 'Case party is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_relation.case_id;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case party is unavailable' using errcode = 'no_data_found';
  end if;

  if p_relationship not in (
    'APPLICANT', 'REPRESENTATIVE', 'PROPERTY_OWNER', 'NEIGHBOUR',
    'CONTROL_RESPONSIBLE', 'OTHER'
  ) then
    raise exception 'Invalid case relationship' using errcode = 'check_violation';
  end if;

  if v_relation.relationship = p_relationship then
    return;
  end if;

  update core.case_parties
  set relationship = p_relationship
  where id = p_case_party_id;

  perform audit.record(
    'case.party.relationship.changed',
    'case',
    v_case.id,
    v_case.authority_id,
    format(
      'Party %s relationship changed from %s to %s',
      v_relation.party_id,
      v_relation.relationship,
      p_relationship
    )
  );
end;
$$;

revoke all on function core.update_case_party_relationship_for_user(uuid, text) from public;
revoke all on function core.update_case_party_relationship_for_user(uuid, text) from anon;
grant execute on function core.update_case_party_relationship_for_user(uuid, text) to authenticated;


create or replace function core.update_party_contact_for_user(
  p_case_id uuid,
  p_party_id uuid,
  p_display_name text,
  p_organization_number text default null,
  p_person_reference text default null,
  p_contact_email text default null,
  p_contact_phone text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_party core.parties%rowtype;
  v_other_case core.cases%rowtype;
  v_decision jsonb;
  v_email text := nullif(trim(p_contact_email), '');
  v_phone text := nullif(trim(p_contact_phone), '');
  v_org text := nullif(trim(p_organization_number), '');
  v_person_ref text := nullif(trim(p_person_reference), '');
begin
  select * into v_case from core.cases c where c.id = p_case_id;
  select * into v_party from core.parties p where p.id = p_party_id;

  if v_case.id is null
     or v_party.id is null
     or v_party.authority_id <> v_case.authority_id
     or not exists (
       select 1
       from core.case_parties cp
       where cp.case_id = p_case_id
         and cp.party_id = p_party_id
     ) then
    raise exception 'Party is unavailable' using errcode = 'no_data_found';
  end if;

  v_decision := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Party is unavailable' using errcode = 'no_data_found';
  end if;

  -- A party can be canonical across several cases. Updating shared contact data
  -- is only allowed when the caller may update every case using that party.
  for v_other_case in
    select c.*
    from core.case_parties cp
    join core.cases c on c.id = cp.case_id
    where cp.party_id = p_party_id
      and cp.case_id <> p_case_id
  loop
    v_decision := authz.can('case.update', jsonb_build_object(
      'authority_id', v_other_case.authority_id,
      'department_id', v_other_case.department_id,
      'assigned_user_id', v_other_case.assigned_user_id,
      'assigned_team_id', v_other_case.assigned_team_id,
      'information_class', v_other_case.information_class
    ));

    if not coalesce((v_decision->>'allowed')::boolean, false) then
      raise exception 'Shared party contact requires access to every linked case'
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if length(trim(coalesce(p_display_name, ''))) < 2
     or length(trim(p_display_name)) > 200 then
    raise exception 'Display name must contain 2-200 characters'
      using errcode = 'check_violation';
  end if;

  if v_email is not null and (
    length(v_email) > 320
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ) then
    raise exception 'Invalid email address' using errcode = 'check_violation';
  end if;

  if v_phone is not null and length(v_phone) > 50 then
    raise exception 'Phone number is too long' using errcode = 'check_violation';
  end if;

  if v_org is not null and length(v_org) > 50 then
    raise exception 'Organization number is too long' using errcode = 'check_violation';
  end if;

  if v_person_ref is not null and length(v_person_ref) > 200 then
    raise exception 'Person reference is too long' using errcode = 'check_violation';
  end if;

  if v_party.party_type = 'PERSON' then
    v_org := null;
  else
    v_person_ref := null;
  end if;

  update core.parties
  set display_name = trim(p_display_name),
      organization_number = v_org,
      person_reference = v_person_ref,
      contact_email = v_email,
      contact_phone = v_phone
  where id = p_party_id;

  perform audit.record(
    'case.party.contact.updated',
    'case',
    p_case_id,
    v_case.authority_id,
    format('Party %s contact metadata updated', p_party_id)
  );
end;
$$;

revoke all on function core.update_party_contact_for_user(
  uuid, uuid, text, text, text, text, text
) from public;
revoke all on function core.update_party_contact_for_user(
  uuid, uuid, text, text, text, text, text
) from anon;
grant execute on function core.update_party_contact_for_user(
  uuid, uuid, text, text, text, text, text
) to authenticated;
