/**
 * The job router. Masterplan 44: the worker owns the loop; a handler owns one
 * job type and nothing else.
 *
 * A job type whose external dependency does not exist yet is not silently
 * dropped and not retried forever — retrying cannot make a missing supplier
 * appear. It is dead-lettered with an `EXTERNAL_BLOCKED` reason, so the job
 * stays visible in `config.dead_letter_jobs` and can be replayed on the day the
 * dependency exists (masterplan 39, and `docs/blockers.md`).
 */
import { ExternalBlockedError, PermanentJobError } from '../errors';
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';
import { handleIntegrationInbound } from './integration-inbound';
import { handleSearchIndexing } from './search-indexing';
import { handleWorkflowTimer } from './workflow-timer';
import { handleReportGeneration } from './report-generation';

export type TypedHandler = (envelope: JobEnvelope, sql: SqlExecutor) => Promise<void>;

function blocked(blockerId: string, what: string): TypedHandler {
  return async () => {
    throw new ExternalBlockedError(blockerId, what);
  };
}

/**
 * Keyed by the envelope's `type`, not by the queue: one queue can carry several
 * job types, and the type is what decides the work.
 */
export const HANDLERS: Readonly<Record<string, TypedHandler>> = {
  integration_inbound: handleIntegrationInbound,
  search_indexing: handleSearchIndexing,
  workflow_timer: handleWorkflowTimer,
  report_generation: handleReportGeneration,
  metrics_rollup: handleReportGeneration,

  document_processing: blocked(
    'EB-08',
    'no malware-scanning provider, so an upload cannot leave quarantine',
  ),
  ai_analysis: blocked('EB-07', 'no AI provider contracted and no data-processing terms'),
  notification: blocked('EB-09', 'no mail provider configured for outbound delivery'),
  archive_generation: blocked('P25', 'the FGS package writer is not implemented'),
  reference_data_sync: blocked(
    'EB-03',
    'Lantmäteriet Geotorget access requires a per-municipality agreement',
  ),
};

export class UnknownJobTypeError extends PermanentJobError {
  constructor(type: string) {
    super(`No handler registered for job type "${type}"`);
  }
}

export function routeJob(sql: SqlExecutor) {
  return async (envelope: JobEnvelope): Promise<void> => {
    const handler = HANDLERS[envelope.type];
    if (handler === undefined) {
      throw new UnknownJobTypeError(envelope.type);
    }
    await handler(envelope, sql);
  };
}
