/**
 * Payment statements (spec §5, technical F9): a payer's remittance file comes in, each payment line is
 * matched to the claim it pays, and the payment is recorded through the claim lifecycle.
 *
 * - The file is read through the columns a reviewer mapped for the payer. A problem names headers and
 *   line numbers, never a value.
 * - Until `ALLOW_REAL_IDENTIFIERS=yes`, an NRIC outside the synthetic `T9` block refuses the file, as
 *   an import does (decisions-g2 #1).
 * - Each line's NRIC is hashed with the match key on arrival and the NRIC dropped (ADR 0006).
 * - The same file for the same payer is recognised by its keyed content hash and adds nothing. Once
 *   the key that hashed a file is retired that no longer works, so a file with the same payer, name
 *   and line count as one under a retired key is refused as a possible duplicate until a reviewer
 *   confirms it (review B1).
 * - A line pays once. It is held for its claim first, by a write that succeeds only while the line
 *   and the claim are both free in the file; only the request whose hold landed records the payment,
 *   through `act` with `record_payment`. A payment the lifecycle refuses gives the line back, audited.
 */
import type { LineClaim, LineNote, ManualMatchRequest, OpenClaimOption, RemittanceDetail, RemittanceLineView, RemittanceRefusal, RemittanceSummary } from "../../src/api/remittances";
import { MAX_OPEN_CLAIM_OPTIONS, MAX_REMITTANCE_LINES } from "../../src/api/remittances";
import type { ClaimState } from "../../src/domain/claims/state";
import { type IsoDate, sgtDay } from "../../src/domain/dates";
import { type LineMatch, matchRemittance } from "../../src/domain/matcher";
import { cents } from "../../src/domain/money";
import { err, ok, type Result } from "../../src/domain/result";
import type { RemittanceColumns } from "../../src/domain/settings";
import { canonicalJson } from "../../src/domain/source-visit";
import { parseStatement } from "../../src/domain/statement";
import { type Actor, actorId, type PayerId } from "../../src/domain/types";
import { contentHashes, currentVersion, patientHashes } from "../crypto";
import { refusedIdentifierPositions } from "../identifiers";
import { auditStatement } from "../repo/audit";
import * as patients from "../repo/patients";
import * as remittances from "../repo/remittances";
import * as settingsRepo from "../repo/settings";
import { RETRY, withRetry } from "../retry";
import { type ActError, act, type ClaimDeps } from "./claims";
import type { Deps } from "./deps";
import { saveSettings } from "./settings";

export interface RemittanceInput {
  payerId: PayerId;
  fileName: string;
  csv: string;
  /** The payer's mapping, saved to settings before the file is read. Reviewers only (AC-8.4). */
  columns?: RemittanceColumns;
  /** Import although the file looks like one under a retired key. Reviewers only. */
  confirmPossibleDuplicate?: boolean;
}

export type RemittanceProblem =
  | RemittanceRefusal
  /** An officer sent a column mapping (settings are the reviewers') or confirmed a possible duplicate. */
  | { error: "forbidden"; reason: "columns" | "confirm_duplicate" }
  /** No payer has this id. */
  | { error: "unknown_payer"; payerId: PayerId }
  /** Lines carrying an NRIC outside the synthetic block while real identifiers are not allowed. */
  | { error: "real_identifier_refused"; lines: number[] };

/** The desk recording a payment a statement line made. */
const REMITTANCE: Actor = { kind: "system", name: "remittance" };

export async function importRemittance(deps: Deps, input: RemittanceInput, actor: Actor): Promise<Result<RemittanceSummary, RemittanceProblem>> {
  const { db, keys, now } = deps;
  const reviewer = actor.kind === "person" && actor.roles.includes("reviewer");
  if (input.confirmPossibleDuplicate && !reviewer) return err({ error: "forbidden", reason: "confirm_duplicate" });
  if (input.columns) {
    if (!reviewer) return err({ error: "forbidden", reason: "columns" });
    const saved = await saveColumns(deps, input.payerId, input.columns, actor);
    if (!saved) return err({ error: "unknown_payer", payerId: input.payerId });
  }
  const { settings } = await settingsRepo.get(db);
  const payer = settings.payers.find((p) => p.id === input.payerId);
  if (!payer) return err({ error: "unknown_payer", payerId: input.payerId });
  if (!payer.remittanceColumns) return err({ error: "columns_not_mapped", payerId: input.payerId });

  const parsed = parseStatement(input.csv, payer.remittanceColumns, { maxLines: MAX_REMITTANCE_LINES });
  if (!parsed.ok) return err({ error: "statement_unreadable", problem: parsed.error });
  if (parsed.value.length === 0) return ok({ outcome: "empty" });

  const at = new Date(now).toISOString();
  const realAt = refusedIdentifierPositions(
    deps.env,
    parsed.value.map((l) => [l.lineNo, [l.patientNric]] as const),
  );
  if (realAt.length > 0) {
    await auditStatement(db, {
      at,
      actor: actorId(actor),
      action: "import_refused",
      entityType: "remittance",
      entityId: crypto.randomUUID(),
      detail: { reason: "real_identifier_refused", payerId: input.payerId, lines: realAt },
    }).run();
    return err({ error: "real_identifier_refused", lines: realAt });
  }

  // Under every key in use, current first: during a rotation, the file may have come in under the previous key.
  const fileHashes = await contentHashes(keys, input.csv);
  const fileHash = fileHashes[0] as string;
  const before = await remittances.byHash(db, input.payerId, fileHashes);
  if (before) return ok({ outcome: "already_imported", remittanceId: before, added: 0 });
  const inUse = [keys.current.version, ...(keys.previous ? [keys.previous.version] : [])];
  const lookalike = await remittances.retiredLookalike(db, { payerId: input.payerId, fileName: input.fileName, lines: parsed.value.length }, inUse);
  if (lookalike && !input.confirmPossibleDuplicate) {
    await auditStatement(db, {
      at,
      actor: actorId(actor),
      action: "import_refused",
      entityType: "remittance",
      entityId: crypto.randomUUID(),
      detail: { reason: "possible_duplicate", payerId: input.payerId, earlierId: lookalike },
    }).run();
    return err({ error: "possible_duplicate", remittanceId: lookalike });
  }

  const hashed = await Promise.all(
    parsed.value.map(async ({ patientNric, ...l }) => ({ line: l, hashes: patientNric === null ? null : await patientHashes(keys, patientNric) })),
  );
  const lines = hashed.map(({ line, hashes }) => ({ ...line, patientHash: hashes === null ? null : (hashes[0] as string) }));
  // Each patient's earlier rows move to the current hash, so the matcher finds their claims under it.
  const adoptions = patients.adoptStatements(db, currentVersion(keys), hashed.flatMap(({ hashes }) => (hashes === null ? [] : [hashes])));
  const remittanceId = crypto.randomUUID();
  try {
    await db.batch([
      ...remittances.insertStatements(db, { id: remittanceId, payerId: input.payerId, fileName: input.fileName, fileHash, keyVersion: currentVersion(keys), importedAt: at, actor: actorId(actor) }, lines),
      auditStatement(db, {
        at,
        actor: actorId(actor),
        action: "remittance_imported",
        entityType: "remittance",
        entityId: remittanceId,
        detail: { payerId: input.payerId, lines: lines.length },
      }),
      ...(lookalike
        ? [
            auditStatement(db, {
              at,
              actor: actorId(actor),
              action: "remittance_duplicate_confirmed",
              entityType: "remittance",
              entityId: remittanceId,
              detail: { payerId: input.payerId, earlierId: lookalike },
            }),
          ]
        : []),
    ]);
  } catch (e) {
    // The same file arrived alongside this one and was written first.
    const winner = remittances.isDuplicateFile(e) ? await remittances.byHash(db, input.payerId, fileHashes) : null;
    if (!winner) throw e;
    return ok({ outcome: "already_imported", remittanceId: winner, added: 0 });
  }
  if (adoptions.length > 0) await db.batch(adoptions);

  const candidates = await remittances.candidates(db, input.payerId, lines);
  const facts = new Map(candidates.map((c) => [c.claimId, c]));
  const matches = new Map(matchRemittance(lines, candidates).map((m) => [m.lineNo, m]));
  const paying = lines.flatMap((line) => {
    const m = matches.get(line.lineNo);
    if (m?.kind !== "reference" && m?.kind !== "patient_date_amount") return [];
    const claim = facts.get(m.claimId);
    return claim ? [{ held: { ...line, claimId: claim.claimId }, kind: m.kind, version: claim.version }] : [];
  });
  if (paying.length > 0) {
    // One write holds every line the matcher paired; a line a person matched meanwhile stays theirs.
    const holds = await db.batch(paying.map((p) => remittances.reserveStatement(db, remittanceId, p.held.lineNo, p.held.claimId, p.kind)));
    for (const [i, p] of paying.entries()) {
      if (holds[i]?.meta.changes === 1) await payHeld(deps, remittanceId, p.held, p.version, REMITTANCE, { retryStale: true });
    }
  }
  const matched = await remittances.countMatchedStatement(db, remittanceId).first<number>("matched");
  return ok({ outcome: "imported", remittanceId, lines: lines.length, matched: matched ?? 0, forPerson: lines.length - (matched ?? 0) });
}

const lineClaim = (c: remittances.ClaimFacts): LineClaim => ({ claimId: c.claimId, visitKey: c.visitKey, scheme: c.scheme, status: c.status });

const openOption = (c: remittances.ClaimFacts): OpenClaimOption => ({
  ...lineClaim(c),
  version: c.version,
  visitDate: c.visitDate,
  portalReference: c.portalReference,
  patientMask: c.patientMask,
  claimedCents: c.claimedCents,
  acceptedCents: c.acceptedCents,
  paidCents: c.paidCents,
});

/**
 * A file, its lines and the payer's open claims. Why a line waits is worked out now, not when it was
 * imported, so the note follows the claims: the matcher runs again over the waiting lines with the
 * claims this file already paid taken.
 */
export async function remittanceDetail(db: D1Database, remittanceId: string): Promise<RemittanceDetail | null> {
  const remittance = await remittances.get(db, remittanceId);
  if (!remittance) return null;
  const stored = await remittances.lines(db, remittanceId);
  const paidByFile = stored.flatMap((l) => (l.claimId === null ? [] : [l.claimId]));
  const waiting = stored.filter((l) => l.claimId === null);
  const [paid, candidates, open] = await Promise.all([
    remittances.claimFacts(db, paidByFile),
    remittances.candidates(db, remittance.payerId, waiting),
    remittances.openClaims(db, remittance.payerId, MAX_OPEN_CLAIM_OPTIONS),
  ]);
  const facts = new Map([...paid, ...candidates].map((c) => [c.claimId, c]));
  const claimOf = (id: string) => lineClaim(facts.get(id)!);
  const notes = new Map(matchRemittance(waiting, candidates, { taken: paidByFile }).map((m) => [m.lineNo, noteFor(m, claimOf)]));
  const lines = stored.map(
    (l): RemittanceLineView => ({
      lineNo: l.lineNo,
      portalReference: l.portalReference,
      visitDate: l.visitDate,
      amountCents: l.amountCents,
      paidOn: l.paidOn,
      match: l.claimId === null || l.matchKind === null ? null : { kind: l.matchKind, ...claimOf(l.claimId) },
      note: l.claimId === null ? (notes.get(l.lineNo) ?? { kind: "no_claim" }) : null,
    }),
  );
  return { remittance, lines, openClaims: open.map(openOption) };
}

/**
 * A person matches a waiting line to a claim of the file's payer (AC-5.5). The line is held first, so
 * two people (or a person and an import) cannot both pay with it. The payment is recorded as theirs,
 * at the claim version they saw, so a claim that moved on is `stale` rather than retried. The match is
 * audited on the file. Returns the file as it now reads.
 */
export async function matchByHand(
  deps: ClaimDeps,
  remittanceId: string,
  lineNo: number,
  request: ManualMatchRequest,
  actor: Actor,
): Promise<Result<RemittanceDetail, ActError>> {
  const { db, now } = deps;
  const remittance = await remittances.get(db, remittanceId);
  const stored = remittance ? await remittances.lines(db, remittanceId) : [];
  const line = stored.find((l) => l.lineNo === lineNo);
  if (!remittance || !line) return err({ code: "not_found" });
  if (line.amountCents <= 0) return err({ code: "not_allowed", detail: `line ${lineNo} is not a payment` });
  const taken = alreadyHeld(stored, lineNo, request.claimId);
  if (taken) return err(taken);
  const payer = await remittances.claimPayer(db, request.claimId);
  if (payer === null) return err({ code: "not_found" });
  if (payer !== remittance.payerId) return err({ code: "not_allowed", detail: "the claim is to another payer" });

  const hold = await remittances.reserveStatement(db, remittanceId, lineNo, request.claimId, "manual").run();
  if (hold.meta.changes !== 1) {
    // Another request held the line, or the claim, since this one read the file.
    return err(alreadyHeld(await remittances.lines(db, remittanceId), lineNo, request.claimId) ?? { code: "stale", currentVersion: request.expectedVersion });
  }
  const paid = await payHeld(deps, remittanceId, { ...line, claimId: request.claimId }, request.expectedVersion, actor, { retryStale: false });
  if (!paid.ok) return paid;
  await db.batch([
    remittances.countMatchedStatement(db, remittanceId),
    auditStatement(db, {
      at: new Date(now).toISOString(),
      actor: actorId(actor),
      action: "remittance_line_matched",
      entityType: "remittance",
      entityId: remittanceId,
      detail: { lineNo, claimId: request.claimId },
    }),
  ]);
  return ok((await remittanceDetail(db, remittanceId))!);
}

/** Why a line cannot be held for a claim: it holds one already, or another line of the file holds this claim. */
function alreadyHeld(stored: readonly remittances.StoredLine[], lineNo: number, claimId: string): ActError | null {
  if (stored.some((l) => l.lineNo === lineNo && l.claimId !== null)) return { code: "not_allowed", detail: `line ${lineNo} already paid a claim` };
  if (stored.some((l) => l.claimId === claimId)) return { code: "not_allowed", detail: "another line of this file already paid the claim" };
  return null;
}

/** Why a waiting line waits. A line the matcher would now pay still waits for a person, who confirms the claim that fits. */
function noteFor(m: LineMatch, claimOf: (id: string) => LineClaim): LineNote {
  switch (m.kind) {
    case "unmatched":
      if (m.reason.kind === "taken" || m.reason.kind === "closed") return { kind: m.reason.kind, ...claimOf(m.reason.claimId) };
      return m.reason;
    case "ambiguous":
      return { kind: "several", claims: m.claimIds.map(claimOf) };
    default:
      return { kind: "fits", ...claimOf(m.claimId) };
  }
}

/**
 * Saves the payer's column mapping through the settings save (versioned and audited; a mapping moves
 * no claim, so nothing rebuilds), retrying when someone saved in between. False for an unknown payer.
 */
async function saveColumns(deps: Deps, payerId: PayerId, columns: RemittanceColumns, actor: Actor): Promise<boolean> {
  return withRetry(
    async () => {
      const { version, settings } = await settingsRepo.get(deps.db);
      const payer = settings.payers.find((p) => p.id === payerId);
      if (!payer) return false;
      if (payer.remittanceColumns && canonicalJson(payer.remittanceColumns) === canonicalJson(columns)) return true;
      const payers = settings.payers.map((p) => (p.id === payerId ? { ...p, remittanceColumns: columns } : p));
      const outcome = await saveSettings(deps, { ...settings, payers }, version, actor);
      if (outcome.kind === "saved") return true;
      if (outcome.kind === "stale") return RETRY;
      throw new Error(`the stored settings no longer validate at ${outcome.issues.map((i) => i.path).join(", ")}`);
    },
    () => new Error("the settings kept changing while a column mapping was saved"),
  );
}

/** A line held for a claim, its payment not yet recorded. */
interface Held {
  lineNo: number;
  amountCents: number;
  paidOn: IsoDate | null;
  claimId: string;
}

/**
 * The one way a statement line's payment is recorded: through the lifecycle, as `actor`, at `version`.
 * With `retryStale` (the desk's own payment), a claim that moved on is tried again at its new version;
 * without it (a person's, at the version they saw), `stale` is the answer. A payment that is refused
 * or fails gives the line back, audited with the reason, so it waits for a person again.
 */
async function payHeld(
  deps: ClaimDeps,
  remittanceId: string,
  held: Held,
  version: number,
  actor: Actor,
  opts: { retryStale: boolean },
): Promise<Result<ClaimState, ActError>> {
  const payment = {
    kind: "record_payment",
    cents: cents(held.amountCents),
    paidOn: held.paidOn ?? sgtDay(deps.now),
    remittanceLineId: `${remittanceId}:${held.lineNo}`,
  } as const;
  let at = version;
  let last: Result<ClaimState, ActError> | null = null;
  try {
    const paid = await withRetry(
      async () => {
        last = await act(deps, held.claimId, payment, at, actor);
        if (opts.retryStale && !last.ok && last.error.code === "stale") {
          at = last.error.currentVersion;
          return RETRY;
        }
        return last;
      },
      () => new Error("the claim kept changing while a payment was recorded"),
    );
    if (!paid.ok) await release(deps, remittanceId, held, actor, paid.error.code);
    return paid;
  } catch (e) {
    await release(deps, remittanceId, held, actor, last === null ? "error" : "kept_changing");
    throw e;
  }
}

async function release(deps: ClaimDeps, remittanceId: string, held: Held, actor: Actor, reason: string): Promise<void> {
  const { db, now } = deps;
  await db.batch([
    remittances.releaseStatement(db, remittanceId, held.lineNo, held.claimId),
    remittances.countMatchedStatement(db, remittanceId),
    auditStatement(db, {
      at: new Date(now).toISOString(),
      actor: actorId(actor),
      action: "remittance_line_released",
      entityType: "remittance",
      entityId: remittanceId,
      detail: { lineNo: held.lineNo, claimId: held.claimId, reason },
    }),
  ]);
}
