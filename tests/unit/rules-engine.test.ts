import { describe, expect, it } from 'vitest';
import {
  assessCompleteness,
  evaluatePredicate,
  evaluateRuleSet,
  NoEffectiveRuleSetError,
  selectEffectiveVersion,
  type RuleSetVersion,
} from '@tryggsignal/rules';

describe('predicate evaluation (masterplan 40)', () => {
  const facts = {
    documents: { situationsplan: true, fasadritning: false },
    area: { gross_floor_area: 180 },
    property: { designation: 'BJÖRNEN 1:2' },
  };

  it('evaluates comparisons and returns evidence', () => {
    const result = evaluatePredicate({ op: 'gt', field: 'area.gross_floor_area', value: 150 }, facts);
    expect(result.satisfied).toBe(true);
    expect(result.evidence).toEqual([
      { field: 'area.gross_floor_area', observed: 180, expected: 150, satisfied: true },
    ]);
  });

  it('marks a missing fact as indeterminate rather than failing it', () => {
    const result = evaluatePredicate({ op: 'eq', field: 'area.plot_area', value: 800 }, facts);
    expect(result.satisfied).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it('treats exists/missing as decided even when the fact is absent', () => {
    expect(evaluatePredicate({ op: 'missing', field: 'nothing.here' }, facts)).toMatchObject({
      satisfied: true,
      indeterminate: false,
    });
    expect(evaluatePredicate({ op: 'exists', field: 'documents.fasadritning' }, facts)).toMatchObject({
      satisfied: true,
    });
  });

  it('short-circuits an any-branch that is already satisfied', () => {
    const result = evaluatePredicate(
      {
        op: 'any',
        of: [
          { op: 'eq', field: 'documents.situationsplan', value: true },
          { op: 'eq', field: 'area.unknown_field', value: 1 },
        ],
      },
      facts,
    );
    expect(result).toMatchObject({ satisfied: true, indeterminate: false });
  });

  it('reports an all-branch as failed when one branch is decidedly false', () => {
    const result = evaluatePredicate(
      {
        op: 'all',
        of: [
          { op: 'eq', field: 'documents.fasadritning', value: true },
          { op: 'eq', field: 'area.unknown_field', value: 1 },
        ],
      },
      facts,
    );
    expect(result).toMatchObject({ satisfied: false, indeterminate: false });
  });
});

const ruleSet = (version: number, validFrom: string, validTo: string | null): RuleSetVersion => ({
  id: `rsv-${version}`,
  ruleSetKey: 'pbl_bygglov',
  version,
  validFrom,
  validTo,
  rules: [
    {
      id: 'r1',
      key: 'situationsplan_finns',
      name: 'Situationsplan',
      severity: 'REQUIRED',
      predicate: { op: 'eq', field: 'documents.situationsplan', value: true },
      legalReference: 'PBL 9 kap. 21 §',
    },
    {
      id: 'r2',
      key: 'fasadritning_finns',
      name: 'Fasadritning',
      severity: 'REQUIRED',
      predicate: { op: 'eq', field: 'documents.fasadritning', value: true },
    },
    {
      id: 'r3',
      key: 'kulturmiljo_yttrande',
      name: 'Yttrande kulturmiljö',
      severity: 'CONDITIONAL',
      appliesWhen: { op: 'eq', field: 'property.cultural_heritage', value: true },
      predicate: { op: 'exists', field: 'documents.kulturmiljo_yttrande' },
    },
    {
      id: 'r5',
      key: 'byggnadshojd_inom_plan',
      name: 'Byggnadshöjd inom detaljplan',
      severity: 'REQUIRED',
      predicate: { op: 'lte', field: 'building.height_m', value: 4.5 },
    },
    {
      id: 'r4',
      key: 'energiklass_angiven',
      name: 'Energiklass',
      severity: 'ADVISORY',
      predicate: { op: 'exists', field: 'building.energy_class' },
    },
  ],
});

describe('rule set versioning (masterplan 39/107)', () => {
  const versions = [ruleSet(1, '2020-01-01', '2025-07-01'), ruleSet(2, '2025-07-01', null)];

  it('selects the version in force at the effective date, not today', () => {
    expect(selectEffectiveVersion(versions, new Date('2024-03-01')).version).toBe(1);
    expect(selectEffectiveVersion(versions, new Date('2026-03-01')).version).toBe(2);
  });

  it('refuses to guess when no version was in force', () => {
    expect(() => selectEffectiveVersion(versions, new Date('2019-01-01'))).toThrow(
      NoEffectiveRuleSetError,
    );
  });
});

describe('completeness engine (masterplan 120)', () => {
  const version = ruleSet(2, '2025-07-01', null);

  it('reports INCOMPLETE and names the missing requirement', () => {
    const evaluations = evaluateRuleSet(version, {
      documents: { situationsplan: true, fasadritning: false },
      property: { cultural_heritage: false },
      building: { height_m: 4.2, energy_class: 'C' },
    });
    const assessment = assessCompleteness(evaluations);
    expect(assessment.status).toBe('INCOMPLETE');
    expect(assessment.missing.map((m) => m.ruleKey)).toEqual(['fasadritning_finns']);
    expect(assessment.explanation).toContain('fasadritning_finns');
  });

  it('reports HUMAN_REVIEW when a required fact is absent rather than false', () => {
    const evaluations = evaluateRuleSet(version, {
      documents: { situationsplan: true, fasadritning: true },
      property: { cultural_heritage: false },
      building: { energy_class: 'C' },
    });
    const assessment = assessCompleteness(evaluations);
    expect(assessment.status).toBe('HUMAN_REVIEW');
    expect(assessment.undecided.map((u) => u.ruleKey)).toEqual(['byggnadshojd_inom_plan']);
  });

  it('counts an applicable CONDITIONAL rule as required', () => {
    const evaluations = evaluateRuleSet(version, {
      documents: { situationsplan: true, fasadritning: true },
      property: { cultural_heritage: true },
      building: { height_m: 4.2, energy_class: 'C' },
    });
    const assessment = assessCompleteness(evaluations);
    expect(assessment.status).toBe('INCOMPLETE');
    expect(assessment.missing.map((m) => m.ruleKey)).toEqual(['kulturmiljo_yttrande']);
  });

  it('reports COMPLETE and keeps advisory remarks separate', () => {
    const evaluations = evaluateRuleSet(version, {
      documents: { situationsplan: true, fasadritning: true },
      property: { cultural_heritage: false },
      building: { height_m: 4.2 },
    });
    const assessment = assessCompleteness(evaluations);
    expect(assessment.status).toBe('COMPLETE');
    expect(assessment.advisory.map((a) => a.ruleKey)).toEqual(['energiklass_angiven']);
  });

  it('skips rules that do not apply and says so', () => {
    const evaluations = evaluateRuleSet(version, {
      documents: { situationsplan: true, fasadritning: true },
      property: { cultural_heritage: false },
      building: { height_m: 4.2, energy_class: 'A' },
    });
    const conditional = evaluations.find((e) => e.ruleKey === 'kulturmiljo_yttrande');
    expect(conditional?.result).toBe('NOT_APPLICABLE');
    expect(conditional?.explanation).toContain('does not apply');
  });

  it('carries the legal reference into the evaluation', () => {
    const evaluations = evaluateRuleSet(version, { documents: { situationsplan: false } });
    expect(evaluations[0]?.legalReference).toBe('PBL 9 kap. 21 §');
  });
});
