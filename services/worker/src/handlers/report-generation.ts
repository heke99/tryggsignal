/**
 * Masterplan 26: operational and ROI metrics are computed from case data, never
 * from estimates. The computation itself lives in `reporting.rollup_metrics`, so
 * the same rule serves both the nightly cron job and an on-demand job.
 */
import type { JobEnvelope } from '../envelope';
import type { SqlExecutor } from '../pgmq-client';

export async function handleReportGeneration(
  _envelope: JobEnvelope,
  sql: SqlExecutor,
): Promise<void> {
  await sql.query('select reporting.rollup_metrics()');
}
