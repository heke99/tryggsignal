-- Tryggsignal — communication, referrals, hearings, decisions, inspections,
-- compliance/OVK, AI governance, archive and reporting.
-- Masterplan 69–74, 75–79, 88–92, 96.

-- ---------------------------------------------------------------------------
-- Communication (masterplan 69, 31)
-- ---------------------------------------------------------------------------

create table communication.templates (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  channel text not null check (channel in ('EMAIL', 'DIGITAL_POST', 'SMS', 'PORTAL', 'API', 'PHYSICAL_POST')),
  subject text,
  body text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (authority_id, key, version)
);

create table communication.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  direction text not null check (direction in ('OUTBOUND', 'INBOUND')),
  subject text,
  body text,
  template_id uuid references communication.templates (id),
  information_class text not null default 'INTERNAL'
    check (information_class in ('PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET')),
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  correlation_id uuid not null default extensions.gen_random_uuid()
);

create index messages_case_idx on communication.messages (case_id, created_at desc);
create index messages_authority_idx on communication.messages (authority_id);

create table communication.deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  message_id uuid not null references communication.messages (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  channel text not null check (channel in ('EMAIL', 'DIGITAL_POST', 'SMS', 'PORTAL', 'API', 'PHYSICAL_POST')),
  recipient_party_id uuid references core.parties (id),
  recipient_address text,
  document_version_id uuid references documents.document_versions (id),
  -- Masterplan 31: external post is always traceable to case, message, version
  -- and correlation id.
  correlation_id uuid not null,
  status text not null default 'PENDING' check (status in (
    'PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'CANCELLED'
  )),
  attempt integer not null default 0,
  next_retry_at timestamptz,
  external_reference text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_reason text,
  created_at timestamptz not null default now()
);

create index deliveries_message_idx on communication.deliveries (message_id);
create index deliveries_retry_idx on communication.deliveries (status, next_retry_at)
  where status in ('PENDING', 'FAILED');
create index deliveries_authority_idx on communication.deliveries (authority_id);

create table communication.delivery_events (
  id bigint generated always as identity primary key,
  delivery_id uuid not null references communication.deliveries (id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);

create index delivery_events_delivery_idx on communication.delivery_events (delivery_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Referrals and neighbour hearings (masterplan 70, 71)
-- ---------------------------------------------------------------------------

create table referral.referrals (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  subject text not null,
  description text,
  sent_at timestamptz,
  due_at timestamptz not null,
  reminder_at timestamptz,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SENT', 'PARTIALLY_ANSWERED', 'ANSWERED', 'OVERDUE', 'CLOSED')),
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id)
);

create index referrals_case_idx on referral.referrals (case_id);
create index referrals_due_idx on referral.referrals (authority_id, due_at)
  where status in ('SENT', 'PARTIALLY_ANSWERED', 'OVERDUE');

create table referral.referral_recipients (
  id uuid primary key default extensions.gen_random_uuid(),
  referral_id uuid not null references referral.referrals (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  party_id uuid references core.parties (id),
  organization_name text,
  contact_address text,
  sent_at timestamptz,
  reminded_at timestamptz,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'ANSWERED', 'DECLINED', 'NO_RESPONSE'))
);

create index referral_recipients_referral_idx on referral.referral_recipients (referral_id);

create table referral.referral_responses (
  id uuid primary key default extensions.gen_random_uuid(),
  referral_id uuid not null references referral.referrals (id) on delete cascade,
  recipient_id uuid references referral.referral_recipients (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  document_id uuid references documents.documents (id),
  response_text text,
  position text check (position in ('NO_OBJECTION', 'OBJECTION', 'CONDITIONAL', 'NO_OPINION')),
  received_at timestamptz not null default now(),
  -- Masterplan 70: AI may summarize responses; the original document stays the source.
  ai_summary text,
  ai_summary_run_id uuid
);

create index referral_responses_referral_idx on referral.referral_responses (referral_id);

create table referral.hearings (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  hearing_type text not null default 'GRANNEHORANDE'
    check (hearing_type in ('GRANNEHORANDE', 'SAKAGARE', 'PUBLIC')),
  subject text not null,
  due_at timestamptz not null,
  status text not null default 'DRAFT'
    check (status in ('DRAFT', 'SENT', 'PARTIALLY_ANSWERED', 'ANSWERED', 'OVERDUE', 'CLOSED')),
  created_at timestamptz not null default now()
);

create index hearings_case_idx on referral.hearings (case_id);

create table referral.hearing_recipients (
  id uuid primary key default extensions.gen_random_uuid(),
  hearing_id uuid not null references referral.hearings (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  party_id uuid references core.parties (id),
  property_id uuid references property.properties (id),
  relation text not null default 'NEIGHBOUR',
  status text not null default 'PENDING'
    check (status in ('PENDING', 'SENT', 'ANSWERED', 'NO_RESPONSE'))
);

create index hearing_recipients_hearing_idx on referral.hearing_recipients (hearing_id);

create table referral.hearing_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  hearing_recipient_id uuid not null references referral.hearing_recipients (id) on delete cascade,
  delivery_id uuid references communication.deliveries (id),
  sent_at timestamptz,
  status text not null default 'PENDING'
);

create table referral.hearing_responses (
  id uuid primary key default extensions.gen_random_uuid(),
  hearing_id uuid not null references referral.hearings (id) on delete cascade,
  hearing_recipient_id uuid references referral.hearing_recipients (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  document_id uuid references documents.documents (id),
  response_text text,
  position text check (position in ('NO_OBJECTION', 'OBJECTION', 'CONDITIONAL', 'NO_OPINION')),
  received_at timestamptz not null default now()
);

create index hearing_responses_hearing_idx on referral.hearing_responses (hearing_id);

-- ---------------------------------------------------------------------------
-- Decisions (masterplan 72, 79)
-- ---------------------------------------------------------------------------

create table decision.decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete cascade,
  decision_type text not null,
  decision_number text,
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'REVIEW', 'APPROVED', 'DECIDED', 'EXPEDITED', 'ARCHIVED'
  )),
  current_version integer not null default 0,
  -- Masterplan 79: the deciding actor is a person unless the municipality has
  -- explicitly enabled a legally analysed deterministic flow.
  decided_by uuid references identity.users (id),
  decided_at timestamptz,
  delegation_reference text,
  appeal_deadline_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, decision_number)
);

create index decisions_case_idx on decision.decisions (case_id);
create index decisions_authority_status_idx on decision.decisions (authority_id, status);

create table decision.decision_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  decision_id uuid not null references decision.decisions (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  version integer not null check (version >= 1),
  body text not null,
  conditions jsonb not null default '[]'::jsonb,
  legal_references jsonb not null default '[]'::jsonb,
  -- Masterplan 72/79: AI-generated text is always a draft.
  generated_by text not null default 'HUMAN' check (generated_by in ('HUMAN', 'AI_DRAFT', 'TEMPLATE')),
  ai_run_id uuid,
  document_id uuid references documents.documents (id),
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  unique (decision_id, version)
);

create or replace function decision.enforce_human_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status in ('DECIDED', 'EXPEDITED') and new.decided_by is null then
    raise exception 'A decision may not reach % without an accountable human decision maker', new.status
      using errcode = 'raise_exception';
  end if;
  return new;
end;
$$;

revoke all on function decision.enforce_human_decision() from public;

create trigger decisions_require_human
  before insert or update on decision.decisions
  for each row execute function decision.enforce_human_decision();

create trigger decisions_set_updated_at before update on decision.decisions
  for each row execute function config.set_updated_at();

-- ---------------------------------------------------------------------------
-- Inspections and findings (masterplan 73)
-- ---------------------------------------------------------------------------

create table inspection.inspection_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  inspection_type text not null,
  created_at timestamptz not null default now(),
  unique (authority_id, key)
);

create table inspection.inspection_template_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  template_id uuid not null references inspection.inspection_templates (id) on delete cascade,
  version integer not null check (version >= 1),
  definition jsonb not null,
  valid_from date not null default current_date,
  valid_to date,
  unique (template_id, version)
);

create table inspection.inspections (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  property_id uuid references property.properties (id),
  building_id uuid references property.buildings (id),
  template_version_id uuid references inspection.inspection_template_versions (id),
  inspection_type text not null,
  scheduled_at timestamptz,
  performed_at timestamptz,
  performed_by uuid references identity.users (id),
  status text not null default 'PLANNED'
    check (status in ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  result text check (result in ('APPROVED', 'APPROVED_WITH_REMARKS', 'REJECTED', 'NOT_APPLICABLE')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index inspections_case_idx on inspection.inspections (case_id);
create index inspections_authority_status_idx on inspection.inspections (authority_id, status, scheduled_at);
create index inspections_property_idx on inspection.inspections (property_id);

create table inspection.inspection_items (
  id uuid primary key default extensions.gen_random_uuid(),
  inspection_id uuid not null references inspection.inspections (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  item_key text not null,
  description text not null,
  result text check (result in ('OK', 'REMARK', 'DEVIATION', 'NOT_APPLICABLE')),
  comment text,
  sort_order integer not null default 0
);

create index inspection_items_inspection_idx on inspection.inspection_items (inspection_id);

create table inspection.findings (
  id uuid primary key default extensions.gen_random_uuid(),
  inspection_id uuid references inspection.inspections (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  severity text not null check (severity in ('INFO', 'REMARK', 'DEVIATION', 'SERIOUS')),
  title text not null,
  description text,
  rule_id uuid references rules.rules (id),
  status text not null default 'OPEN'
    check (status in ('OPEN', 'ACTION_REQUIRED', 'RESOLVED', 'ESCALATED', 'CLOSED')),
  due_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index findings_case_idx on inspection.findings (case_id);
create index findings_authority_status_idx on inspection.findings (authority_id, status, due_at);

create table inspection.finding_evidence (
  id uuid primary key default extensions.gen_random_uuid(),
  finding_id uuid not null references inspection.findings (id) on delete cascade,
  document_id uuid references documents.documents (id),
  document_version_id uuid references documents.document_versions (id),
  note text,
  captured_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Compliance / OVK (masterplan 28, 74)
-- ---------------------------------------------------------------------------

create table compliance.obligations (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique,
  name text not null,
  domain text not null default 'OVK',
  legal_reference text,
  description text
);

create table compliance.obligation_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  obligation_id uuid not null references compliance.obligations (id) on delete cascade,
  applies_when jsonb not null,
  interval_months integer not null check (interval_months > 0),
  valid_from date not null default current_date,
  valid_to date
);

create table compliance.compliance_objects (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  property_id uuid references property.properties (id) on delete cascade,
  building_id uuid references property.buildings (id) on delete cascade,
  obligation_id uuid not null references compliance.obligations (id) on delete restrict,
  object_reference text,
  ventilation_system_type text,
  last_performed_at date,
  next_due_at date,
  status text not null default 'UNKNOWN'
    check (status in ('UNKNOWN', 'COMPLIANT', 'DUE', 'OVERDUE', 'EXEMPT')),
  risk_score numeric(5, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (authority_id, obligation_id, building_id, object_reference)
);

create index compliance_objects_due_idx on compliance.compliance_objects (authority_id, next_due_at)
  where status in ('DUE', 'OVERDUE', 'UNKNOWN');

create table compliance.compliance_findings (
  id uuid primary key default extensions.gen_random_uuid(),
  compliance_object_id uuid not null references compliance.compliance_objects (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  inspection_id uuid references inspection.inspections (id),
  finding_type text not null,
  description text,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Masterplan 28: cached Boverket energy declarations with source hash and fetch time.
create table compliance.energy_declarations (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  property_id uuid references property.properties (id) on delete cascade,
  building_id uuid references property.buildings (id) on delete cascade,
  source_id uuid references integration.data_sources (id),
  declaration_number text,
  energy_class text,
  primary_energy numeric(10, 2),
  specific_energy numeric(10, 2),
  radon_measurement_status text,
  ventilation_check_status text,
  performed_at date,
  source_fetched_at timestamptz not null default now(),
  source_payload_hash text not null,
  unique (building_id, declaration_number)
);

create index energy_declarations_property_idx on compliance.energy_declarations (property_id);

-- ---------------------------------------------------------------------------
-- AI governance (masterplan 75–79)
-- ---------------------------------------------------------------------------

create table ai.providers (
  id uuid primary key default extensions.gen_random_uuid(),
  key text not null unique,
  name text not null,
  credential_reference text,
  data_processing_agreement text,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table ai.models (
  id uuid primary key default extensions.gen_random_uuid(),
  provider_id uuid not null references ai.providers (id) on delete cascade,
  model_key text not null,
  display_name text not null,
  modality text not null default 'TEXT',
  enabled boolean not null default false,
  unique (provider_id, model_key)
);

create table ai.prompt_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  task_key text not null,
  version integer not null check (version >= 1),
  prompt text not null,
  system_prompt text,
  output_schema jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references identity.users (id),
  unique (task_key, version)
);

create table ai.runs (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  document_version_id uuid references documents.document_versions (id) on delete cascade,
  task_key text not null,
  model_id uuid references ai.models (id),
  prompt_version_id uuid references ai.prompt_versions (id),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED')),
  input_hash text,
  token_usage jsonb not null default '{}'::jsonb,
  latency_ms integer,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  correlation_id uuid
);

create index ai_runs_case_idx on ai.runs (case_id, created_at desc);
create index ai_runs_authority_idx on ai.runs (authority_id, created_at desc);

-- Masterplan 77: every finding carries its evidence so the UI can show "varför".
create table ai.findings (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null references ai.runs (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  finding_type text not null,
  finding text not null,
  extracted_value text,
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  source_document_id uuid references documents.documents (id),
  source_document_version_id uuid references documents.document_versions (id),
  source_page integer,
  source_section text,
  rule_id uuid references rules.rules (id),
  created_at timestamptz not null default now()
);

create index ai_findings_case_idx on ai.findings (case_id, created_at desc);
create index ai_findings_run_idx on ai.findings (run_id);

-- Masterplan 79/92: a human accepts or rejects; that decision is the ROI signal.
create table ai.reviews (
  id uuid primary key default extensions.gen_random_uuid(),
  finding_id uuid not null references ai.findings (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  reviewed_by uuid not null references identity.users (id),
  decision text not null check (decision in ('ACCEPTED', 'REJECTED', 'MODIFIED')),
  comment text,
  reviewed_at timestamptz not null default now(),
  unique (finding_id, reviewed_by)
);

-- ---------------------------------------------------------------------------
-- Archive and retention (masterplan 88–90)
-- ---------------------------------------------------------------------------

create table archive.retention_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  key text not null,
  name text not null,
  applies_to text not null,
  retention_years integer,
  disposition text not null check (disposition in ('PRESERVE', 'DISPOSE', 'REVIEW')),
  legal_reference text,
  valid_from date not null default current_date,
  valid_to date,
  unique (authority_id, key)
);

create table archive.legal_holds (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid references core.cases (id) on delete cascade,
  reason text not null,
  placed_by uuid references identity.users (id),
  placed_at timestamptz not null default now(),
  released_by uuid references identity.users (id),
  released_at timestamptz
);

create index legal_holds_case_idx on archive.legal_holds (case_id) where released_at is null;

create table archive.archive_packages (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete restrict,
  package_reference text not null,
  fgs_version text,
  manifest jsonb not null default '{}'::jsonb,
  checksum text,
  storage_bucket text,
  storage_path text,
  status text not null default 'BUILDING'
    check (status in ('BUILDING', 'READY', 'DELIVERED', 'FAILED')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (authority_id, package_reference)
);

create table archive.archive_exports (
  id uuid primary key default extensions.gen_random_uuid(),
  package_id uuid not null references archive.archive_packages (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  export_format text not null check (export_format in ('FGS', 'SIARD', 'CANONICAL_JSON', 'PDF_A')),
  exported_at timestamptz not null default now(),
  exported_by uuid references identity.users (id),
  destination text,
  checksum text
);

create table archive.archive_events (
  id bigint generated always as identity primary key,
  package_id uuid references archive.archive_packages (id) on delete cascade,
  case_id uuid references core.cases (id) on delete cascade,
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  actor uuid references identity.users (id),
  detail jsonb not null default '{}'::jsonb
);

-- Masterplan 89: no general delete. Disposition requires a retention decision,
-- an absent legal hold and an approval.
create table archive.disposition_decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  authority_id uuid not null references organization.authorities (id) on delete restrict,
  case_id uuid not null references core.cases (id) on delete restrict,
  retention_rule_id uuid not null references archive.retention_rules (id),
  approved_by uuid references identity.users (id),
  approved_at timestamptz,
  executed_at timestamptz,
  status text not null default 'PROPOSED'
    check (status in ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTED')),
  constraint disposition_requires_approval check (
    status not in ('APPROVED', 'EXECUTED') or (approved_by is not null and approved_at is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Reporting and ROI (masterplan 91, 92)
-- ---------------------------------------------------------------------------

create table reporting.operational_metrics (
  id bigint generated always as identity primary key,
  authority_id uuid not null references organization.authorities (id) on delete cascade,
  metric_key text not null,
  metric_date date not null,
  dimension jsonb not null default '{}'::jsonb,
  value numeric(18, 4) not null,
  computed_at timestamptz not null default now(),
  unique (authority_id, metric_key, metric_date, dimension)
);

create index operational_metrics_lookup_idx
  on reporting.operational_metrics (authority_id, metric_key, metric_date desc);

create table reporting.roi_events (
  id bigint generated always as identity primary key,
  authority_id uuid not null references organization.authorities (id) on delete cascade,
  case_id uuid references core.cases (id) on delete cascade,
  event_type text not null check (event_type in (
    'MANUAL_TOUCH', 'AUTOMATED_ACTION', 'AI_SUGGESTION', 'AI_ACCEPTED', 'AI_REJECTED',
    'PHASE_COMPLETED', 'COMPLETION_ROUND', 'DEADLINE_MISSED', 'INSPECTION_COMPLETED'
  )),
  phase text,
  duration_seconds integer,
  actor uuid references identity.users (id),
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);

create index roi_events_authority_idx on reporting.roi_events (authority_id, event_type, occurred_at desc);
create index roi_events_case_idx on reporting.roi_events (case_id);

create trigger inspections_set_updated_at before update on inspection.inspections
  for each row execute function config.set_updated_at();
create trigger compliance_objects_set_updated_at before update on compliance.compliance_objects
  for each row execute function config.set_updated_at();
