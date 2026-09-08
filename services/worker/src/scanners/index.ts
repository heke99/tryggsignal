import { ExternalBlockedError } from '../errors';
import { ClamAvScanner } from './clamav';
import type { MalwareScanner } from './malware-scanner';

export type { MalwareScanner, MalwareScanResult } from './malware-scanner';

export function scannerFromEnvironment(env: NodeJS.ProcessEnv = process.env): MalwareScanner {
  const provider = (env['MALWARE_SCANNER'] ?? '').trim().toLowerCase();

  if (provider.length === 0) {
    throw new ExternalBlockedError(
      'EB-08',
      'MALWARE_SCANNER is not configured; quarantined files remain unavailable',
    );
  }

  if (provider !== 'clamav') {
    throw new Error(`Unsupported MALWARE_SCANNER provider "${provider}"`);
  }

  return new ClamAvScanner({
    socketPath: env['CLAMAV_SOCKET']?.trim() || '/run/clamav/clamd.ctl',
    timeoutMs: Number(env['CLAMAV_TIMEOUT_MS'] ?? 120_000),
  });
}
