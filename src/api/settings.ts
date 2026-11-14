/**
 * `GET`/`PUT /api/settings`, `POST /api/settings/rebuild`, `GET`/`POST /api/settings/reseal` and the
 * code map routes (technical §6). Officers read; reviewers write. The reseal routes are reviewers only. A settings save carries the version it was made against and answers
 * 409 `stale` with the current version when someone saved in between. Code-map entries are not
 * versioned: each PUT or DELETE names one entry by its key and the last write wins, with the trail
 * keeping the code it replaced.
 */
import type { RuleSetSummary } from "../domain/rules";
import type { DeskSettings } from "../domain/settings";
import type { Channel, CodeMapEntry, CodeMapOrigin, CodeMapTarget, PayerId } from "../domain/types";

/** A save rebuilds at most this many visits per request; the rest continue on the next request. */
export const REBUILD_BATCH = 100;

/** Which visits a change can move: every one, those of some dentists or branches, or one clinic code. */
export type RebuildScope =
  | { kind: "all" }
  | { kind: "dentists"; ids: string[] }
  | { kind: "branches"; ids: string[] }
  | { kind: "clinic_code"; clinicCode: string };

/** Where a rebuild got to. Post it to `POST /api/settings/rebuild` to do the next batch. */
export interface RebuildCursor {
  scope: RebuildScope;
  /**
   * Where the last batch stopped, opaque to the caller: the last visit's place in clinic order (date,
   * start time, visit key). The next batch starts after it, so a patient's visits rebuild oldest first.
   */
  after: string;
}

/** What one batch of a rebuild did. Only visits with claims still on the desk are considered. */
export interface RebuildProgress {
  /** Visits in scope looked at in this batch. */
  considered: number;
  /** Visits whose claims changed. */
  rebuilt: number;
  /** Sent claims newly marked changed after submission. */
  flagged: number;
  /** Visits in scope still to look at after this batch. */
  remaining: number;
  /** Null when the rebuild is finished. */
  next: RebuildCursor | null;
}

/**
 * A reseal moves at most this many visit revisions per request (infra I1). Sized for Workers Paid
 * (review Q3): about 300 D1 statements and well within its CPU limit; Workers Free's 10 ms of CPU
 * would need it near 8. `reseal.budget.test.ts` holds the statement count to it.
 */
export const RESEAL_BATCH = 150;

/** Where a reseal got to. Post it to `POST /api/settings/reseal` to do the next batch; start with `after: ""`. */
export interface ResealCursor {
  /** Opaque to the caller: the last revision the previous batch looked at. */
  after: string;
}

/** What is left of a rotation: every reseal answer carries it. */
export interface ResealLeft {
  /** Revisions anywhere still not under the current key. Unset the previous key only once this is 0. */
  remaining: number;
  /**
   * True when the key is past version 1, revisions remain under an older key and no previous key is
   * set: those revisions cannot open, and a returning patient's new rows will not join their old ones
   * until the previous key is set again.
   */
  previousKeyMissing: boolean;
  /**
   * Payment statement rows the reseal cannot move, because nothing on the desk holds the identifier
   * they were hashed from: statements' file hashes, and the patient hashes of lines whose patient has
   * no visit. Matching by reference or by hand still works for them; a statement imported again under
   * a later key is caught by the duplicate check rather than by its hash.
   */
  cantMove: { remittanceFiles: number; remittanceLines: number };
}

/** `GET /api/settings/reseal`: where the identifier key stands, for the settings page. Reviewers only. */
export interface ResealStatus extends ResealLeft {
  /** The current key's version, from `IDENTIFIER_KEY_VERSION`. */
  version: number;
  /** Whether `IDENTIFIER_KEY_PREVIOUS` is set, so a reseal can run. */
  previousKeySet: boolean;
}

/** What one batch of a reseal did, after a new `IDENTIFIER_KEY` is set with the old one as `IDENTIFIER_KEY_PREVIOUS`. */
export interface ResealProgress extends ResealLeft {
  /** Revisions this batch moved to the current key. */
  moved: number;
  /** Revisions this batch could not open or check, left as they were. */
  failed: number;
  /** Which revisions those were, by visit key and revision: never a value they hold. */
  failures: { visitKey: string; revision: number }[];
  /** Null when there is nothing after this batch to look at. Start again from `after: ""` to retry what failed. */
  next: ResealCursor | null;
}

/** S15: approved claims keep the channel stamped when they were approved. */
export interface ApprovedChannelCount {
  payerId: PayerId;
  channel: Channel;
  count: number;
}

export interface SettingsResponse {
  /** 0 until the first save; the desk then runs on the defaults. */
  version: number;
  settings: DeskSettings;
  /** From `ROLE_REVIEWERS` and `ROLE_OFFICERS`; changed in the deployment, never here. */
  roles: { reviewers: string[]; officers: string[] };
  ruleSets: RuleSetSummary[];
  approvedByChannel: ApprovedChannelCount[];
}

export interface SettingsSaveRequest {
  settings: DeskSettings;
  expectedVersion: number;
}

export interface SettingsSaveResponse {
  version: number;
  rebuild: RebuildProgress;
}

/** A clinic code seen on a current visit with no code-map entry at all. */
export interface UnmappedCode {
  clinicCode: string;
  description: string;
  /** Current visits carrying the code. */
  visits: number;
}

export interface CodeMapResponse {
  items: CodeMapEntry[];
  unmapped: UnmappedCode[];
}

/** `PUT /api/code-map/:clinicCode/:target/:payerId` (payer `-` for CHAS and TOSP). */
export interface CodeMapSaveRequest {
  /** Null means "not claimable" under this target. */
  targetCode: string | null;
  origin: CodeMapOrigin;
}

export interface CodeMapSaveResponse {
  entry: CodeMapEntry;
  rebuild: RebuildProgress;
}

/** `DELETE /api/code-map/:clinicCode/:target/:payerId`; 404 `not_found` when there is no such entry. */
export interface CodeMapDeleteResponse {
  rebuild: RebuildProgress;
}

/** The path segment standing for "no payer" (CHAS and TOSP entries). */
export const NO_PAYER_SEGMENT = "-";

export function codeMapPath(clinicCode: string, target: CodeMapTarget, payerId: string): string {
  return `/api/code-map/${encodeURIComponent(clinicCode)}/${target}/${payerId === "" ? NO_PAYER_SEGMENT : encodeURIComponent(payerId)}`;
}
