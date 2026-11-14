import { describe, expect, it } from "vitest";
import * as audit from "../repo/audit";
import { act } from "./claims";
import { nricCheckLetter } from "../../src/domain/nric";
import type { PayerId } from "../../src/domain/types";
import type { Actor } from "../../src/domain/types";
import { REVIEWER } from "../../tests/helpers/env";
import { CLINIC, OFFICER_ACTOR, retiredDesk, rotatedDesk, seededDesk } from "../../tests/helpers/fixtures";
import { awaitingPayment, claimOf, force, R1 } from "../../tests/helpers/payments";
import * as settingsRepo from "../repo/settings";
import { importRemittance, matchByHand, remittanceDetail } from "./remittances";

const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer"] };

/** A well-formed NRIC outside the synthetic T9 block. */
const OUTSIDE_BLOCK = `T8999999${nricCheckLetter("T", "8999999")}`;
const CHAS_HEADER = "reference,identifier,visit date,amount";

describe("importRemittance", () => {
  it("AC-5.1: R1's MHCP-0001 line pays D01's CHAS claim", async () => {
    const { db, deps } = await awaitingPayment();

    const result = await importRemittance(deps, R1, OFFICER_ACTOR);

    expect(result.ok).toBe(true);
    const d01 = await claimOf(db, "SC-D01", "CHAS");
    expect(d01).toMatchObject({ status: "paid", paidCents: 5050 });
  });

  it("N5: a line whose reference differs from the claim's only in case still pays it", async () => {
    const { db, deps } = await awaitingPayment();
    const csv = `${CHAS_HEADER}\nmhcp-0001,,2026-11-03,50.50\n`;

    const result = await importRemittance(deps, { ...R1, csv }, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { outcome: "imported", lines: 1, matched: 1 } });
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "paid", paidCents: 5050 });
  });

  it("AC-5.2: a line with no reference pays the one open claim for that patient, date and amount", async () => {
    const { db, deps } = await awaitingPayment();

    await importRemittance(deps, R1, OFFICER_ACTOR);

    expect(await claimOf(db, "SC-D02-P04", "CHAS")).toMatchObject({ status: "paid", paidCents: 2050 });
  });

  it("AC-5.3: a short payment leaves D03 accepted until a person accepts the shortfall", async () => {
    const { db, deps } = await awaitingPayment();

    await importRemittance(deps, R1, OFFICER_ACTOR);

    const d03 = await claimOf(db, "SC-D03", "CHAS");
    expect(d03).toMatchObject({ status: "accepted", acceptedCents: 59450, paidCents: 55000 });
    const accepted = await act(deps, d03.id, { kind: "accept_short_payment", reason: "Payer capped the root canal" }, d03.version, REVIEWER_ACTOR);
    expect(accepted.ok && accepted.value).toMatchObject({ status: "paid", paidCents: 55000 });
    const events = await audit.list(db, { type: "claim", id: d03.id });
    expect(events.find((e) => e.action === "accept_short_payment")?.detail).toMatchObject({ writtenOffCents: 4450 });
  });

  it("AC-5.4: R2 pays D04b's submitted Meridian claim, accepting it in passing", async () => {
    const { db, deps } = await awaitingPayment();

    const result = await importRemittance(deps, { payerId: "MERIDIAN", fileName: "r2-meridian.csv", csv: CLINIC.remittances.r2Meridian }, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { outcome: "imported", lines: 1, matched: 1, forPerson: 0 } });
    const d04b = await claimOf(db, "SC-D04b", "MERIDIAN");
    expect(d04b).toMatchObject({ status: "paid", paidCents: 28800, acceptedCents: 28800 });
    const actions = (await audit.list(db, { type: "claim", id: d04b.id })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["accepted_by_remittance", "record_payment"]));
  });

  it("AC-5.5: R1 matches three lines and leaves UNKNOWN-1 and the repeated D01 line for a person", async () => {
    const { deps } = await awaitingPayment();

    const result = await importRemittance(deps, R1, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { outcome: "imported", lines: 5, matched: 3, forPerson: 2 } });
  });

  it("AC-5.6: the same file again adds nothing and changes no claim", async () => {
    const { db, deps } = await awaitingPayment();
    const first = await importRemittance(deps, R1, OFFICER_ACTOR);
    const d01 = await claimOf(db, "SC-D01", "CHAS");

    const again = await importRemittance(deps, { ...R1, fileName: "r1-chas (1).csv" }, OFFICER_ACTOR);

    expect(first.ok && first.value.outcome).toBe("imported");
    expect(again).toEqual({ ok: true, value: { outcome: "already_imported", remittanceId: first.ok && "remittanceId" in first.value ? first.value.remittanceId : "", added: 0 } });
    expect(await claimOf(db, "SC-D01", "CHAS")).toEqual(d01);
  });

  it("AC-5.6: the same file sent twice at once is imported once", async () => {
    const { db, deps } = await awaitingPayment();

    const both = await Promise.all([importRemittance(deps, R1, OFFICER_ACTOR), importRemittance(deps, R1, OFFICER_ACTOR)]);

    const outcomes = both.map((r) => r.ok && r.value.outcome).sort();
    expect(outcomes).toEqual(["already_imported", "imported"]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM remittances").first("n")).toBe(1);
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "paid", paidCents: 5050 });
  });

  it("during a key rotation, knows a file first imported under the previous key", async () => {
    const before = await awaitingPayment();
    const first = await importRemittance(before.deps, R1, OFFICER_ACTOR);
    const { deps } = await rotatedDesk(before);

    const again = await importRemittance(deps, R1, OFFICER_ACTOR);

    expect(again).toMatchObject({ ok: true, value: { outcome: "already_imported", remittanceId: first.ok && "remittanceId" in first.value ? first.value.remittanceId : "" } });
  });

  it("during a key rotation, pays a claim whose patient hash is under the previous key by patient, date and amount", async () => {
    const { db, deps } = await rotatedDesk(await awaitingPayment());

    await importRemittance(deps, R1, OFFICER_ACTOR);

    const d02 = await claimOf(db, "SC-D02-P04", "CHAS");
    expect(d02).toMatchObject({ status: "paid", paidCents: 2050 });
    expect(d02.patientHash.startsWith("v2:")).toBe(true);
  });

  it("stores the current key version beside the file's hash and each line's patient hash", async () => {
    const { db, deps } = await rotatedDesk(await awaitingPayment());

    const result = await importRemittance(deps, R1, OFFICER_ACTOR);

    const id = result.ok && "remittanceId" in result.value ? result.value.remittanceId : "";
    expect(await db.prepare("SELECT key_version FROM remittances WHERE id = ?").bind(id).first("key_version")).toBe(2);
    const { results } = await db.prepare("SELECT patient_hash, key_version FROM remittance_lines WHERE remittance_id = ?").bind(id).all<{ patient_hash: string | null; key_version: number | null }>();
    expect(results.length).toBeGreaterThan(0);
    for (const line of results) expect(line.key_version).toBe(line.patient_hash === null ? null : 2);
  });

  it("AC-5.7: a file with a header and no lines writes nothing", async () => {
    const { db, deps } = await awaitingPayment();

    const result = await importRemittance(deps, { ...R1, csv: "reference,identifier,visit date,amount\n" }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: true, value: { outcome: "empty" } });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM remittances").first("n")).toBe(0);
  });

  it("refuses a statement naming an NRIC outside the synthetic block, by line number, keeping nothing", async () => {
    const { db, deps } = await awaitingPayment();
    const csv = `${CHAS_HEADER}\nMHCP-0001,,2026-11-03,50.50\nMHCP-0009,${OUTSIDE_BLOCK},2026-11-03,12.00\n`;

    const result = await importRemittance(deps, { ...R1, csv }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { error: "real_identifier_refused", lines: [2] } });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM remittances").first("n")).toBe(0);
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "submitted", paidCents: 0 });
    const { results } = await db.prepare("SELECT entity_id FROM audit_events WHERE action = 'import_refused'").all<{ entity_id: string }>();
    expect(results).toHaveLength(1);
    const events = await audit.list(db, { type: "remittance", id: results[0]!.entity_id });
    expect(events.map((e) => e.detail)).toEqual([{ reason: "real_identifier_refused", payerId: "CHAS", lines: [2] }]);
    const everything = JSON.stringify((await db.prepare("SELECT * FROM audit_events").all()).results);
    expect(everything).not.toContain(OUTSIDE_BLOCK);
  });

  it("takes a statement naming an NRIC outside the block when real identifiers are allowed", async () => {
    const { deps } = await seededDesk({ ALLOW_REAL_IDENTIFIERS: "yes" });
    const csv = `${CHAS_HEADER}\nMHCP-0009,${OUTSIDE_BLOCK},2026-11-03,12.00\n`;

    const result = await importRemittance(deps, { ...R1, csv }, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { outcome: "imported", lines: 1, matched: 0, forPerson: 1 } });
  });

  it("refuses a payer whose statement columns no one has mapped", async () => {
    const { deps } = await awaitingPayment();

    const result = await importRemittance(deps, { payerId: "HARBOUR", fileName: "harbour.csv", csv: "a,b\n1,2\n" }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { error: "columns_not_mapped", payerId: "HARBOUR" } });
  });

  it("saves a reviewer's column mapping with the upload and reads the file through it", async () => {
    const { db, deps } = await awaitingPayment();
    const columns = { reference: "Ref", patientNric: null, visitDate: "Date", amount: "Paid", paidOn: null };

    const result = await importRemittance(deps, { payerId: "HARBOUR", fileName: "harbour.csv", csv: "Ref,Date,Paid\nHB-0009,2026-11-03,12.00\n", columns }, REVIEWER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { outcome: "imported", lines: 1, matched: 0, forPerson: 1 } });
    const { version, settings } = await settingsRepo.get(db);
    expect(settings.payers.find((p) => p.id === "HARBOUR")?.remittanceColumns).toEqual(columns);
    const saved = await audit.list(db, { type: "settings", id: "desk" });
    expect(saved.at(-1)).toMatchObject({ action: "settings_saved", actor: REVIEWER, detail: { toVersion: version, sections: ["payers"] } });
  });

  it("refuses a column mapping sent by an officer, saving nothing", async () => {
    const { db, deps } = await awaitingPayment();
    const before = await settingsRepo.get(db);
    const columns = { reference: "Ref", patientNric: null, visitDate: "Date", amount: "Paid", paidOn: null };

    const result = await importRemittance(deps, { payerId: "HARBOUR", fileName: "harbour.csv", csv: "Ref,Date,Paid\nHB-0009,2026-11-03,12.00\n", columns }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { error: "forbidden", reason: "columns" } });
    expect(await settingsRepo.get(db)).toEqual(before);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM remittances").first("n")).toBe(0);
  });

  it("refuses a payer the desk does not know", async () => {
    const { deps } = await awaitingPayment();

    const result = await importRemittance(deps, { ...R1, payerId: "NOBODY" }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { error: "unknown_payer", payerId: "NOBODY" } });
  });
});

describe("a statement imported again after its key is retired (review B1)", () => {
  const remittanceCount = (db: D1Database) => db.prepare("SELECT COUNT(*) AS n FROM remittances").first<number>("n");

  /** R1 taken in under version 1, then the rotation finished: version 2 alone, so R1's file hash no longer matches. */
  async function retiredAfterR1() {
    const desk = await awaitingPayment();
    const first = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
    if (!first.ok || first.value.outcome !== "imported") throw new Error("R1 did not import");
    return { desk: await retiredDesk(desk), earlierId: first.value.remittanceId };
  }

  it("is still recognised by its hash while the previous key is set", async () => {
    const desk = await awaitingPayment();
    const first = await importRemittance(desk.deps, R1, OFFICER_ACTOR);

    const again = await importRemittance((await rotatedDesk(desk)).deps, R1, OFFICER_ACTOR);

    expect(again).toMatchObject({ ok: true, value: { outcome: "already_imported", remittanceId: first.ok && "remittanceId" in first.value ? first.value.remittanceId : "" } });
  });

  it("is refused as a possible duplicate when the payer, file name and line count match a statement under a retired key", async () => {
    const { desk, earlierId } = await retiredAfterR1();

    const again = await importRemittance(desk.deps, R1, OFFICER_ACTOR);

    expect(again).toEqual({ ok: false, error: { error: "possible_duplicate", remittanceId: earlierId } });
    expect(await remittanceCount(desk.db)).toBe(1);
    const refused = await desk.db.prepare("SELECT detail_json FROM audit_events WHERE action = 'import_refused'").first<string>("detail_json");
    expect(JSON.parse(refused ?? "null")).toEqual({ reason: "possible_duplicate", payerId: "CHAS", earlierId });
  });

  it("refuses the confirmation from an officer", async () => {
    const { desk } = await retiredAfterR1();

    const again = await importRemittance(desk.deps, { ...R1, confirmPossibleDuplicate: true }, OFFICER_ACTOR);

    expect(again).toEqual({ ok: false, error: { error: "forbidden", reason: "confirm_duplicate" } });
    expect(await remittanceCount(desk.db)).toBe(1);
  });

  it("imports it when a reviewer confirms, recording the confirmation and the earlier statement", async () => {
    const { desk, earlierId } = await retiredAfterR1();

    const again = await importRemittance(desk.deps, { ...R1, confirmPossibleDuplicate: true }, REVIEWER_ACTOR);

    expect(again).toMatchObject({ ok: true, value: { outcome: "imported", lines: 5 } });
    const id = again.ok && "remittanceId" in again.value ? again.value.remittanceId : "";
    const confirmed = await audit.list(desk.db, { type: "remittance", id });
    expect(confirmed.map((e) => [e.action, e.actor, e.detail])).toContainEqual(["remittance_duplicate_confirmed", REVIEWER, { payerId: "CHAS", earlierId }]);
  });

  it("imports a statement with another file name or line count without asking", async () => {
    const { desk } = await retiredAfterR1();

    const renamed = await importRemittance(desk.deps, { ...R1, fileName: "r1-chas-december.csv" }, OFFICER_ACTOR);

    expect(renamed).toMatchObject({ ok: true, value: { outcome: "imported" } });
  });
});

describe("remittanceDetail", () => {
  async function importedR1() {
    const desk = await awaitingPayment();
    const result = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
    if (!result.ok || result.value.outcome !== "imported") throw new Error("R1 did not import");
    return { ...desk, remittanceId: result.value.remittanceId };
  }

  it("AC-5.5 and AC-5.6: lists each line with the claim it paid, or why it waits for a person", async () => {
    const { db, remittanceId } = await importedR1();

    const detail = await remittanceDetail(db, remittanceId);

    expect(detail?.remittance).toMatchObject({ id: remittanceId, payerId: "CHAS", fileName: "r1-chas.csv", lines: 5, matched: 3 });
    expect(detail?.lines.map((l) => [l.lineNo, l.match?.visitKey ?? null, l.match?.kind ?? null, l.note])).toEqual([
      [1, "SC-D01", "reference", null],
      [2, "SC-D03", "reference", null],
      [3, "SC-D02-P04", "patient_date_amount", null],
      [4, null, null, { kind: "no_claim" }],
      [5, null, null, expect.objectContaining({ kind: "closed", visitKey: "SC-D01", status: "paid" })],
    ]);
    expect(detail?.lines[3]).toMatchObject({ portalReference: "UNKNOWN-1", amountCents: 9999 });
  });

  it("offers the payer's claims still waiting on money, masked, for matching by hand", async () => {
    const { db, remittanceId } = await importedR1();

    const detail = await remittanceDetail(db, remittanceId);

    const offered = detail?.openClaims ?? [];
    expect(offered.map((c) => c.visitKey)).toContain("SC-D03");
    expect(offered.map((c) => c.visitKey)).not.toContain("SC-D01");
    expect(offered.every((c) => c.status === "submitted" || c.status === "accepted")).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/T9\d{6}[A-Z]|patientHash/);
  });

  it("says which claim now fits a waiting line whose claim was sent after the file came in", async () => {
    const desk = await seededDesk();
    await force(desk.db, "SC-D01", "CHAS", "submitted", { portalReference: "MHCP-0001" });
    const imported = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
    const remittanceId = imported.ok && "remittanceId" in imported.value ? imported.value.remittanceId : "";
    await force(desk.db, "SC-D02-P04", "CHAS", "submitted");

    const detail = await remittanceDetail(desk.db, remittanceId);

    expect(detail?.lines[2]).toMatchObject({ lineNo: 3, match: null, note: { kind: "fits", visitKey: "SC-D02-P04", status: "submitted" } });
  });

  it("is null for a file the desk does not hold", async () => {
    const { db } = await awaitingPayment();

    expect(await remittanceDetail(db, crypto.randomUUID())).toBeNull();
  });
});

describe("matchByHand", () => {
  async function importedR1() {
    const desk = await awaitingPayment();
    await force(desk.db, "SC-D05", "CHAS", "submitted", { portalReference: "MHCP-0005" });
    const result = await importRemittance(desk.deps, R1, OFFICER_ACTOR);
    if (!result.ok || result.value.outcome !== "imported") throw new Error("R1 did not import");
    return { ...desk, remittanceId: result.value.remittanceId };
  }

  it("AC-5.5: a person matches R1's unknown line to a claim, recorded as their payment and audited on the file", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    const result = await matchByHand(deps, remittanceId, 4, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR);

    expect(result.ok).toBe(true);
    expect(await claimOf(db, "SC-D05", "CHAS")).toMatchObject({ status: "paid", paidCents: 9999 });
    const payment = (await audit.list(db, { type: "claim", id: d05.id })).find((e) => e.action === "record_payment");
    expect(payment).toMatchObject({ actor: OFFICER_ACTOR.kind === "person" ? OFFICER_ACTOR.email : "", detail: { cents: 9999, remittanceLineId: `${remittanceId}:4` } });
    const onFile = await audit.list(db, { type: "remittance", id: remittanceId });
    expect(onFile.find((e) => e.action === "remittance_line_matched")?.detail).toEqual({ lineNo: 4, claimId: d05.id });
    const detail = await remittanceDetail(db, remittanceId);
    expect(detail?.remittance.matched).toBe(4);
    expect(detail?.lines[3]).toMatchObject({ match: { kind: "manual", visitKey: "SC-D05" }, note: null });
  });

  it("refuses a claim the line's file already paid, changing nothing", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d03 = await claimOf(db, "SC-D03", "CHAS");

    const result = await matchByHand(deps, remittanceId, 4, { claimId: d03.id, expectedVersion: d03.version }, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await claimOf(db, "SC-D03", "CHAS")).toEqual(d03);
  });

  it("refuses a line already matched, a claim of another payer, and a line that is not a payment", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");
    const d04b = await claimOf(db, "SC-D04b", "MERIDIAN");
    await db.prepare("UPDATE remittance_lines SET amount_cents = -500 WHERE remittance_id = ? AND line_no = 5").bind(remittanceId).run();

    const matched = await matchByHand(deps, remittanceId, 1, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR);
    const otherPayer = await matchByHand(deps, remittanceId, 4, { claimId: d04b.id, expectedVersion: d04b.version }, OFFICER_ACTOR);
    const clawback = await matchByHand(deps, remittanceId, 5, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR);

    for (const r of [matched, otherPayer, clawback]) expect(r).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await claimOf(db, "SC-D05", "CHAS")).toEqual(d05);
    expect(await claimOf(db, "SC-D04b", "MERIDIAN")).toEqual(d04b);
  });

  it("is stale when the claim moved on since the person saw it", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    const result = await matchByHand(deps, remittanceId, 4, { claimId: d05.id, expectedVersion: d05.version - 1 }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "stale", currentVersion: d05.version } });
    expect((await remittanceDetail(db, remittanceId))?.lines[3]?.match).toBeNull();
  });

  it("is not found for a line the file does not have", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    const result = await matchByHand(deps, remittanceId, 9, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "not_found" } });
  });

  it("gives the line back, audited, when the payment is refused", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    await matchByHand(deps, remittanceId, 4, { claimId: d05.id, expectedVersion: d05.version - 1 }, OFFICER_ACTOR);

    const onFile = await audit.list(db, { type: "remittance", id: remittanceId });
    expect(onFile.find((e) => e.action === "remittance_line_released")?.detail).toEqual({ lineNo: 4, claimId: d05.id, reason: "stale" });
    expect(onFile.some((e) => e.action === "remittance_line_matched")).toBe(false);
    expect((await remittanceDetail(db, remittanceId))?.remittance.matched).toBe(3);
  });

  it("two people matching one line at once pay one claim; the other is refused", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const other = await openChasClaim(db);
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    const both = await Promise.all([
      matchByHand(deps, remittanceId, 4, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR),
      matchByHand(deps, remittanceId, 4, { claimId: other.id, expectedVersion: other.version }, REVIEWER_ACTOR),
    ]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await paymentsOnLine(db, `${remittanceId}:4`)).toBe(1);
  });

  it("two lines matched by hand to one claim at once pay it once, and neither fails", async () => {
    const { db, deps, remittanceId } = await importedR1();
    const d05 = await claimOf(db, "SC-D05", "CHAS");

    const both = await Promise.all([
      matchByHand(deps, remittanceId, 4, { claimId: d05.id, expectedVersion: d05.version }, OFFICER_ACTOR),
      matchByHand(deps, remittanceId, 5, { claimId: d05.id, expectedVersion: d05.version }, REVIEWER_ACTOR),
    ]);

    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const payments = (await audit.list(db, { type: "claim", id: d05.id })).filter((e) => e.action === "record_payment");
    expect(payments).toHaveLength(1);
  });
});

/** A CHAS claim R1 does not name, sent and waiting for payment. */
async function openChasClaim(db: D1Database) {
  const key = await db
    .prepare("SELECT visit_key FROM claims WHERE payer_id = 'CHAS' AND visit_key NOT IN ('SC-D01', 'SC-D02-P04', 'SC-D03', 'SC-D05') ORDER BY visit_key LIMIT 1")
    .first<string>("visit_key");
  await force(db, key!, "CHAS", "submitted", { portalReference: "MHCP-0077" });
  return claimOf(db, key!, "CHAS");
}

/** How many payments name this statement line, across every claim. */
async function paymentsOnLine(db: D1Database, lineId: string): Promise<number> {
  const { results } = await db.prepare("SELECT detail_json FROM audit_events WHERE action = 'record_payment'").all<{ detail_json: string }>();
  return results.filter((r) => JSON.parse(r.detail_json).remittanceLineId === lineId).length;
}

/** A D1 that runs `before(n)` ahead of its nth batch, standing in for another request arriving mid-import. */
function interleaved(db: D1Database, before: (n: number) => Promise<void>): D1Database {
  let n = 0;
  return new Proxy(db, {
    get: (target, key) =>
      key === "batch"
        ? async (statements: D1PreparedStatement[]) => {
            n += 1;
            await before(n);
            return target.batch(statements);
          }
        : Reflect.get(target, key),
  });
}

describe("a statement line pays once", () => {
  async function racing(atBatch: number) {
    const desk = await awaitingPayment();
    let hand: Awaited<ReturnType<typeof matchByHand>> | null = null;
    const db = interleaved(desk.db, async (n) => {
      if (n !== atBatch) return;
      const remittanceId = await desk.db.prepare("SELECT id FROM remittances").first<string>("id");
      const d01 = await claimOf(desk.db, "SC-D01", "CHAS");
      hand = await matchByHand(desk.deps, remittanceId!, 1, { claimId: d01.id, expectedVersion: d01.version }, REVIEWER_ACTOR);
    });
    const imported = await importRemittance({ ...desk.deps, db }, R1, OFFICER_ACTOR);
    if (!imported.ok || imported.value.outcome !== "imported") throw new Error("R1 did not import");
    return { ...desk, hand: hand as Awaited<ReturnType<typeof matchByHand>> | null, imported: imported.value, remittanceId: imported.value.remittanceId };
  }

  it("a person who matches a line before the import reaches it keeps the match; the import leaves it", async () => {
    const { db, hand, imported, remittanceId } = await racing(2);

    expect(hand).toMatchObject({ ok: true });
    expect(await paymentsOnLine(db, `${remittanceId}:1`)).toBe(1);
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "paid", paidCents: 5050 });
    const detail = await remittanceDetail(db, remittanceId);
    expect(detail?.lines[0]?.match).toMatchObject({ kind: "manual" });
    expect(detail?.remittance.matched).toBe(3);
    expect(imported).toMatchObject({ matched: 3, forPerson: 2 });
  });

  it("a person who matches a line the import is paying is refused", async () => {
    const { db, hand, remittanceId } = await racing(3);

    expect(hand).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await paymentsOnLine(db, `${remittanceId}:1`)).toBe(1);
    expect(await claimOf(db, "SC-D01", "CHAS")).toMatchObject({ status: "paid", paidCents: 5050 });
  });
});
