/** Masterplan 20: canonical case model shared by every product surface. */

export const CASE_PROCESS_TYPES = [
  'BYGGLOV',
  'ANMALAN',
  'FORHANDSBESKED',
  'RIVNINGSLOV',
  'MARKLOV',
  'PBL_TILLSYN',
  'OVK',
] as const;

export type CaseProcessType = (typeof CASE_PROCESS_TYPES)[number];

export const CASE_STATUSES = [
  'DRAFT',
  'RECEIVED',
  'REGISTERED',
  'AWAITING_COMPLETION',
  'IN_REVIEW',
  'AWAITING_DECISION',
  'DECIDED',
  'CLOSED',
  'ARCHIVED',
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PHASES = [
  'INTAKE',
  'COMPLETENESS',
  'REVIEW',
  'DECISION',
  'EXECUTION',
  'FINAL_CLEARANCE',
  'ARCHIVE',
] as const;

export type CasePhase = (typeof CASE_PHASES)[number];

/** Masterplan 82: information class drives search, AI and export filtering. */
export const INFORMATION_CLASSES = ['PUBLIC', 'INTERNAL', 'RESTRICTED', 'SECRET'] as const;
export type InformationClass = (typeof INFORMATION_CLASSES)[number];

export interface CaseSummary {
  readonly id: string;
  readonly authorityId: string;
  readonly departmentId: string | null;
  readonly caseNumber: string;
  readonly externalCaseNumber: string | null;
  readonly processType: CaseProcessType;
  readonly status: CaseStatus;
  readonly phase: CasePhase;
  readonly title: string;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
  readonly informationClass: InformationClass;
  readonly statutoryDueAt: string | null;
  readonly effectiveDueAt: string | null;
  readonly systemOfRecord: string;
}
