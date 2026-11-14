import { describe, expect, it } from "vitest";
import { parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { parseDeskSettings } from "../../src/domain/settings";
import { generateClinic } from "./generate";

const AS_OF = parseIsoDate("2026-11-13") as IsoDate;

describe("generateClinic: configuration (UAT 2.1)", () => {
  const clinic = generateClinic({ seed: 1, asOf: AS_OF });

  it("hands back settings that parse as desk settings", () => {
    const parsed = parseDeskSettings(clinic.settings);
    expect(parsed.ok).toBe(true);
  });

  it("has an East branch charging GST and a West branch that does not", () => {
    const byId = Object.fromEntries(clinic.settings.branches.map((b) => [b.id, b]));
    expect(byId["BR-EAST"]).toMatchObject({ gstRegistered: true, chasRegistered: true, medisaveRegistered: true });
    expect(byId["BR-WEST"]).toMatchObject({ gstRegistered: false, chasRegistered: true, medisaveRegistered: true });
  });

  it("has two accredited dentists and one who is not", () => {
    const accredited = Object.fromEntries(clinic.settings.dentists.map((d) => [d.id, d.medisaveAccredited]));
    expect(accredited).toEqual({ "DR-A": true, "DR-B": true, "DR-C": false });
  });

  it("routes each payer down the channel UAT 2.1 names, with no deadline set", () => {
    const channels = Object.fromEntries(clinic.settings.payers.map((p) => [p.id, p.channel]));
    expect(channels).toEqual({
      CHAS: "assisted",
      MEDISAVE_TOSP: "simulator",
      MEDISAVE_FLEXI: "simulator",
      MERIDIAN: "api",
      HARBOUR: "file",
    });
    for (const p of clinic.settings.payers) expect(p.deadlineDays).toBeNull();
  });

  it("names fictional insurers only, with Harbour requiring pre-auth for crowns", () => {
    const byId = Object.fromEntries(clinic.settings.payers.map((p) => [p.id, p]));
    expect(byId.MERIDIAN?.name).toBe("Meridian Dental Plan");
    expect(byId.HARBOUR?.name).toBe("Harbour TPA");
    expect(byId.HARBOUR?.preAuthBenefitCodes).toEqual(["H-CRN"]);
    expect(byId.MERIDIAN?.preAuthBenefitCodes).toEqual([]);
  });

  it("applies the waterfall CHAS, then MediSave, then insurance", () => {
    expect(clinic.settings.waterfall).toEqual(["chas", "medisave", "insurance"]);
  });

  it("maps whitening as not claimable and leaves the new laser code unmapped", () => {
    const whitening = clinic.codeMap.filter((e) => e.clinicCode === "WHT");
    expect(whitening).toEqual([expect.objectContaining({ target: "chas", targetCode: null })]);
    expect(clinic.codeMap.some((e) => e.clinicCode === "NEW-99")).toBe(false);
  });

  it("maps the wisdom-tooth surgery to one TOSP code and its MSP variant to another", () => {
    const tosp = Object.fromEntries(clinic.codeMap.filter((e) => e.target === "tosp").map((e) => [e.clinicCode, e.targetCode]));
    expect(tosp).toMatchObject({ "SURG-WT": "SF813T", "SURG-WTS": "SF811T" });
  });

  it("records the seed and the as-of date on the clinic profile", () => {
    expect(clinic.clinic).toMatchObject({ seed: 1, asOf: "2026-11-13" });
  });
});
