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

  const referrals = await session.client
    .schema('referral')
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .lt('due_at', new Date().toISOString())
    .in('status', ['SENT', 'PARTIALLY_ANSWERED', 'OVERDUE']);

  const failedJobs = await session.client
    .schema('integration')
    .from('sync_jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', ['FAILED', 'DEAD_LETTER']);

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
  readonly case_number: string;
  readonly title: string;
  readonly status: string;
  readonly phase: string;
  readonly information_class: string;
  readonly statutory_due_at: string | null;
  readonly effective_due_at: string | null;
  readonly system_of_record: string;
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
      'id, case_number, title, status, phase, information_class, statutory_due_at, effective_due_at, system_of_record',
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

  const [documents, deadlines, history] = await Promise.all([
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
  ]);

  return {
    available: true,
    header,
    documents: (documents.data ?? []) as CaseWorkspace['documents'],
    deadlines: (deadlines.data ?? []) as CaseWorkspace['deadlines'],
    history: (history.data ?? []) as CaseWorkspace['history'],
  };
}
