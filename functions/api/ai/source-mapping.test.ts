import { openSqlite } from "../../../connector/sources/sqlite";
import { shippedMapping } from "../../../connector/test-support";
import { writeSqlite } from "../../../mock/synthetic-clinic/write-sqlite";
import type { Env } from "../../../server/env";
import type { SourceSchema } from "../../../src/domain/source-mapping";
import { accessClaims, accessTeam } from "../../../tests/helpers/access";
import { apiError, deskRows, modelJson, modelText, stubModel } from "../../../tests/helpers/ai";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { CLINIC, configuredDesk, NOW } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestPost } from "./source-mapping";

const team = await accessTeam();
const KEY: Partial<Env> = { ANTHROPIC_API_KEY: "test-key-not-real" };
const NOTES = "Amounts look like whole cents. The note column is doctor_note.";

/** The synthetic clinic's SQLite file, described the way the connector describes it: names only. */
const source = await openSqlite(await writeSqlite(CLINIC));
const SCHEMA: SourceSchema = await source.describe();
source.close();

async function desk(overrides: Partial<Env> = KEY) {
  const d = await configuredDesk(overrides);
  const post = async (json: unknown, who = REVIEWER) =>
    call(onRequestPost, apiRequest("/api/ai/source-mapping", { json, jwt: await team.sign(accessClaims(who)) }), d.env, {});
  return { desk: d, post };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/ai/source-mapping (AC-6.5)", () => {
  it("proposes a mapping for the clinic's tables and saves nothing", async () => {
    const { desk: d, post } = await desk();
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));
    const before = await deskRows(d.db);

    const res = await post({ schema: SCHEMA });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: { mapping: shippedMapping(), notes: NOTES } });
    expect(await deskRows(d.db)).toEqual(before);
  });

  it("leaves out an optional field the model answers null for", async () => {
    const { post } = await desk();
    const shipped = shippedMapping();
    const answer = { ...shipped, visits: { ...shipped.visits, fields: { ...shipped.visits.fields, startTime: null } }, preAuths: null };
    stubModel(team, modelJson({ mapping: answer, notes: NOTES }));

    const res = await post({ schema: SCHEMA });

    expect(res.status).toBe(200);
    const { startTime: _dropped, ...fields } = shipped.visits.fields;
    const { preAuths: _none, ...rest } = shipped;
    expect(await res.json()).toEqual({ suggestion: { mapping: { ...rest, visits: { ...shipped.visits, fields } }, notes: NOTES } });
  });

  it("sends the table and column names and not one row value (SC6.3)", async () => {
    const { post } = await desk();
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));

    await post({ schema: SCHEMA });

    expect(model.calls()).toBe(1);
    for (const table of SCHEMA.tables) {
      expect(model.sent[0]).toContain(table.name);
      for (const column of table.columns) expect(model.sent[0]).toContain(column);
    }
    for (const visit of CLINIC.visits.slice(0, 20)) {
      for (const value of [visit.patient.name, visit.patient.nric, visit.patient.phone]) expect(model.sent[0]).not.toContain(value);
      if (visit.notes) expect(model.sent[0]).not.toContain(visit.notes);
    }
  });

  it("scrubs an identifier out of a column name before anything is sent", async () => {
    const { post } = await desk();
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));
    const { nric, phone } = CLINIC.visits[0]!.patient;
    const schema: SourceSchema = { kind: "sqlite", tables: [{ name: "patients", columns: ["patient_id", nric, `call ${phone}`] }] };

    await post({ schema });

    expect(model.calls()).toBe(1);
    expect(model.sent[0]).toContain("patient_id");
    for (const value of [nric, phone]) expect(model.sent[0]).not.toContain(value);
  });

  it.each([
    ["markup in place of an answer", modelText("<b>mapping</b>")],
    ["a mapping missing a required field", modelJson({ mapping: { ...shippedMapping(), patients: null }, notes: NOTES })],
    [
      "a mapping naming a column the clinic does not have",
      modelJson({
        mapping: { ...shippedMapping(), patients: { ...shippedMapping().patients, fields: { ...shippedMapping().patients.fields, nric: "ic_number" } } },
        notes: NOTES,
      }),
    ],
    ["a mapping naming a table the clinic does not have", modelJson({ mapping: { ...shippedMapping(), chasCards: { ...shippedMapping().chasCards!, table: "cards" } }, notes: NOTES })],
  ])("answers ai_unusable for %s, saving nothing", async (_name, answer) => {
    const { desk: d, post } = await desk();
    stubModel(team, answer);
    const before = await deskRows(d.db);

    const res = await post({ schema: SCHEMA });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "ai_unusable" });
    expect(await deskRows(d.db)).toEqual(before);
  });

  it("answers ai_busy when the service is rate-limiting (SC6.7)", async () => {
    const { post } = await desk();
    stubModel(team, apiError(429, "rate_limit_error"));

    const res = await post({ schema: SCHEMA });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_busy" });
  });

  it("answers ai_not_configured without a key, calling nothing (AC-6.1)", async () => {
    const { post } = await desk({});
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));

    const res = await post({ schema: SCHEMA });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ai_not_configured" });
    expect(model.calls()).toBe(0);
  });

  it("answers 400 for a body that is not a schema description", async () => {
    const { post } = await desk();
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));

    expect((await post({ schema: { kind: "sqlite", tables: [{ name: "patients", columns: ["a"], rows: [["T9000018H"]] }] } })).status).toBe(400);
    expect(model.calls()).toBe(0);
  });

  it.each([
    ["an officer", OFFICER],
    ["a stranger", STRANGER],
  ])("refuses %s: only a reviewer changes the source mapping", async (_name, who) => {
    const { post } = await desk();
    const model = stubModel(team, modelJson({ mapping: shippedMapping(), notes: NOTES }));

    expect((await post({ schema: SCHEMA }, who)).status).toBe(403);
    expect(model.calls()).toBe(0);
  });
});
