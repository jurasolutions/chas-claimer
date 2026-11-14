import * as audit from "../../../server/repo/audit";
import * as claims from "../../../server/repo/claims";
import { act } from "../../../server/services/claims";
import { importVisits } from "../../../server/services/imports";
import type { Actor } from "../../../src/domain/types";
import { accessClaims, accessTeam } from "../../../tests/helpers/access";
import { apiError, deskRows, modelJson, modelText, stubModel } from "../../../tests/helpers/ai";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR, visitByKey } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import type { Env } from "../../../server/env";
import { onRequestPost } from "./rejection-explainer";

const team = await accessTeam();
const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["officer", "reviewer"] };
const REASON = "Tooth 14 is a pre-molar, not a molar";
const EXPLAINED = { explanation: "RCT-M is for molars; tooth 14 is a pre-molar.", fix: "Claim the root canal under the pre-molar code instead." };

/** D27's CHAS claim, approved and then refused by the portal with the reason the UAT gives. */
async function d27(overrides: Partial<Env> = { ANTHROPIC_API_KEY: "test-key-not-real" }, reason = REASON) {
  const desk = await configuredDesk(overrides);
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D27") }, OFFICER_ACTOR);
  const drafted = (await claims.forVisit(desk.db, "SC-D27")).find((c) => c.scheme === "chas")!;
  const approved = await act(desk.deps, drafted.id, { kind: "approve" }, drafted.version, REVIEWER_ACTOR);
  if (!approved.ok) throw new Error("approval failed");
  const rejected = await act(desk.deps, drafted.id, { kind: "portal_refused", message: reason }, approved.value.version, OFFICER_ACTOR);
  if (!rejected.ok) throw new Error("refusal failed");
  const post = async (json: unknown, who = OFFICER) =>
    call(onRequestPost, apiRequest("/api/ai/rejection-explainer", { json, jwt: await team.sign(accessClaims(who)) }), desk.env, {});
  return { desk, claim: rejected.value, post };
}

/** Every row but the audit trail, which the explainer adds one `revealed` event to. */
async function rowsButAudit(db: D1Database) {
  const { audit_events: _audit, ...rest } = await deskRows(db);
  return rest;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/ai/rejection-explainer (AC-6.4)", () => {
  it("explains D27's rejection as a suggestion and leaves the claim as it was", async () => {
    const { desk, claim, post } = await d27();
    const model = stubModel(team, modelJson(EXPLAINED));
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: EXPLAINED });
    expect(model.calls()).toBe(1);
    expect(model.sent[0]).toContain(REASON);
    expect(model.sent[0]).toContain("RCT-M");
    expect(model.sent[0]).toContain("$800.00");
    expect(await rowsButAudit(desk.db)).toEqual(before);
    expect(await claims.detail(desk.db, claim.id)).toMatchObject({ status: "rejected", version: claim.version, rejectionReason: REASON });
  });

  it("records that it opened the patient's identity to scrub the reason, naming the purpose and no value", async () => {
    const { desk, claim, post } = await d27();
    stubModel(team, modelJson(EXPLAINED));

    await post({ claimId: claim.id }, REVIEWER);

    const last = (await audit.list(desk.db, { type: "claim", id: claim.id })).at(-1);
    expect(last).toMatchObject({ action: "revealed", actor: REVIEWER, detail: { field: "identity", purpose: "ai_rejection_explainer" } });
  });

  it("sends nothing that identifies the patient, even when the payer's reason names them", async () => {
    const patient = visitByKey("SC-D27").patient;
    const { claim, post } = await d27(undefined, `Member ${patient.name} (${patient.nric}) not eligible; call ${patient.phone}`);
    const model = stubModel(team, modelJson(EXPLAINED));

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(200);
    for (const value of [patient.name, patient.nric, patient.phone]) expect(model.sent[0]).not.toContain(value);
    expect(model.sent[0]).toContain("not eligible");
  });

  it("answers 409 for a claim that has not been rejected, without calling the model", async () => {
    const { desk, post } = await d27();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
    const open = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
    const model = stubModel(team, modelJson(EXPLAINED));

    const res = await post({ claimId: open.id });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_allowed" });
    expect(model.calls()).toBe(0);
  });

  it("answers 404 for a claim that is not there", async () => {
    const { post } = await d27();
    const model = stubModel(team, modelJson(EXPLAINED));

    expect((await post({ claimId: "no-such-claim" })).status).toBe(404);
    expect(model.calls()).toBe(0);
  });

  it.each([
    ["markup in place of an answer", modelText("<img src=x onerror=alert(1)>")],
    ["an explanation with no fix", modelJson({ explanation: "It is a pre-molar." })],
    ["a refusal", modelText("I can't help with that.", "refusal")],
  ])("answers ai_unusable for %s, with the claim unchanged", async (_name, answer) => {
    const { desk, claim, post } = await d27();
    stubModel(team, answer);
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unusable" });
    expect(await rowsButAudit(desk.db)).toEqual(before);
  });

  it("answers ai_busy when the service is rate-limiting, with the claim unchanged", async () => {
    const { desk, claim, post } = await d27();
    stubModel(team, apiError(429, "rate_limit_error"));
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_busy" });
    expect(await rowsButAudit(desk.db)).toEqual(before);
  });

  it("answers ai_not_configured without a key, opening nothing and calling nothing (AC-6.1)", async () => {
    const { desk, claim, post } = await d27({});
    const model = stubModel(team, modelJson(EXPLAINED));
    const before = await deskRows(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_not_configured" });
    expect(model.calls()).toBe(0);
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it("answers 500 and calls nothing when the identity cannot be recorded as opened", async () => {
    const { desk, claim, post } = await d27();
    const model = stubModel(team, modelJson(EXPLAINED));
    await desk.db.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(500);
    expect(model.calls()).toBe(0);
  });

  it("refuses a stranger", async () => {
    const { claim, post } = await d27();
    const model = stubModel(team, modelJson(EXPLAINED));

    expect((await post({ claimId: claim.id }, STRANGER)).status).toBe(403);
    expect(model.calls()).toBe(0);
  });
});
