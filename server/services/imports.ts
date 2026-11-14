/**
 * The import service (technical F1, F2, F5): every way visits reach the desk (the connector, the
 * synthetic clinic, an upload later) comes through `importVisits`.
 *
 * - Each visit is parsed; one that fails is refused by its position and the paths that failed, never
 *   by a value.
 * - Until `ALLOW_REAL_IDENTIFIERS=yes`, an NRIC outside the synthetic `T9` block refuses the whole
 *   import (decisions-g2 #1). The refusal is recorded without the value.
 * - A visit identical to its current revision is unchanged and writes nothing. One that repeats an
 *   earlier revision is an older payload arriving late and is ignored.
 * - A new or changed visit writes its revision and its rebuilt claims in one batch. The revision's
 *   primary key is the lock: a writer that loses the race re-reads the head and tries again.
 */
import type { ImportSummary } from "../../src/api/imports";
import { orderKey } from "../../src/domain/claims/plan";
import type { IsoDate } from "../../src/domain/dates";
import { maskNric, type Nric } from "../../src/domain/nric";
import { canonicalJson, parseSourceVisit, type SourceVisit, splitVisit } from "../../src/domain/source-visit";
import { type Actor, actorId, type ImportSource } from "../../src/domain/types";
import { contentHashes, currentVersion, patientHashes, sealIdentity } from "../crypto";
import { refusedIdentifierPositions } from "../identifiers";
import { auditStatement } from "../repo/audit";
import * as imports from "../repo/imports";
import * as patients from "../repo/patients";
import * as visits from "../repo/visits";
import { RETRY, withRetry } from "../retry";
import type { Deps } from "./deps";
import { landed, rebuildLaterVisits, rebuildStatements, rebuildVisits } from "./rebuild";

export type { Deps } from "./deps";

export interface ImportInput {
  source: ImportSource;
  visits: readonly unknown[];
}

/** An identifier outside the synthetic block while real identifiers are not allowed. Carries positions only. */
export class RealIdentifierRefusedError extends Error {
  constructor(
    readonly importId: string,
    readonly indexes: readonly number[],
  ) {
    super("this import carries an identifier outside the synthetic test block");
    this.name = "RealIdentifierRefusedError";
  }
}

type Outcome = "new" | "changed" | "unchanged" | "ignored";

/** Clinic order: by date, then start time, then visit key. A patient's earlier visit imports first. */
export const visitOrder = (a: SourceVisit, b: SourceVisit): number =>
  a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? "") || a.visitKey.localeCompare(b.visitKey);

export async function importVisits(deps: Deps, input: ImportInput, actor: Actor): Promise<ImportSummary> {
  const { db, now } = deps;
  const importId = crypto.randomUUID();
  const startedAt = new Date(now).toISOString();
  const actorName = actorId(actor);
  const summary: ImportSummary = {
    importId,
    received: input.visits.length,
    new: 0,
    changed: 0,
    unchanged: 0,
    flagged: 0,
    refused: 0,
    ignored: [],
    refusedVisits: [],
  };

  const parsed: SourceVisit[] = [];
  const identifiers: [number, (Nric | null)[]][] = [];
  input.visits.forEach((raw, index) => {
    const result = parseSourceVisit(raw);
    if (!result.ok) {
      summary.refusedVisits.push({ index, issues: result.error });
      return;
    }
    identifiers.push([index, [result.value.patient.nric, result.value.medisave?.accountHolder.nric ?? null]]);
    parsed.push(result.value);
  });
  summary.refused = summary.refusedVisits.length;

  const importRow = (refused: number) =>
    imports.startStatement(db, { id: importId, source: input.source, actor: actorName, startedAt, received: summary.received, refused });

  const realAt = refusedIdentifierPositions(deps.env, identifiers);
  if (realAt.length > 0) {
    await db.batch([
      importRow(summary.received),
      imports.refusedStatement(db, importId, startedAt),
      auditStatement(db, {
        at: startedAt,
        actor: actorName,
        action: "import_refused",
        entityType: "import",
        entityId: importId,
        detail: { reason: "real_identifier_refused", received: summary.received, indexes: realAt },
      }),
    ]);
    throw new RealIdentifierRefusedError(importId, realAt);
  }

  await importRow(summary.refused).run();

  for (const visit of [...parsed].sort(visitOrder)) {
    const outcome = await importOne(deps, importId, visit, actor, summary);
    if (outcome === "ignored") summary.ignored.push({ visitKey: visit.visitKey, reason: "older_than_current" });
    else summary[outcome] += 1;
  }

  const finishedAt = new Date(now).toISOString();
  await db.batch([
    imports.finishStatement(db, importId, finishedAt, { ...summary, ignored: summary.ignored.length }),
    auditStatement(db, {
      at: finishedAt,
      actor: actorName,
      action: "import_completed",
      entityType: "import",
      entityId: importId,
      detail: {
        source: input.source,
        received: summary.received,
        new: summary.new,
        changed: summary.changed,
        unchanged: summary.unchanged,
        ignored: summary.ignored.length,
        flagged: summary.flagged,
        refused: summary.refused,
      },
    }),
  ]);
  return summary;
}

/** A visit's place in a patient's history: whose it is, and where it falls in clinic order. */
type Place = { date: IsoDate; startTime: string | null; patientHash: string };

async function importOne(deps: Deps, importId: string, visit: SourceVisit, actor: Actor, summary: ImportSummary): Promise<Outcome> {
  const { db, keys, now } = deps;
  // Under every key in use, current first: during a rotation, earlier rows may carry the previous key's.
  const hashes = await contentHashes(keys, canonicalJson(visit));
  const hash = hashes[0] as string;
  const { identity, clinical } = splitVisit(visit);
  const pHashes = await patientHashes(keys, identity.nric);
  const pHash = pHashes[0] as string;
  const mask = maskNric(identity.nric);

  // Where the visit stood before this revision: a date that moves later passes visits in between.
  let previous: Place | null = null;
  const outcome = await withRetry<Outcome>(async () => {
    const head = (await visits.heads(db, [visit.visitKey])).get(visit.visitKey);
    if (head && hashes.includes(head.contentHash)) return "unchanged";
    if (head && (await visits.revisionWithHash(db, visit.visitKey, hashes)) !== null) return "ignored";
    // Before reading the patient's history, so it is all found under the current hash.
    const adoptions = patients.adoptStatements(db, currentVersion(keys), [pHashes]);
    if (adoptions.length > 0) await db.batch(adoptions);
    const before = head ? await visits.loadClinical(db, visit.visitKey) : null;
    previous = before ? { date: before.clinical.date, startTime: before.clinical.startTime, patientHash: before.patientHash } : null;

    const revision = (head?.revision ?? 0) + 1;
    const revisionWrites = visits.revisionStatements(db, {
      visitKey: visit.visitKey,
      revision,
      previousRevision: head?.revision ?? 0,
      importId,
      contentHash: hash,
      clinical,
      identitySealed: await sealIdentity(keys, identity, { visitKey: visit.visitKey, revision }),
      patientHash: pHash,
      patientMask: mask,
      createdAt: new Date(now).toISOString(),
    });
    const plan = await rebuildStatements(deps, { clinical, revision, patientHash: pHash, patientMask: mask }, actor, "import");

    let results: D1Result[];
    try {
      results = await db.batch([...revisionWrites, ...plan.statements]);
    } catch (e) {
      if (visits.isRevisionConflict(e)) return RETRY;
      throw e;
    }
    summary.flagged += plan.flagged;
    // The revision landed but a claim moved under the build: rebuild from fresh reads.
    if (!landed(results.slice(revisionWrites.length), plan.guardIndexes)) {
      summary.flagged += (await rebuildVisits(deps, [visit.visitKey], actor, "import")).flagged;
    }
    return head ? "changed" : "new";
  }, () => new Error(`visit ${visit.visitKey} kept changing during the import`));

  // A new or changed visit moves what the patient's later visits have left under their limits: every
  // visit after the earlier of where it was and where it is now. A visit moved to another patient
  // also moves what the first patient's later visits have left.
  if (outcome === "new" || outcome === "changed") {
    const here = { visitKey: visit.visitKey, date: clinical.date, startTime: clinical.startTime, patientHash: pHash };
    const was = previous as Place | null; // set inside the retry, which narrowing can't see
    const from = (p: Place) => ({ visitKey: visit.visitKey, ...p });
    const starts = !was
      ? [here]
      : was.patientHash !== pHash
        ? [here, from(was)]
        : [orderKey(was.date, was.startTime, visit.visitKey) < orderKey(here.date, here.startTime, visit.visitKey) ? from(was) : here];
    for (const at of starts) summary.flagged += (await rebuildLaterVisits(deps, at, actor, "import")).flagged;
  }
  return outcome;
}
