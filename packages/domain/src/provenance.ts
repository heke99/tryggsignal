/**
 * Masterplan 21–24: every canonical record must be able to answer where a value
 * came from, from which source version, and how authoritative that source is.
 */

/** Masterplan 23: `integration.data_sources.authoritative_level`. */
export const AUTHORITATIVE_LEVELS = [
  'AUTHORITATIVE',
  'REFERENCE',
  'ADVISORY',
  'DERIVED',
  'AI_DERIVED',
] as const;

export type AuthoritativeLevel = (typeof AUTHORITATIVE_LEVELS)[number];

/**
 * Masterplan 24: conflict priority. Lower index wins. An AI derivation may never
 * silently replace an authoritative value — the conflict is surfaced instead.
 */
const PRECEDENCE: readonly AuthoritativeLevel[] = [
  'AUTHORITATIVE',
  'REFERENCE',
  'ADVISORY',
  'DERIVED',
  'AI_DERIVED',
];

export type SystemOfRecord = 'KOMMUN_OS' | 'EXTERNAL';

export interface Provenance {
  readonly sourceSystem: string;
  readonly sourceRecordId: string | null;
  readonly sourceVersion: string | null;
  readonly sourceUpdatedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly mappingVersion: string | null;
  readonly authoritativeLevel: AuthoritativeLevel;
  readonly locallyModified: boolean;
  readonly locallyModifiedBy: string | null;
}

export interface ValueCandidate<T> {
  readonly value: T;
  readonly provenance: Provenance;
}

export type ValueResolution<T> =
  | { readonly kind: 'RESOLVED'; readonly winner: ValueCandidate<T> }
  | {
      readonly kind: 'CONFLICT';
      readonly winner: ValueCandidate<T>;
      readonly conflicting: readonly ValueCandidate<T>[];
    }
  | { readonly kind: 'EMPTY' };

const rank = (level: AuthoritativeLevel): number => PRECEDENCE.indexOf(level);

/**
 * Masterplan 24 + 68: no general "last write wins". Candidates of equal rank with
 * differing values are reported as a conflict for a human to resolve.
 */
export function resolveValue<T>(
  candidates: readonly ValueCandidate<T>[],
  isEqual: (a: T, b: T) => boolean = (a, b) => Object.is(a, b),
): ValueResolution<T> {
  if (candidates.length === 0) return { kind: 'EMPTY' };

  const sorted = [...candidates].sort(
    (a, b) => rank(a.provenance.authoritativeLevel) - rank(b.provenance.authoritativeLevel),
  );
  const winner = sorted[0]!;
  const conflicting = sorted
    .slice(1)
    .filter(
      (candidate) =>
        rank(candidate.provenance.authoritativeLevel) ===
          rank(winner.provenance.authoritativeLevel) && !isEqual(candidate.value, winner.value),
    );

  return conflicting.length > 0
    ? { kind: 'CONFLICT', winner, conflicting }
    : { kind: 'RESOLVED', winner };
}
