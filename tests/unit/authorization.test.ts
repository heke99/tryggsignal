import { describe, expect, it } from 'vitest';
import {
  can,
  ROLE_PERMISSIONS,
  type AuthorizationSubject,
  type ResourceAttributes,
} from '@tryggsignal/authorization';

const TENANT = 'tenant-mjolby';
const AUTHORITY_A = 'authority-bygg';
const AUTHORITY_B = 'authority-miljo';
const DEPARTMENT_A = 'dep-bygglov';

const caseWorker: AuthorizationSubject = {
  userId: 'user-1',
  tenantId: TENANT,
  assignments: [
    {
      role: 'building_case_worker',
      scopeType: 'DEPARTMENT',
      scopeId: DEPARTMENT_A,
      validFrom: null,
      validTo: null,
    },
  ],
  authorityIds: [AUTHORITY_A],
  departmentIds: [DEPARTMENT_A],
  teamIds: [],
  isExternal: false,
};

const buildingCase: ResourceAttributes = {
  kind: 'case',
  tenantId: TENANT,
  authorityId: AUTHORITY_A,
  departmentId: DEPARTMENT_A,
  assignedUserId: 'user-1',
  informationClass: 'INTERNAL',
};

describe('can() — masterplan 17 ABAC decisions', () => {
  it('tenant admin holds the explicit branding permission', () => {
    expect(ROLE_PERMISSIONS.tenant_admin).toContain('branding.manage');
    expect(ROLE_PERMISSIONS.security_admin).not.toContain('branding.manage');
  });

  it('allows a granted permission inside the assigned scope', () => {
    const decision = can(caseWorker, 'case.update', buildingCase);
    expect(decision.allowed).toBe(true);
    expect(decision.policyId).toBe('policy.rbac');
    expect(decision.reason).toContain('building_case_worker');
  });

  it('denies a permission the role does not hold', () => {
    expect(can(caseWorker, 'decision.approve', buildingCase)).toMatchObject({
      allowed: false,
      policyId: 'policy.rbac',
    });
  });

  it('denies across the authority boundary (masterplan 13)', () => {
    expect(
      can(caseWorker, 'case.read', { ...buildingCase, authorityId: AUTHORITY_B }),
    ).toMatchObject({ allowed: false, policyId: 'policy.authority_boundary' });
  });

  it('denies across the tenant boundary even with matching ids', () => {
    expect(
      can(caseWorker, 'case.read', { ...buildingCase, tenantId: 'tenant-other' }),
    ).toMatchObject({ allowed: false, policyId: 'policy.tenant_boundary' });
  });

  it('denies another department inside the same authority', () => {
    expect(
      can(caseWorker, 'case.update', { ...buildingCase, departmentId: 'dep-annat' }),
    ).toMatchObject({ allowed: false, policyId: 'policy.rbac' });
  });

  it('honours assignment validity windows', () => {
    const expired: AuthorizationSubject = {
      ...caseWorker,
      assignments: [
        {
          role: 'building_case_worker',
          scopeType: 'DEPARTMENT',
          scopeId: DEPARTMENT_A,
          validFrom: '2020-01-01T00:00:00Z',
          validTo: '2021-01-01T00:00:00Z',
        },
      ],
    };
    expect(can(expired, 'case.read', buildingCase, new Date('2026-01-01T00:00:00Z')).allowed).toBe(
      false,
    );
  });

  it('requires clearance for secrecy-classified resources', () => {
    const unassigned = {
      ...buildingCase,
      informationClass: 'SECRET' as const,
      assignedUserId: 'user-2',
    };
    expect(can(caseWorker, 'case.read', unassigned)).toMatchObject({
      allowed: false,
      policyId: 'policy.information_class',
    });
    const senior: AuthorizationSubject = {
      ...caseWorker,
      assignments: [
        {
          role: 'senior_case_worker',
          scopeType: 'AUTHORITY',
          scopeId: AUTHORITY_A,
          validFrom: null,
          validTo: null,
        },
      ],
    };
    expect(can(senior, 'case.read', unassigned).allowed).toBe(true);
  });

  describe('external parties (masterplan 96)', () => {
    const applicant: AuthorizationSubject = {
      userId: 'ext-1',
      tenantId: TENANT,
      assignments: [
        {
          role: 'external_applicant',
          scopeType: 'TENANT',
          scopeId: TENANT,
          validFrom: null,
          validTo: null,
        },
      ],
      authorityIds: [],
      departmentIds: [],
      teamIds: [],
      isExternal: true,
    };

    it('allows read only through a verified relationship', () => {
      expect(
        can(applicant, 'case.read', { ...buildingCase, relationshipToResource: 'APPLICANT' })
          .allowed,
      ).toBe(true);
      expect(can(applicant, 'case.read', buildingCase)).toMatchObject({
        allowed: false,
        policyId: 'policy.external_relationship',
      });
    });

    it('never allows staff-only permissions or classified content', () => {
      expect(
        can(applicant, 'case.close', { ...buildingCase, relationshipToResource: 'APPLICANT' }),
      ).toMatchObject({ allowed: false, policyId: 'policy.external_permission' });
      expect(
        can(applicant, 'case.read', {
          ...buildingCase,
          relationshipToResource: 'APPLICANT',
          informationClass: 'RESTRICTED',
        }),
      ).toMatchObject({ allowed: false, policyId: 'policy.information_class' });
    });
  });

  it('grants no permission by default to an unknown subject shape', () => {
    const nobody: AuthorizationSubject = {
      userId: 'user-x',
      tenantId: TENANT,
      assignments: [],
      authorityIds: [AUTHORITY_A],
      departmentIds: [],
      teamIds: [],
      isExternal: false,
    };
    for (const permission of Object.values(ROLE_PERMISSIONS).flat()) {
      expect(can(nobody, permission, buildingCase).allowed).toBe(false);
    }
  });
});
