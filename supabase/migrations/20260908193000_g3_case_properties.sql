-- Tryggsignal Phase G3 — operational property handling.
-- Links canonical property graph objects to cases without letting staff overwrite
-- authoritative geodata. Local provisional registration is explicit and sourced.

create unique index if not exists case_properties_one_primary_idx
  on core.case_properties (case_id)
  where is_primary;

drop policy if exists case_properties_select on core.case_properties;
create policy case_properties_select on core.case_properties
  for select to authenticated
  using (exists (
    select 1
    from core.cases c
    where c.id = case_properties.case_id
  ));

create or replace function core.link_property_to_case_for_user(
  p_case_id uuid,
  p_property_id uuid,
  p_make_primary boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_property property.properties%rowtype;
  v_decision jsonb;
  v_should_primary boolean;
begin
  select * into v_case
  from core.cases c
  where c.id = p_case_id;

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

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if v_case.status in ('CLOSED', 'ARCHIVED') then
    raise exception 'A closed or archived case cannot change property links'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select * into v_property
  from property.properties p
  where p.id = p_property_id
    and p.authority_id = v_case.authority_id;

  if not found then
    raise exception 'Property is unavailable' using errcode = 'no_data_found';
  end if;

  v_should_primary := p_make_primary or not exists (
    select 1 from core.case_properties cp
    where cp.case_id = p_case_id
  );

  if v_should_primary then
    update core.case_properties
    set is_primary = false
    where case_id = p_case_id
      and is_primary;
  end if;

  insert into core.case_properties (
    case_id, property_id, authority_id, is_primary
  )
  values (
    p_case_id, p_property_id, v_case.authority_id, v_should_primary
  )
  on conflict (case_id, property_id)
  do update set is_primary = excluded.is_primary or core.case_properties.is_primary;

  if v_should_primary then
    update core.case_properties
    set is_primary = (property_id = p_property_id)
    where case_id = p_case_id;

    update core.cases
    set primary_property_id = p_property_id,
        updated_by = (select authz.current_user_id()),
        updated_at = now()
    where id = p_case_id;
  end if;

  perform audit.record(
    'case.property.linked',
    'case',
    p_case_id,
    v_case.authority_id,
    format(
      'Property %s linked%s',
      p_property_id,
      case when v_should_primary then ' as primary' else '' end
    )
  );
end;
$$;

revoke all on function core.link_property_to_case_for_user(uuid, uuid, boolean) from public;
revoke all on function core.link_property_to_case_for_user(uuid, uuid, boolean) from anon;
grant execute on function core.link_property_to_case_for_user(uuid, uuid, boolean) to authenticated;

create or replace function core.set_primary_property_for_user(
  p_case_id uuid,
  p_property_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from core.case_properties cp
    where cp.case_id = p_case_id
      and cp.property_id = p_property_id
  ) then
    raise exception 'Property link is unavailable' using errcode = 'no_data_found';
  end if;

  perform core.link_property_to_case_for_user(p_case_id, p_property_id, true);
end;
$$;

revoke all on function core.set_primary_property_for_user(uuid, uuid) from public;
revoke all on function core.set_primary_property_for_user(uuid, uuid) from anon;
grant execute on function core.set_primary_property_for_user(uuid, uuid) to authenticated;

create or replace function core.register_local_property_for_case_user(
  p_case_id uuid,
  p_designation text,
  p_municipality_code text default null,
  p_street_name text default null,
  p_street_number text default null,
  p_letter text default null,
  p_postal_code text default null,
  p_postal_town text default null,
  p_make_primary boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_property_id uuid;
  v_decision jsonb;
  v_designation text := trim(coalesce(p_designation, ''));
  v_municipality_code text := nullif(trim(p_municipality_code), '');
  v_street_name text := nullif(trim(p_street_name), '');
  v_street_number text := nullif(trim(p_street_number), '');
  v_letter text := nullif(trim(p_letter), '');
  v_postal_code text := nullif(trim(p_postal_code), '');
  v_postal_town text := nullif(trim(p_postal_town), '');
begin
  select * into v_case
  from core.cases c
  where c.id = p_case_id;

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

  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  if v_case.status in ('CLOSED', 'ARCHIVED') then
    raise exception 'A closed or archived case cannot register a property'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if length(v_designation) < 2 or length(v_designation) > 240 then
    raise exception 'Property designation must contain 2-240 characters'
      using errcode = 'check_violation';
  end if;

  if v_municipality_code is not null and v_municipality_code !~ '^[0-9]{4}$' then
    raise exception 'Municipality code must contain four digits'
      using errcode = 'check_violation';
  end if;

  if v_street_name is not null and length(v_street_name) > 240 then
    raise exception 'Street name is too long' using errcode = 'check_violation';
  end if;
  if v_street_number is not null and length(v_street_number) > 30 then
    raise exception 'Street number is too long' using errcode = 'check_violation';
  end if;
  if v_letter is not null and length(v_letter) > 10 then
    raise exception 'Address letter is too long' using errcode = 'check_violation';
  end if;
  if v_postal_code is not null and length(v_postal_code) > 20 then
    raise exception 'Postal code is too long' using errcode = 'check_violation';
  end if;
  if v_postal_town is not null and length(v_postal_town) > 120 then
    raise exception 'Postal town is too long' using errcode = 'check_violation';
  end if;

  insert into property.properties (
    authority_id,
    designation,
    municipality_code,
    source,
    source_timestamp,
    attributes
  )
  values (
    v_case.authority_id,
    v_designation,
    v_municipality_code,
    'LOCAL',
    now(),
    jsonb_build_object(
      'provisional', true,
      'registered_from_case', p_case_id
    )
  )
  on conflict (authority_id, designation) do nothing;

  select p.id into v_property_id
  from property.properties p
  where p.authority_id = v_case.authority_id
    and p.designation = v_designation;

  if v_property_id is null then
    raise exception 'Property registration failed' using errcode = 'raise_exception';
  end if;

  insert into property.property_identifiers (
    property_id,
    authority_id,
    identifier_type,
    value,
    source,
    source_timestamp
  )
  values (
    v_property_id,
    v_case.authority_id,
    'FASTIGHETSBETECKNING',
    v_designation,
    'LOCAL',
    now()
  )
  on conflict (property_id, identifier_type, value) do nothing;

  if v_street_name is not null and not exists (
    select 1
    from property.addresses a
    where a.property_id = v_property_id
      and a.street_name = v_street_name
      and a.street_number is not distinct from v_street_number
      and a.letter is not distinct from v_letter
      and a.postal_code is not distinct from v_postal_code
      and a.postal_town is not distinct from v_postal_town
  ) then
    insert into property.addresses (
      authority_id,
      property_id,
      street_name,
      street_number,
      letter,
      postal_code,
      postal_town,
      municipality_code,
      source,
      source_timestamp,
      attributes
    )
    values (
      v_case.authority_id,
      v_property_id,
      v_street_name,
      v_street_number,
      v_letter,
      v_postal_code,
      v_postal_town,
      v_municipality_code,
      'LOCAL',
      now(),
      jsonb_build_object('provisional', true)
    );
  end if;

  perform core.link_property_to_case_for_user(
    p_case_id,
    v_property_id,
    p_make_primary
  );

  perform audit.record(
    'case.property.local_registered',
    'case',
    p_case_id,
    v_case.authority_id,
    format('Local provisional property %s registered', v_property_id)
  );

  return v_property_id;
end;
$$;

revoke all on function core.register_local_property_for_case_user(
  uuid, text, text, text, text, text, text, text, boolean
) from public;
revoke all on function core.register_local_property_for_case_user(
  uuid, text, text, text, text, text, text, text, boolean
) from anon;
grant execute on function core.register_local_property_for_case_user(
  uuid, text, text, text, text, text, text, text, boolean
) to authenticated;
