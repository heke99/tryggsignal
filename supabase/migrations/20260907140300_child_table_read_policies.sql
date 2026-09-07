-- Tryggsignal — advisor follow-up: child tables that had RLS enabled but no
-- policy, so they were unreachable even for a legitimate reader.
--
-- Each one now follows its parent. The tables deliberately left without a policy
-- are documented in place: they hold credential references or raw external
-- payloads and are server-side only (masterplan 82/174).

grant select on archive.archive_events, communication.delivery_events,
  inspection.inspection_template_versions, referral.hearing_deliveries to authenticated;

create policy archive_events_select on archive.archive_events
  for select to authenticated
  using (
    case when case_id is null
      then (select authz.scope_keys('case.read')) && authz.case_scope_keys(authority_id, null, null)
      else exists (select 1 from core.cases c where c.id = archive_events.case_id)
    end
  );

create policy delivery_events_select on communication.delivery_events
  for select to authenticated
  using (exists (
    select 1 from communication.deliveries d where d.id = delivery_events.delivery_id
  ));

create policy inspection_template_versions_select on inspection.inspection_template_versions
  for select to authenticated
  using (exists (
    select 1 from inspection.inspection_templates t where t.id = inspection_template_versions.template_id
  ));

create policy hearing_deliveries_select on referral.hearing_deliveries
  for select to authenticated
  using (exists (
    select 1 from referral.hearing_recipients r where r.id = hearing_deliveries.hearing_recipient_id
  ));

comment on table ai.providers is
  'Server-side only: holds credential references. RLS is enabled with no policy and no client grant, so a client key cannot reach it (masterplan 174).';
comment on table ai.models is
  'Server-side only, alongside ai.providers.';
comment on table integration.external_records is
  'Raw external payloads that have not passed classification. Server-side only (masterplan 82).';
comment on table migration.objects is
  'Raw legacy payloads preserved before transform. Server-side only (masterplan 56/82).';
comment on table integration.sync_checkpoints is
  'Connector cursors. Server-side only.';
