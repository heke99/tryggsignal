/**
 * Failures a retry cannot fix.
 *
 * The retry policy exists for transient trouble — a lock, a timeout, a
 * connector that is briefly down. A job whose payload names a row that does not
 * exist, or whose supplier has not been contracted, will fail identically on
 * every attempt. Retrying those eight times costs eight failures and delays the
 * moment a person sees the problem, so they go straight to the dead-letter table.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** A dependency that is not merely down but does not exist yet. */
export class ExternalBlockedError extends PermanentJobError {
  constructor(
    readonly blockerId: string,
    reason: string,
  ) {
    super(`EXTERNAL_BLOCKED (${blockerId}): ${reason}`);
    this.name = 'ExternalBlockedError';
  }
}
