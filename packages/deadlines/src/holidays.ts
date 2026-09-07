/**
 * Swedish public holidays, computed rather than listed, so the calculation stays
 * correct for any year a case can reach (masterplan 41).
 */

/** Gauss/Meeus algorithm for Gregorian Easter Sunday (UTC date). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 86_400_000);

const iso = (date: Date): string => date.toISOString().slice(0, 10);

/** Midsummer Day is the Saturday between 20 and 26 June. */
function midsummerDay(year: number): Date {
  for (let day = 20; day <= 26; day += 1) {
    const candidate = new Date(Date.UTC(year, 5, day));
    if (candidate.getUTCDay() === 6) return candidate;
  }
  /* c8 ignore next */
  throw new Error(`No Saturday found between 20 and 26 June ${year}`);
}

/** All Saints' Day is the Saturday between 31 October and 6 November. */
function allSaintsDay(year: number): Date {
  for (let offset = 0; offset <= 6; offset += 1) {
    const candidate = new Date(Date.UTC(year, 9, 31 + offset));
    if (candidate.getUTCDay() === 6) return candidate;
  }
  /* c8 ignore next */
  throw new Error(`No Saturday found for All Saints' Day ${year}`);
}

export function swedishHolidays(year: number): ReadonlySet<string> {
  const easter = easterSunday(year);
  return new Set([
    iso(new Date(Date.UTC(year, 0, 1))), // Nyårsdagen
    iso(new Date(Date.UTC(year, 0, 6))), // Trettondedag jul
    iso(addDays(easter, -2)), // Långfredagen
    iso(easter), // Påskdagen
    iso(addDays(easter, 1)), // Annandag påsk
    iso(new Date(Date.UTC(year, 4, 1))), // Första maj
    iso(addDays(easter, 39)), // Kristi himmelsfärdsdag
    iso(addDays(easter, 49)), // Pingstdagen
    iso(new Date(Date.UTC(year, 5, 6))), // Nationaldagen
    iso(midsummerDay(year)), // Midsommardagen
    iso(allSaintsDay(year)), // Alla helgons dag
    iso(new Date(Date.UTC(year, 11, 24))), // Julafton (treated as non-working)
    iso(new Date(Date.UTC(year, 11, 25))), // Juldagen
    iso(new Date(Date.UTC(year, 11, 26))), // Annandag jul
    iso(new Date(Date.UTC(year, 11, 31))), // Nyårsafton (treated as non-working)
  ]);
}

export function isNonWorkingDay(
  date: Date,
  holidays = swedishHolidays(date.getUTCFullYear()),
): boolean {
  const weekday = date.getUTCDay();
  return weekday === 0 || weekday === 6 || holidays.has(iso(date));
}

export { iso as isoDate, addDays };
