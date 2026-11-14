import { describe, expect, it } from "vitest";
import { addDays, type IsoDate } from "../../src/domain/dates";
import { caseVisits, configuredDesk, OFFICER_ACTOR, seededDesk, TODAY } from "../../tests/helpers/fixtures";
import * as audit from "../repo/audit";
import { DEADLINE_RECHECKS_PER_LOAD, recheckDeadlines } from "./deadlines";
import { importVisits } from "./imports";

/** 10:00 SGT on `day`. */
const at = (day: IsoDate) => Date.parse(`${day}T02:00:00.000Z`);

interface ClaimRow {
  id: string;
  status: string;
  deadline_date: IsoDate;
  claimed_cents: number;
}

const d01 = async (db: D1Database) =>
  (await db.prepare("SELECT id, status, deadline_date, claimed_cents FROM claims WHERE visit_key = 'SC-D01' AND scheme = 'chas'").first<ClaimRow>())!;

const findings = async (db: D1Database, id: string) =>
  (await db.prepare("SELECT code, severity, params_json FROM findings WHERE claim_id = ? ORDER BY seq").bind(id).all<{ code: string; severity: string; params_json: string }>())
    .results;

/** A desk holding only D01: one ready CHAS claim, visited three days before TODAY. */
async function d01Desk() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
  return desk;
}

describe("recheckDeadlines (decisions-g2 #5)", () => {
  it("changes nothing on the day the claims were built", async () => {
    const { db, deps } = await seededDesk();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>();

    const result = await recheckDeadlines(deps, OFFICER_ACTOR);

    expect(result).toEqual({ rebuilt: 0, more: false });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM audit_events").first<{ n: number }>()).toEqual(before);
  });

  it("warns with the days left once a claim is five days from its deadline, and keeps it ready", async () => {
    const { db, deps } = await d01Desk();
    const claim = await d01(db);

    const result = await recheckDeadlines({ ...deps, now: at(addDays(claim.deadline_date, -3)) }, OFFICER_ACTOR);

    expect(result).toEqual({ rebuilt: 1, more: false });
    expect((await d01(db)).status).toBe("ready");
    expect(await findings(db, claim.id)).toContainEqual({ code: "deadline_approaching", severity: "warning", params_json: JSON.stringify({ daysLeft: 3 }) });
  });

  it("blocks a claim the day after its window closes and claims $0, audited with the reason deadline", async () => {
    const { db, deps } = await d01Desk();
    const claim = await d01(db);
    expect(claim.claimed_cents).toBe(5050);

    await recheckDeadlines({ ...deps, now: at(addDays(claim.deadline_date, 1)) }, OFFICER_ACTOR);

    expect(await d01(db)).toMatchObject({ status: "needs_attention", claimed_cents: 0 });
    const codes = (await findings(db, claim.id)).map((f) => f.code);
    expect(codes).toContain("past_submission_window");
    expect(codes).not.toContain("deadline_approaching");
    const events = await audit.list(db, { type: "claim", id: claim.id });
    expect(events.at(-1)).toMatchObject({ action: "rebuilt", detail: { reason: "deadline", from: "ready", to: "needs_attention" } });
  });

  it("is still the deadline in SGT on the last day: in time at 23:59 SGT, past at 00:00 SGT the next day", async () => {
    const { db, deps } = await d01Desk();
    const claim = await d01(db);
    const lastMinute = Date.parse(`${claim.deadline_date}T15:59:00.000Z`);

    await recheckDeadlines({ ...deps, now: lastMinute }, OFFICER_ACTOR);
    expect((await d01(db)).status).toBe("ready");

    await recheckDeadlines({ ...deps, now: lastMinute + 60_000 }, OFFICER_ACTOR);
    expect((await d01(db)).status).toBe("needs_attention");
  });

  it("rebuilds a bounded number of visits per load and carries on from there on the next one", async () => {
    const { db, deps } = await seededDesk();
    const later = { ...deps, now: at(addDays(TODAY, 60)) };

    const first = await recheckDeadlines(later, OFFICER_ACTOR);
    expect(first.rebuilt).toBeLessThanOrEqual(DEADLINE_RECHECKS_PER_LOAD);
    expect(first.more).toBe(true);

    let last = first;
    for (let loads = 0; last.more && loads < 20; loads += 1) last = await recheckDeadlines(later, OFFICER_ACTOR);
    expect(last.more).toBe(false);
    expect(await recheckDeadlines(later, OFFICER_ACTOR)).toEqual({ rebuilt: 0, more: false });

    const { results } = await db
      .prepare(
        `SELECT c.id FROM claims c WHERE c.scheme = 'chas' AND c.status IN ('needs_attention', 'ready', 'approved') AND c.deadline_date IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM findings f WHERE f.claim_id = c.id AND f.code = 'past_submission_window')`,
      )
      .all();
    expect(results).toEqual([]);
  });
});
