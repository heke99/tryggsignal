-- Tryggsignal P8/P9 — workflow, rules and statutory deadlines.
-- Masterplan 39 (versioned workflow, never hard-coded in the frontend),
-- 40 (deterministic rule engine — AI is never the rule engine),
-- 41 (legal deadlines separated from ordinary tasks, always explainable).

create table workflow.workflow_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  process_type text not null,
  created_at timestamptz not null default now(),
  unique (authority_id, key)
);

create table workflow.workflow_template_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  template_id uuid not null references workflow.workflow_templates (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  version integer not null check (version >= 1),
  -- The definition is data, not code: states, transitions, tasks and timers.
  definition jsonb not null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  published_at timestamptz,
  published_by uuid references identity.users (id),
  unique (template_id, version)
);

create table workflow.workflow_instances (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  -- Masterplan 39: an existing case keeps the workflow version it started on.
  template_version_id uuid not null references workflow.workflow_template_versions (id),
  current_state text not null,
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  started_at timestamptz not null default now(),
  paused_at timestamptz,
  resumed_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (case_id, template_version_id)
);

create index workflow_instances_case_idx on workflow.workflow_instances (case_id);
create index workflow_instances_authority_state_idx
  on workflow.workflow_instances (authority_id, status, current_state);

create table workflow.workflow_transitions (
  id bigint generated always as identity primary key,
  instance_id uuid not null references workflow.workflow_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  from_state text,
  to_state text not null,
  triggered_by uuid references identity.users (id),
  trigger_type text not null default 'USER'
    check (trigger_type in ('USER', 'RULE', 'TIMER', 'INTEGRATION', 'SYSTEM')),
  reason text,
  occurred_at timestamptz not null default now()
);

create index workflow_transitions_instance_idx
  on workflow.workflow_transitions (instance_id, occurred_at desc);

create table workflow.workflow_tasks (
  id uuid primary key default extensions.gen_random_uuid(),
  instance_id uuid not null references workflow.workflow_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  task_key text not null,
  title text not null,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELLED')),
  assigned_user_id uuid references identity.users (id) on delete set null,
  assigned_team_id uuid references organization.teams (id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references identity.users (id),
  created_at timestamptz not null default now()
);

create index workflow_tasks_user_queue_idx
  on workflow.workflow_tasks (assigned_user_id, status, due_at);
create index workflow_tasks_team_queue_idx
  on workflow.workflow_tasks (assigned_team_id, status, due_at);
create index workflow_tasks_case_idx on workflow.workflow_tasks (case_id);
create index workflow_tasks_authority_idx on workflow.workflow_tasks (authority_id);

create table workflow.workflow_timers (
  id uuid primary key default extensions.gen_random_uuid(),
  instance_id uuid not null references workflow.workflow_instances (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  timer_key text not null,
  fires_at timestamptz not null,
  fired_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);

create index workflow_timers_due_idx on workflow.workflow_timers (fires_at)
  where fired_at is null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- Rule engine (masterplan 40)
-- ---------------------------------------------------------------------------

create table rules.rule_sets (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  domain text not null default 'PBL',
  created_at timestamptz not null default now(),
  unique (authority_id, key)
);

create table rules.rule_set_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_set_id uuid not null references rules.rule_sets (id) on delete cascade,
  version integer not null check (version >= 1),
  -- Effective dating is what makes an old case explainable years later.
  valid_from date not null,
  valid_to date,
  published_at timestamptz,
  published_by uuid references identity.users (id),
  unique (rule_set_id, version),
  constraint rule_set_version_dates check (valid_to is null or valid_to > valid_from)
);

create table rules.rules (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_set_version_id uuid not null references rules.rule_set_versions (id) on delete cascade,
  key text not null,
  name text not null,
  description text,
  severity text not null default 'REQUIRED'
    check (severity in ('REQUIRED', 'CONDITIONAL', 'ADVISORY')),
  -- Deterministic predicate expressed as data and evaluated by the rule engine.
  predicate jsonb not null,
  outcome jsonb not null default '{}'::jsonb,
  legal_reference text,
  created_at timestamptz not null default now(),
  unique (rule_set_version_id, key)
);

create table rules.rule_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_id uuid not null references rules.rules (id) on delete cascade,
  source_type text not null check (source_type in ('LAW', 'REGULATION', 'GUIDANCE', 'LOCAL_DECISION')),
  reference text not null,
  url text,
  valid_from date,
  valid_to date
);

create table rules.rule_evaluations (
  id bigint generated always as identity primary key,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  rule_set_version_id uuid not null references rules.rule_set_versions (id),
  rule_id uuid not null references rules.rules (id),
  result text not null check (result in ('PASS', 'FAIL', 'NOT_APPLICABLE', 'HUMAN_REVIEW')),
  -- Masterplan 40: every evaluation stores its input snapshot and its evidence.
  input_snapshot jsonb not null,
  evidence jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  evaluated_by text not null default 'RULE_ENGINE'
);

create index rule_evaluations_case_idx on rules.rule_evaluations (case_id, evaluated_at desc);
create index rule_evaluations_authority_idx on rules.rule_evaluations (authority_id);

-- ---------------------------------------------------------------------------
-- Deadlines (masterplan 41)
-- ---------------------------------------------------------------------------

create table workflow.deadlines (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  deadline_key text not null,
  name text not null,
  -- A statutory deadline is legally different from an internal target date.
  deadline_type text not null default 'STATUTORY'
    check (deadline_type in ('STATUTORY', 'INTERNAL', 'AGREED')),
  legal_reference text,
  base_at timestamptz not null,
  duration_days integer not null check (duration_days > 0),
  due_at timestamptz not null,
  paused_days integer not null default 0 check (paused_days >= 0),
  extended_days integer not null default 0 check (extended_days >= 0),
  status text not null default 'RUNNING'
    check (status in ('RUNNING', 'PAUSED', 'MET', 'MISSED', 'CANCELLED')),
  met_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, deadline_key)
);

create index deadlines_authority_due_idx on workflow.deadlines (authority_id, due_at)
  where status in ('RUNNING', 'PAUSED');
create index deadlines_case_idx on workflow.deadlines (case_id);

create table workflow.deadline_events (
  id bigint generated always as identity primary key,
  deadline_id uuid not null references workflow.deadlines (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  event_type text not null check (event_type in (
    'STARTED', 'PAUSED', 'RESUMED', 'EXTENDED', 'MET', 'MISSED', 'CANCELLED', 'RECALCULATED'
  )),
  occurred_at timestamptz not null default now(),
  actor uuid references identity.users (id),
  reason text,
  detail jsonb not null default '{}'::jsonb
);

create index deadline_events_deadline_idx on workflow.deadline_events (deadline_id, occurred_at);

-- Masterplan 41: a caseworker must be able to see exactly why due_at is what it is.
create table workflow.deadline_calculations (
  id bigint generated always as identity primary key,
  deadline_id uuid not null references workflow.deadlines (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  calculated_at timestamptz not null default now(),
  rule_reference text not null,
  base_at timestamptz not null,
  duration_days integer not null,
  paused_days integer not null,
  extended_days integer not null,
  holiday_adjustment_days integer not null default 0,
  due_at timestamptz not null,
  explanation text not null,
  inputs jsonb not null default '{}'::jsonb
);

create index deadline_calculations_deadline_idx
  on workflow.deadline_calculations (deadline_id, calculated_at desc);

create trigger workflow_instances_set_updated_at before update on workflow.workflow_instances
  for each row execute function config.set_updated_at();
create trigger deadlines_set_updated_at before update on workflow.deadlines
  for each row execute function config.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table workflow.workflow_templates enable row level security;
alter table workflow.workflow_template_versions enable row level security;
alter table workflow.workflow_instances enable row level security;
alter table workflow.workflow_transitions enable row level security;
alter table workflow.workflow_tasks enable row level security;
alter table workflow.workflow_timers enable row level security;
alter table workflow.deadlines enable row level security;
alter table workflow.deadline_events enable row level security;
alter table workflow.deadline_calculations enable row level security;
alter table rules.rule_sets enable row level security;
alter table rules.rule_set_versions enable row level security;
alter table rules.rules enable row level security;
alter table rules.rule_sources enable row level security;
alter table rules.rule_evaluations enable row level security;

grant usage on schema workflow, rules to authenticated;
grant select on workflow.workflow_templates, workflow.workflow_template_versions,
  workflow.workflow_instances, workflow.workflow_transitions, workflow.workflow_timers,
  workflow.deadlines, workflow.deadline_events, workflow.deadline_calculations to authenticated;
grant select, insert, update on workflow.workflow_tasks to authenticated;
grant select on rules.rule_sets, rules.rule_set_versions, rules.rules, rules.rule_sources,
  rules.rule_evaluations to authenticated;

create policy workflow_templates_select on workflow.workflow_templates
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy workflow_template_versions_select on workflow.workflow_template_versions
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy workflow_instances_select on workflow.workflow_instances
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = workflow_instances.case_id));

create policy workflow_transitions_select on workflow.workflow_transitions
  for select to authenticated
  using (exists (
    select 1 from workflow.workflow_instances i where i.id = workflow_transitions.instance_id
  ));

create policy workflow_timers_select on workflow.workflow_timers
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy workflow_tasks_select on workflow.workflow_tasks
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = workflow_tasks.case_id));

create policy workflow_tasks_update on workflow.workflow_tasks
  for update to authenticated
  using (authz.has_permission('case.update', authority_id, null, null))
  with check (authz.has_permission('case.update', authority_id, null, null));

create policy workflow_tasks_insert on workflow.workflow_tasks
  for insert to authenticated
  with check (authz.has_permission('case.update', authority_id, null, null));

create policy deadlines_select on workflow.deadlines
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = deadlines.case_id));

create policy deadline_events_select on workflow.deadline_events
  for select to authenticated
  using (exists (select 1 from workflow.deadlines d where d.id = deadline_events.deadline_id));

create policy deadline_calculations_select on workflow.deadline_calculations
  for select to authenticated
  using (exists (select 1 from workflow.deadlines d where d.id = deadline_calculations.deadline_id));

-- Rule definitions are not case content; national and local rule sets are readable
-- to any signed-in user of the data plane, while evaluations follow the case.
create policy rule_sets_select on rules.rule_sets
  for select to authenticated
  using (authority_id is null or authority_id in (select authz.assigned_authority_ids()));

create policy rule_set_versions_select on rules.rule_set_versions
  for select to authenticated
  using (exists (select 1 from rules.rule_sets rs where rs.id = rule_set_versions.rule_set_id));

create policy rules_select on rules.rules
  for select to authenticated
  using (exists (
    select 1 from rules.rule_set_versions v where v.id = rules.rule_set_version_id
  ));

create policy rule_sources_select on rules.rule_sources
  for select to authenticated
  using (exists (select 1 from rules.rules r where r.id = rule_sources.rule_id));

create policy rule_evaluations_select on rules.rule_evaluations
  for select to authenticated
  using (
    case_id is null
      and authority_id in (select authz.assigned_authority_ids())
    or exists (select 1 from core.cases c where c.id = rule_evaluations.case_id)
  );
