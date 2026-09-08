/**
 * Masterplan 84: rate limiting per IP, user, tenant and endpoint, with the
 * strictest limits on authentication, upload, public submission, search, AI and
 * export.
 *
 * A fixed-window counter in the running instance. It is deliberately small and
 * replaceable: the store is a port, so a shared store can be dropped in without
 * touching the call sites.
 */

export type RateLimitedAction =
  | 'auth'
  | 'upload'
  | 'public_submission'
  | 'search'
  | 'ai'
  | 'export'
  | 'default';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMITS: Readonly<Record<RateLimitedAction, RateLimitRule>> = {
  auth: { limit: 10, windowMs: 5 * 60_000 },
  upload: { limit: 60, windowMs: 60_000 },
  public_submission: { limit: 20, windowMs: 60_000 },
  search: { limit: 120, windowMs: 60_000 },
  ai: { limit: 30, windowMs: 60_000 },
  export: { limit: 5, windowMs: 60_000 },
  default: { limit: 300, windowMs: 60_000 },
};

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number, now: number): { count: number; resetAt: number };
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  increment(key: string, windowMs: number, now: number): { count: number; resetAt: number } {
    const existing = this.windows.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, fresh);
      // Opportunistic cleanup so a long-lived instance does not grow unbounded.
      if (this.windows.size > 10_000) {
        for (const [k, v] of this.windows) if (v.resetAt <= now) this.windows.delete(k);
      }
      return fresh;
    }
    existing.count += 1;
    return existing;
  }
}

/**
 * The key always includes the tenant, so one municipality's traffic can never
 * exhaust another's budget (masterplan 84 + 142).
 */
export function rateLimitKey(parts: {
  readonly action: RateLimitedAction;
  readonly tenantId: string | null;
  readonly subject: string;
}): string {
  return `${parts.action}:${parts.tenantId ?? 'platform'}:${parts.subject}`;
}

export function checkRateLimit(
  store: RateLimitStore,
  parts: { action: RateLimitedAction; tenantId: string | null; subject: string },
  now: number = Date.now(),
): RateLimitDecision {
  const rule = RATE_LIMITS[parts.action];
  const { count, resetAt } = store.increment(rateLimitKey(parts), rule.windowMs, now);
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
  };
}
