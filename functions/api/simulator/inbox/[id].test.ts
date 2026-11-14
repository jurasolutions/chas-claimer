import * as claims from "../../../../server/repo/claims";
import { act, claimDetail } from "../../../../server/services/claims";
import { importVisits } from "../../../../server/services/imports";
import type { SimulatorInbox, SimulatorItem } from "../../../../src/api/submissions";
import type { ClaimState } from "../../../../src/domain/claims/state";
import type { Actor } from "../../../../src/domain/types";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER } from "../../../../tests/helpers/env";
import { caseVisits, configuredDesk, type Desk, NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestPost as submit } from "../../submissions/index";
import { onRequestPost as decide } from "./[id]";
import { onRequestGet as inbox } from "./index";

const team = await accessTeam();
const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer", "officer"] };

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

const jwt = async () => team.sign(accessClaims(OFFICER));

/** D10's MediSave TOSP claim (a wisdom tooth surgery), approved and sent to the simulator. */
async function simulated(desk: Desk): Promise<{ claim: ClaimState; item: SimulatorItem }> {
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D10") }, OFFICER_ACTOR);
  const ready = (await claims.forVisit(desk.db, "SC-D10")).find((c) => c.payerId === "MEDISAVE_TOSP")!;
  const approved = await act(desk.deps, ready.id, { kind: "approve" }, ready.version, REVIEWER_ACTOR);
  if (!approved.ok) throw new Error(approved.error.code);
  const sent = await call(submit, apiRequest("/api/submissions", { json: { items: [{ id: ready.id, version: approved.value.version }] }, jwt: await jwt() }), desk.env);
  expect(sent.status).toBe(200);
  const listed = await readInbox(desk);
  return { claim: (await claims.detail(desk.db, ready.id))!, item: listed.items.find((i) => i.claimId === ready.id)! };
}

/** The simulator is on: a demo deployment. */
const demoDesk = () => configuredDesk({ DEMO_MODE: "yes" });

async function readInbox(desk: Desk): Promise<SimulatorInbox> {
  const res = await call(inbox, apiRequest("/api/simulator/inbox", { jwt: await jwt() }), desk.env);
  expect(res.status).toBe(200);
  return (await res.json()) as SimulatorInbox;
}

async function decideOn(desk: Desk, id: string, json: unknown) {
  return call(decide, apiRequest(`/api/simulator/inbox/${id}`, { json, jwt: await jwt() }), desk.env, { id });
}

async function trail(desk: Desk, claimId: string) {
  return (await claimDetail(desk.deps, claimId, OFFICER_ACTOR))!.audit;
}

describe("the payer simulator, off on a deployed desk", () => {
  it("answers 404 to the inbox and to a decision unless DEMO_MODE=yes", async () => {
    const desk = await configuredDesk();

    expect((await call(inbox, apiRequest("/api/simulator/inbox", { jwt: await jwt() }), desk.env)).status).toBe(404);
    expect((await decideOn(desk, "any-item", { decision: "pay" })).status).toBe(404);
  });

  it("is on for a desk addressed as localhost, without DEMO_MODE", async () => {
    const desk = await configuredDesk();
    const res = await call(inbox, apiRequest("/api/simulator/inbox", { jwt: await jwt(), site: "http://127.0.0.1:8788" }), desk.env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as SimulatorInbox).items).toEqual([]);
  });
});

describe("the payer simulator", () => {
  it("lists what it received: the claim, its reference and its masked packet", async () => {
    const desk = await demoDesk();
    const { claim, item } = await simulated(desk);

    expect(item).toMatchObject({
      claimId: claim.id,
      payerId: "MEDISAVE_TOSP",
      simReference: claim.portalReference,
      state: "received",
      claimedCents: claim.claimedCents,
      claimStatus: "submitted",
    });
    expect(item.fields.length).toBeGreaterThan(0);
    expect(JSON.stringify(item)).not.toMatch(/S\d{7}[A-Z]/);
  });

  it("AC-4.7: accepting at $550.00 with a reason makes the claim accepted, with the simulator as actor", async () => {
    const desk = await demoDesk();
    const { claim, item } = await simulated(desk);
    expect(claim.claimedCents).toBeGreaterThan(55_000);

    const res = await decideOn(desk, item.id, { decision: "accept", amount: 55_000, reason: "Annual limit reached." });

    expect(res.status).toBe(200);
    expect(((await res.json()) as SimulatorItem).state).toBe("accepted");
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "accepted", acceptedCents: 55_000 });
    expect((await trail(desk, claim.id)).find((e) => e.action === "accept")).toMatchObject({ actor: "system:simulator" });
  });

  it("AC-4.7: rejecting needs a reason, and then the claim is rejected with it", async () => {
    const desk = await demoDesk();
    const { claim, item } = await simulated(desk);

    expect((await decideOn(desk, item.id, { decision: "reject" })).status).toBe(400);
    expect((await decideOn(desk, item.id, { decision: "reject", reason: "  " })).status).toBe(400);
    const res = await decideOn(desk, item.id, { decision: "reject", reason: "Member not found." });

    expect(res.status).toBe(200);
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "rejected", rejectionReason: "Member not found." });
    expect((await trail(desk, claim.id)).find((e) => e.action === "reject")).toMatchObject({ actor: "system:simulator" });
    expect((await readInbox(desk)).items[0]).toMatchObject({ state: "rejected", reason: "Member not found." });
  });

  it("AC-4.7: paying a received claim pays what was claimed; paying an accepted one pays what was accepted", async () => {
    const desk = await demoDesk();
    const { claim, item } = await simulated(desk);

    const res = await decideOn(desk, item.id, { decision: "pay" });

    expect(res.status).toBe(200);
    expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "paid", paidCents: claim.claimedCents });
    expect((await trail(desk, claim.id)).find((e) => e.action === "record_payment")).toMatchObject({
      actor: "system:simulator",
      detail: { cents: claim.claimedCents, paidOn: "2026-11-13" },
    });
    expect((await readInbox(desk)).items[0]).toMatchObject({ state: "paid", paidCents: claim.claimedCents });

    const other = await demoDesk();
    const second = await simulated(other);
    await decideOn(other, second.item.id, { decision: "accept", amount: 55_000, reason: "Annual limit reached." });
    await decideOn(other, second.item.id, { decision: "pay" });
    expect((await claims.detail(other.db, second.claim.id))!).toMatchObject({ status: "paid", paidCents: 55_000 });
  });

  it("refuses a decision the simulated payer has already made, and an unknown item", async () => {
    const desk = await demoDesk();
    const { item } = await simulated(desk);
    await decideOn(desk, item.id, { decision: "reject", reason: "Member not found." });

    const again = await decideOn(desk, item.id, { decision: "accept" });
    expect(again.status).toBe(409);
    expect((await decideOn(desk, "no-such-item", { decision: "accept" })).status).toBe(404);
  });
});
