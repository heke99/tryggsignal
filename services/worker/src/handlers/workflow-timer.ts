/**
 * Masterplan 45: `workflow.sweep_timers` marks a timer fired and enqueues this
 * job. The timer's effect is recorded here, outside the cron transaction, so a
 * slow effect cannot hold the sweep open.
 */
import { PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';

interface TimerRow {
  id: string;
  instance_id: string;
  authority_id: string;
  timer_key: string;
  fired_at: string | null;
  cancelled_at: string | null;
}

export async function handleWorkflowTimer(envelope: JobEnvelope, sql: SqlExecutor): Promise<void> {
  const payload = envelope.payload as { timer_id?: string };
  const timerId = payload.timer_id;
  if (timerId === undefined) {
    throw new PermanentJobError('Payload has no timer_id');
  }

  const { rows } = await sql.query<TimerRow>(
    `select id, instance_id, authority_id, timer_key, fired_at, cancelled_at
     from workflow.workflow_timers where id = $1`,
    [timerId],
  );
  const timer = rows[0];
  if (timer === undefined) {
    throw new PermanentJobError(`Workflow timer ${timerId} no longer exists`);
  }

  // A timer cancelled between the sweep and this job must not have an effect.
  if (timer.cancelled_at !== null) return;

  await sql.query(
    `insert into reporting.roi_events (authority_id, case_id, event_type, detail)
     select $1::uuid, wi.case_id, 'WORKFLOW_TIMER_FIRED',
            jsonb_build_object('timer_key', $2::text, 'timer_id', $3::uuid)
     from workflow.workflow_instances wi
     where wi.id = $4::uuid`,
    [timer.authority_id, timer.timer_key, timer.id, timer.instance_id],
  );
}
