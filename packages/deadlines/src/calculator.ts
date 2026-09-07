/**
 * Masterplan 41: a caseworker must be able to see exactly why due_at is what it
 * is. Every calculation returns the inputs, the steps and a sentence in Swedish.
 */
import { addDays, isNonWorkingDay, isoDate, swedishHolidays } from './holidays';

export type DeadlineType = 'STATUTORY' | 'INTERNAL' | 'AGREED';

export interface DeadlineInput {
  readonly deadlineKey: string;
  readonly name: string;
  readonly deadlineType: DeadlineType;
  /** When the clock starts, e.g. the date the application became complete. */
  readonly baseAt: Date;
  readonly durationDays: number;
  /** Days the clock was stopped, e.g. while waiting for a completion request. */
  readonly pausedDays?: number;
  /** A granted extension, e.g. PBL 9 kap. 27 § second paragraph. */
  readonly extendedDays?: number;
  readonly legalReference?: string;
  /** Statutory deadlines that must not fall on a weekend or public holiday. */
  readonly rollToWorkingDay?: boolean;
}

export interface DeadlineCalculation {
  readonly deadlineKey: string;
  readonly dueAt: Date;
  readonly baseAt: Date;
  readonly durationDays: number;
  readonly pausedDays: number;
  readonly extendedDays: number;
  readonly holidayAdjustmentDays: number;
  readonly legalReference: string | null;
  readonly explanation: string;
  readonly steps: readonly string[];
}

export class InvalidDeadlineError extends Error {}

export function calculateDeadline(input: DeadlineInput): DeadlineCalculation {
  if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
    throw new InvalidDeadlineError(
      `durationDays must be a positive whole number, got ${input.durationDays}`,
    );
  }
  const pausedDays = input.pausedDays ?? 0;
  const extendedDays = input.extendedDays ?? 0;
  if (pausedDays < 0 || extendedDays < 0) {
    throw new InvalidDeadlineError('pausedDays and extendedDays may not be negative');
  }

  const steps: string[] = [];
  const totalDays = input.durationDays + pausedDays + extendedDays;

  steps.push(`Utgångspunkt: ${isoDate(input.baseAt)}.`);
  steps.push(`Frist: ${input.durationDays} dagar.`);
  if (pausedDays > 0) steps.push(`Uppehåll: ${pausedDays} dagar läggs till.`);
  if (extendedDays > 0) steps.push(`Förlängning: ${extendedDays} dagar läggs till.`);

  let dueAt = addDays(input.baseAt, totalDays);
  let holidayAdjustmentDays = 0;

  if (input.rollToWorkingDay ?? input.deadlineType === 'STATUTORY') {
    const holidaysByYear = new Map<number, ReadonlySet<string>>();
    while (
      isNonWorkingDay(
        dueAt,
        holidaysByYear.get(dueAt.getUTCFullYear()) ??
          (() => {
            const set = swedishHolidays(dueAt.getUTCFullYear());
            holidaysByYear.set(dueAt.getUTCFullYear(), set);
            return set;
          })(),
      )
    ) {
      dueAt = addDays(dueAt, 1);
      holidayAdjustmentDays += 1;
    }
    if (holidayAdjustmentDays > 0) {
      steps.push(
        `Slutdatum flyttas ${holidayAdjustmentDays} dag(ar) framåt eftersom det annars ` +
          'infaller på helg eller helgdag.',
      );
    }
  }

  steps.push(`Slutdatum: ${isoDate(dueAt)}.`);

  const reference = input.legalReference ?? null;
  const explanation =
    `${input.name} förfaller ${isoDate(dueAt)}: ${isoDate(input.baseAt)} + ${input.durationDays} dagar` +
    (pausedDays > 0 ? ` + ${pausedDays} dagars uppehåll` : '') +
    (extendedDays > 0 ? ` + ${extendedDays} dagars förlängning` : '') +
    (holidayAdjustmentDays > 0 ? ` + ${holidayAdjustmentDays} dag(ar) till närmaste vardag` : '') +
    (reference === null ? '.' : ` (${reference}).`);

  return {
    deadlineKey: input.deadlineKey,
    dueAt,
    baseAt: input.baseAt,
    durationDays: input.durationDays,
    pausedDays,
    extendedDays,
    holidayAdjustmentDays,
    legalReference: reference,
    explanation,
    steps,
  };
}

/**
 * The statutory PBL handling deadlines used by the building-permit module.
 * `durationDays` is configuration, not folklore: each entry names the provision
 * it comes from, and a municipality can only change it through the rule set.
 */
export const PBL_DEADLINES: Readonly<Record<string, { days: number; reference: string; name: string }>> =
  {
    bygglov_beslut: {
      days: 70,
      reference: 'PBL 9 kap. 27 § första stycket',
      name: 'Beslut i lovärende',
    },
    bygglov_beslut_forlangt: {
      days: 140,
      reference: 'PBL 9 kap. 27 § första stycket (förlängd handläggningstid)',
      name: 'Beslut i lovärende efter förlängning',
    },
    anmalan_startbesked: {
      days: 28,
      reference: 'PBF 6 kap. 7 §',
      name: 'Startbesked efter anmälan',
    },
  };
