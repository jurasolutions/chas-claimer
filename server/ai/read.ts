/**
 * Checks on the model's parsed answer. The answer is untrusted input: a task takes a field only when
 * it has the exact type and size the task expects, and refuses the whole answer otherwise.
 */

/** Longest text the desk takes from any answer field. */
export const MAX_ANSWER_TEXT = 4000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-blank string of at most `max` characters, trimmed; null otherwise. */
export function answerText(value: unknown, max = MAX_ANSWER_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}
