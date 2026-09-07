/**
 * Masterplan 17: `can(user, permission, resource)` returning allowed, policy_id
 * and reason. This is the ABAC layer above RBAC; RLS in the data plane remains
 * the enforcing boundary (masterplan 18) and this never replaces it.
 */
import type { Permission, Role } from './permissions';
import { ROLE_PERMISSIONS } from './permissions';

export const SCOPE_TYPES = ['TENANT', 'AUTHORITY', 'DEPARTMENT', 'UNIT', 'TEAM'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface RoleAssignment {
  readonly role: Role;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface AuthorizationSubject {
  readonly userId: string;
  readonly tenantId: string;
  readonly assignments: readonly RoleAssignment[];
  /** Authority ids the subject may act within, expanded from the org hierarchy. */
  readonly authorityIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly teamIds: readonly string[];
  readonly isExternal: boolean;
}

export interface ResourceAttributes {
  readonly kind: 'case' | 'document' | 'decision' | 'inspection' | 'audit_event';
  readonly tenantId: string;
  readonly authorityId: string;
  readonly departmentId?: string | null;
  readonly assignedUserId?: string | null;
  readonly assignedTeamId?: string | null;
  readonly informationClass?: 'PUBLIC' | 'INTERNAL' | 'RESTRICTED' | 'SECRET';
  readonly secrecyLevel?: number;
  /** Set for external parties with a verified relation to the case. */
  readonly relationshipToResource?: 'APPLICANT' | 'REPRESENTATIVE' | 'NEIGHBOUR' | null;
}

export interface Decision {
  readonly allowed: boolean;
  readonly policyId: string;
  readonly reason: string;
}

const deny = (policyId: string, reason: string): Decision => ({ allowed: false, policyId, reason });
const allow = (policyId: string, reason: string): Decision => ({ allowed: true, policyId, reason });

function assignmentActive(assignment: RoleAssignment, now: Date): boolean {
  if (assignment.validFrom !== null && new Date(assignment.validFrom) > now) return false;
  if (assignment.validTo !== null && new Date(assignment.validTo) <= now) return false;
  return true;
}

function scopeCovers(
  assignment: RoleAssignment,
  subject: AuthorizationSubject,
  resource: ResourceAttributes,
): boolean {
  switch (assignment.scopeType) {
    case 'TENANT':
      return assignment.scopeId === resource.tenantId;
    case 'AUTHORITY':
      return assignment.scopeId === resource.authorityId;
    case 'DEPARTMENT':
      return assignment.scopeId != null && assignment.scopeId === resource.departmentId;
    case 'UNIT':
      // Unit scope is expanded to its department by the directory layer.
      return assignment.scopeId != null && subject.departmentIds.includes(assignment.scopeId);
    case 'TEAM':
      return assignment.scopeId != null && assignment.scopeId === resource.assignedTeamId;
  }
}

/**
 * Deny-by-default. Every allow decision must be traceable to one role assignment
 * whose scope covers the resource, plus the information-class check.
 */
export function can(
  subject: AuthorizationSubject,
  permission: Permission,
  resource: ResourceAttributes,
  now: Date = new Date(),
): Decision {
  if (subject.tenantId !== resource.tenantId) {
    return deny('policy.tenant_boundary', 'Subject belongs to another tenant/data plane.');
  }

  if (subject.isExternal) {
    // Masterplan 17/96: external parties reach a case only through a verified relation.
    if (resource.relationshipToResource == null) {
      return deny('policy.external_relationship', 'No verified relationship to the resource.');
    }
    if (
      !(['case.read', 'document.read', 'document.upload'] as readonly string[]).includes(permission)
    ) {
      return deny('policy.external_permission', `External parties may not perform ${permission}.`);
    }
    if (resource.informationClass === 'SECRET' || resource.informationClass === 'RESTRICTED') {
      return deny(
        'policy.information_class',
        'Resource information class excludes external access.',
      );
    }
    return allow(
      'policy.external_party',
      `Verified ${resource.relationshipToResource} on the resource.`,
    );
  }

  if (!subject.authorityIds.includes(resource.authorityId)) {
    return deny(
      'policy.authority_boundary',
      'Subject has no assignment inside the resource authority.',
    );
  }

  const granting = subject.assignments.find(
    (assignment) =>
      assignmentActive(assignment, now) &&
      ROLE_PERMISSIONS[assignment.role].includes(permission) &&
      scopeCovers(assignment, subject, resource),
  );

  if (granting === undefined) {
    return deny('policy.rbac', `No active role assignment grants ${permission} on this scope.`);
  }

  if (resource.informationClass === 'SECRET') {
    const cleared =
      granting.role === 'security_admin' ||
      granting.role === 'senior_case_worker' ||
      granting.role === 'decision_maker' ||
      resource.assignedUserId === subject.userId;
    if (!cleared) {
      return deny(
        'policy.information_class',
        'Secrecy-classified resource requires explicit clearance.',
      );
    }
  }

  return allow(
    'policy.rbac',
    `Role ${granting.role} on ${granting.scopeType} scope grants ${permission}.`,
  );
}
