-- Tryggsignal Phase G6 — deterministic, sourced completeness assessment.
-- Existing versioned rules are reused. AI is never part of this decision path.

create table rules.completeness_assessments (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  rule_set_version_id uuid not null references rules.rule_set_versions (id) on delete restrict,
  result text not null check (result in ('COMPLETE', 'INCOMPLETE', 'HUMAN_REVIEW')),
  evidence jsonb not null default '[]'::jsonb,
  missing_items jsonb not null default '[]'::jsonb,
  input_snapshot jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now(),
  evaluated_by uuid references identity.users (id),
  superseded_at timestamptz
);

create index completeness_assessments_case_idx
  on rules.completeness_assessments (case_id, evaluated_at desc);
create unique index completeness_assessments_current_idx
  on rules.completeness_assessments (case_id)
  where superseded_at is null;

create table rules.completeness_reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  assessment_id uuid not null references rules.completeness_assessments (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  decision text not null check (decision in ('COMPLETE', 'INCOMPLETE')),
  note text not null,
  reviewed_by uuid not null references identity.users (id),
  reviewed_at timestamptz not null default now(),
  unique (assessment_id)
);

alter table rules.completeness_assessments enable row level security;
alter table rules.completeness_reviews enable row level security;

grant select on rules.completeness_assessments, rules.completeness_reviews to authenticated;

create policy completeness_assessments_select on rules.completeness_assessments
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = completeness_assessments.case_id));

create policy completeness_reviews_select on rules.completeness_reviews
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = completeness_reviews.case_id));

create or replace function rules.evaluate_case_completeness_for_user(
  p_case_id uuid,
  p_rule_set_version_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case core.cases%rowtype;
  v_version rules.rule_set_versions%rowtype;
  v_set rules.rule_sets%rowtype;
  v_rule rules.rules%rowtype;
  v_decision jsonb;
  v_result text := 'COMPLETE';
  v_rule_result text;
  v_evidence jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_input jsonb;
  v_kind text;
  v_value text;
  v_count integer;
  v_assessment_id uuid;
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
  if not coalesce((v_decision->>'allowed')::boolean, false) then
    raise exception 'Case is unavailable' using errcode = 'no_data_found';
  end if;

  select * into v_version
  from rules.rule_set_versions v
  where v.id = p_rule_set_version_id
    and v.published_at is not null
    and v.valid_from <= current_date
    and (v.valid_to is null or v.valid_to > current_date);

  if not found then
    raise exception 'Completeness rule version is unavailable'
      using errcode = 'no_data_found';
  end if;

  select * into v_set from rules.rule_sets rs where rs.id = v_version.rule_set_id;
  if v_set.domain <> 'COMPLETENESS'
     or (v_set.authority_id is not null and v_set.authority_id <> v_case.authority_id) then
    raise exception 'Completeness rule version is unavailable'
      using errcode = 'no_data_found';
  end if;

  if not exists (
    select 1 from rules.rules r where r.rule_set_version_id = v_version.id
  ) then
    raise exception 'Completeness rule version contains no rules'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if exists (
    select 1
    from rules.rules r
    where r.rule_set_version_id = v_version.id
      and not exists (select 1 from rules.rule_sources s where s.rule_id = r.id)
  ) then
    raise exception 'Every completeness rule must have a source'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  v_input := jsonb_build_object(
    'case_id', v_case.id,
    'process_type', v_case.process_type,
    'case_type', v_case.case_type,
    'evaluated_at', now()
  );

  for v_rule in
    select *
    from rules.rules r
    where r.rule_set_version_id = v_version.id
    order by r.key
  loop
    v_kind := upper(coalesce(v_rule.predicate->>'kind', ''));
    v_value := nullif(trim(v_rule.predicate->>'value'), '');
    v_rule_result := 'PASS';
    v_count := 0;

    if v_kind = 'PARTY_RELATIONSHIP' and v_value is not null then
      select count(*) into v_count
      from core.case_parties cp
      where cp.case_id = v_case.id
        and cp.relationship = v_value;
      if v_count = 0 then v_rule_result := 'FAIL'; end if;

    elsif v_kind = 'PROPERTY_LINK' then
      select count(*) into v_count
      from core.case_properties cp
      where cp.case_id = v_case.id;
      if v_count = 0 then v_rule_result := 'FAIL'; end if;

    elsif v_kind = 'CLEAN_DOCUMENT_TYPE' and v_value is not null then
      select count(*) into v_count
      from documents.documents d
      join documents.document_versions dv
        on dv.document_id = d.id
       and dv.version = d.current_version
      where d.case_id = v_case.id
        and d.document_type = v_value
        and dv.ingestion_status = 'CLEAN';
      if v_count = 0 then v_rule_result := 'FAIL'; end if;

    elsif v_kind = 'MANUAL_REVIEW' then
      v_rule_result := 'HUMAN_REVIEW';

    else
      -- Unknown/unsupported predicates are never guessed.
      v_rule_result := 'HUMAN_REVIEW';
    end if;

    v_evidence := v_evidence || jsonb_build_array(jsonb_build_object(
      'rule_id', v_rule.id,
      'key', v_rule.key,
      'name', v_rule.name,
      'kind', v_kind,
      'value', v_value,
      'result', v_rule_result,
      'matched_count', v_count,
      'legal_reference', v_rule.legal_reference,
      'sources', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'source_type', s.source_type,
          'reference', s.reference,
          'url', s.url
        ) order by s.reference), '[]'::jsonb)
        from rules.rule_sources s
        where s.rule_id = v_rule.id
      )
    ));

    if v_rule_result = 'HUMAN_REVIEW' then
      v_result := 'HUMAN_REVIEW';
      v_missing := v_missing || jsonb_build_array(jsonb_build_object(
        'rule_id', v_rule.id,
        'key', v_rule.key,
        'label', v_rule.name,
        'reason', 'HUMAN_REVIEW'
      ));
    elsif v_rule_result = 'FAIL' and v_rule.severity = 'REQUIRED' then
      if v_result <> 'HUMAN_REVIEW' then v_result := 'INCOMPLETE'; end if;
      v_missing := v_missing || jsonb_build_array(jsonb_build_object(
        'rule_id', v_rule.id,
        'key', v_rule.key,
        'label', v_rule.name,
        'reason', 'MISSING_REQUIRED_EVIDENCE'
      ));
    end if;

    insert into rules.rule_evaluations (
      authority_id, case_id, rule_set_version_id, rule_id, result,
      input_snapshot, evidence, evaluated_by
    )
    values (
      v_case.authority_id, v_case.id, v_version.id, v_rule.id,
      case
        when v_rule_result = 'PASS' then 'PASS'
        when v_rule_result = 'FAIL' then 'FAIL'
        else 'HUMAN_REVIEW'
      end,
      v_input,
      jsonb_build_array(v_evidence->-1),
      'RULE_ENGINE'
    );
  end loop;

  update rules.completeness_assessments
  set superseded_at = now()
  where case_id = v_case.id
    and superseded_at is null;

  insert into rules.completeness_assessments (
    authority_id, case_id, rule_set_version_id, result,
    evidence, missing_items, input_snapshot, evaluated_by
  )
  values (
    v_case.authority_id, v_case.id, v_version.id, v_result,
    v_evidence, v_missing, v_input, (select authz.current_user_id())
  )
  returning id into v_assessment_id;

  perform audit.record(
    'case.completeness.evaluated',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Completeness result %s using rule-set version %s', v_result, v_version.id)
  );

  return v_assessment_id;
end;
$$;

revoke all on function rules.evaluate_case_completeness_for_user(uuid, uuid) from public;
revoke all on function rules.evaluate_case_completeness_for_user(uuid, uuid) from anon;
grant execute on function rules.evaluate_case_completeness_for_user(uuid, uuid) to authenticated;

create or replace function rules.review_case_completeness_for_user(
  p_assessment_id uuid,
  p_decision text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment rules.completeness_assessments%rowtype;
  v_case core.cases%rowtype;
  v_authz jsonb;
  v_review_id uuid;
  v_decision text := upper(trim(coalesce(p_decision, '')));
  v_note text := trim(coalesce(p_note, ''));
begin
  select * into v_assessment
  from rules.completeness_assessments a
  where a.id = p_assessment_id;

  if not found or v_assessment.superseded_at is not null
     or v_assessment.result <> 'HUMAN_REVIEW' then
    raise exception 'Assessment is unavailable for human review'
      using errcode = 'no_data_found';
  end if;

  select * into v_case from core.cases c where c.id = v_assessment.case_id;
  v_authz := authz.can('case.update', jsonb_build_object(
    'authority_id', v_case.authority_id,
    'department_id', v_case.department_id,
    'assigned_user_id', v_case.assigned_user_id,
    'assigned_team_id', v_case.assigned_team_id,
    'information_class', v_case.information_class
  ));
  if not coalesce((v_authz->>'allowed')::boolean, false) then
    raise exception 'Assessment is unavailable for human review'
      using errcode = 'no_data_found';
  end if;

  if v_decision not in ('COMPLETE', 'INCOMPLETE') then
    raise exception 'Human review decision must be COMPLETE or INCOMPLETE'
      using errcode = 'check_violation';
  end if;
  if length(v_note) < 3 or length(v_note) > 4000 then
    raise exception 'Human review note must contain 3-4000 characters'
      using errcode = 'check_violation';
  end if;

  insert into rules.completeness_reviews (
    assessment_id, authority_id, case_id, decision, note, reviewed_by
  )
  values (
    v_assessment.id, v_assessment.authority_id, v_assessment.case_id,
    v_decision, v_note, (select authz.current_user_id())
  )
  returning id into v_review_id;

  perform audit.record(
    'case.completeness.reviewed',
    'case',
    v_case.id,
    v_case.authority_id,
    format('Human completeness review resolved as %s', v_decision)
  );

  return v_review_id;
end;
$$;

revoke all on function rules.review_case_completeness_for_user(uuid, text, text) from public;
revoke all on function rules.review_case_completeness_for_user(uuid, text, text) from anon;
grant execute on function rules.review_case_completeness_for_user(uuid, text, text) to authenticated;
