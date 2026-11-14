/**
 * Words for values the server sends. Nothing here computes an amount: money is formatted with
 * the domain's `formatSgd`, and dates are calendar days already in Singapore time.
 */
import type { IsoDate } from "../domain/dates";

const longDate = new Intl.DateTimeFormat("en-SG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "2026-10-02" -> "2 Oct 2026". The date is a calendar day, so it is read as UTC midnight. */
export function formatDate(date: IsoDate): string {
  return longDate.format(new Date(`${date}T00:00:00Z`));
}

const dateTime = new Intl.DateTimeFormat("en-SG", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Singapore",
});

/**
 * "2026-11-12T02:05:00.000Z" -> "12 Nov 2026, 10:05 am": a recorded moment, read in Singapore time.
 * Some ICU builds put a narrow no-break space before "am"; the text keeps plain spaces.
 */
export function formatDateTime(at: string): string {
  return dateTime.format(new Date(at)).replace(/\s/g, " ");
}

/** A count with its noun: "1 claim", "3 claims". For nouns that take a plain "s". */
export function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * A field label as it reads inside a sentence: "Claim amount" -> "claim amount". A label that
 * opens with an acronym keeps its capitals ("NRIC/FIN", "CHAS procedure").
 */
export function inSentence(label: string): string {
  const first = label.split(/[\s/]/, 1)[0] ?? "";
  if (first.length > 1 && first === first.toUpperCase()) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}
