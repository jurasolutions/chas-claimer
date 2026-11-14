/** Turns a zod schema into a `Result` with plain, dot-joined issue paths the UI and API can show. */
import type { z } from "zod";
import { err, ok, type Result } from "./result";

export interface ValidationIssue {
  /** Dot-joined path into the document, for example `branches.0.gstRegistered`; "" for the root. */
  path: string;
  message: string;
}

export function validate<S extends z.ZodType>(schema: S, input: unknown): Result<z.output<S>, ValidationIssue[]> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return err(parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })));
}
