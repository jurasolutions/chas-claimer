/**
 * `POST /api/imports`, `POST /api/imports/synthetic` and `GET /api/imports` (technical §6). An
 * import never echoes an identifier: refused visits are named by their position and the paths that
 * failed, never by a value.
 */
import type { ImportSource } from "../domain/types";
import type { ValidationIssue } from "../domain/validation";

/** A connector import carries at most this many source visits; more is 413 `too_large`. */
export const MAX_VISITS_PER_IMPORT = 100;

/** The connector's body. Each visit is parsed on the server; the shape here is only the envelope. */
export interface ImportRequest {
  visits: unknown[];
}

/** What one import did. `received` = `new` + `changed` + `unchanged` + `ignored.length` + `refused`. */
export interface ImportSummary {
  importId: string;
  received: number;
  /** Visits the desk had not seen before. */
  new: number;
  /** Visits whose content differs from the current revision: a new revision, claims rebuilt. */
  changed: number;
  /** Visits identical to their current revision: nothing written. */
  unchanged: number;
  /** Claims already sent to a payer whose visit changed: kept as sent, marked changed after submission. */
  flagged: number;
  /** Visits that failed validation. */
  refused: number;
  /** Visits that repeat an earlier revision: an older payload arriving late. */
  ignored: { visitKey: string; reason: "older_than_current" }[];
  /** Which visits failed validation, by position in the request, with the paths that failed. */
  refusedVisits: { index: number; issues: ValidationIssue[] }[];
}

/** `POST /api/imports/synthetic`'s body: where in the clinic this page starts (default 0). */
export interface SyntheticImportRequest {
  offset?: number;
}

/**
 * One page of the synthetic clinic, at most `MAX_VISITS_PER_IMPORT` visits, imported as its own
 * import. `next` is the offset to post for the following page, or null when this was the last.
 */
export interface SyntheticImportPage extends ImportSummary {
  next: number | null;
}

/** One row of `GET /api/imports`, newest first. */
export interface ImportListItem {
  id: string;
  source: ImportSource;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
  received: number;
  new: number;
  changed: number;
  unchanged: number;
  /** Visits that repeated an earlier revision: an older payload arriving late. */
  ignored: number;
  flagged: number;
  refused: number;
}

export interface ImportListResponse {
  items: ImportListItem[];
}
