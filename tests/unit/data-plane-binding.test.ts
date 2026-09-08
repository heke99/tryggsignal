import { describe, expect, it } from 'vitest';
import { assertDeploymentMatchesContext, DataPlaneMismatchError } from '@tryggsignal/database';
import {
  clearedRefreshSessionCookie,
  refreshSessionCookie,
  sessionCookie,
} from '@tryggsignal/identity';
import type { TenantContext, TenantDeploymentRecord } from '@tryggsignal/tenancy';

const context: TenantContext = {
  tenantId: 'tenant-a',
  tenantSlug: 'alfakommun',
  domainId: 'domain-a',
  domainType: 'PLATFORM_SUBDOMAIN',
  canonicalDomain: 'alfakommun.tryggsignal.se',
  brandingVersion: 1,
  deploymentId: 'deployment-a',
  dataPlaneReference: 'project-a',
  authConfigurationReference: 'auth/a/staff',
  resolvedHostname: 'alfakommun.tryggsignal.se',
};

const deployment: TenantDeploymentRecord = {
  id: 'deployment-a',
  supabaseProjectRef: 'project-a',
  supabaseRegion: 'eu-north-1',
  supabaseUrl: 'https://project-a.supabase.co',
  publishableKey: 'sb_publishable_a',
  privilegedCredentialReference: 'tenant/a/service',
  schemaVersion: 'v1',
  status: 'ACTIVE',
  healthStatus: 'HEALTHY',
};

describe('tenant data-plane binding (masterplan 171)', () => {
  it('accepts only the exact deployment id and project reference', () => {
    expect(() => assertDeploymentMatchesContext(context, deployment)).not.toThrow();
  });

  it('hard-fails a deployment-id mismatch', () => {
    expect(() =>
      assertDeploymentMatchesContext(context, { ...deployment, id: 'deployment-b' }),
    ).toThrow(DataPlaneMismatchError);
  });

  it('hard-fails a project-ref mismatch', () => {
    expect(() =>
      assertDeploymentMatchesContext(context, {
        ...deployment,
        supabaseProjectRef: 'project-b',
      }),
    ).toThrow(DataPlaneMismatchError);
  });
});

describe('tenant refresh cookies (masterplan 180)', () => {
  it('keeps the refresh token host-only and tenant-specific', () => {
    const access = sessionCookie(context, 'access');
    const refresh = refreshSessionCookie(context, 'refresh');

    expect(refresh.name).toBe('__Host-ts_alfakommun_refresh');
    expect(refresh.name).not.toBe(access.name);
    expect(refresh.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('clears the exact refresh cookie name', () => {
    const cleared = clearedRefreshSessionCookie(context);
    expect(cleared.name).toBe('__Host-ts_alfakommun_refresh');
    expect(cleared.value).toBe('');
    expect(cleared.options.maxAge).toBe(0);
  });
});
