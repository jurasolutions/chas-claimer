import { err, ok, type Result } from "./result";

/** Singapore dollars as integer cents. Never a float past the parse edge. */
export type Cents = number & { readonly __brand: "Cents" };

/** Brands a number as cents. Throws unless it is a safe, non-negative integer. */
export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`Not a whole, non-negative number of cents: ${n}`);
  }
  return n as Cents;
}

const DOLLARS = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** "462.50" -> 46250. Accepts thousands separators; refuses signs, symbols and a third decimal. */
export function parseDollars(text: string): Result<Cents, "invalid"> {
  const match = DOLLARS.exec(text.trim());
  if (!match) return err("invalid");
  const whole = Number(match[1]!.replaceAll(",", ""));
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const total = whole * 100 + fraction;
  if (!Number.isSafeInteger(total)) return err("invalid");
  return ok(total as Cents);
}

export function add(...xs: Cents[]): Cents {
  return cents(xs.reduce((sum, x) => sum + x, 0));
}

/** a - b. Throws when b > a: callers cap first, so a negative amount is a bug, not a value. */
export function subtract(a: Cents, b: Cents): Cents {
  if (b > a) throw new RangeError(`Cannot subtract ${b} cents from ${a} cents`);
  return cents(a - b);
}

export function min(...xs: Cents[]): Cents {
  if (xs.length === 0) throw new RangeError("min needs at least one amount");
  return cents(Math.min(...xs));
}

/**
 * 46250 -> "$462.50", -50 -> "-$0.50". Cents only, so a dollar value or a raw number cannot reach
 * the page; a fraction of a cent throws (from formatDecimal).
 */
export function formatSgd(amount: Cents): string {
  const decimal = formatDecimal(amount);
  const sign = decimal.startsWith("-") ? "-" : "";
  const [dollars, centsPart] = decimal.slice(sign.length).split(".");
  return `${sign}$${dollars!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${centsPart}`;
}

/**
 * 5050 -> "50.50": dollars with two decimals and no currency sign or separators, for a CSV cell or a
 * portal field. Signed, since an export can carry a difference. Integer maths only.
 */
export function formatDecimal(amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError(`Not a whole number of cents: ${amount}`);
  const sign = amount < 0 ? "-" : "";
  const c = Math.abs(amount);
  return `${sign}${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}
