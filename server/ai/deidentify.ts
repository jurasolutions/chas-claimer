/**
 * The de-identification gate (technical F8, ADR 0004). The only way to build what goes to the model:
 * every prompt is a `DeidentifiedText`, and only `deidentify()` makes one.
 *
 * 1. Redact the visit's own identity values, ignoring case, spaces, dots and hyphens, and its date
 *    of birth in any common written form.
 * 2. Redact anything shaped like an NRIC/FIN, a Singapore phone number, an email or a postal code.
 * 3. Fail closed if anything identifier-shaped is still there, including any date labelled as a birth date.
 *
 * It over-redacts on purpose: a patient called "Test Patient One" takes the words "patient" and "one"
 * with them. A clumsy prompt is better than a leaked name.
 */
import { err, ok, type Result } from "../../src/domain/result";
import type { VisitIdentity } from "../../src/domain/source-visit";

export type DeidentifiedText = string & { readonly __brand: "DeidentifiedText" };

export const REDACTED = "[redacted]";

/** Between any two characters of an identity value: spaces, dots and hyphens, as people type them. */
const GAP = "[\\s.\\-]*";
const escape = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A value matched however it is spaced, punctuated or cased, and never inside a longer word. */
function loose(value: string): RegExp | null {
  const chars = [...value.replace(/[\s.\-,]/g, "")];
  if (chars.length < 2) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${chars.map(escape).join(GAP)}(?![\\p{L}\\p{N}])`, "giu");
}

/** A phone number by its last eight digits, with or without the +65 in front. */
function loosePhone(phone: string): RegExp | null {
  const digits = phone.replace(/\D/g, "").slice(-8);
  if (digits.length < 7) return null;
  return new RegExp(`(?:\\+${GAP})?(?:6${GAP}5${GAP})?(?<!\\d)${[...digits].join(GAP)}(?!\\d)`, "g");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A literal matched however it is spaced out, as `loose` does: "1960" also as "1 9 6 0". */
const spaced = (s: string) => [...s].map(escape).join("\\s*");

/**
 * The visit's date of birth however a clinic writes it: day or month first with / - or . between,
 * with or without leading zeros, a two-digit year, or the month in words ("4 Mar 1960", "March 4th, 1960").
 * Reading the day and month the other way round over-redacts harmlessly. The ISO form is `loose`'s job.
 */
function dobPatterns(iso: string): RegExp[] {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return [];
  const num = (n: number) => (n < 10 ? `(?:0\\s*)?${n}` : spaced(String(n)));
  const year = `(?:${spaced(String(y))}|${spaced(String(y).slice(-2))})`;
  const long = MONTHS[m - 1]!;
  const names = [long, ...(m === 9 ? ["Sept"] : []), long.slice(0, 3)].map(spaced).join("|");
  const month = `(?<!\\p{L})(?:${names})(?!\\p{L})\\.?`;
  const day = `${num(d)}(?:\\s*(?:s\\s*t|n\\s*d|r\\s*d|t\\s*h))?`;
  const SEP = "\\s*[/.\\-]\\s*";
  const WORD_SEP = "[\\s/.\\-,]*";
  const whole = (body: string) => new RegExp(`(?<!\\p{N})${body}(?!\\p{N})`, "giu");
  return [
    whole(`${num(d)}${SEP}${num(m)}${SEP}${year}`),
    whole(`${num(m)}${SEP}${num(d)}${SEP}${year}`),
    whole(`${spaced(String(y))}${SEP}${num(m)}${SEP}${num(d)}`),
    whole(`${day}${WORD_SEP}${month}${WORD_SEP}${year}`),
    whole(`${month}${WORD_SEP}${day}${WORD_SEP}${year}`),
  ];
}

/** Every value the visit's sealed identity holds that could turn up in free text, longest first. */
function identityPatterns(identity: VisitIdentity): RegExp[] {
  const values = [
    identity.nric,
    identity.name,
    ...identity.name.split(/\s+/),
    identity.dateOfBirth,
    ...(identity.address ? [identity.address, ...identity.address.split(",")] : []),
    ...identity.memberIds.map((m) => m.memberId),
    ...(identity.accountHolderNric ? [identity.accountHolderNric] : []),
    ...identity.preAuthRefs.map((p) => p.reference),
  ]
    .map((v) => v.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const patterns = values.map(loose);
  return [loosePhone(identity.phone), ...dobPatterns(identity.dateOfBirth), ...patterns].filter((p): p is RegExp => p !== null);
}

/** Emails go first, whole: a name token redacted inside one would leave half an address behind. */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi;

/** Identifier shapes, whoever they belong to. */
const PATTERNS: readonly RegExp[] = [
  /(?<![A-Z0-9])[STFGM][\s-]?\d{7}[\s-]?[A-Z](?![A-Z0-9])/gi,
  /(?<![A-Z0-9])\d{7}[A-Z](?![A-Z0-9])/gi,
  /\+\s*65[\s-]*(?:\d[\s-]*){7}\d/g,
  /(?<!\d)[689]\d{3}[\s-]?\d{4}(?!\d)/g,
  /(?<!\d)\d{6}(?!\d)/g,
];

/**
 * Any date labelled as a date of birth, whoever's it is: "born 5/6/1971", "DOB: 5 June 1971". The label
 * must sit right before the date, so "born [redacted], seen 2026-11-14" still passes.
 */
const MONTH_WORD = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DATE_SHAPE = [
  "\\d{1,4}\\s*[/.\\-]\\s*\\d{1,2}\\s*[/.\\-]\\s*\\d{2,4}",
  `\\d{1,2}(?:st|nd|rd|th)?[\\s/.\\-,]*${MONTH_WORD}[\\s/.\\-,]*\\d{2,4}`,
  `${MONTH_WORD}[\\s/.\\-]*\\d{1,2}(?:st|nd|rd|th)?,?[\\s/.\\-]*\\d{2,4}`,
].join("|");
const LABELLED_DOB = new RegExp(
  `(?<!\\p{L})(?:born|d\\s*\\.?\\s*o\\s*\\.?\\s*b|date\\s+of\\s+birth|birth\\s*date|birthday)(?!\\p{L})\\.?(?:[\\s:=,\\-–]|(?:on|is|was)(?!\\p{L}))*(?:${DATE_SHAPE})`,
  "iu",
);

/** What must not be left once redaction is done. Broader than `PATTERNS`, so a miss fails closed. */
const LEFTOVERS: readonly RegExp[] = [/\S@\S/, /[STFGM]\s?\d{7}/i, /\d(?: ?\d){6,}/, LABELLED_DOB];

/**
 * Text that is safe to send to the model, or `identifiers_remain` when redaction could not make it so.
 * Pass the visit's identity whenever the text is about one visit.
 */
export function deidentify(text: string, identity: VisitIdentity | null = null): Result<DeidentifiedText, "identifiers_remain"> {
  const own = identity ? identityPatterns(identity) : [];
  let out = text;
  for (const pattern of [EMAIL, ...own, ...PATTERNS]) out = out.replace(pattern, REDACTED);
  const remains = [EMAIL, ...own, ...PATTERNS, ...LEFTOVERS].some((p) => {
    p.lastIndex = 0;
    return p.test(out);
  });
  return remains ? err("identifiers_remain") : ok(out as DeidentifiedText);
}
