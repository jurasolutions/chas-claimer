import fc from "fast-check";
import * as audit from "../../../server/repo/audit";
import * as claims from "../../../server/repo/claims";
import { importVisits } from "../../../server/services/imports";
import type { Env } from "../../../server/env";
import type { SourceVisit } from "../../../src/domain/source-visit";
import { accessClaims, accessTeam } from "../../../tests/helpers/access";
import { apiError, deskRows, modelJson, modelText, stubModel } from "../../../tests/helpers/ai";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR, visitByKey } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestPost } from "./justification";

const team = await accessTeam();
const KEY: Partial<Env> = { ANTHROPIC_API_KEY: "test-key-not-real" };
const DRAFT = "The patient asked for a longer consultation, which took more chair time than a standard visit.";

/** A desk holding `visits`, and a poster for the CHAS claim on `visitKey`. */
async function deskWith(visits: SourceVisit[], visitKey: string, overrides: Partial<Env> = KEY) {
  const desk = await configuredDesk(overrides);
  await importVisits(desk.deps, { source: "synthetic", visits }, OFFICER_ACTOR);
  const claim = (await claims.forVisit(desk.db, visitKey)).find((c) => c.scheme === "chas")!;
  const post = async (json: unknown, who = OFFICER) =>
    call(onRequestPost, apiRequest("/api/ai/justification", { json, jwt: await team.sign(accessClaims(who)) }), desk.env, {});
  return { desk, claim, post };
}

/** The patient's date of birth as a clinic might write it in a note, never in the ISO form. */
function writtenDob(iso: string): string[] {
  const [y, m, d] = iso.split("-");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1];
  return [`${d}/${m}/${y}`, `${Number(d)}.${Number(m)}.${y}`, `${Number(d)} ${month} ${y}`, `${d}-${month}-${y}`];
}

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

describe("POST /api/ai/justification (AC-6.2)", () => {
  it("drafts D18's justification from the dentist's note, with the patient's name and phone left out", async () => {
    const patient = visitByKey("SC-D18").patient;
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    const model = stubModel(team, modelJson({ draft: DRAFT }));
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draft: DRAFT });
    expect(model.calls()).toBe(1);
    for (const value of [patient.name, patient.phone]) expect(model.sent[0]).not.toContain(value);
    expect(model.sent[0]).toContain("asked for a longer consultation");
    expect(model.sent[0]).toContain("CON");
    expect(model.sent[0]).toContain("Above the fee benchmark");
    expect(await rowsButAudit(desk.db)).toEqual(before);
  });

  it("leaves D18b's name, NRIC, phone and date of birth out of the request", async () => {
    const base = visitByKey("SC-D18b");
    const patient = base.patient;
    const dobs = writtenDob(patient.dateOfBirth);
    const notes = `${base.notes} Born ${dobs[0]}, also written ${dobs.slice(1).join(" and ")}.`;
    const { claim, post } = await deskWith([{ ...base, notes }], "SC-D18b");
    const model = stubModel(team, modelJson({ draft: DRAFT }));

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(200);
    for (const value of [patient.name, patient.nric, patient.phone, ...dobs]) expect(model.sent[0]).not.toContain(value);
    expect(model.sent[0]).toContain("extended consultation at the patient's request");
  });

  it("sends none of the patient's identifiers however the note spells them (SC6.2)", async () => {
    const base = visitByKey("SC-D18b");
    const { name, nric, phone, dateOfBirth } = base.patient;
    const dobs = writtenDob(dateOfBirth);
    const spellings = (value: string) => fc.constantFrom(value, value.toUpperCase(), value.toLowerCase(), value.split("").join(" "));
    const fragment = fc.oneof(
      fc.constantFrom("extended consultation", "patient asked for more time", "tooth 36 sensitive", ";", ",", "\n"),
      fc.constantFrom(name, nric, phone, ...dobs).chain(spellings),
    );
    const note = fc.array(fragment, { minLength: 1, maxLength: 10 }).map((parts) => parts.join(" "));

    await fc.assert(
      fc.asyncProperty(note, async (notes) => {
        const { claim, post } = await deskWith([{ ...base, notes }], "SC-D18b");
        const model = stubModel(team, modelJson({ draft: DRAFT }));
        const res = await post({ claimId: claim.id });
        const sent = (model.sent[0] ?? "").toLowerCase().replace(/\s/g, "");
        const leaked = [name, nric, phone, ...dobs].filter((v) => sent.includes(v.toLowerCase().replace(/\s/g, "")));
        return (res.status === 200 || res.status === 422) && leaked.length === 0;
      }),
      { numRuns: 100 },
    );
  });

  it("records that it opened the dentist's notes, naming the purpose and no value", async () => {
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    stubModel(team, modelJson({ draft: DRAFT }));

    await post({ claimId: claim.id }, REVIEWER);

    const last = (await audit.list(desk.db, { type: "claim", id: claim.id })).at(-1);
    expect(last).toMatchObject({ action: "revealed", actor: REVIEWER, detail: { field: "notes", purpose: "ai_justification" } });
  });

  it("answers 404 for a claim that is not there, without calling the model", async () => {
    const { post } = await deskWith(caseVisits("D18"), "SC-D18");
    const model = stubModel(team, modelJson({ draft: DRAFT }));

    expect((await post({ claimId: "no-such-claim" })).status).toBe(404);
    expect(model.calls()).toBe(0);
  });

  it.each([
    ["markup in place of an answer", modelText("<script>alert(1)</script>")],
    ["an empty draft", modelJson({ draft: "  " })],
    ["a draft too long for the justification field", modelJson({ draft: "x".repeat(5000) })],
    ["an answer cut off at the token limit", modelText(JSON.stringify({ draft: DRAFT }), "max_tokens")],
  ])("answers ai_unusable for %s, with the claim unchanged", async (_name, answer) => {
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    stubModel(team, answer);
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unusable" });
    expect(await rowsButAudit(desk.db)).toEqual(before);
  });

  it("answers ai_unavailable when the service fails, with the claim unchanged (SC6.7)", async () => {
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    stubModel(team, apiError(500, "api_error"));
    const before = await rowsButAudit(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unavailable" });
    expect(await rowsButAudit(desk.db)).toEqual(before);
  });

  it("answers ai_not_configured without a key, opening nothing and calling nothing (AC-6.1)", async () => {
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18", {});
    const model = stubModel(team, modelJson({ draft: DRAFT }));
    const before = await deskRows(desk.db);

    const res = await post({ claimId: claim.id });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_not_configured" });
    expect(model.calls()).toBe(0);
    expect(await deskRows(desk.db)).toEqual(before);
  });

  it("answers 500 and calls nothing when the notes cannot be recorded as opened", async () => {
    const { desk, claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    const model = stubModel(team, modelJson({ draft: DRAFT }));
    await desk.db.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();

    expect((await post({ claimId: claim.id })).status).toBe(500);
    expect(model.calls()).toBe(0);
  });

  it("refuses a stranger", async () => {
    const { claim, post } = await deskWith(caseVisits("D18"), "SC-D18");
    const model = stubModel(team, modelJson({ draft: DRAFT }));

    expect((await post({ claimId: claim.id }, STRANGER)).status).toBe(403);
    expect(model.calls()).toBe(0);
  });
});
