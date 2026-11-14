/**
 * Calendar dates in Singapore time, as YYYY-MM-DD. Workers run in UTC, so "today" is always
 * derived from an instant with sgtDay(), never from new Date().toISOString() directly.
 */
export type IsoDate = string & { readonly __brand: "IsoDate" };

const DAY_MS = 86_400_000;
const SGT_OFFSET_MS = 8 * 3_600_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form, or null. */
export function parseIsoDate(text: string): IsoDate | null {
  const match = ISO_DATE.exec(text);
  if (!match) return null;
  const [y, m, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, day);
  return toIso(ms) === text ? (text as IsoDate) : null;
}

/** The Singapore calendar day of an instant (epoch milliseconds). */
export function sgtDay(now: number): IsoDate {
  return toIso(now + SGT_OFFSET_MS);
}

export function addDays(date: IsoDate, n: number): IsoDate {
  return toIso(toMs(date) + n * DAY_MS);
}

/** Whole days from a to b: positive when b is later. */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** Age in whole years on a date. A person is a year older on their birthday; 29 Feb birthdays on 1 Mar in other years. */
export function ageOn(birthDate: IsoDate, date: IsoDate): number {
  const [by, bm, bd] = parts(birthDate);
  const [y, m, d] = parts(date);
  const hadBirthday = m > bm || (m === bm && d >= bd);
  return y - by - (hadBirthday ? 0 : 1);
}

export function yearOf(date: IsoDate): number {
  return parts(date)[0];
}

function parts(date: IsoDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m!, d!];
}

function toMs(date: IsoDate): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

function toIso(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}
