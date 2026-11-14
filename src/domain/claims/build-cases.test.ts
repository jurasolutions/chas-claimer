/**
 * The UAT D-cases (seed 7, T = 2026-11-13) through the builder, one row per case. Visits run in
 * date order and each patient's history is what the builder produced for their earlier visits,
 * the way the import service composes it. Expected values are the UAT script's table.
 */
import { describe, expect, it } from "vitest";
import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import type { IsoDate } from "../dates";
import type { DeskSettings } from "../settings";
import { splitVisit } from "../source-visit";
import { type BuildOutput, buildVisitClaims, type ClaimAnnotations, type CodeMap, type PatientHistory } from "./build";

const TODAY = "2026-11-13" as IsoDate;
const FLEXI_RULE_SET = "medisave-flexi-2026-07-01";
const clinic = generateClinic({ seed: 7, asOf: TODAY });

function runClinic(codeMap: CodeMap, settings: DeskSettings = clinic.settings): Map<string, BuildOutput> {
  const out = new Map<string, BuildOutput>();
  const histories = new Map<string, PatientHistory>();
  const ordered = [...clinic.visits].sort((a, b) =>
    `${a.date}|${a.startTime ?? ""}|${a.visitKey}` < `${b.date}|${b.startTime ?? ""}|${b.visitKey}` ? -1 : 1,
  );
  for (const source of ordered) {
    const { identity, clinical } = splitVisit(source);
    const history = histories.get(identity.nric) ?? { visits: [], claims: [] };
    const built = buildVisitClaims({ visit: clinical, settings, codeMap, history, fixed: [], annotations: {}, today: TODAY });
    out.set(clinical.visitKey, built);
    histories.set(identity.nric, {
      visits: [
        ...history.visits,
        {
          visitKey: clinical.visitKey,
          date: clinical.date,
          startTime: clinical.startTime,
          branchId: clinical.branchId,
          inProgressCodes: clinical.treatments.filter((t) => t.completion === "in_progress").map((t) => t.code),
        },
      ],
      claims: [
        ...history.claims,
        ...built.claims.map((c) => ({
          visitKey: clinical.visitKey,
          visitDate: clinical.date,
          visitStartTime: clinical.startTime,
          scheme: c.scheme,
          status: c.status,
          payerId: c.payerId,
          claimedCents: c.claimedCents,
          claimDate: c.claimDate,
          lines: c.lines.map((l) => ({ schemeCode: l.schemeCode, quantity: l.quantity })),
        })),
      ],
    });
  }
  return out;
}

const built = runClinic(clinic.codeMap);

function chasOf(key: string) {
  const v = built.get(key);
  if (!v) throw new Error(`no visit ${key}`);
  return { visit: v, chas: v.claims.find((c) => c.scheme === "chas") ?? null };
}

/** Benchmark-not-set warnings depend on which benchmarks MOH has published; D01 covers them. */
const codes = (fs: readonly { code: string }[]) => fs.map((f) => f.code).filter((c) => c !== "benchmark_not_set").sort();

type Row = [key: string, claimedCents: number | null, status: "ready" | "needs_attention" | null, findings: string[]];

/*
 * The CHAS column only. A claim CHAS can never pay (Green, expired card, past the window, no rule
 * set) claims $0 (decisions-g2 #4). What the other payers and the patient are asked for, and the
 * blocked-upper-payer behaviour, are ticket 03's and are not asserted here.
 */
// prettier-ignore
const ROWS: Row[] = [
  ["SC-D01",        5050,  "ready",           []],
  ["SC-D02-P02",    2800,  "ready",           []],
  ["SC-D02-P03",    2550,  "ready",           []],
  ["SC-D02-P04",    2050,  "ready",           []],
  ["SC-D02-P05",    1350,  "ready",           []],
  ["SC-D02-P06",    2800,  "ready",           []],
  ["SC-D02-P07",    0,     "needs_attention", ["chas_green_no_dental"]],
  ["SC-D03",        59450, "ready",           []],
  ["SC-D04a",       4150,  "ready",           []],
  ["SC-D04b",       62000, "ready",           []],
  ["SC-D05",        1350,  "ready",           []],
  ["SC-D06",        0,     "needs_attention", ["chas_green_no_dental"]],
  ["SC-D07",        0,     "needs_attention", ["card_expired"]],
  ["SC-D07b",       2000,  "ready",           []],
  ["SC-D08",        0,     "needs_attention", ["past_submission_window"]],
  ["SC-D08b",       3000,  "ready",           ["deadline_approaching"]],
  ["SC-D09a",       2050,  "ready",           []],
  ["SC-D09b",       1100,  "needs_attention", ["same_day_duplicate"]],
  ["SC-D10",        null,  null,              []],
  ["SC-D11",        null,  null,              []],
  ["SC-D12",        null,  null,              []],
  ["SC-D13",        null,  null,              []],
  ["SC-D14",        32600, "ready",           []],
  ["SC-D14b",       21750, "ready",           []],
  ["SC-D15",        3000,  "ready",           []],
  ["SC-D16",        61500, "ready",           []],
  ["SC-D17",        3000,  "ready",           []],
  ["SC-D18",        2050,  "needs_attention", ["benchmark_exceeded"]],
  ["SC-D18b",       2050,  "needs_attention", ["benchmark_exceeded"]],
  ["SC-D19-3",      3000,  "ready",           ["frequency_over_limit"]],
  ["SC-D20",        2050,  "needs_attention", ["unmapped_treatment"]],
  ["SC-D21",        2550,  "ready",           ["tier_chosen_from_several"]],
  ["SC-D22",        2050,  "needs_attention", ["gst_not_registered"]],
  ["SC-D23",        0,     "needs_attention", ["no_rule_set"]],
  ["SC-D24",        null,  null,              []],
  ["SC-D25",        61500, "ready",           ["started_at_other_branch"]],
  ["SC-D26",        32600, "ready",           []],
  ["SC-D27",        58450, "ready",           []],
];

describe("buildVisitClaims over the UAT D-cases", () => {
  it.each(ROWS)("%s: CHAS %s, %s, %j", (key, claimed, status, findings) => {
    const { chas } = chasOf(key);
    if (claimed === null) {
      expect(chas).toBeNull();
      return;
    }
    expect(chas).not.toBeNull();
    expect(chas!.claimedCents).toBe(claimed);
    expect(chas!.status).toBe(status);
    expect(codes(chas!.findings)).toEqual([...findings].sort());
  });

  it("every split sums to the fee including GST and no segment is negative (AC-2.13)", () => {
    for (const source of clinic.visits) {
      const { clinical } = splitVisit(source);
      const out = built.get(clinical.visitKey)!;
      if (clinical.voided) {
        expect(out.split).toEqual([]);
        continue;
      }
      const total = clinical.treatments.reduce((s, t) => s + t.feeCents + (t.gstCents ?? 0), 0);
      expect(out.split.reduce((s, x) => s + x.cents, 0)).toBe(total);
      for (const seg of out.split) expect(seg.cents).toBeGreaterThanOrEqual(0);
    }
  });

  it("D04a and D05 hold the started crown; D04b claims it on its own date (AC-2.11)", () => {
    expect(chasOf("SC-D04a").visit.visitNotes).toEqual([{ code: "held_until_complete", params: { clinicCode: "CRN" } }]);
    expect(chasOf("SC-D05").visit.visitNotes).toEqual([{ code: "held_until_complete", params: { clinicCode: "CRN" } }]);
    expect(chasOf("SC-D04b").chas!.lines.map((l) => l.schemeCode)).toEqual(["CROWN_PERMANENT"]);
  });

  it("D08b is due today: zero days left (AC-2.6)", () => {
    expect(chasOf("SC-D08b").chas!.findings.find((f) => f.code === "deadline_approaching")?.params).toEqual({ daysLeft: 0 });
  });

  it("D19: only the third scaling of the year warns; the first is close to its deadline (AC-2.9)", () => {
    expect(codes(chasOf("SC-D19-2").chas!.findings)).not.toContain("frequency_over_limit");
    expect(chasOf("SC-D19-3").chas!.findings.find((f) => f.code === "frequency_over_limit")).toMatchObject({
      severity: "warning",
      params: { count: 2, periodYears: 1 },
      lineNo: 1,
    });
    expect(chasOf("SC-D19-1").chas!.findings.find((f) => f.code === "deadline_approaching")?.params).toEqual({ daysLeft: 2 });
  });

  it("D20 reports the unmapped code on the visit too", () => {
    expect(chasOf("SC-D20").visit.visitFindings).toEqual([
      { code: "unmapped_treatment", severity: "blocking", params: { clinicCode: "NEW-99" } },
    ]);
  });

  it("D21 names the tier it chose", () => {
    expect(chasOf("SC-D21").chas!.findings.find((f) => f.code === "tier_chosen_from_several")?.params).toEqual({ count: 2, tier: "MG" });
  });

  it("D25 names the branch the crown was started at", () => {
    expect(chasOf("SC-D25").chas!.findings.find((f) => f.code === "started_at_other_branch")?.params).toEqual({ branch: "West branch" });
  });

  it("UAT 8.3: once NEW-99 is mapped to no CHAS procedure, D20 is ready", () => {
    const mapped: CodeMap = [
      ...clinic.codeMap,
      { clinicCode: "NEW-99", target: "chas", payerId: "", targetCode: null, origin: "desk", updatedBy: "officer", updatedAt: "2026-11-13T00:00:00Z" },
    ] as CodeMap;
    const { chas } = (() => {
      const out = runClinic(mapped).get("SC-D20")!;
      return { chas: out.claims.find((c) => c.scheme === "chas")! };
    })();
    expect(chas.claimedCents).toBe(2050);
    expect(chas.status).toBe("ready");
  });

  /*
   * The whole waterfall: what each payer is asked for and what is left for the patient (UAT
   * script, D-case table). A segment the payer is asked $0 for still shows when its claim exists.
   */
  // prettier-ignore
  const SPLITS: [key: string, split: Record<string, number>][] = [
    ["SC-D01",     { CHAS: 5050, patient: 4542 }],
    ["SC-D03",     { CHAS: 59450, MEDISAVE_FLEXI: 38650, patient: 0 }],
    ["SC-D04a",    { CHAS: 4150, patient: 2172 }],
    ["SC-D04b",    { CHAS: 62000, MEDISAVE_FLEXI: 40000, MERIDIAN: 28800, patient: 0 }],
    ["SC-D06",     { CHAS: 0, MEDISAVE_FLEXI: 40000, patient: 36300 }],
    ["SC-D07",     { CHAS: 0, patient: 5000 }],
    ["SC-D08",     { CHAS: 0, patient: 5000 }],
    ["SC-D10",     { MEDISAVE_TOSP: 112000, patient: 51500 }],
    ["SC-D11",     { MEDISAVE_TOSP: 0, patient: totalOf("SC-D11") }],
    ["SC-D12",     { MEDISAVE_TOSP: 98100, patient: 0 }],
    ["SC-D13",     { MEDISAVE_TOSP: 112000, patient: 188000 }],
    ["SC-D14",     { CHAS: 32600, patient: 17400 }],
    ["SC-D14b",    { CHAS: 21750, MEDISAVE_FLEXI: 28250, patient: 0 }],
    ["SC-D15",     { CHAS: 3000, patient: totalOf("SC-D15") - 3000 }],
    ["SC-D16",     { CHAS: 61500, HARBOUR: 47500, patient: 0 }],
    ["SC-D17",     { CHAS: 3000, HARBOUR: 5000, patient: 0 }],
    ["SC-D24",     { patient: 15000 }],
    ["SC-D26",     { CHAS: 32600, MEDISAVE_FLEXI: 17400, patient: 0 }],
    ["SC-D27",     { CHAS: 58450, MERIDIAN: 28750, patient: 0 }],
    ["SC-PARTLY-1", { CHAS: 0, MERIDIAN: 109000, patient: 0 }],
    ["SC-PARTLY-2", { CHAS: 58450, MERIDIAN: 28750, patient: 0 }],
    ["SC-MULTITOSP", { MEDISAVE_TOSP: 112000, patient: 215000 }],
  ];

  it.each(SPLITS)("%s splits the bill %j", (key, split) => {
    const v = built.get(key);
    if (!v) throw new Error(`no visit ${key}`);
    expect(Object.fromEntries(v.split.map((s) => [s.payer, s.cents]))).toEqual(split);
    expect(v.split.at(-1)?.payer).toBe("patient");
  });

  type PayerRow = [key: string, payerId: string, status: "ready" | "needs_attention", findings: string[]];
  // prettier-ignore
  const PAYER_ROWS: PayerRow[] = [
    ["SC-D03",      "MEDISAVE_FLEXI", "ready",           ["flexi_yearly_amount_exceeded"]],
    ["SC-D04b",     "MEDISAVE_FLEXI", "ready",           ["flexi_yearly_amount_exceeded"]],
    ["SC-D04b",     "MERIDIAN",       "ready",           []],
    ["SC-D06",      "MEDISAVE_FLEXI", "ready",           ["flexi_yearly_amount_exceeded"]],
    ["SC-D10",      "MEDISAVE_TOSP",  "ready",           []],
    ["SC-D11",      "MEDISAVE_TOSP",  "needs_attention", ["tosp_msp_ranked"]],
    ["SC-D12",      "MEDISAVE_TOSP",  "needs_attention", ["medisave_no_mcaf"]],
    ["SC-D13",      "MEDISAVE_TOSP",  "needs_attention", ["dentist_not_medisave_accredited"]],
    ["SC-D14b",     "MEDISAVE_FLEXI", "ready",           ["flexi_yearly_amount_exceeded"]],
    ["SC-D16",      "HARBOUR",        "needs_attention", ["pre_auth_missing"]],
    ["SC-D17",      "HARBOUR",        "needs_attention", ["policy_not_active"]],
    ["SC-D26",      "MEDISAVE_FLEXI", "ready",           ["flexi_yearly_amount_exceeded"]],
    ["SC-D27",      "MERIDIAN",       "ready",           []],
    ["SC-PARTLY-1", "MERIDIAN",       "ready",           ["insurance_annual_limit_exceeded"]],
    ["SC-PARTLY-2", "MERIDIAN",       "ready",           ["insurance_annual_limit_exceeded"]],
    ["SC-MULTITOSP", "MEDISAVE_TOSP", "ready",           ["tosp_multiple_codes"]],
  ];

  it.each(PAYER_ROWS)("%s: %s is %s with %j", (key, payerId, status, findings) => {
    const claim = built.get(key)?.claims.find((c) => c.payerId === payerId);
    expect(claim).toBeDefined();
    expect(claim!.status).toBe(status);
    expect(codes(claim!.findings)).toEqual([...findings].sort());
  });

  it("N7: a pre-auth reference the officer recorded on the D16 claim clears pre_auth_missing", () => {
    const source = clinic.visits.find((v) => v.visitKey === "SC-D16");
    if (!source) throw new Error("no visit SC-D16");
    const { clinical } = splitVisit(source);
    const build = (annotations: ClaimAnnotations) =>
      buildVisitClaims({ visit: clinical, settings: clinic.settings, codeMap: clinic.codeMap, history: { visits: [], claims: [] }, fixed: [], annotations, today: TODAY }).claims.find(
        (c) => c.payerId === "HARBOUR",
      )!;

    expect(codes(build({ HARBOUR: { preAuthReference: "  " } }).findings)).toContain("pre_auth_missing");
    const annotated = build({ HARBOUR: { preAuthReference: "PA-0016" } });
    expect(codes(annotated.findings)).not.toContain("pre_auth_missing");
    expect(annotated.status).toBe("ready");
  });

  it("D04a claims nothing from Meridian: no treatment it covers is finished", () => {
    expect(built.get("SC-D04a")!.claims.map((c) => c.payerId)).toEqual(["CHAS"]);
  });

  it("D14 is under 60 for Flexi-MediSave; D15 and D02-P02 have nothing it covers (visit notes)", () => {
    const flexi = { ruleRef: FLEXI_RULE_SET };
    expect(built.get("SC-D14")!.visitNotes).toContainEqual({ code: "flexi_patient_under_60", params: { age: 59, minAge: 60 }, ...flexi });
    expect(built.get("SC-D15")!.visitNotes).toContainEqual({ code: "flexi_treatment_not_covered", params: {}, ...flexi });
    expect(built.get("SC-D02-P02")!.visitNotes).toContainEqual({ code: "flexi_treatment_not_covered", params: {}, ...flexi });
  });

  it("D24: Public Assistance leaves a balance the patient pays, said on the visit", () => {
    // No CHAS claim on D24, so the warning names the CHAS rule set in force when the visit was paid.
    expect(built.get("SC-D24")!.visitFindings).toContainEqual({
      code: "pa_patient_balance",
      severity: "warning",
      params: { balanceCents: 15000 },
      ruleRef: "chas-2025-10-01",
    });
  });

  it("MULTITOSP: the second surgical code adds nothing past the highest table limit", () => {
    const tosp = built.get("SC-MULTITOSP")!.claims.find((c) => c.scheme === "medisave_tosp")!;
    expect(tosp.lines.map((l) => l.claimedCents)).toEqual([112000, 0]);
    expect(tosp.findings.find((f) => f.code === "tosp_multiple_codes")?.params).toEqual({ count: 2, capCents: 112000 });
  });

  it("MULTITOSP with three surgical codes is within MediSave's cap; a fourth holds the claim (SC1.8)", () => {
    const source = clinic.visits.find((v) => v.visitKey === "SC-MULTITOSP")!;
    const base = splitVisit(source).clinical;
    // SURG-WT maps to SF813T (system SF) and IMP to SB816M (system SB), both table 2C.
    const withTreatments = (treatments: [code: string, tooth: string][]) => {
      const visit = { ...base, treatments: treatments.map(([code, tooth]) => ({ ...base.treatments[0]!, code, tooth })) };
      const out = buildVisitClaims({ visit, settings: clinic.settings, codeMap: clinic.codeMap, history: { visits: [], claims: [] }, fixed: [], annotations: {}, today: TODAY });
      return out.claims.find((c) => c.scheme === "medisave_tosp")!;
    };
    const codes = (claim: { findings: { code: string }[] }) => claim.findings.map((f) => f.code);

    const threeAcrossTwo = withTreatments([["SURG-WT", "38"], ["SURG-WT", "48"], ["IMP", "36"]]);
    expect(threeAcrossTwo.lines).toHaveLength(3);
    expect(codes(threeAcrossTwo)).not.toContain("tosp_too_many_procedures");
    expect(codes(threeAcrossTwo)).not.toContain("tosp_too_many_systems");
    expect(codes(threeAcrossTwo)).not.toContain("tosp_too_many_in_system");
    expect(threeAcrossTwo.status).toBe("ready");

    // No more than 2 procedures in any one anatomical system (research §2.1, CPF withdrawal limits).
    const threeInOne = withTreatments([["SURG-WT", "38"], ["SURG-WT", "48"], ["SURG-WT", "18"]]);
    expect(threeInOne.findings).toContainEqual(
      expect.objectContaining({ code: "tosp_too_many_in_system", severity: "blocking", params: { max: 2, count: 3, system: "SF" } }),
    );
    expect(codes(threeInOne)).not.toContain("tosp_too_many_procedures");
    expect(threeInOne.status).toBe("needs_attention");

    const four = withTreatments([["SURG-WT", "38"], ["SURG-WT", "48"], ["IMP", "36"], ["IMP", "46"]]);
    expect(four.findings).toContainEqual(expect.objectContaining({ code: "tosp_too_many_procedures", severity: "blocking", params: { max: 3, count: 4 } }));
    expect(codes(four)).not.toContain("tosp_too_many_in_system");
    expect(four.status).toBe("needs_attention");
  });

  it("PARTLY-1 is past the CHAS window, so Meridian is billed the whole bill, past its yearly limit with a warning", () => {
    const chas = built.get("SC-PARTLY-1")!.claims.find((c) => c.payerId === "CHAS")!;
    expect(chas.status).toBe("needs_attention");
    expect(codes(chas.findings)).toContain("past_submission_window");
  });

  it("PARTLY-2 finds Meridian's yearly limit used up: billed in full with the warning, not cut or blocked", () => {
    const meridian = built.get("SC-PARTLY-2")!.claims.find((c) => c.payerId === "MERIDIAN")!;
    expect(meridian.claimedCents).toBeGreaterThan(0);
    expect(meridian.findings.find((f) => f.code === "insurance_annual_limit_exceeded")).toMatchObject({ severity: "warning", params: { limitCents: 100000 } });
  });

  it("D04b with insurance above MediSave: Meridian takes the rest and no MediSave claim is built", () => {
    const out = runClinic(clinic.codeMap, { ...clinic.settings, waterfall: ["chas", "insurance", "medisave"] }).get("SC-D04b")!;
    expect(Object.fromEntries(out.split.map((s) => [s.payer, s.cents]))).toEqual({ CHAS: 62000, MERIDIAN: 68800, patient: 0 });
    expect(out.claims.map((c) => c.payerId)).toEqual(["CHAS", "MERIDIAN"]);
  });

  it("findings and notes name the rule set they come from; an unmapped code names the code map instead", () => {
    const chas = built.get("SC-D07")!.claims[0]!;
    expect(chas.findings.every((f) => f.ruleRef === chas.ruleSetId)).toBe(true);
    const tosp = built.get("SC-D12")!.claims[0]!;
    expect(tosp.findings.every((f) => f.ruleRef === "medisave-tosp-2024-01-01")).toBe(true);
    expect(built.get("SC-D24")!.visitFindings.find((f) => f.code === "pa_patient_balance")?.ruleRef).toMatch(/^chas-/);
    expect(built.get("SC-D14")!.visitNotes.find((n) => n.code === "flexi_patient_under_60")?.ruleRef).toBe(FLEXI_RULE_SET);
    // The code map is the clinic's own setting, not a rule set; the message says so.
    const unmapped = built.get("SC-D20")!.visitFindings.filter((f) => f.code === "unmapped_treatment");
    expect(unmapped.length).toBeGreaterThan(0);
    expect(unmapped.every((f) => f.ruleRef === undefined)).toBe(true);
  });
});

function totalOf(key: string): number {
  const source = clinic.visits.find((v) => v.visitKey === key);
  if (!source) throw new Error(`no visit ${key}`);
  return splitVisit(source).clinical.treatments.reduce((s, t) => s + t.feeCents + (t.gstCents ?? 0), 0);
}
