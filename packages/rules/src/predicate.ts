/**
 * Masterplan 40: the rule engine is deterministic and separate from AI.
 * A rule's predicate is data, evaluated here — never generated code and never a
 * model call. Every evaluation returns the evidence it used.
 */

export type Scalar = string | number | boolean | null;

export type Predicate =
  | { readonly op: 'always' }
  | { readonly op: 'exists'; readonly field: string }
  | { readonly op: 'missing'; readonly field: string }
  | { readonly op: 'eq'; readonly field: string; readonly value: Scalar }
  | { readonly op: 'ne'; readonly field: string; readonly value: Scalar }
  | { readonly op: 'gt'; readonly field: string; readonly value: number }
  | { readonly op: 'gte'; readonly field: string; readonly value: number }
  | { readonly op: 'lt'; readonly field: string; readonly value: number }
  | { readonly op: 'lte'; readonly field: string; readonly value: number }
  | { readonly op: 'in'; readonly field: string; readonly values: readonly Scalar[] }
  | { readonly op: 'matches'; readonly field: string; readonly pattern: string }
  | { readonly op: 'all'; readonly of: readonly Predicate[] }
  | { readonly op: 'any'; readonly of: readonly Predicate[] }
  | { readonly op: 'not'; readonly of: Predicate };

export type Facts = Readonly<Record<string, unknown>>;

export interface EvidenceItem {
  readonly field: string;
  readonly observed: unknown;
  readonly expected?: unknown;
  readonly satisfied: boolean;
}

export interface PredicateResult {
  readonly satisfied: boolean;
  readonly evidence: readonly EvidenceItem[];
  /** Set when a fact the predicate depends on was not supplied at all. */
  readonly indeterminate: boolean;
}

const MISSING = Symbol('missing');

/** Dotted path lookup. A path that does not exist yields the MISSING sentinel. */
function read(facts: Facts, path: string): unknown | typeof MISSING {
  let current: unknown = facts;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return MISSING;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compare(
  predicate: Extract<Predicate, { op: 'gt' | 'gte' | 'lt' | 'lte' }>,
  observed: unknown,
): boolean | null {
  const left = numeric(observed);
  if (left === null) return null;
  switch (predicate.op) {
    case 'gt':
      return left > predicate.value;
    case 'gte':
      return left >= predicate.value;
    case 'lt':
      return left < predicate.value;
    case 'lte':
      return left <= predicate.value;
  }
}

/**
 * `indeterminate` is what separates "the rule failed" from "we do not know yet",
 * which is what makes HUMAN_REVIEW a real outcome rather than a silent FAIL.
 */
export function evaluatePredicate(predicate: Predicate, facts: Facts): PredicateResult {
  switch (predicate.op) {
    case 'always':
      return { satisfied: true, evidence: [], indeterminate: false };

    case 'all':
    case 'any': {
      const results = predicate.of.map((inner) => evaluatePredicate(inner, facts));
      const evidence = results.flatMap((result) => result.evidence);
      const satisfied =
        predicate.op === 'all'
          ? results.every((result) => result.satisfied)
          : results.some((result) => result.satisfied);
      // An `any` that already has a satisfied branch is decided, even if another
      // branch lacked facts.
      const indeterminate =
        predicate.op === 'all'
          ? results.some((result) => result.indeterminate) &&
            !results.some((r) => !r.satisfied && !r.indeterminate)
          : !satisfied && results.some((result) => result.indeterminate);
      return { satisfied, evidence, indeterminate };
    }

    case 'not': {
      const inner = evaluatePredicate(predicate.of, facts);
      return {
        satisfied: !inner.satisfied,
        evidence: inner.evidence,
        indeterminate: inner.indeterminate,
      };
    }

    default:
      break;
  }

  const observed = read(facts, predicate.field);
  const present = observed !== MISSING;
  const value = present ? observed : null;

  const evidenceFor = (satisfied: boolean, expected?: unknown): PredicateResult => ({
    satisfied,
    evidence: [
      {
        field: predicate.field,
        observed: value,
        ...(expected === undefined ? {} : { expected }),
        satisfied,
      },
    ],
    indeterminate: false,
  });

  switch (predicate.op) {
    case 'exists':
      return evidenceFor(present && value !== null && value !== '');
    case 'missing':
      return evidenceFor(!present || value === null || value === '');
    case 'eq':
      if (!present) return { ...evidenceFor(false, predicate.value), indeterminate: true };
      return evidenceFor(value === predicate.value, predicate.value);
    case 'ne':
      if (!present) return { ...evidenceFor(false, predicate.value), indeterminate: true };
      return evidenceFor(value !== predicate.value, predicate.value);
    case 'in':
      if (!present) return { ...evidenceFor(false, predicate.values), indeterminate: true };
      return evidenceFor(predicate.values.includes(value as Scalar), predicate.values);
    case 'matches': {
      if (!present || typeof value !== 'string') {
        return { ...evidenceFor(false, predicate.pattern), indeterminate: true };
      }
      // Patterns come from the rule set, which is authored by the municipality,
      // not from user input.
      return evidenceFor(new RegExp(predicate.pattern, 'u').test(value), predicate.pattern);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const outcome = compare(predicate, value);
      if (outcome === null) {
        return { ...evidenceFor(false, predicate.value), indeterminate: true };
      }
      return evidenceFor(outcome, predicate.value);
    }
  }
}
