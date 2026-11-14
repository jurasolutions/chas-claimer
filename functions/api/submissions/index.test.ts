import * as claims from "../../../server/repo/claims";
import * as settingsRepo from "../../../server/repo/settings";
import * as simulatorRepo from "../../../server/repo/simulator";
import * as submissions from "../../../server/repo/submissions";
import { verifyAccessJwt } from "../../../server/access-jwt";
import { act, claimDetail } from "../../../server/services/claims";
import { importVisits } from "../../../server/services/imports";
import type { SubmitResponse } from "../../../src/api/submissions";
import type { ClaimState } from "../../../src/domain/claims/state";
import type { PayerSettings } from "../../../src/domain/settings";
import type { Actor } from "../../../src/domain/types";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER, TEST_AUD, TEST_TEAM_DOMAIN } from "../../../tests/helpers/env";
import { caseVisits, CLINIC, configuredDesk, type Desk, NOW, OFFICER_ACTOR } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { jsonAnswer, stubNetwork } from "../../../tests/helpers/network";
import { simulatorChannel } from "../../../server/channels/simulator";
import { onRequestPost as confirm } from "./confirm";
import { onRequestPost } from "./index";

const team = await accessTeam();
const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer", "officer"] };

beforeEach(async () => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  // Warm the Access key-set cache now, so a test that swaps the network for its payer's still
  // signs in when it runs on its own, and its fetch counts see only payer calls.
  await verifyAccessJwt(await team.sign(accessClaims(OFFICER)), { teamDomain: TEST_TEAM_DOMAIN, aud: TEST_AUD });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function approve(desk: Desk, claim: ClaimState): Promise<ClaimState> {
  const approved = await act(desk.deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);
  if (!approved.ok) throw new Error(`approve failed: ${approved.error.code}`);
  return approved.value;
}

/** Three Harbour visits by the same synthetic member, each with a ready Harbour claim, approved. */
async function approvedHarbour(desk: Desk): Promise<ClaimState[]> {
  const [d17] = caseVisits("D17");
  const visits = ["2026-11-08", "2026-11-07", "2026-11-06"].map((date, i) => ({
    ...d17!,
    visitKey: `SC-H${i + 1}`,
    date,
    treatments: d17!.treatments.map((t) => ({ ...t, completedOn: date })),
    policies: d17!.policies.map((p) => ({ ...p, validTo: null })),
  }));
  await importVisits(desk.deps, { source: "synthetic", visits }, OFFICER_ACTOR);
  const out: ClaimState[] = [];
  for (const key of ["SC-H1", "SC-H2", "SC-H3"]) {
    const harbour = (await claims.forVisit(desk.db, key)).find((c) => c.payerId === "HARBOUR")!;
    out.push(await approve(desk, harbour));
  }
  return out;
}

async function post(desk: Desk, handler: typeof onRequestPost, path: string, json: unknown, who = OFFICER) {
  return call(handler, apiRequest(path, { json, jwt: await team.sign(accessClaims(who)) }), desk.env);
}

const items = (cs: ClaimState[]) => cs.map((c) => ({ id: c.id, version: c.version }));

const MERIDIAN_URL = "https://simulator.example.test/meridian";
const TOKEN = "test-meridian-token";

/** A case's claim for one payer, approved. */
async function approvedClaim(desk: Desk, name: Parameters<typeof caseVisits>[0], payerId: string): Promise<ClaimState> {
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits(name) }, OFFICER_ACTOR);
  const visitKey = caseVisits(name)[0]!.visitKey;
  const claim = (await claims.forVisit(desk.db, visitKey)).find((c) => c.payerId === payerId);
  if (!claim) throw new Error(`${name} has no ${payerId} claim`);
  return approve(desk, claim);
}

const CHAS_URL = "https://simulator.example.test/chas";
const CHAS_TOKEN = "test-chas-token";

/** Puts CHAS on another channel, before any claim is approved (a claim's channel is stamped at approval). */
async function chasOn(desk: Desk, patch: Partial<PayerSettings>) {
  const payers = CLINIC.settings.payers.map((p) => (p.id === "CHAS" ? { ...p, ...patch } : p));
  await desk.db.batch([settingsRepo.saveStatement(desk.db, { ...CLINIC.settings, payers }, 1, OFFICER, new Date(NOW).toISOString())]);
}

/** D01's CHAS deadline is 2026-12-10; this is two days after it, 10:00 SGT. */
const PAST_WINDOW = Date.parse("2026-12-12T02:00:00.000Z");

/** The simulator is on: a demo deployment. */
const DEMO = { DEMO_MODE: "yes" };

async function sent(res: Response) {
  expect(res.status).toBe(200);
  const body = (await res.json()) as SubmitResponse;
  const group = body.groups[0];
  if (group?.kind !== "sent") throw new Error(`expected a sent group, got ${JSON.stringify(body)}`);
  return { body, group };
}

describe("POST /api/submissions", () => {
  it("AC-4.5: exports approved claims as one file in the payer's column order, and marks them submitted only once the officer confirms", async () => {
    const desk = await configuredDesk();
    const harbour = await approvedHarbour(desk);

    const res = await post(desk, onRequestPost, "/api/submissions", { items: items(harbour) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as SubmitResponse;
    expect(body.refused).toEqual([]);
    expect(body.groups).toHaveLength(1);
    const group = body.groups[0]!;
    if (group.kind !== "file") throw new Error(`expected a file group, got ${group.kind}`);
    expect(group.payerId).toBe("HARBOUR");
    expect(group.filename).toMatch(/^harbour-2026-11-13-[a-z0-9]+\.csv$/);
    const lines = group.csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("claim_ref,member_id,patient_name,visit_date,benefit_code,fee,claim_amount,pre_auth_ref");
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(1)) {
      const cells = line.split(",");
      expect(cells[1]).toBe("TEST-818517");
      expect(cells[6]).toBe("50.00");
    }
    expect(lines.slice(1).map((l) => l.split(",")[3])).toEqual(["2026-11-08", "2026-11-07", "2026-11-06"]);

    for (const c of harbour) {
      const after = await claims.detail(desk.db, c.id);
      expect(after!.status).toBe("approved");
      const detail = await claimDetail(desk.deps, c.id, OFFICER_ACTOR);
      const exported = detail!.audit.filter((e) => e.action === "exported");
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({ actor: OFFICER, detail: { batchRef: group.batchRef, payerId: "HARBOUR" } });
    }

    const confirmed = await post(desk, confirm, "/api/submissions/confirm", { batchRef: group.batchRef, items: items(harbour) });

    expect(confirmed.status).toBe(200);
    const outcome = (await confirmed.json()) as { done: { id: string }[]; failed: unknown[] };
    expect(outcome.failed).toEqual([]);
    expect(outcome.done.map((d) => d.id).sort()).toEqual(harbour.map((c) => c.id).sort());
    for (const c of harbour) {
      expect((await claims.detail(desk.db, c.id))!.status).toBe("submitted");
      const [attempt] = await submissions.list(desk.db, c.id);
      expect(attempt).toMatchObject({ channel: "file", result: "exported", batchRef: group.batchRef });
    }
  });

  it("AC-4.5: a claim that was not in the file is not confirmed", async () => {
    const desk = await configuredDesk();
    const [first, second] = await approvedHarbour(desk);
    const res = await post(desk, onRequestPost, "/api/submissions", { items: items([first!]) });
    const group = ((await res.json()) as SubmitResponse).groups[0]!;
    if (group.kind !== "file") throw new Error("expected a file group");

    const confirmed = await post(desk, confirm, "/api/submissions/confirm", { batchRef: group.batchRef, items: items([second!]) });

    const outcome = (await confirmed.json()) as { done: unknown[]; failed: { id: string; status: number; error: { detail: string } }[] };
    expect(outcome.done).toEqual([]);
    expect(outcome.failed).toMatchObject([{ id: second!.id, status: 409, error: { detail: "This claim was not in that file." } }]);
    expect((await claims.detail(desk.db, second!.id))!.status).toBe("approved");
  });

  it("D17: once a file is confirmed, its claims are refused in another export or confirmation, even at their current version", async () => {
    const desk = await configuredDesk();
    const harbour = await approvedHarbour(desk);
    const first = ((await (await post(desk, onRequestPost, "/api/submissions", { items: items(harbour) })).json()) as SubmitResponse).groups[0]!;
    if (first.kind !== "file") throw new Error("expected a file group");
    const confirmed = (await (await post(desk, confirm, "/api/submissions/confirm", { batchRef: first.batchRef, items: items(harbour) })).json()) as {
      done: { id: string; version: number }[];
    };
    const current = confirmed.done;
    expect(current).toHaveLength(3);

    const again = (await (await post(desk, onRequestPost, "/api/submissions", { items: current })).json()) as SubmitResponse;

    expect(again.groups).toEqual([]);
    expect(again.refused).toHaveLength(3);
    for (const r of again.refused) expect(r).toMatchObject({ status: 409, error: { detail: "A submitted claim is not waiting to be sent." } });
    for (const c of harbour) {
      const detail = await claimDetail(desk.deps, c.id, OFFICER_ACTOR);
      expect(detail!.audit.filter((e) => e.action === "exported")).toHaveLength(1);
    }

    const reconfirmed = (await (await post(desk, confirm, "/api/submissions/confirm", { batchRef: first.batchRef, items: current })).json()) as {
      done: unknown[];
      failed: { id: string; status: number }[];
    };
    expect(reconfirmed.done).toEqual([]);
    expect(reconfirmed.failed.map((f) => f.status)).toEqual([409, 409, 409]);
    for (const c of harbour) expect(await submissions.list(desk.db, c.id)).toHaveLength(1);
  });

  it("AC-4.6: sends the packet to the payer's API with its token and an idempotency key, and records the payer's reference", async () => {
    const desk = await configuredDesk({ PAYER_MERIDIAN_API_TOKEN: TOKEN });
    const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
    const requests: Request[] = [];
    const fetchStub = stubNetwork({
      [MERIDIAN_URL]: async (req) => {
        requests.push(req);
        return jsonAnswer({ reference: "MDP-REF-0001" })(req);
      },
    });

    const { body, group } = await sent(await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) }));

    expect(body.refused).toEqual([]);
    expect(group).toMatchObject({ payerId: "MERIDIAN", results: [{ claimId: claim.id, ok: true, portalReference: "MDP-REF-0001" }] });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(req.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f]{64}$/);
    const payload = (await req.json()) as { claimId: string; payerId: string; fields: Record<string, string | null> };
    expect(payload).toMatchObject({ claimId: claim.id, payerId: "MERIDIAN" });
    expect(Object.values(payload.fields)).toContain("288.00");

    const after = (await claims.detail(desk.db, claim.id))!;
    expect(after).toMatchObject({ status: "submitted", portalReference: "MDP-REF-0001" });
    const [attempt] = await submissions.list(desk.db, claim.id);
    expect(attempt).toMatchObject({ channel: "api", result: "sent", portalReference: "MDP-REF-0001" });
    const trail = JSON.stringify((await claimDetail(desk.deps, claim.id, OFFICER_ACTOR))!.audit);
    expect(trail).not.toContain(TOKEN);
  });

  it("AC-4.6: a send that times out leaves the claim approved with the failed attempt on its trail, and a retry uses the same key", async () => {
    const desk = await configuredDesk({ PAYER_MERIDIAN_API_TOKEN: TOKEN });
    const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
    const keys: (string | null)[] = [];
    stubNetwork({
      [MERIDIAN_URL]: (req) => {
        keys.push(req.headers.get("Idempotency-Key"));
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    const first = await sent(await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) }));

    expect(first.group.results).toEqual([{ claimId: claim.id, ok: false, error: "timeout" }]);
    const after = (await claims.detail(desk.db, claim.id))!;
    expect(after.status).toBe("approved");
    const detail = await claimDetail(desk.deps, claim.id, OFFICER_ACTOR);
    expect(detail!.audit.filter((e) => e.action === "submission_failed")).toHaveLength(1);
    const [attempt] = await submissions.list(desk.db, claim.id);
    expect(attempt).toMatchObject({ channel: "api", error: "timeout" });

    await post(desk, onRequestPost, "/api/submissions", { items: items([after]) });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("AC-4.6: a claim the payer rejected, reopened and sent again goes with a new key, so the payer takes it as a new claim", async () => {
    const desk = await configuredDesk({ PAYER_MERIDIAN_API_TOKEN: TOKEN });
    const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
    const keys: (string | null)[] = [];
    stubNetwork({
      [MERIDIAN_URL]: async (req) => {
        keys.push(req.headers.get("Idempotency-Key"));
        return jsonAnswer({ reference: `MDP-REF-000${keys.length}` })(req);
      },
    });
    await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });
    const submitted = (await claims.detail(desk.db, claim.id))!;
    const rejected = await act(desk.deps, claim.id, { kind: "reject", reason: "Missing tooth chart" }, submitted.version, REVIEWER_ACTOR);
    if (!rejected.ok) throw new Error(`reject failed: ${rejected.error.code}`);
    const reopened = await act(desk.deps, claim.id, { kind: "reopen" }, rejected.value.version, REVIEWER_ACTOR);
    if (!reopened.ok) throw new Error(`reopen failed: ${reopened.error.code}`);
    const again = await approve(desk, reopened.value);
    expect(again.builtFromRevision).toBe(submitted.builtFromRevision);

    await post(desk, onRequestPost, "/api/submissions", { items: items([again]) });

    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).not.toBe(keys[0]);
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "submitted", portalReference: "MDP-REF-0002" });
  });

  it("F3: the API token never reaches a D1 row, a response or a log, even when the payer echoes it back", async () => {
    const desk = await configuredDesk({ PAYER_MERIDIAN_API_TOKEN: TOKEN });
    const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    let calls = 0;
    stubNetwork({
      [MERIDIAN_URL]: async (req) => {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: `bad credentials: ${req.headers.get("Authorization")}` }), { status: 500, headers: { "content-type": "application/json" } });
        }
        return jsonAnswer({ reference: "MDP-REF-0003", echo: req.headers.get("Authorization") })(req);
      },
    });

    const failed = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });
    const failedText = await failed.text();
    const retried = await post(desk, onRequestPost, "/api/submissions", { items: items([(await claims.detail(desk.db, claim.id))!]) });
    const retriedText = await retried.text();

    expect(calls).toBe(2);
    expect((await claims.detail(desk.db, claim.id))!.status).toBe("submitted");
    expect(failedText).not.toContain(TOKEN);
    expect(retriedText).not.toContain(TOKEN);
    const tables = await desk.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    expect(tables.results.length).toBeGreaterThan(0);
    for (const { name } of tables.results) {
      const rows = await desk.db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows.results), name).not.toContain(TOKEN);
    }
    for (const spy of logged) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
      spy.mockRestore();
    }
  });

  it("AC-4.6: a payer whose token is not set is refused before anything is sent", async () => {
    const desk = await configuredDesk();
    const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
    const fetchStub = stubNetwork({});

    const res = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });

    const body = (await res.json()) as SubmitResponse;
    expect(body.groups).toEqual([]);
    expect(body.refused).toMatchObject([{ id: claim.id, status: 409, error: { detail: "This payer's API token is not set." } }]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect((await claims.detail(desk.db, claim.id))!.status).toBe("approved");
  });

  it("AC-4.2: an assisted payer's claims come back as a checklist, and nothing moves until the officer records the reference", async () => {
    const desk = await configuredDesk();
    const claim = await approvedClaim(desk, "D01", "CHAS");

    const res = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });

    const body = (await res.json()) as SubmitResponse;
    expect(body.groups).toEqual([{ kind: "checklist", payerId: "CHAS", payerName: expect.any(String), claimIds: [claim.id] }]);
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "approved", version: claim.version });
  });

  it("AC-4.7: a simulator payer takes the claim and answers a SIM- reference", async () => {
    const desk = await configuredDesk(DEMO);
    const claim = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");
    const fetchStub = stubNetwork({});

    const { group } = await sent(await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) }));

    const [result] = group.results;
    expect(result).toMatchObject({ claimId: claim.id, ok: true, portalReference: expect.stringMatching(/^SIM-[0-9A-F]{8}$/) });
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "submitted", portalReference: (result as { portalReference: string }).portalReference });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a claim that is not approved, or that changed since it was selected, and still sends the rest", async () => {
    const desk = await configuredDesk(DEMO);
    const approved = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D03") }, OFFICER_ACTOR);
    const notApproved = (await claims.forVisit(desk.db, "SC-D03"))[0]!;

    const res = await post(desk, onRequestPost, "/api/submissions", {
      items: [
        { id: notApproved.id, version: notApproved.version },
        { id: approved.id, version: approved.version + 1 },
      ],
    });

    const body = (await res.json()) as SubmitResponse;
    expect(body.groups).toEqual([]);
    expect(body.refused).toMatchObject([
      { id: notApproved.id, status: 409, error: { detail: expect.stringMatching(/is not waiting to be sent\.$/) } },
      { id: approved.id, status: 409, error: { error: "stale", currentVersion: approved.version } },
    ]);
  });

  it("names each claim once", async () => {
    const desk = await configuredDesk(DEMO);
    const claim = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");
    const res = await post(desk, onRequestPost, "/api/submissions", { items: [...items([claim]), ...items([claim])] });
    expect(res.status).toBe(400);
  });

  describe("the payer simulator is off unless DEMO_MODE=yes or the desk runs on this machine", () => {
    it("refuses a simulator payer's claim on a deployed desk, and nothing reaches the simulator", async () => {
      const desk = await configuredDesk();
      const claim = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");

      const res = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });

      const body = (await res.json()) as SubmitResponse;
      expect(body.groups).toEqual([]);
      expect(body.refused).toMatchObject([{ id: claim.id, status: 409, error: { detail: "The payer simulator is off on this deployment." } }]);
      expect(await simulatorRepo.inbox(desk.db)).toEqual([]);
      expect(await submissions.list(desk.db, claim.id)).toEqual([]);
      expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "approved", version: claim.version });
    });

    it("sends to the simulator on a desk addressed as localhost, without DEMO_MODE", async () => {
      const desk = await configuredDesk();
      const claim = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");
      const request = apiRequest("/api/submissions", { json: { items: items([claim]) }, jwt: await team.sign(accessClaims(OFFICER)), site: "http://localhost:8788" });

      const { group } = await sent(await call(onRequestPost, request, desk.env));

      expect(group.results).toMatchObject([{ claimId: claim.id, ok: true }]);
    });
  });

  describe("decisions-g2 #5: a CHAS claim whose window closed after approval", () => {
    it("is refused on the simulator channel before anything reaches the payer", async () => {
      const desk = await configuredDesk(DEMO);
      await chasOn(desk, { channel: "simulator" });
      const claim = await approvedClaim(desk, "D01", "CHAS");
      vi.setSystemTime(PAST_WINDOW);

      const res = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });

      const body = (await res.json()) as SubmitResponse;
      expect(body.groups).toEqual([]);
      expect(body.refused).toMatchObject([{ id: claim.id, status: 409, error: { detail: "This claim's CHAS submission window has closed, so it cannot be sent." } }]);
      expect(await simulatorRepo.inbox(desk.db)).toEqual([]);
      expect(await submissions.list(desk.db, claim.id)).toEqual([]);
      const after = (await claims.detail(desk.db, claim.id))!;
      expect(after.status).not.toBe("submitted");
      expect(after.findings.map((f) => f.code)).toContain("past_submission_window");
    });

    it("is refused on the api channel without calling the payer", async () => {
      const desk = await configuredDesk({ PAYER_CHAS_API_TOKEN: CHAS_TOKEN });
      await chasOn(desk, { channel: "api", apiUrl: CHAS_URL });
      const claim = await approvedClaim(desk, "D01", "CHAS");
      const fetchStub = stubNetwork({ [CHAS_URL]: jsonAnswer({ reference: "CHAS-REF-1" }) });
      vi.setSystemTime(PAST_WINDOW);

      const res = await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) });

      const body = (await res.json()) as SubmitResponse;
      expect(body.groups).toEqual([]);
      expect(body.refused).toMatchObject([{ id: claim.id, status: 409, error: { detail: "This claim's CHAS submission window has closed, so it cannot be sent." } }]);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await submissions.list(desk.db, claim.id)).toEqual([]);
    });
  });

  describe("the payer took the claim, but the desk could not record its answer", () => {
    /** Unapproves the claim on the desk while the payer is answering, so `act` finds it stale. */
    const unapprove = async (desk: Desk, claim: ClaimState) => {
      const moved = await act(desk.deps, claim.id, { kind: "unapprove" }, claim.version, REVIEWER_ACTOR);
      if (!moved.ok) throw new Error(`unapprove failed: ${moved.error.code}`);
    };

    it("on the api channel, keeps the attempt with the payer's reference and audits the send", async () => {
      const desk = await configuredDesk({ PAYER_MERIDIAN_API_TOKEN: TOKEN });
      const claim = await approvedClaim(desk, "D04b", "MERIDIAN");
      stubNetwork({
        [MERIDIAN_URL]: async (req) => {
          await unapprove(desk, claim);
          return jsonAnswer({ reference: "MDP-REF-0002" })(req);
        },
      });

      const { group } = await sent(await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) }));

      expect(group.results).toEqual([{ claimId: claim.id, ok: false, error: "stale", portalReference: "MDP-REF-0002" }]);
      expect(await submissions.list(desk.db, claim.id)).toMatchObject([
        { channel: "api", result: "failed", portalReference: "MDP-REF-0002", error: "not_recorded" },
      ]);
      const detail = await claimDetail(desk.deps, claim.id, OFFICER_ACTOR);
      expect(detail!.audit.filter((e) => e.action === "sent_not_recorded")).toMatchObject([
        { actor: OFFICER, detail: { portalReference: "MDP-REF-0002", channel: "api", refusedAs: "stale" } },
      ]);
      expect((await claims.detail(desk.db, claim.id))!.status).not.toBe("submitted");
    });

    it("on the simulator channel, also takes the claim back out of the simulator's inbox", async () => {
      const desk = await configuredDesk(DEMO);
      const claim = await approvedClaim(desk, "D06", "MEDISAVE_FLEXI");
      const send = simulatorChannel.send.bind(simulatorChannel);
      vi.spyOn(simulatorChannel, "send").mockImplementation(async (outgoing, ctx) => {
        const answer = await send(outgoing, ctx);
        await unapprove(desk, claim);
        return answer;
      });

      const { group } = await sent(await post(desk, onRequestPost, "/api/submissions", { items: items([claim]) }));

      const [result] = group.results;
      expect(result).toMatchObject({ claimId: claim.id, ok: false, error: "stale", portalReference: expect.stringMatching(/^SIM-/) });
      const reference = (result as { portalReference: string }).portalReference;
      expect(await simulatorRepo.inbox(desk.db)).toEqual([]);
      expect(await submissions.list(desk.db, claim.id)).toMatchObject([
        { channel: "simulator", result: "failed", portalReference: reference, error: "not_recorded" },
      ]);
      const detail = await claimDetail(desk.deps, claim.id, OFFICER_ACTOR);
      expect(detail!.audit.filter((e) => e.action === "sent_not_recorded")).toMatchObject([
        { detail: { portalReference: reference, channel: "simulator" } },
      ]);
    });
  });
});
