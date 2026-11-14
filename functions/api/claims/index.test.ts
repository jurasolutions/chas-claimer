import type { ClaimListResponse } from "../../../src/api/claims";
import { CLAIM_STATUSES } from "../../../src/domain/types";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { caseVisits, CLINIC, configuredDesk, NOW, OFFICER_ACTOR, seededDesk } from "../../../tests/helpers/fixtures";
import * as settingsRepo from "../../../server/repo/settings";
import { importVisits } from "../../../server/services/imports";
import { addDays } from "../../../src/domain/dates";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestGet as listImports } from "../imports/index";
import { onRequestGet } from "./index";

const team = await accessTeam();
const desk = await seededDesk();
const get = async (query: string, who = OFFICER) => call(onRequestGet, apiRequest(`/api/claims${query}`, { jwt: await team.sign(accessClaims(who)) }), desk.env);
const page = async (query: string) => {
  const res = await get(query);
  expect(res.status).toBe(200);
  return (await res.json()) as ClaimListResponse;
};
/** Every claim the query matches, following the cursor: the seeded clinic fills more than one page. */
const everything = async (query: string) => {
  const items: ClaimListResponse["items"] = [];
  let cursor: string | null = null;
  do {
    const body = await page(`${query}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    items.push(...body.items);
    cursor = body.next;
  } while (cursor);
  return items;
};

beforeEach(() => {
  stubAccessCerts(team);
  // A queue load re-checks deadlines against the clock, so the clock is the desk's day.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/claims", () => {
  it("shows D01 as one ready CHAS claim of $50.50 with the patient masked and the branch East (AC-1.7)", async () => {
    const queue = await everything("?");

    const d01 = queue.filter((r) => r.visitKey === "SC-D01");
    expect(d01).toHaveLength(1);
    expect(d01[0]).toMatchObject({ scheme: "chas", status: "ready", claimedCents: 5050, branchId: "BR-EAST", branchName: "East branch" });
    expect(d01[0]!.patientMask).toMatch(/^T••••\d{3}[A-Z]$/);
  });

  it("names a branch settings no longer list by its code, as claim detail does (UAT 3.3)", async () => {
    const own = await seededDesk();
    const { version, settings } = await settingsRepo.get(own.db);
    const withoutEast = { ...settings, branches: settings.branches.filter((b) => b.id !== "BR-EAST") };
    await settingsRepo.saveStatement(own.db, withoutEast, version, OFFICER).run();

    const res = await call(onRequestGet, apiRequest("/api/claims?status=ready&branch=BR-EAST&limit=100", { jwt: await team.sign(accessClaims(OFFICER)) }), own.env);
    const body = (await res.json()) as ClaimListResponse;

    const d01 = body.items.find((r) => r.visitKey === "SC-D01");
    expect(d01).toMatchObject({ branchId: "BR-EAST", branchName: "BR-EAST" });
  });

  it("filters by status, scheme and branch from the query string", async () => {
    const rows = await everything("?status=ready,approved&scheme=chas&branch=BR-EAST");

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(["ready", "approved"]).toContain(row.status);
      expect(row).toMatchObject({ scheme: "chas", branchId: "BR-EAST" });
    }
  });

  it("pages with the cursor it returns, without repeating a claim", async () => {
    const first = await page("?limit=5");
    expect(first.next).not.toBeNull();

    const second = await page(`?limit=5&cursor=${encodeURIComponent(first.next!)}`);

    const ids = new Set(first.items.map((r) => r.id));
    expect(second.items.length).toBeGreaterThan(0);
    for (const row of second.items) expect(ids.has(row.id)).toBe(false);
  });

  it.each([
    ["?status=paid_in_full", "status"],
    ["?scheme=dental_plan", "scheme"],
    ["?payer=lower case", "payer"],
    ["?due=-1", "due"],
    ["?due=soon", "due"],
    ["?limit=0", "limit"],
    ["?limit=101", "limit"],
    ["?changed=maybe", "changed"],
    ["?cursor=not-a-cursor", "cursor"],
  ])("refuses %s with 400 invalid at the path %s", async (query, path) => {
    const res = await get(query);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid", issues: [{ path }] });
  });

  it("D18: the due filter keeps claims with 0 to 5 days left and leaves out those past their window (AC-8.3)", async () => {
    const all = await everything("?scheme=chas");
    expect(all.some((r) => r.deadline !== null && r.deadline.daysLeft < 0)).toBe(true);

    const due = await everything("?scheme=chas&due=5");

    expect(due.length).toBeGreaterThan(0);
    for (const row of due) expect(row.deadline?.daysLeft).toBeGreaterThanOrEqual(0);
    for (const row of due) expect(row.deadline?.daysLeft).toBeLessThanOrEqual(5);
  });

  it("re-checks CHAS deadlines as it loads: D01 needs attention the day after its window closes (decisions-g2 #5)", async () => {
    const d01Desk = await configuredDesk();
    await importVisits(d01Desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
    const { deadline_date } = (await d01Desk.db.prepare("SELECT deadline_date FROM claims WHERE visit_key = 'SC-D01'").first<{ deadline_date: string }>())!;
    vi.setSystemTime(Date.parse(`${addDays(deadline_date as never, 1)}T02:00:00.000Z`));

    const res = await call(onRequestGet, apiRequest("/api/claims", { jwt: await team.sign(accessClaims(OFFICER)) }), d01Desk.env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as ClaimListResponse).items).toEqual([expect.objectContaining({ visitKey: "SC-D01", status: "needs_attention" })]);
  });

  it("lets a reviewer read the queue and refuses someone on neither role list", async () => {
    expect((await get("", REVIEWER)).status).toBe(200);
    expect((await get("", STRANGER)).status).toBe(403);
  });
});

describe("list endpoints never carry an identifier", () => {
  it("no claims or imports response holds a patient's NRIC, name, phone or address", async () => {
    const bodies = [JSON.stringify(await everything(`?status=${CLAIM_STATUSES.join(",")}`))];
    bodies.push(await (await call(listImports, apiRequest("/api/imports", { jwt: await team.sign(accessClaims(OFFICER)) }), desk.env)).text());

    const all = bodies.join("\n");
    expect(all).toContain("SC-D01");
    for (const p of CLINIC.records.patients) {
      expect(all).not.toContain(p.nric);
      expect(all).not.toContain(p.nric.slice(1, 8));
      expect(all).not.toContain(p.name);
      expect(all).not.toContain(p.phone);
      if (p.address) expect(all).not.toContain(p.address);
    }
  });
});
