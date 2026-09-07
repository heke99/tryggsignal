/**
 * Masterplan 159/162/172: control-plane implementation of the TenantDirectory
 * port. Lookups are keyed on the normalized hostname only; no client-supplied
 * tenant identifier is ever accepted here.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TenantDeploymentRecord,
  TenantDirectory,
  TenantDomainRecord,
  TenantRecord,
} from '@tryggsignal/tenancy';

interface DomainRow {
  id: string;
  tenant_id: string;
  normalized_hostname: string;
  domain_type: TenantDomainRecord['domainType'];
  status: TenantDomainRecord['status'];
  is_canonical: boolean;
}

interface DeploymentRow {
  id: string;
  supabase_project_ref: string;
  supabase_region: string;
  supabase_url: string;
  publishable_key: string;
  privileged_credential_reference: string;
  schema_version: string;
  status: string;
  health_status: string;
}

interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  status: TenantRecord['status'];
  canonical_hostname: string;
  branding_version: number;
  auth_configuration_reference: string;
  deployment: DeploymentRow | DeploymentRow[] | null;
}

const firstDeployment = (value: TenantRow['deployment']): DeploymentRow | null =>
  Array.isArray(value) ? (value[0] ?? null) : value;

const toDeployment = (row: DeploymentRow): TenantDeploymentRecord => ({
  id: row.id,
  supabaseProjectRef: row.supabase_project_ref,
  supabaseRegion: row.supabase_region,
  supabaseUrl: row.supabase_url,
  publishableKey: row.publishable_key,
  privilegedCredentialReference: row.privileged_credential_reference,
  schemaVersion: row.schema_version,
  status: row.status,
  healthStatus: row.health_status,
});

export class ControlPlaneTenantDirectory implements TenantDirectory {
  constructor(private readonly client: SupabaseClient) {}

  async findDomain(normalizedHostname: string): Promise<TenantDomainRecord | null> {
    const { data, error } = await this.client
      .schema('platform')
      .from('tenant_domains')
      .select('id, tenant_id, normalized_hostname, domain_type, status, is_canonical')
      .eq('normalized_hostname', normalizedHostname)
      .maybeSingle<DomainRow>();

    if (error !== null) throw new Error(`tenant_domains lookup failed: ${error.message}`);
    if (data === null) return null;

    return {
      id: data.id,
      tenantId: data.tenant_id,
      normalizedHostname: data.normalized_hostname,
      domainType: data.domain_type,
      status: data.status,
      isCanonical: data.is_canonical,
    };
  }

  async findTenant(tenantId: string): Promise<TenantRecord | null> {
    const { data, error } = await this.client
      .schema('platform')
      .from('tenants')
      .select(
        'id, slug, display_name, status, canonical_hostname, branding_version, auth_configuration_reference, deployment:tenant_deployments(id, supabase_project_ref, supabase_region, supabase_url, publishable_key, privileged_credential_reference, schema_version, status, health_status)',
      )
      .eq('id', tenantId)
      .maybeSingle<TenantRow>();

    if (error !== null) throw new Error(`tenants lookup failed: ${error.message}`);
    if (data === null) return null;

    const deploymentRow = firstDeployment(data.deployment);
    if (deploymentRow === null) return null;

    return {
      id: data.id,
      slug: data.slug,
      displayName: data.display_name,
      status: data.status,
      canonicalHostname: data.canonical_hostname,
      brandingVersion: data.branding_version,
      authConfigurationReference: data.auth_configuration_reference,
      deployment: toDeployment(deploymentRow),
    };
  }
}
