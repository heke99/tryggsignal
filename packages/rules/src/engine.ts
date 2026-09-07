/** Masterplan 40/107: versioned, effective-dated, explainable rule evaluation. */
import { evaluatePredicate, type EvidenceItem, type Facts, type Predicate } from './predicate';

export type RuleSeverity = 'REQUIRED' | 'CONDITIONAL' | 'ADVISORY';
export type RuleResult = 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'HUMAN_REVIEW';

export interface Rule {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly severity: RuleSeverity;
  /** Optional gate: when present and unsatisfied, the rule is NOT_APPLICABLE. */
  readonly appliesWhen?: Predicate;
  readonly predicate: Predicate;
  readonly legalReference?: string;
}

export interface RuleSetVersion {
  readonly id: string;
  readonly ruleSetKey: string;
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly rules: readonly Rule[];
}

export interface RuleEvaluation {
  readonly ruleId: string;
  readonly ruleKey: string;
  readonly ruleSetVersionId: string;
  readonly result: RuleResult;
  readonly severity: RuleSeverity;
  readonly evidence: readonly EvidenceItem[];
  readonly explanation: string;
  readonly legalReference: string | null;
}

export class NoEffectiveRuleSetError extends Error {
  constructor(ruleSetKey: string, at: string) {
    super(`No rule set version of "${ruleSetKey}" is effective at ${at}`);
    this.name = 'NoEffectiveRuleSetError';
  }
}

/**
 * Masterplan 39/107: an existing case is judged by the rule version that was in
 * force, so the effective date — not "today" — selects the version.
 */
export function selectEffectiveVersion(
  versions: readonly RuleSetVersion[],
  effectiveAt: Date,
): RuleSetVersion {
  const stamp = effectiveAt.toISOString().slice(0, 10);
  const candidates = versions
    .filter((v) => v.validFrom <= stamp && (v.validTo === null || v.validTo > stamp))
    .sort((a, b) => b.version - a.version);

  const winner = candidates[0];
  if (winner === undefined) {
    throw new NoEffectiveRuleSetError(versions[0]?.ruleSetKey ?? 'unknown', stamp);
  }
  return winner;
}

export function evaluateRuleSet(version: RuleSetVersion, facts: Facts): readonly RuleEvaluation[] {
  return version.rules.map((rule) => {
    if (rule.appliesWhen !== undefined) {
      const gate = evaluatePredicate(rule.appliesWhen, facts);
      if (!gate.satisfied && !gate.indeterminate) {
        return {
          ruleId: rule.id,
          ruleKey: rule.key,
          ruleSetVersionId: version.id,
          result: 'NOT_APPLICABLE',
          severity: rule.severity,
          evidence: gate.evidence,
          explanation: `${rule.name} does not apply to this case.`,
          legalReference: rule.legalReference ?? null,
        };
      }
    }

    const outcome = evaluatePredicate(rule.predicate, facts);
    const result: RuleResult = outcome.indeterminate
      ? 'HUMAN_REVIEW'
      : outcome.satisfied
        ? 'PASS'
        : 'FAIL';

    const explanation = outcome.indeterminate
      ? `${rule.name} could not be decided: required information is missing.`
      : outcome.satisfied
        ? `${rule.name} is satisfied.`
        : `${rule.name} is not satisfied.`;

    return {
      ruleId: rule.id,
      ruleKey: rule.key,
      ruleSetVersionId: version.id,
      result,
      severity: rule.severity,
      evidence: outcome.evidence,
      explanation,
      legalReference: rule.legalReference ?? null,
    };
  });
}
