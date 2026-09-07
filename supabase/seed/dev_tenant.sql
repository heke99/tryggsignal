-- Development fixture for the control plane (masterplan 5: no production data in DEV).
--
-- Run with psql and supply the values for the environment:
--   psql "$CONTROL_PLANE_URL" \
--     -v slug=demokommun -v project_ref=... -v supabase_url=https://....supabase.co \
--     -v publishable_key=sb_publishable_... -f supabase/seed/dev_tenant.sql
--
-- The domain is intentionally created as PENDING. A domain may only become ACTIVE
-- after real ownership, DNS and TLS verification (masterplan 166/168); the schema
-- enforces this, and no seed may pretend a domain is verified.

insert into platform.tenants (
  slug, display_name, legal_name, status, operating_mode, canonical_hostname,
  auth_configuration_reference
)
values (
  :'slug', initcap(:'slug'), initcap(:'slug') || ' (utvecklingsmiljö)', 'ACTIVE', 'OVERLAY',
  :'slug' || '.tryggsignal.se', 'auth/' || :'slug' || '/dev'
)
on conflict (slug) do nothing;

insert into platform.tenant_deployments (
  tenant_id, environment, supabase_project_ref, supabase_region, supabase_url,
  publishable_key, privileged_credential_reference, schema_version, status, health_status,
  last_health_check_at
)
select t.id, 'DEV', :'project_ref', 'eu-north-1', :'supabase_url',
       :'publishable_key', 'tenant/' || :'slug' || '/dev/service',
       '20260907120800', 'ACTIVE', 'HEALTHY', now()
from platform.tenants t
where t.slug = :'slug'
on conflict (tenant_id, environment) do nothing;

insert into platform.tenant_domains (
  tenant_id, hostname, normalized_hostname, domain_type, status, is_canonical
)
select t.id, :'slug' || '.tryggsignal.se', :'slug' || '.tryggsignal.se',
       'PLATFORM_SUBDOMAIN', 'PENDING', true
from platform.tenants t
where t.slug = :'slug'
on conflict (normalized_hostname) do nothing;

insert into platform.tenant_branding (
  tenant_id, version, display_name, short_name, primary_color, secondary_color,
  locale, contrast_validation_status, status
)
select t.id, 1, initcap(:'slug'), 'Demo', '#14532d', '#1f2937', 'sv-SE', 'NOT_VALIDATED', 'DRAFT'
from platform.tenants t
where t.slug = :'slug'
on conflict (tenant_id, version) do nothing;

insert into platform.tenant_provisioning_runs (tenant_id, state)
select t.id, 'BRANDING_DRAFTED' from platform.tenants t where t.slug = :'slug';
