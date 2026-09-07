/** Masterplan 16: granular permission catalog, mirrored by `authz.permissions`. */

export const PERMISSIONS = [
  'case.read',
  'case.create',
  'case.update',
  'case.assign',
  'case.close',
  'document.read',
  'document.upload',
  'document.classify',
  'decision.prepare',
  'decision.approve',
  'inspection.create',
  'inspection.complete',
  'audit.read',
  'integration.manage',
  'security.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  'tenant_admin',
  'security_admin',
  'registrar',
  'building_case_worker',
  'senior_case_worker',
  'building_inspector',
  'environmental_inspector',
  'planning_officer',
  'decision_maker',
  'board_secretary',
  'archivist',
  'records_manager',
  'finance_officer',
  'gis_officer',
  'auditor',
  'external_applicant',
  'external_representative',
  'integration_service',
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Default role → permission grants. The database is the source of truth
 * (`authz.role_permissions`); this catalog keeps the seed migration and the
 * application in sync and is asserted against the database in the RLS test suite.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  tenant_admin: ['case.read', 'case.assign', 'audit.read', 'integration.manage'],
  security_admin: ['audit.read', 'security.manage'],
  registrar: ['case.read', 'case.create', 'case.update', 'document.read', 'document.upload'],
  building_case_worker: [
    'case.read',
    'case.create',
    'case.update',
    'document.read',
    'document.upload',
    'document.classify',
    'decision.prepare',
  ],
  senior_case_worker: [
    'case.read',
    'case.create',
    'case.update',
    'case.assign',
    'case.close',
    'document.read',
    'document.upload',
    'document.classify',
    'decision.prepare',
  ],
  building_inspector: ['case.read', 'document.read', 'inspection.create', 'inspection.complete'],
  environmental_inspector: [
    'case.read',
    'document.read',
    'inspection.create',
    'inspection.complete',
  ],
  planning_officer: ['case.read', 'document.read'],
  decision_maker: ['case.read', 'document.read', 'decision.prepare', 'decision.approve'],
  board_secretary: ['case.read', 'document.read', 'decision.prepare'],
  archivist: ['case.read', 'document.read'],
  records_manager: ['case.read', 'document.read', 'case.update'],
  finance_officer: ['case.read'],
  gis_officer: ['case.read', 'document.read'],
  auditor: ['case.read', 'document.read', 'audit.read'],
  external_applicant: ['case.read', 'document.read', 'document.upload'],
  external_representative: ['case.read', 'document.read', 'document.upload'],
  integration_service: ['case.read', 'case.create', 'case.update', 'document.upload'],
};
