import type { ClaimDetail } from "../../../../src/api/claim-detail";
import * as claims from "../../../../server/repo/claims";
import { act } from "../../../../server/services/claims";
import { importVisits } from "../../../../server/services/imports";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../../tests/helpers/env";
import type { Actor } from "../../../../src/domain/types";
import { caseVisits, configuredDesk, NOW, OFFICER_ACTOR } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestGet } from "./index";

const team = await accessTeam();
const desk = await configuredDesk();
await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
const d01 = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;

const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["reviewer"] };

const get = async (id: string, who = OFFICER) =>
  call(onRequestGet, apiRequest(`/api/claims/${id}`, { jwt: await team.sign(accessClaims(who)) }), desk.env, { id });

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/claims/:id", () => {
  it("answers D01's claim with its lines, split and trail, the patient masked and no patient hash (AC-3.7)", async () => {
    const res = await get(d01.id);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ClaimDetail;
    expect(body.claim).toMatchObject({ id: d01.id, status: "ready", claimedCents: 5050 });
    expect(body.claim.patientMask).toMatch(/^T••••\d{3}[A-Z]$/);
    expect(body.claim).not.toHaveProperty("patientHash");
    expect(body.lines.length).toBeGreaterThan(0);
    expect(body.split.segments.at(-1)).toMatchObject({ payer: "patient" });
    expect(body.audit[0]).toMatchObject({ action: "built" });
    expect(JSON.stringify(body)).not.toMatch(/T9\d{6}[A-Z]/);
  });

  it("offers approve to a reviewer and not to an officer", async () => {
    const officer = (await (await get(d01.id, OFFICER)).json()) as ClaimDetail;
    const reviewer = (await (await get(d01.id, REVIEWER)).json()) as ClaimDetail;

    expect(officer.actions).not.toContain("approve");
    expect(reviewer.actions).toContain("approve");
  });

  it("answers 404 not_found for a claim the desk does not hold", async () => {
    const res = await get("CL-NOPE");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("D05: the claim detail says the crown in progress is held until it's complete", async () => {
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D05") }, OFFICER_ACTOR);
    const d05 = (await claims.forVisit(desk.db, "SC-D05")).find((c) => c.scheme === "chas")!;

    const body = JSON.stringify(await (await get(d05.id)).json());

    expect(body).toMatch(/held_until_complete|held until it's complete/);
  });

  it("D24: the claim detail carries the visit's Public Assistance balance warning (UAT 4.10)", async () => {
    // D24 as cased has nothing claimable; a consultation alongside gives it a claim page to read.
    const withConsult = caseVisits("D24").map((v) => ({ ...v, treatments: [...v.treatments, { ...v.treatments[0]!, code: "CON", feeCents: 3000 }] }));
    await importVisits(desk.deps, { source: "synthetic", visits: withConsult }, OFFICER_ACTOR);
    const [claim] = await claims.forVisit(desk.db, "SC-D24");

    const body = (await (await get(claim!.id)).json()) as ClaimDetail;

    expect(body.visit.findings).toContainEqual(expect.objectContaining({ code: "pa_patient_balance", severity: "warning" }));
  });

  it("D07: a withdrawn claim stays withdrawn when its visit comes back changed, and the visit says why (UAT 5.15)", async () => {
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D07") }, OFFICER_ACTOR);
    const d07 = (await claims.forVisit(desk.db, "SC-D07")).find((c) => c.scheme === "chas")!;
    const withdrawn = await act(desk.deps, d07.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, d07.version, REVIEWER_ACTOR);
    expect(withdrawn.ok).toBe(true);
    const changed = caseVisits("D07").map((v) => ({ ...v, treatments: v.treatments.map((t) => ({ ...t, feeCents: t.feeCents + 500 })) }));

    await importVisits(desk.deps, { source: "synthetic", visits: changed }, OFFICER_ACTOR);

    const after = (await claims.forVisit(desk.db, "SC-D07")).find((c) => c.id === d07.id)!;
    expect(after.status).toBe("withdrawn");
    const body = (await (await get(d07.id)).json()) as ClaimDetail;
    expect(body.visit.notes).toContainEqual(expect.objectContaining({ code: "withdrawn_not_rebuilt" }));
  });

  it("D12: a withdrawn claim's split stays as built when the visit's fee changes, and says when it was built", async () => {
    const visits = caseVisits("D07").map((v) => ({ ...v, visitKey: "SC-D07-FROZEN" }));
    await importVisits(desk.deps, { source: "synthetic", visits }, OFFICER_ACTOR);
    const claim = (await claims.forVisit(desk.db, "SC-D07-FROZEN")).find((c) => c.scheme === "chas")!;
    const asBuilt = (await (await get(claim.id)).json()) as ClaimDetail;
    expect(asBuilt.frozenOn).toBeNull();
    await act(desk.deps, claim.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, claim.version, REVIEWER_ACTOR);
    const changed = visits.map((v) => ({ ...v, treatments: v.treatments.map((t) => ({ ...t, feeCents: t.feeCents + 500 })) }));

    await importVisits(desk.deps, { source: "synthetic", visits: changed }, OFFICER_ACTOR);

    const body = (await (await get(claim.id)).json()) as ClaimDetail;
    expect(body.revision).toEqual({ builtFrom: 1, current: 2 });
    expect(body.split).toEqual(asBuilt.split);
    expect(body.frozenOn).toBe("2026-11-13");
  });

  it("D12: a frozen claim built from an earlier revision shows none of the later revision's notes or findings", async () => {
    const visits = caseVisits("D05").map((v) => ({ ...v, visitKey: "SC-D05-FROZEN" }));
    await importVisits(desk.deps, { source: "synthetic", visits }, OFFICER_ACTOR);
    const claim = (await claims.forVisit(desk.db, "SC-D05-FROZEN")).find((c) => c.scheme === "chas")!;
    await act(desk.deps, claim.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, claim.version, REVIEWER_ACTOR);
    const changed = visits.map((v) => ({ ...v, treatments: v.treatments.map((t) => ({ ...t, feeCents: t.feeCents + 500 })) }));

    await importVisits(desk.deps, { source: "synthetic", visits: changed }, OFFICER_ACTOR);

    const body = (await (await get(claim.id)).json()) as ClaimDetail;
    expect(body.revision).toEqual({ builtFrom: 1, current: 2 });
    expect(body.visit.notes.map((n) => n.code)).not.toContain("held_until_complete");
    expect(body.visit.findings).toEqual([]);
    // Why the desk left this claim alone still shows: it's about this claim, not the new figures.
    expect(body.visit.notes).toContainEqual(expect.objectContaining({ code: "withdrawn_not_rebuilt" }));
  });

  it("D12: a frozen claim built from the visit's current revision still shows the visit's notes", async () => {
    const visits = caseVisits("D05").map((v) => ({ ...v, visitKey: "SC-D05-SAME" }));
    await importVisits(desk.deps, { source: "synthetic", visits }, OFFICER_ACTOR);
    const claim = (await claims.forVisit(desk.db, "SC-D05-SAME")).find((c) => c.scheme === "chas")!;
    await act(desk.deps, claim.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, claim.version, REVIEWER_ACTOR);

    const body = (await (await get(claim.id)).json()) as ClaimDetail;

    expect(body.claim.status).toBe("withdrawn");
    expect(body.revision).toEqual({ builtFrom: 1, current: 1 });
    expect(body.visit.notes).toContainEqual(expect.objectContaining({ code: "held_until_complete" }));
  });

  it("D03: names the branch from settings and the rule set and sources behind each scheme payer (UAT 3.3, 4.1)", async () => {
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D04b") }, OFFICER_ACTOR);
    const onVisit = await claims.forVisit(desk.db, "SC-D04b");
    const chas = onVisit.find((c) => c.scheme === "chas")!;

    const body = (await (await get(chas.id)).json()) as ClaimDetail;

    expect(body.branchName).toBe("East branch");
    const schemeClaims = onVisit.filter((c) => c.scheme !== "insurance" && c.ruleSetId !== claims.NO_RULE_SET);
    expect(schemeClaims.length).toBeGreaterThan(0);
    expect(body.pricedBy.map((p) => p.ruleSet.id).sort()).toEqual(schemeClaims.map((c) => c.ruleSetId).sort());
    for (const priced of body.pricedBy) {
      expect(priced.payerName).not.toBe("");
      expect(priced.ruleSet.sources.length).toBeGreaterThan(0);
    }
  });

  it("refuses a signed-in person on neither role list", async () => {
    const res = await get(d01.id, STRANGER);

    expect(res.status).toBe(403);
  });
});
