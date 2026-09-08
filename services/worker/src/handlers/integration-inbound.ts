/**
 * Masterplan 67: an inbound integration event is processed exactly once, and a
 * failure is recorded on the event rather than lost.
 *
 * `integration.sweep_retries` enqueues the event id; this handler is what moves
 * the event out of RECEIVED/FAILED. The connector that would interpret the
 * payload is per-vendor and does not exist yet (EB-06), so the handler does the
 * part that is ours — validating the event exists, is not already processed, and
 * belongs to the tenant in the envelope — and leaves the payload untouched.
 */
import { PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';

interface EventRow {
  id: string;
  status: string;
  authority_id: string | null;
  connector_instance_id: string;
  attempt: number;
}

export async function handleIntegrationInbound(
  envelope: JobEnvelope,
  sql: SqlExecutor,
): Promise<void> {
  const payload = envelope.payload as { integration_event_id?: number | string };
  const eventId = payload.integration_event_id;
  if (eventId === undefined || eventId === null) {
    throw new PermanentJobError('Payload has no integration_event_id');
  }

  const { rows } = await sql.query<EventRow>(
    `select id, status, authority_id, connector_instance_id, attempt
     from integration.integration_events where id = $1`,
    [eventId],
  );
  const event = rows[0];
  if (event === undefined) {
    // The event was removed. Replaying it can never succeed.
    throw new PermanentJobError(`Integration event ${String(eventId)} no longer exists`);
  }

  // The envelope carries the connector instance as its tenant context. A job
  // that names a different one is not this event's job.
  if (event.connector_instance_id !== envelope.tenantContext) {
    throw new PermanentJobError(`Job tenant context does not match the event's connector instance`);
  }

  if (event.status === 'PROCESSED') return;

  await sql.query(
    `update integration.integration_events
     set status = 'PROCESSED', processed_at = now(), error = null, next_retry_at = null
     where id = $1`,
    [eventId],
  );
}
