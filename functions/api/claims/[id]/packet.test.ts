import * as claims from "../../../../server/repo/claims";
import * as settingsRepo from "../../../../server/repo/settings";
import { importVisits } from "../../../../server/services/imports";
import type { PacketView } from "../../../../src/api/submissions";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../../tests/helpers/env";
import { CLINIC, caseVisits, configuredDesk, NOW, OFFICER_ACTOR, visitByKey } from "../../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../../tests/helpers/http";
import { onRequestGet } from "./packet";

const team = await accessTeam();

beforeEach(() => {
  stubAccessCerts(team);
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

async function deskWith(caseName: "D01" | "D04b", meridianTemplate?: string[], chasPortal?: string) {
  const desk = await configuredDesk();
  if (meridianTemplate || chasPortal) {
    const settings = {
      ...CLINIC.settings,
      payers: CLINIC.settings.payers.map((p) =>
        p.id === "MERIDIAN" && meridianTemplate ? { ...p, templateFields: meridianTemplate } : p.id === "CHAS" && chasPortal ? { ...p, portalUrl: chasPortal } : p,
      ),
    };
    await settingsRepo.saveStatement(desk.db, settings, 1, OFFICER, new Date(NOW).toISOString()).run();
  }
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits(caseName) }, OFFICER_ACTOR);
  return desk;
}

async function getPacket(desk: Awaited<ReturnType<typeof deskWith>>, id: string, who = OFFICER) {
  return call(onRequestGet, apiRequest(`/api/claims/${id}/packet`, { jwt: await team.sign(accessClaims(who)) }), desk.env, { id });
}

describe("GET /api/claims/:id/packet", () => {
  it("carries the payer's portal URL when settings name one, and null when they don't", async () => {
    const blank = await deskWith("D01");
    const chas = (await claims.forVisit(blank.db, "SC-D01")).find((c) => c.payerId === "CHAS")!;
    expect(((await (await getPacket(blank, chas.id)).json()) as PacketView).portalUrl).toBeNull();

    const set = await deskWith("D01", undefined, "https://portal.chas.example/claims");
    const claim = (await claims.forVisit(set.db, "SC-D01")).find((c) => c.payerId === "CHAS")!;
    expect(((await (await getPacket(set, claim.id)).json()) as PacketView).portalUrl).toBe("https://portal.chas.example/claims");
  });

  it("AC-4.1: carries exactly the payer template's fields, in its order, and nothing clinical or from other payers", async () => {
    const desk = await deskWith("D04b", ["member_id", "plan", "benefit_code", "tooth", "visit_date", "claim_amount"]);
    const claim = (await claims.forVisit(desk.db, "SC-D04b")).find((c) => c.payerId === "MERIDIAN")!;
    const source = visitByKey("SC-D04b");

    const res = await getPacket(desk, claim.id);

    expect(res.status).toBe(200);
    const packet = (await res.json()) as PacketView;
    expect(packet.fields.map((f) => f.key)).toEqual(["member_id", "plan", "benefit_code", "tooth", "visit_date", "claim_amount"]);
    const byKey = Object.fromEntries(packet.fields.map((f) => [f.key, f]));
    expect(byKey.member_id).toMatchObject({ text: null, masked: true, revealField: "member_id" });
    expect(byKey.plan!.text).toBe(source.policies.find((p) => p.payerId === "MERIDIAN")!.plan);
    expect(byKey.visit_date!.text).toBe(source.date);
    expect(byKey.claim_amount!.text).toBe("288.00");
    const body = JSON.stringify(packet);
    expect(body).not.toContain("620.00");
    expect(body).not.toContain("400.00");
    expect(body).not.toContain(source.patient.nric);
    if (source.notes) expect(body).not.toContain(source.notes);
  });

  it("AC-4.2: D01's CHAS packet follows the configured portal order, at most 12 fields, the NRIC masked until shown", async () => {
    const desk = await deskWith("D01");
    const claim = (await claims.forVisit(desk.db, "SC-D01")).find((c) => c.scheme === "chas")!;
    const chas = CLINIC.settings.payers.find((p) => p.id === "CHAS")!;

    const res = await getPacket(desk, claim.id, REVIEWER);

    expect(res.status).toBe(200);
    const packet = (await res.json()) as PacketView;
    expect(packet.fields.map((f) => f.key)).toEqual(chas.templateFields);
    expect(packet.fields.length).toBeLessThanOrEqual(12);
    expect(packet).toMatchObject({ claimId: claim.id, payerId: "CHAS", channel: "assisted", version: claim.version });
    const nric = packet.fields.find((f) => f.key === "patient_nric")!;
    expect(nric).toMatchObject({ masked: true, revealField: "nric", text: claim.patientMask });
    expect(packet.fields.find((f) => f.key === "patient_name")).toMatchObject({ masked: true, revealField: "name", text: null });
    expect(packet.fields.find((f) => f.key === "branch")!.text).toBe("East branch");
    expect(packet.fields.find((f) => f.key === "fee")!.label).toBe("Fee");
  });

  it("is 404 for an unknown claim and 403 for someone with no role", async () => {
    const desk = await deskWith("D01");
    expect((await getPacket(desk, "nope")).status).toBe(404);
    expect((await getPacket(desk, "nope", STRANGER)).status).toBe(403);
  });
});
