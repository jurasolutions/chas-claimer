// @vitest-environment node
/**
 * The whole desk, end to end (ticket 10). The synthetic clinic is written to a SQLite file, the
 * connector reads it through the shipped mapping and posts it to the real `/api/imports` handler, and
 * from there every step goes through the desk's own routes: an officer fixes a claim, a reviewer
 * approves, the batch goes to the payer simulator, the simulator decides, and R1 pays what it matches.
 *
 * The run happens twice: once with an Anthropic key set (the model stubbed) and once without (SC8.3,
 * exit criterion 7). Nothing reaches the network: `stubNetwork` serves the Access certs, routes the
 * connector to the import handler, and answers for the model; any other URL throws.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../connector/cli";
import { SHIPPED_MAPPING_PATH } from "../../connector/test-support";
import { onRequestPost as explainRejection } from "../../functions/api/ai/rejection-explainer";
import { onRequestPost as draftJustification } from "../../functions/api/ai/justification";
import { onRequestPost as claimAction } from "../../functions/api/claims/[id]/actions";
import { onRequestPut as saveAnnotations } from "../../functions/api/claims/[id]/annotations";
import { onRequestGet as claimDetail } from "../../functions/api/claims/[id]/index";
import { onRequestPost as reveal } from "../../functions/api/claims/[id]/reveal";
import { onRequestPost as importVisits } from "../../functions/api/imports/index";
import { onRequestPost as importRemittance } from "../../functions/api/remittances/index";
import { onRequestGet as readSettings, onRequestPut as saveSettings } from "../../functions/api/settings";
import { onRequestPost as continueRebuild } from "../../functions/api/settings/rebuild";
import { onRequestPost as decide } from "../../functions/api/simulator/inbox/[id]";
import { onRequestGet as simulatorInbox } from "../../functions/api/simulator/inbox/index";
import { onRequestPost as submit } from "../../functions/api/submissions/index";
import { writeSqlite } from "../../mock/synthetic-clinic/write-sqlite";
import * as audit from "../../server/repo/audit";
import * as claims from "../../server/repo/claims";
import type { ClaimDetail } from "../../src/api/claim-detail";
import type { RebuildProgress, SettingsSaveResponse } from "../../src/api/settings";
import type { SimulatorInbox, SimulatorItem, SubmitResponse } from "../../src/api/submissions";
import type { ClaimState } from "../../src/domain/claims/state";
import { accessClaims, accessTeam } from "../helpers/access";
import { MESSAGES, modelJson } from "../helpers/ai";
import { OFFICER, REVIEWER, TEST_CONNECTOR_TOKEN, TEST_TEAM_DOMAIN } from "../helpers/env";
import { CLINIC, configuredDesk, type Desk, NOW } from "../helpers/fixtures";
import { apiRequest, call, SITE } from "../helpers/http";
import { jsonAnswer, stubNetwork } from "../helpers/network";

/** The synthetic clinic's payers. MERIDIAN and HARBOUR are fictional insurers (decisions-g2 §11). */
const SYNTHETIC_PAYER_IDS = ["CHAS", "MEDISAVE_FLEXI", "MEDISAVE_TOSP", "MERIDIAN", "HARBOUR"];

const team = await accessTeam();
const as = (who: string) => team.sign(accessClaims(who));

const CERTS = `https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`;
const IMPORTS = `${SITE}/api/imports`;
const MAPPING = fileURLToPath(SHIPPED_MAPPING_PATH);
const CONNECTOR_ENV = { CLAIMS_DESK_URL: SITE, CONNECTOR_TOKEN: TEST_CONNECTOR_TOKEN, CF_ACCESS_CLIENT_ID: "test.access", CF_ACCESS_CLIENT_SECRET: "test-access-secret" };
const KEY = "test-key-not-real";

const DRAFT = "The patient asked for a longer consultation, which took more chair time than a standard visit.";
const EXPLAINED = { explanation: "RCT-M is for molars; tooth 14 is a pre-molar.", fix: "Claim the root canal under the pre-molar code instead." };
const JUSTIFICATION = "Extended consultation for a complex medical history.";
const PORTAL_MESSAGE = "Tooth 14 is a pre-molar, not a molar";
const SCALING_OVERRIDE = { procedureCode: "SCALING", minCents: 4000, maxCents: 9000, sourceUrl: "https://example.test/scaling-benchmark", asOf: "2026-10-01" };

const dirs: string[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Answers the model the way each AI route expects: the explainer's schema asks for a fix. */
async function model(request: Request): Promise<Response> {
  const body = await request.clone().text();
  return (body.includes('"fix"') ? modelJson(EXPLAINED) : modelJson({ draft: DRAFT }))(request);
}

/**
 * A desk filled the way a clinic fills it: the synthetic clinic written to SQLite, read by the
 * connector through the shipped mapping, and posted to the import handler.
 */
async function clinicDesk(key: boolean) {
  const desk = await configuredDesk({ DEMO_MODE: "yes", ...(key ? { ANTHROPIC_API_KEY: KEY } : {}) });
  const dir = mkdtempSync(join(tmpdir(), "chas-e2e-"));
  dirs.push(dir);
  const source = join(dir, "clinic.sqlite");
  writeFileSync(source, await writeSqlite(CLINIC));
  const network = stubNetwork({
    [CERTS]: jsonAnswer({ keys: team.jwks.keys }),
    [IMPORTS]: (request) => call(importVisits, request, desk.env),
    [MESSAGES]: model,
  });
  const printed: string[] = [];
  const code = await run(["push", "--mapping", MAPPING, "--source", source], (line) => void printed.push(line), CONNECTOR_ENV, { wait: async () => {} });
  expect(code, printed.join("\n")).toBe(0);
  const modelCalls = () => network.mock.calls.filter(([input, init]) => new Request(input as RequestInfo, init).url === MESSAGES).length;
  return { desk, modelCalls };
}

const claimFor = async (desk: Desk, visitKey: string, payerId: string): Promise<ClaimState> => {
  const claim = (await claims.forVisit(desk.db, visitKey)).find((c) => c.payerId === payerId);
  if (!claim) throw new Error(`no ${payerId} claim for ${visitKey}`);
  return claim;
};

const route = (desk: Desk) => ({
  detail: async (id: string, who = OFFICER) => call(claimDetail, apiRequest(`/api/claims/${id}`, { jwt: await as(who) }), desk.env, { id }),
  act: async (claim: ClaimState, action: unknown, who = REVIEWER) =>
    call(claimAction, apiRequest(`/api/claims/${claim.id}/actions`, { json: { action, expectedVersion: claim.version }, jwt: await as(who) }), desk.env, { id: claim.id }),
  annotate: async (claim: ClaimState, annotations: unknown, who = OFFICER) =>
    call(
      saveAnnotations,
      apiRequest(`/api/claims/${claim.id}/annotations`, { method: "PUT", json: { annotations, expectedVersion: claim.version }, jwt: await as(who) }),
      desk.env,
      { id: claim.id },
    ),
  reveal: async (claim: ClaimState, field: string, who = REVIEWER) =>
    call(reveal, apiRequest(`/api/claims/${claim.id}/reveal`, { json: { field }, jwt: await as(who) }), desk.env, { id: claim.id }),
  submit: async (items: ClaimState[], who = OFFICER) =>
    call(submit, apiRequest("/api/submissions", { json: { items: items.map((c) => ({ id: c.id, version: c.version })) }, jwt: await as(who) }), desk.env),
  inbox: async () => (await (await call(simulatorInbox, apiRequest("/api/simulator/inbox", { jwt: await as(OFFICER) }), desk.env)).json()) as SimulatorInbox,
  decide: async (item: SimulatorItem, json: unknown) =>
    call(decide, apiRequest(`/api/simulator/inbox/${item.id}`, { json, jwt: await as(OFFICER) }), desk.env, { id: item.id }),
  justification: async (claim: ClaimState) => call(draftJustification, apiRequest("/api/ai/justification", { json: { claimId: claim.id }, jwt: await as(OFFICER) }), desk.env),
  explain: async (claim: ClaimState) =>
    call(explainRejection, apiRequest("/api/ai/rejection-explainer", { json: { claimId: claim.id }, jwt: await as(OFFICER) }), desk.env),
  remittance: async (json: unknown) => call(importRemittance, apiRequest("/api/remittances", { json, jwt: await as(OFFICER) }), desk.env),
  settings: async () => (await (await call(readSettings, apiRequest("/api/settings", { jwt: await as(REVIEWER) }), desk.env)).json()) as { version: number },
  saveSettings: async (json: unknown, who = REVIEWER) => call(saveSettings, apiRequest("/api/settings", { method: "PUT", json, jwt: await as(who) }), desk.env),
  rebuild: async (next: unknown) => call(continueRebuild, apiRequest("/api/settings/rebuild", { json: next, jwt: await as(REVIEWER) }), desk.env),
});

interface AuditRow {
  at: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
}

const auditRows = async (desk: Desk) => (await desk.db.prepare("SELECT * FROM audit_events ORDER BY rowid").all<AuditRow>()).results;
const count = async (desk: Desk, sql: string) => (await desk.db.prepare(sql).first<{ n: number }>())!.n;

/** The trail only grows: everything it held before a step is still there, unchanged, after it. */
function trailKeeper(desk: Desk) {
  let seen: AuditRow[] = [];
  return async (step: string) => {
    const now = await auditRows(desk);
    expect(now.length, `${step} added to the trail`).toBeGreaterThan(seen.length);
    expect(now.slice(0, seen.length), `${step} left the earlier trail as it was`).toEqual(seen);
    seen = now;
    return now;
  };
}

describe.each([
  ["with an Anthropic key", true],
  ["with no Anthropic key", false],
])("the whole flow %s (SC8.3)", (_name, key) => {
  it("imports the synthetic clinic through the connector, with claims for every scheme (SC1.14)", async () => {
    const { desk } = await clinicDesk(key);

    const payers = (await desk.db.prepare("SELECT payer_id, COUNT(*) AS n FROM claims GROUP BY payer_id").all<{ payer_id: string; n: number }>()).results;
    expect(Object.fromEntries(payers.map((p) => [p.payer_id, p.n > 0]))).toEqual(Object.fromEntries(SYNTHETIC_PAYER_IDS.map((p) => [p, true])));
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visits")).toBe(CLINIC.visits.length);
  });

  it("fixes, approves, submits, decides and pays, keeping one audit event per thing that happened (SC4.6, SC4.7, SC6.5)", async () => {
    const { desk, modelCalls } = await clinicDesk(key);
    const api = route(desk);
    const kept = trailKeeper(desk);
    const imports = await count(desk, "SELECT COUNT(*) AS n FROM imports");
    expect((await kept("the import")).filter((e) => e.action === "import_completed")).toHaveLength(imports);

    // An officer asks for a draft of D18's justification, then writes and saves one.
    const d18 = await claimFor(desk, "SC-D18", "CHAS");
    expect(d18.status).toBe("needs_attention");
    const drafted = await api.justification(d18);
    if (key) {
      expect(drafted.status).toBe(200);
      expect(await drafted.json()).toEqual({ draft: DRAFT });
      expect((await kept("the justification draft")).at(-1)).toMatchObject({ action: "revealed", actor: OFFICER, entity_id: d18.id });
    } else {
      expect(drafted.status).toBe(503);
      expect(await drafted.json()).toEqual({ error: "ai_not_configured" });
    }
    const annotated = await api.annotate(d18, { justification: JUSTIFICATION });
    expect(annotated.status).toBe(200);
    expect(((await annotated.json()) as ClaimDetail).claim.status).toBe("ready");
    await kept("the justification");

    // Only a reviewer approves.
    const fixed = await claimFor(desk, "SC-D18", "CHAS");
    expect((await api.act(fixed, { kind: "approve" }, OFFICER)).status).toBe(403);
    const keyedIn = [
      ["SC-D18", "CHAS", "MHCP-0018"],
      ["SC-D01", "CHAS", "MHCP-0001"],
      ["SC-D03", "CHAS", "MHCP-0002"],
      ["SC-D02-P04", "CHAS", "MHCP-0024"],
    ] as const;
    const simulated = [
      ["SC-D06", "MEDISAVE_FLEXI"],
      ["SC-D10", "MEDISAVE_TOSP"],
      ["SC-D26", "MEDISAVE_FLEXI"],
    ] as const;
    for (const [visitKey, payerId] of [...keyedIn, ...simulated, ["SC-D27", "CHAS"] as const]) {
      const res = await api.act(await claimFor(desk, visitKey, payerId), { kind: "approve" });
      expect(res.status, `${visitKey} ${payerId} approved`).toBe(200);
      await kept(`approving ${visitKey}`);
    }

    // The portal refuses D27 when the officer keys it in: a failed attempt, and the claim rejected.
    const d27 = await claimFor(desk, "SC-D27", "CHAS");
    expect((await api.act(d27, { kind: "portal_refused", message: PORTAL_MESSAGE }, OFFICER)).status).toBe(200);
    expect(await claimFor(desk, "SC-D27", "CHAS")).toMatchObject({ status: "rejected", rejectionReason: PORTAL_MESSAGE });
    await kept("the portal refusal");
    const explained = await api.explain(await claimFor(desk, "SC-D27", "CHAS"));
    if (key) {
      expect(explained.status).toBe(200);
      expect(await explained.json()).toEqual({ suggestion: EXPLAINED });
      await kept("the rejection explainer");
    } else {
      expect(explained.status).toBe(503);
      expect(await explained.json()).toEqual({ error: "ai_not_configured" });
    }

    // The rest go in one batch: CHAS comes back as a checklist, MediSave goes to the payer simulator.
    const chas = await Promise.all(keyedIn.map(([visitKey, payerId]) => claimFor(desk, visitKey, payerId)));
    const medisave = await Promise.all(simulated.map(([visitKey, payerId]) => claimFor(desk, visitKey, payerId)));
    const sent = await api.submit([...chas, ...medisave]);
    expect(sent.status).toBe(200);
    const batch = (await sent.json()) as SubmitResponse;
    expect(batch.refused).toEqual([]);
    const checklist = batch.groups.flatMap((g) => (g.kind === "checklist" ? g.claimIds : []));
    expect(checklist.sort()).toEqual(chas.map((c) => c.id).sort());
    const results = batch.groups.flatMap((g) => (g.kind === "sent" ? g.results : []));
    expect(results.map((r) => r.claimId).sort()).toEqual(medisave.map((c) => c.id).sort());
    expect(results.every((r) => r.ok)).toBe(true);
    for (const claim of medisave) expect((await claims.detail(desk.db, claim.id))!).toMatchObject({ status: "submitted", portalReference: expect.any(String) });
    await kept("the simulator send");

    // The officer keys each CHAS claim into the portal and records the reference it gives.
    for (const [visitKey, , portalReference] of keyedIn) {
      const res = await api.act(await claimFor(desk, visitKey, "CHAS"), { kind: "submit", portalReference }, OFFICER);
      expect(res.status, `${visitKey} submitted`).toBe(200);
      expect((await claims.detail(desk.db, (await claimFor(desk, visitKey, "CHAS")).id))!).toMatchObject({ status: "submitted", portalReference });
      await kept(`submitting ${visitKey}`);
    }

    // The simulated payers accept D06, reject D10 with a reason, and pay D26.
    const { items } = await api.inbox();
    const itemFor = (claim: ClaimState) => items.find((i) => i.claimId === claim.id)!;
    const [d06, d10, d26] = await Promise.all([claimFor(desk, "SC-D06", "MEDISAVE_FLEXI"), claimFor(desk, "SC-D10", "MEDISAVE_TOSP"), claimFor(desk, "SC-D26", "MEDISAVE_FLEXI")]);
    expect((await api.decide(itemFor(d06), { decision: "accept" })).status).toBe(200);
    expect((await api.decide(itemFor(d10), { decision: "reject", reason: "Member not found." })).status).toBe(200);
    expect((await api.decide(itemFor(d26), { decision: "pay" })).status).toBe(200);
    expect((await claims.detail(desk.db, d06.id))!.status).toBe("accepted");
    expect((await claims.detail(desk.db, d10.id))!).toMatchObject({ status: "rejected", rejectionReason: "Member not found." });
    expect((await claims.detail(desk.db, d26.id))!).toMatchObject({ status: "paid", paidCents: d26.claimedCents });
    await kept("the simulator's decisions");

    // R1, the CHAS statement, pays D01 and D03 by reference and P04's D02 by identifier and date.
    const paid = await api.remittance({ payerId: "CHAS", fileName: "r1-chas.csv", csv: CLINIC.remittances.r1Chas });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ outcome: "imported", lines: 5, matched: 3, forPerson: 2 });
    const d01 = await claimFor(desk, "SC-D01", "CHAS");
    expect((await claims.detail(desk.db, d01.id))!.status).toBe("paid");
    await kept("R1");

    // A reviewer reveals D01's NRIC to call the patient back.
    const revealed = await api.reveal(await claimFor(desk, "SC-D01", "CHAS"), "nric");
    expect(revealed.status).toBe(200);
    expect(((await revealed.json()) as { value: string }).value).toMatch(/^T9\d{6}[A-Z]$/);
    const trail = await kept("the reveal");

    // Every event names who, when and what.
    for (const event of trail) {
      expect(event.actor, event.action).not.toBe("");
      expect(new Date(event.at).toISOString(), event.action).toBe(event.at);
      expect(event.entity_type, event.action).not.toBe("");
      expect(event.entity_id, event.action).not.toBe("");
    }
    const actions = new Set(trail.map((e) => e.action));
    for (const action of ["import_completed", "annotations_saved", "approve", "portal_refused", "submit", "accept", "reject", "record_payment", "remittance_imported", "revealed"]) {
      expect(actions, action).toContain(action);
    }
    // One event per submission attempt, the failed one included.
    const attempts = await count(desk, "SELECT COUNT(*) AS n FROM submissions");
    expect(trail.filter((e) => ["submit", "portal_refused", "submission_failed", "sent_not_recorded", "exported"].includes(e.action))).toHaveLength(attempts);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM submissions WHERE result = 'failed'")).toBe(1);

    expect(modelCalls()).toBe(key ? 2 : 0);
  });
});

/** Posts each continuation of a settings rebuild until it is finished. */
async function finishRebuild(api: ReturnType<typeof route>, first: RebuildProgress): Promise<void> {
  let last = first;
  while (last.next) {
    const res = await api.rebuild(last.next);
    expect(res.status).toBe(200);
    last = (await res.json()) as RebuildProgress;
  }
  expect(last).toMatchObject({ remaining: 0, next: null });
}

const findingCodes = async (desk: Desk, visitKey: string) => (await claims.forVisit(desk.db, visitKey)).flatMap((c) => c.findings.map((f) => f.code));

/** Every MediSave claim on the desk, as stored. */
async function medisaveClaims(desk: Desk): Promise<ClaimState[]> {
  const ids = (await desk.db.prepare("SELECT id FROM claims WHERE payer_id IN ('MEDISAVE_TOSP', 'MEDISAVE_FLEXI') ORDER BY id").all<{ id: string }>()).results;
  return Promise.all(ids.map(async ({ id }) => (await claims.detail(desk.db, id))!));
}

describe("the checks the wave-1 tickets could not make alone, on the imported clinic", () => {
  it("AC-3.7: D04b's claim detail shows each payer's lines, rule set, findings, waterfall and source revision", async () => {
    const { desk } = await clinicDesk(false);
    const api = route(desk);
    // D04b is one $1,200.00 crown plus $108.00 GST, split CHAS $620.00, Flexi-MediSave $400.00 (its yearly cap), Meridian $288.00.
    const chas = await claimFor(desk, "SC-D04b", "CHAS");
    const flexi = await claimFor(desk, "SC-D04b", "MEDISAVE_FLEXI");
    const meridian = await claimFor(desk, "SC-D04b", "MERIDIAN");
    const segments = [
      { payer: "CHAS", label: "CHAS", cents: 62000, claimId: chas.id },
      { payer: "MEDISAVE_FLEXI", label: "Flexi-MediSave", cents: 40000, claimId: flexi.id },
      { payer: "MERIDIAN", label: "Meridian Dental Plan", cents: 28800, claimId: meridian.id },
      { payer: "patient", label: "Patient", cents: 0 },
    ];
    const expected = [
      { claim: chas, schemeCode: "CROWN_PERMANENT", claimedCents: 62000, findings: [] as string[], ruleSet: true },
      { claim: flexi, schemeCode: "CROWN_PERMANENT", claimedCents: 40000, findings: ["flexi_yearly_amount_exceeded"], ruleSet: true },
      // An insurer pays under its own plan, not a published rule set.
      { claim: meridian, schemeCode: "CR1", claimedCents: 28800, findings: [] as string[], ruleSet: false },
    ];

    for (const { claim, schemeCode, claimedCents, findings, ruleSet } of expected) {
      const res = await api.detail(claim.id);
      expect(res.status, claim.payerId).toBe(200);
      const text = await res.text();
      const detail = JSON.parse(text) as ClaimDetail;
      expect(detail.lines, claim.payerId).toEqual([expect.objectContaining({ clinicCode: "CRN", schemeCode, feeCents: 120000, consideredCents: 130800, claimedCents })]);
      expect(detail.claim.findings.map((f) => f.code), claim.payerId).toEqual(findings);
      expect(detail.split, claim.payerId).toEqual({ feeCents: 130800, segments });
      expect(detail.revision, claim.payerId).toEqual({ builtFrom: 1, current: 1 });
      if (ruleSet) {
        expect(detail.ruleSet, claim.payerId).toMatchObject({ id: claim.ruleSetId, sources: expect.arrayContaining([expect.objectContaining({ url: expect.stringMatching(/^https:\/\//), retrieved: expect.any(String) })]) });
      } else {
        expect(detail.ruleSet, claim.payerId).toBeNull();
      }
      // Masked patient only.
      expect(text, claim.payerId).not.toMatch(/T9\d{6}[A-Z]/);
      expect(detail.claim, claim.payerId).not.toHaveProperty("patientHash");
    }
  });

  it("AC-8.1: a sourced benchmark saved through the settings route clears D01's blank-benchmark finding; an unsourced one is refused", async () => {
    const { desk } = await clinicDesk(false);
    const api = route(desk);
    expect(await findingCodes(desk, "SC-D01")).toContain("benchmark_not_set");
    const { version } = await api.settings();

    const { sourceUrl: _, ...unsourced } = SCALING_OVERRIDE;
    const refused = await api.saveSettings({ settings: { ...CLINIC.settings, benchmarkOverrides: [...CLINIC.settings.benchmarkOverrides, unsourced] }, expectedVersion: version });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid", issues: [expect.objectContaining({ path: `settings.benchmarkOverrides.${CLINIC.settings.benchmarkOverrides.length}.sourceUrl` })] });
    expect(await audit.list(desk.db, { type: "settings", id: "desk" })).toEqual([]);

    const res = await api.saveSettings({ settings: { ...CLINIC.settings, benchmarkOverrides: [...CLINIC.settings.benchmarkOverrides, SCALING_OVERRIDE] }, expectedVersion: version });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as SettingsSaveResponse;
    expect(saved.version).toBe(version + 1);
    await finishRebuild(api, saved.rebuild);

    expect(await findingCodes(desk, "SC-D01")).not.toContain("benchmark_not_set");
    expect(await audit.list(desk.db, { type: "settings", id: "desk" })).toEqual([expect.objectContaining({ actor: REVIEWER, action: "settings_saved" })]);
  });

  it("AC-8.2: switching DR-A's MediSave accreditation off sends DR-A's unsubmitted MediSave claims to needs attention, and nothing else moves", async () => {
    const { desk } = await clinicDesk(false);
    const api = route(desk);
    const drA = new Set(CLINIC.visits.filter((v) => v.dentistId === "DR-A").map((v) => v.visitKey));

    // One of DR-A's MediSave claims is already with the payer before the change.
    const ready = (await medisaveClaims(desk)).find((c) => drA.has(c.visitKey) && c.status === "ready");
    if (!ready) throw new Error("the synthetic clinic has no ready MediSave claim for DR-A");
    expect((await api.act(ready, { kind: "approve" })).status).toBe(200);
    const approved = (await claims.detail(desk.db, ready.id))!;
    expect((await api.submit([approved])).status).toBe(200);
    expect((await claims.detail(desk.db, ready.id))!.status).toBe("submitted");

    const before = await medisaveClaims(desk);
    const unsubmitted = before.filter((c) => drA.has(c.visitKey) && c.id !== ready.id);
    expect(unsubmitted.length).toBeGreaterThan(0);
    expect(unsubmitted.some((c) => c.status !== "needs_attention")).toBe(true);

    const { version } = await api.settings();
    const settings = { ...CLINIC.settings, dentists: CLINIC.settings.dentists.map((d) => (d.id === "DR-A" ? { ...d, medisaveAccredited: false } : d)) };
    const res = await api.saveSettings({ settings, expectedVersion: version });
    expect(res.status).toBe(200);
    await finishRebuild(api, ((await res.json()) as SettingsSaveResponse).rebuild);

    const after = new Map((await medisaveClaims(desk)).map((c) => [c.id, c]));
    for (const claim of unsubmitted) {
      const now = after.get(claim.id)!;
      expect(now.status, claim.visitKey).toBe("needs_attention");
      expect(now.findings.map((f) => f.code), claim.visitKey).toContain("dentist_not_medisave_accredited");
    }
    const sent = after.get(ready.id)!;
    expect(sent.status).toBe("submitted");
    expect(sent.findings.map((f) => f.code)).not.toContain("dentist_not_medisave_accredited");
    for (const claim of before.filter((c) => !drA.has(c.visitKey))) {
      expect(after.get(claim.id), `${claim.visitKey} is not DR-A's`).toMatchObject({ status: claim.status, findings: claim.findings });
    }
  });
});
