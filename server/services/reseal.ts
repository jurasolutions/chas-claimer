/**
 * Moving stored identities to the current identifier key (infra I1, ADR 0006). After a new
 * `IDENTIFIER_KEY` is set with the old one as `IDENTIFIER_KEY_PREVIOUS`, each batch takes the next
 * `RESEAL_BATCH` visit revisions not yet under the current key, in (visit key, revision) order, and
 * for each one:
 *
 * 1. opens the sealed identity with the key its prefix names, and joins it to the clinical part;
 * 2. checks the stored content hash is the joined visit's under a key in use, so the re-key can never
 *    change what the revision says;
 * 3. writes the identity sealed, and the content hashed, under the current key: the one update the
 *    `visit_revisions` trigger allows (migration 0002), guarded on the values it read;
 * 4. moves the visit's head hash and the patient's rows to the current key's hashes.
 *
 * A revision that fails to open or check is counted, named by visit key and revision, and left; the
 * next batch moves on past it. One audit event per batch records counts and the version, never a value.
 *
 * Every answer also says what is left: revisions under another key, whether that is because the
 * previous key is missing, and the payment statement rows no re-seal can move (`ResealProgress`).
 */
import { RESEAL_BATCH, type ResealLeft, type ResealProgress, type ResealStatus } from "../../src/api/settings";
import { canonicalJson, type ClinicalVisit, joinVisit } from "../../src/domain/source-visit";
import { type Actor, actorId } from "../../src/domain/types";
import { contentHashes, currentPrefix, openIdentity, patientHashes, sealIdentity } from "../crypto";
import { auditStatement } from "../repo/audit";
import { adoptStatements } from "../repo/patients";
import * as revisions from "../repo/visit-revisions";
import type { Deps } from "./deps";

/** Where a batch starts: after this revision. The empty cursor starts before every revision. */
type After = revisions.RevisionAt;

const START: After = { visitKey: "", revision: -1 };

/** The cursor's text, or null when it is not one this service wrote. */
export function decodeAfter(text: string): After | null {
  if (text === "") return START;
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isSafeInteger(value[1]) && (value[1] as number) >= 0) {
      return { visitKey: value[0], revision: value[1] as number };
    }
  } catch {
    // not JSON: falls through
  }
  return null;
}

const encodeAfter = (a: After): string => JSON.stringify([a.visitKey, a.revision]);

/** What is left of the rotation under these keys: one query. */
async function left(db: D1Database, keys: Deps["keys"]): Promise<ResealLeft> {
  const counts = await revisions.resealCounts(db, { prefix: currentPrefix(keys), version: keys.current.version });
  return {
    remaining: counts.remaining,
    previousKeyMissing: !keys.previous && keys.current.version > 1 && counts.remaining > 0,
    cantMove: { remittanceFiles: counts.remittanceFiles, remittanceLines: counts.remittanceLines },
  };
}

/** Where the identifier key stands, for the settings page. Reads only. */
export async function resealStatus(deps: Pick<Deps, "db" | "keys">): Promise<ResealStatus> {
  return { version: deps.keys.current.version, previousKeySet: deps.keys.previous !== null, ...(await left(deps.db, deps.keys)) };
}

export async function resealBatch(deps: Pick<Deps, "db" | "now" | "keys">, afterText: string, actor: Actor): Promise<ResealProgress> {
  const { db, keys, now } = deps;
  const prefix = currentPrefix(keys);
  const after = decodeAfter(afterText);
  if (!after) throw new Error("A reseal cursor this service did not write.");

  const progress = async (moved: number, failures: ResealProgress["failures"], next: ResealProgress["next"]): Promise<ResealProgress> => ({
    moved,
    failed: failures.length,
    failures,
    ...(await left(db, keys)),
    next,
  });
  // Without the previous key nothing stored under it opens: say what is left and stop.
  if (!keys.previous) return progress(0, [], null);

  const rows = await revisions.stalePage(db, prefix, after, RESEAL_BATCH + 1);
  const batch = rows.slice(0, RESEAL_BATCH);
  const last = batch.at(-1);
  if (!last) return progress(0, [], null);

  const writes: D1PreparedStatement[] = [];
  const revisionWrites: number[] = [];
  const patients: string[][] = [];
  const failures: ResealProgress["failures"] = [];
  for (const row of batch) {
    const at = { visitKey: row.visitKey, revision: row.revision };
    try {
      const identity = await openIdentity(keys, row.identitySealed, at);
      const visit = joinVisit(identity, JSON.parse(row.clinicalJson) as ClinicalVisit);
      const hashes = await contentHashes(keys, canonicalJson(visit));
      if (!hashes.includes(row.contentHash)) throw new Error("The revision's content hash does not match what it holds.");
      const rekey = revisions.rekeyStatements(db, row, { identitySealed: await sealIdentity(keys, identity, at), contentHash: hashes[0] as string });
      revisionWrites.push(writes.length);
      writes.push(...rekey);
      patients.push(await patientHashes(keys, identity.nric));
    } catch {
      // Never the value or the reason's detail: only where the revision is leaves this loop.
      failures.push(at);
    }
  }

  writes.push(
    ...adoptStatements(db, keys.current.version, patients),
    auditStatement(db, {
      at: new Date(now).toISOString(),
      actor: actorId(actor),
      action: "identity_resealed",
      entityType: "settings",
      entityId: "identifier_key",
      detail: { version: keys.current.version, considered: batch.length, attempted: revisionWrites.length, failed: failures.length },
    }),
  );
  const results = await db.batch(writes);
  const moved = revisionWrites.reduce((n, i) => n + (results[i]?.meta.changes ?? 0), 0);
  return progress(moved, failures, rows.length > RESEAL_BATCH ? { after: encodeAfter({ visitKey: last.visitKey, revision: last.revision }) } : null);
}
