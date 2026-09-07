/** Masterplan 67: exponential backoff with a bounded attempt count and dead-letter state. */

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 2_000,
  maxDelayMs: 15 * 60_000,
};

export type RetryDecision =
  | { readonly kind: 'RETRY'; readonly delayMs: number; readonly nextAttempt: number }
  | { readonly kind: 'DEAD_LETTER'; readonly reason: string };

/**
 * `jitter` is injected rather than read from Math.random so the schedule is
 * deterministic under test.
 */
export function nextRetry(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  jitter = 0.5,
): RetryDecision {
  if (attempt >= policy.maxAttempts) {
    return { kind: 'DEAD_LETTER', reason: `Exhausted ${policy.maxAttempts} attempts` };
  }
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  // Full jitter in [0.5, 1.5) of the capped delay, keeping the cap as the ceiling.
  const delayMs = Math.min(Math.round(capped * (0.5 + jitter)), policy.maxDelayMs);
  return { kind: 'RETRY', delayMs, nextAttempt: attempt + 1 };
}
