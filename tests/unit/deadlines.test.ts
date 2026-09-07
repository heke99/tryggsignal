import { describe, expect, it } from 'vitest';
import {
  calculateDeadline,
  InvalidDeadlineError,
  isNonWorkingDay,
  PBL_DEADLINES,
  swedishHolidays,
} from '@tryggsignal/deadlines';

describe('Swedish holidays (masterplan 41)', () => {
  it('computes the moving feasts for 2026', () => {
    const holidays = swedishHolidays(2026);
    // Easter Sunday 2026 is 5 April.
    expect(holidays.has('2026-04-05')).toBe(true);
    expect(holidays.has('2026-04-03')).toBe(true); // Långfredagen
    expect(holidays.has('2026-04-06')).toBe(true); // Annandag påsk
    expect(holidays.has('2026-05-14')).toBe(true); // Kristi himmelsfärd
    expect(holidays.has('2026-06-06')).toBe(true); // Nationaldagen
    expect(holidays.has('2026-06-20')).toBe(true); // Midsommardagen
  });

  it('treats weekends as non-working days', () => {
    expect(isNonWorkingDay(new Date('2026-09-05T00:00:00Z'))).toBe(true); // Saturday
    expect(isNonWorkingDay(new Date('2026-09-07T00:00:00Z'))).toBe(false); // Monday
  });
});

describe('deadline calculation (masterplan 41)', () => {
  it('applies the statutory duration and explains the result', () => {
    const result = calculateDeadline({
      deadlineKey: 'bygglov_beslut',
      name: PBL_DEADLINES.bygglov_beslut.name,
      deadlineType: 'STATUTORY',
      baseAt: new Date('2026-01-12T00:00:00Z'),
      durationDays: PBL_DEADLINES.bygglov_beslut.days,
      legalReference: PBL_DEADLINES.bygglov_beslut.reference,
    });
    expect(result.dueAt.toISOString().slice(0, 10)).toBe('2026-03-23');
    expect(result.explanation).toContain('PBL 9 kap. 27 §');
    expect(result.steps).toHaveLength(3);
  });

  it('adds pauses and extensions and shows both in the explanation', () => {
    const result = calculateDeadline({
      deadlineKey: 'bygglov_beslut',
      name: 'Beslut i lovärende',
      deadlineType: 'STATUTORY',
      baseAt: new Date('2026-01-12T00:00:00Z'),
      durationDays: 70,
      pausedDays: 14,
      extendedDays: 70,
    });
    expect(result.explanation).toContain('14 dagars uppehåll');
    expect(result.explanation).toContain('70 dagars förlängning');
    expect(result.dueAt.getTime()).toBeGreaterThan(new Date('2026-03-23T00:00:00Z').getTime());
  });

  it('rolls a statutory deadline off a weekend or holiday', () => {
    // 2026-01-01 + 4 days lands on Monday 5 Jan, but starting 2025-12-30 + 2 days
    // lands on 1 Jan (Nyårsdagen) and must roll forward.
    const result = calculateDeadline({
      deadlineKey: 'test',
      name: 'Test',
      deadlineType: 'STATUTORY',
      baseAt: new Date('2025-12-30T00:00:00Z'),
      durationDays: 2,
    });
    expect(result.holidayAdjustmentDays).toBeGreaterThan(0);
    expect(isNonWorkingDay(result.dueAt)).toBe(false);
    expect(result.explanation).toContain('närmaste vardag');
  });

  it('leaves an internal target date on the calendar day it falls on', () => {
    const result = calculateDeadline({
      deadlineKey: 'internal',
      name: 'Intern måldatum',
      deadlineType: 'INTERNAL',
      baseAt: new Date('2025-12-30T00:00:00Z'),
      durationDays: 2,
    });
    expect(result.holidayAdjustmentDays).toBe(0);
    expect(result.dueAt.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('rejects nonsense input instead of producing a date', () => {
    expect(() =>
      calculateDeadline({
        deadlineKey: 'x',
        name: 'x',
        deadlineType: 'STATUTORY',
        baseAt: new Date(),
        durationDays: 0,
      }),
    ).toThrow(InvalidDeadlineError);
  });
});
