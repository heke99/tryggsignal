import 'server-only';
import type { TenantContext } from '@tryggsignal/tenancy';
import { tenantClient, TenantDataPlaneUnavailableError } from './client';

/**
 * Read models for the staff surfaces. Every query is scoped by RLS in the tenant
 * data plane; nothing here adds or removes an access filter of its own.
 */

export interface ControlTowerRow {
  readonly id: string;
  readonly case_number: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly statutory_due_at: string | null;
  readonly assigned_user_id: string | null;
}

export interface ControlTower {
  readonly available: boolean;
  readonly reason?: string;
  readonly dueSoon: readonly ControlTowerRow[];
  readonly unassigned: readonly ControlTowerRow[];
  readonly awaitingCompletion: readonly ControlTowerRow[];
  readonly overdueReferrals: number;
  readonly failedJobs: number;
}

const EMPTY: ControlTower = {
  available: false,
  dueSoon: [],
  unassigned: [],
  awaitingCompletion: [],
  overdueReferrals: 0,
  failedJobs: 0,
};

const CASE_COLUMNS = 'id, case_number, title, status, phase, statutory_due_at, assigned_user_id';

/** Masterplan 95: the dashboard is operational — queues to act on, not graphs. */
export async function loadControlTower(context: TenantContext): Promise<ControlTower> {
  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { ...EMPTY, reason: error.message };
    }
    throw error;
  }

  if (!session.authenticated) {
    return { ...EMPTY, reason: 'Ingen inloggad session på den här värden.' };
  }

  const db = session.client.schema('core');
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString();

  const [dueSoon, unassigned, awaitingCompletion] = await Promise.all([
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .lte('statutory_due_at', inFiveDays)
      .not('status', 'in', '("CLOSED","ARCHIVED")')
      .order('statutory_due_at', { ascending: true })
      .limit(25),
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .is('assigned_user_id', null)
      .not('status', 'in', '("CLOSED","ARCHIVED")')
      .order('created_at', { ascending: true })
      .limit(25),
    db
      .from('cases')
      .select(CASE_COLUMNS)
      .eq('status', 'AWAITING_COMPLETION')
      .order('statutory_due_at', { ascending: true })
      .limit(25),
  ]);

  const rows = (result: { data: unknown }): readonly ControlTowerRow[] =>
    Array.isArray(result.data) ? (result.data as ControlTowerRow[]) : [];

  const [referrals, failedJobs] = await Promise.all([
    session.client
      .schema('referral')
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .lt('due_at', new Date().toISOString())
      .in('status', ['SENT', 'PARTIALLY_ANSWERED', 'OVERDUE']),
    session.client
      .schema('integration')
      .from('sync_jobs')
      .select('id', { count: 'exact', head: true })
      .in('status', ['FAILED', 'DEAD_LETTER']),
  ]);

  return {
    available: true,
    dueSoon: rows(dueSoon),
    unassigned: rows(unassigned),
    awaitingCompletion: rows(awaitingCompletion),
    overdueReferrals: referrals.count ?? 0,
    failedJobs: failedJobs.count ?? 0,
  };
}

export interface CaseHeader {
  readonly id: string;
  readonly authority_id: string;
  readonly department_id: string | null;
  readonly case_number: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly information_class: string;
  readonly statutory_due_at: string | null;
  readonly effective_due_at: string | null;
  readonly system_of_record: string;
  readonly assigned_user_id: string | null;
  readonly assigned_team_id: string | null;
}

export interface CaseWorkflow {
  readonly id: string;
  readonly currentState: string;
  readonly status: string;
  readonly availableTransitions: readonly string[];
  readonly tasks: readonly {
    id: string;
    title: string;
    status: string;
    due_at: string | null;
  }[];
  readonly transitions: readonly {
    id: number;
    from_state: string | null;
    to_state: string;
    occurred_at: string;
    reason: string | null;
  }[];
}

export interface StaffOption {
  readonly id: string;
  readonly display_name: string;
}

export interface TeamOption {
  readonly id: string;
  readonly name: string;
}

export interface CaseWorkspace {
  readonly available: boolean;
  readonly reason?: string;
  readonly header: CaseHeader | null;
  readonly documents: readonly {
    id: string;
    title: string;
    document_type: string;
    current_version: number;
  }[];
  readonly deadlines: readonly { id: string; name: string; due_at: string; status: string }[];
  readonly history: readonly { id: number; to_status: string; changed_at: string }[];
  readonly workflow: CaseWorkflow | null;
  readonly assignees: readonly StaffOption[];
  readonly teams: readonly TeamOption[];
}

interface WorkflowDefinition {
  readonly states?: Record<string, { readonly to?: readonly string[] }>;
}

function transitionTargets(definition: unknown, currentState: string): readonly string[] {
  if (typeof definition !== 'object' || definition === null) return [];
  const states = (definition as WorkflowDefinition).states;
  const state = states?.[currentState];
  return Array.isArray(state?.to) ? state.to.filter((value): value is string => typeof value === 'string') : [];
}

export async function loadCaseWorkspace(
  context: TenantContext,
  caseId: string,
): Promise<CaseWorkspace> {
  const empty: CaseWorkspace = {
    available: false,
    header: null,
    documents: [],
    deadlines: [],
    history: [],
    workflow: null,
    assignees: [],
    teams: [],
  };

  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError)
      return { ...empty, reason: error.message };
    throw error;
  }
  if (!session.authenticated) {
    return { ...empty, reason: 'Ingen inloggad session på den här värden.' };
  }

  const { data: header } = await session.client
    .schema('core')
    .from('cases')
    .select(
      'id, authority_id, department_id, case_number, title, status, phase, information_class, statutory_due_at, effective_due_at, system_of_record, assigned_user_id, assigned_team_id',
    )
    .eq('id', caseId)
    .maybeSingle<CaseHeader>();

  // An unreadable case is indistinguishable from a missing one by design: RLS
  // filters it out, and the UI must not confirm that it exists.
  if (header === null) {
    return {
      ...empty,
      available: true,
      reason: 'Ärendet finns inte eller är inte tillgängligt för dig.',
    };
  }

  const [documents, deadlines, history, workflowInstance, memberships, teams] = await Promise.all([
    session.client
      .schema('documents')
      .from('documents')
      .select('id, title, document_type, current_version')
      .eq('case_id', caseId)
      .order('created_at', { ascending: false })
      .limit(50),
    session.client
      .schema('workflow')
      .from('deadlines')
      .select('id, name, due_at, status')
      .eq('case_id', caseId)
      .order('due_at', { ascending: true }),
    session.client
      .schema('core')
      .from('case_status_history')
      .select('id, to_status, changed_at')
      .eq('case_id', caseId)
      .order('changed_at', { ascending: false })
      .limit(20),
    session.client
      .schema('workflow')
      .from('workflow_instances')
      .select('id, current_state, status, template_version_id, started_at')
      .eq('case_id', caseId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        id: string;
        current_state: string;
        status: string;
        template_version_id: string;
        started_at: string;
      }>(),
    session.client
      .schema('identity')
      .from('user_memberships')
      .select('user_id')
      .eq('authority_id', header.authority_id),
    session.client
      .schema('organization')
      .from('teams')
      .select('id, name')
      .eq('authority_id', header.authority_id)
      .eq('is_active', true)
      .order('name', { ascending: true }),
  ]);

  const userIds = Array.from(
    new Set(
      (memberships.data ?? [])
        .map((membership) => String((membership as { user_id: string }).user_id))
        .filter(Boolean),
    ),
  );

  const assignees =
    userIds.length === 0
      ? []
      : (
          await session.client
            .schema('identity')
            .from('users')
            .select('id, display_name')
            .in('id', userIds)
            .eq('status', 'ACTIVE')
            .order('display_name', { ascending: true })
        ).data ?? [];

  let workflow: CaseWorkflow | null = null;

  if (workflowInstance.data !== null) {
    const instance = workflowInstance.data;
    const [version, tasks, transitions] = await Promise.all([
      session.client
        .schema('workflow')
        .from('workflow_template_versions')
        .select('definition')
        .eq('id', instance.template_version_id)
        .maybeSingle<{ definition: unknown }>(),
      session.client
        .schema('workflow')
        .from('workflow_tasks')
        .select('id, title, status, due_at')
        .eq('instance_id', instance.id)
        .in('status', ['OPEN', 'IN_PROGRESS', 'BLOCKED'])
        .order('created_at', { ascending: true }),
      session.client
        .schema('workflow')
        .from('workflow_transitions')
        .select('id, from_state, to_state, occurred_at, reason')
        .eq('instance_id', instance.id)
        .order('occurred_at', { ascending: false })
        .limit(20),
    ]);

    workflow = {
      id: instance.id,
      currentState: instance.current_state,
      status: instance.status,
      availableTransitions:
        instance.status === 'RUNNING'
          ? transitionTargets(version.data?.definition, instance.current_state)
          : [],
      tasks: (tasks.data ?? []) as CaseWorkflow['tasks'],
      transitions: (transitions.data ?? []) as CaseWorkflow['transitions'],
    };
  }

  return {
    available: true,
    header,
    documents: (documents.data ?? []) as CaseWorkspace['documents'],
    deadlines: (deadlines.data ?? []) as CaseWorkspace['deadlines'],
    history: (history.data ?? []) as CaseWorkspace['history'],
    workflow,
    assignees: assignees as StaffOption[],
    teams: (teams.data ?? []) as TeamOption[],
  };
}

export interface CaseCreationOptions {
  readonly available: boolean;
  readonly reason?: string;
  readonly authorities: readonly { id: string; name: string }[];
  readonly departments: readonly { id: string; authority_id: string; name: string }[];
  readonly workflows: readonly {
    authority_id: string;
    key: string;
    name: string;
    process_type: string;
  }[];
}

export async function loadCaseCreationOptions(
  context: TenantContext,
): Promise<CaseCreationOptions> {
  const empty: CaseCreationOptions = {
    available: false,
    authorities: [],
    departments: [],
    workflows: [],
  };

  let session;
  try {
    session = await tenantClient(context);
  } catch (error) {
    if (error instanceof TenantDataPlaneUnavailableError) {
      return { ...empty, reason: error.message };
    }
    throw error;
  }

  if (!session.authenticated) {
    return { ...empty, reason: 'Ingen inloggad session på den här värden.' };
  }

  const [authorities, departments, templates, versions] = await Promise.all([
    session.client
      .schema('organization')
      .from('authorities')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
    session.client
      .schema('organization')
      .from('departments')
      .select('id, authority_id, name')
      .eq('is_active', true)
      .order('name', { ascending: true }),
    session.client
      .schema('workflow')
      .from('workflow_templates')
      .select('id, authority_id, key, name, process_type')
      .order('name', { ascending: true }),
    session.client
      .schema('workflow')
      .from('workflow_template_versions')
      .select('template_id, valid_from, valid_to, published_at'),
  ]);

  const now = Date.now();
  const activeTemplateIds = new Set(
    (versions.data ?? [])
      .filter((row) => {
        const version = row as {
          template_id: string;
          valid_from: string;
          valid_to: string | null;
          published_at: string | null;
        };
        return (
          version.published_at !== null &&
          Date.parse(version.valid_from) <= now &&
          (version.valid_to === null || Date.parse(version.valid_to) > now)
        );
      })
      .map((row) => String((row as { template_id: string }).template_id)),
  );

  return {
    available: true,
    authorities: (authorities.data ?? []) as CaseCreationOptions['authorities'],
    departments: (departments.data ?? []) as CaseCreationOptions['departments'],
    workflows: (templates.data ?? [])
      .filter((template) => activeTemplateIds.has(String((template as { id: string }).id)))
      .map((template) => {
        const row = template as {
          authority_id: string;
          key: string;
          name: string;
          process_type: string;
        };
        return {
          authority_id: row.authority_id,
          key: row.key,
          name: row.name,
          process_type: row.process_type,
        };
      }),
  };
}
