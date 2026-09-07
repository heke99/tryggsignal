-- Tryggsignal — RLS and grants for communication, referral, decision, inspection,
-- compliance, AI, archive and reporting (masterplan 18).
--
-- Pattern: anything attached to a case is visible exactly when the case is, so
-- the case policy stays the single place where the authority boundary, secrecy
-- class and external-party relation are decided. Everything else is scoped by
-- an explicit permission check.

do $$
declare
  t record;
begin
  for t in
    select table_schema, table_name
    from information_schema.tables
    where table_schema in ('communication', 'referral', 'decision', 'inspection',
                           'compliance', 'ai', 'archive', 'reporting')
      and table_type = 'BASE TABLE'
  loop
    execute format('alter table %I.%I enable row level security', t.table_schema, t.table_name);
  end loop;
end
$$;

grant usage on schema communication, referral, decision, inspection, compliance, ai,
  archive, reporting to authenticated;

-- Case-attached content
grant select on communication.messages, communication.deliveries, communication.templates
  to authenticated;
grant select on referral.referrals, referral.referral_recipients, referral.referral_responses,
  referral.hearings, referral.hearing_recipients, referral.hearing_responses to authenticated;
grant select on decision.decisions, decision.decision_versions to authenticated;
grant select on inspection.inspections, inspection.inspection_items, inspection.findings,
  inspection.finding_evidence, inspection.inspection_templates to authenticated;
grant select on compliance.obligations, compliance.obligation_rules,
  compliance.compliance_objects, compliance.compliance_findings,
  compliance.energy_declarations to authenticated;
grant select on ai.runs, ai.findings, ai.reviews, ai.prompt_versions to authenticated;
grant select on archive.retention_rules, archive.legal_holds, archive.archive_packages,
  archive.archive_exports, archive.disposition_decisions to authenticated;
grant select on reporting.operational_metrics, reporting.roi_events to authenticated;

create policy templates_select on communication.templates
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy messages_select on communication.messages
  for select to authenticated
  using (
    case when case_id is null
      then authz.has_permission('case.read', authority_id, null, null)
      else exists (select 1 from core.cases c where c.id = messages.case_id)
    end
  );

create policy deliveries_select on communication.deliveries
  for select to authenticated
  using (exists (select 1 from communication.messages m where m.id = deliveries.message_id));

create policy referrals_select on referral.referrals
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = referrals.case_id));

create policy referral_recipients_select on referral.referral_recipients
  for select to authenticated
  using (exists (select 1 from referral.referrals r where r.id = referral_recipients.referral_id));

create policy referral_responses_select on referral.referral_responses
  for select to authenticated
  using (exists (select 1 from referral.referrals r where r.id = referral_responses.referral_id));

create policy hearings_select on referral.hearings
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = hearings.case_id));

create policy hearing_recipients_select on referral.hearing_recipients
  for select to authenticated
  using (exists (select 1 from referral.hearings h where h.id = hearing_recipients.hearing_id));

create policy hearing_responses_select on referral.hearing_responses
  for select to authenticated
  using (exists (select 1 from referral.hearings h where h.id = hearing_responses.hearing_id));

-- A decision draft is internal until it is decided; an external party sees the
-- decision only once it has been made.
create policy decisions_select on decision.decisions
  for select to authenticated
  using (
    exists (select 1 from core.cases c where c.id = decisions.case_id)
    and (
      status in ('DECIDED', 'EXPEDITED', 'ARCHIVED')
      or authz.has_permission('decision.prepare', authority_id, null, null)
      or authz.has_permission('case.read', authority_id, null, null)
    )
  );

create policy decision_versions_select on decision.decision_versions
  for select to authenticated
  using (exists (select 1 from decision.decisions d where d.id = decision_versions.decision_id));

create policy inspection_templates_select on inspection.inspection_templates
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy inspections_select on inspection.inspections
  for select to authenticated
  using (
    case when case_id is null
      then authz.has_permission('case.read', authority_id, null, null)
      else exists (select 1 from core.cases c where c.id = inspections.case_id)
    end
  );

create policy inspection_items_select on inspection.inspection_items
  for select to authenticated
  using (exists (select 1 from inspection.inspections i where i.id = inspection_items.inspection_id));

create policy findings_select on inspection.findings
  for select to authenticated
  using (
    case when case_id is null
      then authz.has_permission('case.read', authority_id, null, null)
      else exists (select 1 from core.cases c where c.id = findings.case_id)
    end
  );

create policy finding_evidence_select on inspection.finding_evidence
  for select to authenticated
  using (exists (select 1 from inspection.findings f where f.id = finding_evidence.finding_id));

-- Obligation definitions are regulation, not municipal content.
create policy obligations_select on compliance.obligations
  for select to authenticated using (true);
create policy obligation_rules_select on compliance.obligation_rules
  for select to authenticated using (true);

create policy compliance_objects_select on compliance.compliance_objects
  for select to authenticated
  using (authz.has_permission('case.read', authority_id, null, null));

create policy compliance_findings_select on compliance.compliance_findings
  for select to authenticated
  using (authz.has_permission('case.read', authority_id, null, null));

create policy energy_declarations_select on compliance.energy_declarations
  for select to authenticated
  using (authz.has_permission('case.read', authority_id, null, null));

-- Masterplan 77/78: AI output is visible with its case, and prompt versions are
-- readable so a caseworker can see which prompt produced a finding.
create policy ai_runs_select on ai.runs
  for select to authenticated
  using (
    case when case_id is null
      then authz.has_permission('case.read', authority_id, null, null)
      else exists (select 1 from core.cases c where c.id = runs.case_id)
    end
  );

create policy ai_findings_select on ai.findings
  for select to authenticated
  using (exists (select 1 from ai.runs r where r.id = findings.run_id));

create policy ai_reviews_select on ai.reviews
  for select to authenticated
  using (exists (select 1 from ai.findings f where f.id = reviews.finding_id));

create policy ai_prompt_versions_select on ai.prompt_versions
  for select to authenticated using (true);

create policy retention_rules_select on archive.retention_rules
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy legal_holds_select on archive.legal_holds
  for select to authenticated
  using (authz.has_permission('case.read', authority_id, null, null));

create policy archive_packages_select on archive.archive_packages
  for select to authenticated
  using (exists (select 1 from core.cases c where c.id = archive_packages.case_id));

create policy archive_exports_select on archive.archive_exports
  for select to authenticated
  using (exists (select 1 from archive.archive_packages p where p.id = archive_exports.package_id));

create policy disposition_decisions_select on archive.disposition_decisions
  for select to authenticated
  using (authz.has_permission('case.close', authority_id, null, null));

-- Aggregated operational metrics carry no case content but are still scoped to
-- the authority that produced them.
create policy operational_metrics_select on reporting.operational_metrics
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));

create policy roi_events_select on reporting.roi_events
  for select to authenticated
  using (authority_id in (select authz.assigned_authority_ids()));
