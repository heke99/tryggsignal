/**
 * Masterplan 120 (P22): the completeness engine turns rule evaluations into one
 * of three answers, always with evidence. It never answers COMPLETE while a
 * required rule is undecided.
 */
import type { RuleEvaluation } from './engine';

export type CompletenessStatus = 'COMPLETE' | 'INCOMPLETE' | 'HUMAN_REVIEW';

export interface CompletenessAssessment {
  readonly status: CompletenessStatus;
  readonly missing: readonly RuleEvaluation[];
  readonly undecided: readonly RuleEvaluation[];
  readonly advisory: readonly RuleEvaluation[];
  readonly explanation: string;
}

export function assessCompleteness(evaluations: readonly RuleEvaluation[]): CompletenessAssessment {
  const relevant = evaluations.filter((e) => e.result !== 'NOT_APPLICABLE');
  // A CONDITIONAL rule is required once its `appliesWhen` gate holds — an
  // applicable conditional that fails makes the case incomplete, not complete.
  const missing = relevant.filter((e) => e.result === 'FAIL' && e.severity !== 'ADVISORY');
  const undecided = relevant.filter(
    (e) => e.result === 'HUMAN_REVIEW' && e.severity !== 'ADVISORY',
  );
  const advisory = relevant.filter((e) => e.result === 'FAIL' && e.severity === 'ADVISORY');

  if (missing.length > 0) {
    return {
      status: 'INCOMPLETE',
      missing,
      undecided,
      advisory,
      explanation: `${missing.length} required condition(s) are not met: ${missing
        .map((e) => e.ruleKey)
        .join(', ')}.`,
    };
  }

  if (undecided.length > 0) {
    return {
      status: 'HUMAN_REVIEW',
      missing,
      undecided,
      advisory,
      explanation: `${undecided.length} condition(s) could not be decided automatically: ${undecided
        .map((e) => e.ruleKey)
        .join(', ')}.`,
    };
  }

  return {
    status: 'COMPLETE',
    missing,
    undecided,
    advisory,
    explanation:
      advisory.length === 0
        ? 'All required conditions are met.'
        : `All required conditions are met; ${advisory.length} advisory remark(s) remain.`,
  };
}
