/**
 * Receipt is not canonical application. A transport can authenticate and persist
 * an event without having a verified domain adapter capable of applying it.
 * Until that adapter's transaction (canonical write + provenance + audit + event
 * completion) exists, leave the receipt untouched and surface EB-06 in the queue.
 */
import { ExternalBlockedError, PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';

interface EventRow {
  readonly id: string;
  readonly status: string;
  readonly authority_id: string | null;
  readonly connector_instance_id: string;
  readonly attempt: number;
}

export async function handleIntegrationInbound(
  envelope: JobEnvelope,
  sql: SqlExecutor,
): Promise<void> {
  if (envelope.payload === null || typeof envelope.payload !== 'object') {
    throw new PermanentJobError('Payload has no integration_event_id');
  }
  const value: unknown = (envelope.payload as { integration_event_id?: unknown })
    .integration_event_id;
  const eventId =
    typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : '';
  if (!/^[1-9][0-9]{0,18}$/.test(eventId) || BigInt(eventId) > 9223372036854775807n) {
    throw new PermanentJobError('Payload has no valid integration_event_id');
  }

  const { rows } = await sql.query<EventRow>(
    `select id, status, authority_id, connector_instance_id, attempt
     from integration.integration_events where id = $1`,
    [eventId],
  );
  const event = rows[0];
  if (event === undefined) {
    throw new PermanentJobError(`Integration event ${eventId} no longer exists`);
  }
  if (
    event.connector_instance_id !== envelope.tenantContext ||
    envelope.authorityContext === null ||
    event.authority_id !== envelope.authorityContext
  ) {
    throw new PermanentJobError('Job scope does not match the integration event');
  }
  // Preserve legitimate completions made by a verified application transaction.
  if (event.status === 'PROCESSED') return;
  if (!['RECEIVED', 'FAILED'].includes(event.status)) {
    throw new PermanentJobError('Integration event is not eligible for processing');
  }
  throw new ExternalBlockedError(
    'EB-06',
    'No verified canonical application adapter is configured; receipt remains unprocessed',
  );
}
