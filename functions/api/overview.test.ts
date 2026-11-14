import * as claims from "../../server/repo/claims";
import { DUE_SOON_DAYS, type OverviewResponse } from "../../src/api/overview";
import { CLAIM_STATUSES } from "../../src/domain/types";
import { accessClaims, accessTeam, stubAccessCerts } from "../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../tests/helpers/env";
import { emptyDesk, NOW, seededDesk } from "../../tests/helpers/fixtures";
import { apiRequest, call } from "../../tests/helpers/http";
import { onRequestGet } from "./overview";

const team = await accessTeam();

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

const as = async (email: string) => team.sign(accessClaims(email));
const overview = async (env: Parameters<typeof call>[2], email = OFFICER) => {
  const res = await call(onRequestGet, apiRequest("/api/overview", { jwt: await as(email) }), env);
  expect(res.status).toBe(200);
  return (await res.json()) as OverviewResponse;
};

describe("GET /api/overview", () => {
  it("AC-8.3: an empty desk shows zeros, not errors", async () => {
    const desk = await emptyDesk();

    expect(await overview(desk.env)).toEqual({
      byStatus: Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0])),
      chasDueSoon: { days: 5, count: 0 },
      outstandingByPayer: [],
      paymentStatements: 0,
      unmatchedRemittanceLines: 0,
    });
  });

  it("AC-8.3: counts CHAS claims due within 5 days exactly as the queue's due filter lists them", async () => {
    const desk = await seededDesk();

    const body = await overview(desk.env, REVIEWER);

    let listed = 0;
    for (let cursor: string | undefined, more = true; more; ) {
      const page = await claims.list(desk.db, { scheme: "chas", due: DUE_SOON_DAYS, cursor }, { now: NOW });
      listed += page.items.length;
      cursor = page.next ?? undefined;
      more = page.next !== null;
    }
    expect(listed).toBeGreaterThan(0);
    expect(body.chasDueSoon).toEqual({ days: 5, count: listed });
    expect(body.byStatus.needs_attention).toBeGreaterThan(0);
    expect(body.byStatus.ready).toBeGreaterThan(0);
  });

  it("AC-8.3: sums what is submitted and not yet paid by payer, and counts remittance lines no claim matched", async () => {
    const desk = await seededDesk();
    const ids = (await desk.db.prepare("SELECT id FROM claims WHERE payer_id = 'CHAS' ORDER BY id LIMIT 4").all<{ id: string }>()).results.map((r) => r.id);
    await desk.db.batch([
      desk.db
        .prepare("UPDATE claims SET payer_id = 'MERIDIAN', scheme = 'insurance', status = 'submitted', claimed_cents = 30000, paid_cents = 0 WHERE id = ?")
        .bind(ids[3]),
      desk.db.prepare("UPDATE claims SET status = 'submitted', claimed_cents = 12000, paid_cents = 0 WHERE id = ?").bind(ids[0]),
      desk.db.prepare("UPDATE claims SET status = 'submitted', claimed_cents = 8000, paid_cents = 0 WHERE id = ?").bind(ids[1]),
      desk.db.prepare("UPDATE claims SET status = 'accepted', claimed_cents = 9000, accepted_cents = 7000, paid_cents = 2500 WHERE id = ?").bind(ids[2]),
      desk.db
        .prepare("INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines, matched) VALUES ('R1', 'CHAS', 'r.csv', 'h', ?, ?, 3, 1)")
        .bind(new Date(NOW).toISOString(), REVIEWER),
      desk.db.prepare("INSERT INTO remittance_lines (remittance_id, line_no, amount_cents, claim_id) VALUES ('R1', 1, 2500, ?)").bind(ids[2]),
      desk.db.prepare("INSERT INTO remittance_lines (remittance_id, line_no, amount_cents) VALUES ('R1', 2, 4000)"),
      desk.db.prepare("INSERT INTO remittance_lines (remittance_id, line_no, amount_cents) VALUES ('R1', 3, 1500)"),
    ]);

    const body = await overview(desk.env);

    expect(body.byStatus).toMatchObject({ submitted: 3, accepted: 1, paid: 0 });
    expect(body.outstandingByPayer).toEqual([
      { payerId: "CHAS", payerName: "CHAS", claims: 3, cents: 12000 + 8000 + (7000 - 2500) },
      { payerId: "MERIDIAN", payerName: "Meridian Dental Plan", claims: 1, cents: 30000 },
    ]);
    expect(body.unmatchedRemittanceLines).toBe(2);
    expect(body.paymentStatements).toBe(1);
  });

  // QA defect D18 (qa-01.md): a claim past its window has no days left, so it is not "due in 5 days".
  it("AC-8.3: a CHAS claim whose window already closed is not counted as due within 5 days", async () => {
    const desk = await seededDesk();
    const ids = (await desk.db.prepare("SELECT id FROM claims WHERE scheme = 'chas' ORDER BY id LIMIT 2").all<{ id: string }>()).results.map((r) => r.id);
    await desk.db.batch([
      desk.db.prepare("UPDATE claims SET deadline_date = '2099-12-31' WHERE scheme = 'chas'"),
      desk.db.prepare("UPDATE claims SET status = 'ready', deadline_date = '2026-11-03' WHERE id = ?").bind(ids[0]),
      desk.db.prepare("UPDATE claims SET status = 'ready', deadline_date = '2026-11-16' WHERE id = ?").bind(ids[1]),
    ]);

    const body = await overview(desk.env);

    expect(body.chasDueSoon).toEqual({ days: 5, count: 1 });
  });

  it("refuses a caller with no role", async () => {
    const desk = await emptyDesk();
    const res = await call(onRequestGet, apiRequest("/api/overview", { jwt: await as(STRANGER) }), desk.env);
    expect(res.status).toBe(403);
  });
});
