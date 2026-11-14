import { describe, expect, it } from "vitest";
import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import type { IsoDate } from "../dates";
import { add, cents } from "../money";
import type { DeskSettings } from "../settings";
import { type ClinicalVisit, splitVisit } from "../source-visit";
import { CHAS_RULE_SETS } from "../rules/chas";
import { type BuildInput, buildVisitClaims, historyWindow, laterReach, type PatientHistory } from "./build";

const EMPTY_HISTORY: PatientHistory = { visits: [], claims: [] };

const TODAY = "2026-11-13" as IsoDate;
const clinic = generateClinic({ seed: 7, asOf: TODAY });

function clinicalOf(key: string) {
  const v = clinic.visits.find((x) => x.visitKey === key);
  if (!v) throw new Error(`no visit ${key}`);
  return splitVisit(v).clinical;
}

describe("buildVisitClaims", () => {
  it("D01: one ready CHAS claim of $50.50 and the patient pays the rest", () => {
    const out = buildVisitClaims({
      visit: clinicalOf("SC-D01"),
      settings: clinic.settings,
      codeMap: clinic.codeMap,
      history: EMPTY_HISTORY,
      fixed: [],
      annotations: {},
      today: TODAY,
    });
    expect(out.claims).toHaveLength(1);
    const chas = out.claims[0]!;
    expect(chas.payerId).toBe("CHAS");
    expect(chas.scheme).toBe("chas");
    expect(chas.claimedCents).toBe(5050);
    expect(chas.status).toBe("ready");
    // Scaling (line 2) has no published benchmark yet: a warning, not a block.
    expect(chas.findings).toEqual([{ code: "benchmark_not_set", severity: "warning", params: {}, lineNo: 2, ruleRef: chas.ruleSetId }]);
    expect(chas.ruleSetId).not.toBeNull();
    // D01 is T-3 with a 30-day window: the last day is T+27.
    expect(chas.deadline).toBe("2026-12-10");
    expect(out.split).toEqual([
      { payer: "CHAS", label: "CHAS", cents: 5050 },
      { payer: "patient", label: "Patient", cents: 4542 },
    ]);
    expect(out.visitFindings).toEqual([]);
    expect(out.visitNotes).toEqual([]);
  });

  it.each([
    ["SC-D07", "card_expired"],
    ["SC-D08", "past_submission_window"],
  ])("%s: CHAS can never pay it (%s), so it claims nothing on any line and the patient's share is the whole fee (decisions-g2 #4)", (key, code) => {
    const out = buildVisitClaims({ visit: clinicalOf(key), settings: clinic.settings, codeMap: clinic.codeMap, history: EMPTY_HISTORY, fixed: [], annotations: {}, today: TODAY });

    const chas = out.claims[0]!;
    expect(chas.status).toBe("needs_attention");
    expect(chas.findings.map((f) => f.code)).toContain(code);
    expect(chas.claimedCents).toBe(0);
    expect(chas.lines.map((l) => l.claimedCents)).toEqual([0]);
    // No MediSave or insurance on the visit: no lower payer, and the patient pays it all.
    expect(out.claims.map((c) => c.payerId)).toEqual(["CHAS"]);
    expect(out.split).toEqual([
      { payer: "CHAS", label: "CHAS", cents: 0 },
      { payer: "patient", label: "Patient", cents: 5000 },
    ]);
  });
});

function build(visit: ClinicalVisit, over: Partial<BuildInput> = {}) {
  return buildVisitClaims({ visit, settings: clinic.settings, codeMap: clinic.codeMap, history: EMPTY_HISTORY, fixed: [], annotations: {}, today: TODAY, ...over });
}
const splitOf = (out: ReturnType<typeof build>) => Object.fromEntries(out.split.map((s) => [s.payer, s.cents]));
const claimOf = (out: ReturnType<typeof build>, payerId: string) => out.claims.find((c) => c.payerId === payerId)!;
const codesOf = (out: ReturnType<typeof build>, payerId: string) => claimOf(out, payerId).findings.map((f) => f.code);

describe("buildVisitClaims across payers", () => {
  it("D27 when CHAS can never pay (card expired): Meridian takes the whole fee and does not wait on CHAS", () => {
    const d27 = clinicalOf("SC-D27");
    const out = build({ ...d27, chasCards: d27.chasCards.map((c) => ({ ...c, expiry: "2026-01-31" as IsoDate })) });
    expect(splitOf(out)).toEqual({ CHAS: 0, MERIDIAN: 87200, patient: 0 });
    expect(codesOf(out, "MERIDIAN")).not.toContain("waiting_on_upper_payer");
    expect(claimOf(out, "MERIDIAN").status).toBe("ready");
  });

  describe("D27 when no CHAS line can be claimed until the code map is fixed (functional B5: fixable)", () => {
    const d27 = () => clinicalOf("SC-D27");
    const withoutChasRow = clinic.codeMap.filter((e) => !(e.clinicCode === "RCT-M" && e.target === "chas"));

    function expectChasHoldsMeridian(out: ReturnType<typeof build>, clinicCode: string) {
      const chas = claimOf(out, "CHAS");
      expect(chas.status).toBe("needs_attention");
      expect(chas.lines).toEqual([]);
      expect(chas.claimedCents).toBe(0);
      expect(chas.findings).toContainEqual(expect.objectContaining({ code: "unmapped_treatment", params: { clinicCode } }));
      expect(claimOf(out, "MERIDIAN").findings).toContainEqual(expect.objectContaining({ code: "waiting_on_upper_payer", params: { scheme: "chas" } }));
      expect(claimOf(out, "MERIDIAN").status).toBe("needs_attention");
    }

    it("its only CHAS row names a code the rule set doesn't know: a $0 CHAS claim says so, and Meridian waits on it", () => {
      const codeMap = clinic.codeMap.map((e) => (e.clinicCode === "RCT-M" && e.target === "chas" ? { ...e, targetCode: "NOT_A_CHAS_CODE" } : e));
      const out = build(d27(), { codeMap });
      expectChasHoldsMeridian(out, "RCT-M");
      expect(splitOf(out)).toEqual({ CHAS: 0, MERIDIAN: 87200, patient: 0 });
    });

    it("a treatment with no mapping at all: a $0 CHAS claim says so, and Meridian waits on it", () => {
      const visit = d27();
      const out = build({ ...visit, treatments: [...visit.treatments, { ...visit.treatments[0]!, code: "NEW-99", feeCents: cents(5000), tooth: null }] }, { codeMap: withoutChasRow });
      expectChasHoldsMeridian(out, "NEW-99");
    });

    it("every treatment mapped, none of them to CHAS: no CHAS claim, and Meridian goes ahead", () => {
      const out = build(d27(), { codeMap: withoutChasRow });
      expect(out.claims.map((c) => c.payerId)).toEqual(["MERIDIAN"]);
      expect(claimOf(out, "MERIDIAN").status).toBe("ready");
    });
  });

  it("AC-8.1: a benchmark override from settings is applied, and its finding carries the source", () => {
    const settings = {
      ...clinic.settings,
      benchmarkOverrides: [{ procedureCode: "SCALING", minCents: 2100, maxCents: 3100, sourceUrl: "https://example.test/benchmarks", asOf: "2026-11-01" }],
    } as DeskSettings;
    const chas = claimOf(build(clinicalOf("SC-D01"), { settings }), "CHAS");
    expect(chas.findings.map((f) => f.code)).not.toContain("benchmark_not_set");
    expect(chas.findings.find((f) => f.code === "benchmark_exceeded")).toMatchObject({
      severity: "blocking",
      lineNo: 2,
      params: { minCents: 2100, maxCents: 3100, sourceUrl: "https://example.test/benchmarks", asOf: "2026-11-01" },
    });
    expect(chas.status).toBe("needs_attention");
  });

  it("a MediSave visit before any Flexi-MediSave rule set gets a note saying so, not a silent gap", () => {
    // The Flexi-MediSave rule set starts on 2026-07-01; move a Flexi visit to the month before.
    const before = "2026-06-15" as IsoDate;
    const v = clinicalOf("SC-D04b");
    const out = build({ ...v, date: before, treatments: v.treatments.map((t) => ({ ...t, completedOn: t.completedOn && before })) });
    expect(out.claims.find((c) => c.scheme === "medisave_flexi")).toBeUndefined();
    expect(out.visitNotes).toContainEqual({ code: "flexi_no_rule_set", params: { date: before } });
  });

  it("a visit with no MediSave details gets no Flexi-MediSave note", () => {
    const before = "2026-06-15" as IsoDate;
    const v = clinicalOf("SC-D04b");
    const out = build({ ...v, medisave: null, date: before, treatments: v.treatments.map((t) => ({ ...t, completedOn: t.completedOn && before })) });
    expect(out.visitNotes.map((n) => n.code)).not.toContain("flexi_no_rule_set");
  });

  it("AC-8.2: a dentist without MediSave accreditation blocks the MediSave claim; lower payers wait on it", () => {
    const settings = { ...clinic.settings, dentists: clinic.settings.dentists.map((d) => (d.id === "DR-A" ? { ...d, medisaveAccredited: false } : d)) };
    const out = build(clinicalOf("SC-D04b"), { settings });
    const flexi = claimOf(out, "MEDISAVE_FLEXI");
    expect(flexi.status).toBe("needs_attention");
    expect(flexi.findings.find((f) => f.code === "dentist_not_medisave_accredited")?.severity).toBe("blocking");
    expect(claimOf(out, "CHAS").status).toBe("ready");
    expect(claimOf(out, "MERIDIAN").findings).toContainEqual(expect.objectContaining({ code: "waiting_on_upper_payer", params: { scheme: "medisave_flexi" } }));
    expect(claimOf(out, "MERIDIAN").status).toBe("needs_attention");
  });

  it("decisions-g2 #8: a claim past the policy's yearly limit is billed in full and warns, not cut", () => {
    const d27 = clinicalOf("SC-D27");
    const out = build({ ...d27, policies: d27.policies.map((p) => ({ ...p, limitCents: cents(20000) })) });
    expect(splitOf(out)).toEqual({ CHAS: 58450, MERIDIAN: 28750, patient: 0 });
    expect(claimOf(out, "MERIDIAN").findings).toContainEqual(expect.objectContaining({ code: "insurance_annual_limit_exceeded", severity: "warning", params: { limitCents: 20000 } }));
    expect(claimOf(out, "MERIDIAN").status).toBe("ready");
  });

  describe("an earlier claim on the policy this year counts towards the limit", () => {
    const withEarlier = (limit: number) => {
      const d27 = clinicalOf("SC-D27");
      const history: PatientHistory = {
        visits: [],
        claims: [{ visitKey: "SC-EARLIER", visitDate: "2026-03-02" as IsoDate, visitStartTime: null, scheme: "insurance", status: "paid", lines: [], payerId: "MERIDIAN", claimedCents: cents(15000) }],
      };
      return build({ ...d27, policies: d27.policies.map((p) => ({ ...p, limitCents: cents(limit) })) }, { history });
    };

    it("warns when this claim takes the year past the limit, still billing in full", () => {
      const out = withEarlier(40000);
      expect(splitOf(out).MERIDIAN).toBe(28750);
      expect(codesOf(out, "MERIDIAN")).toContain("insurance_annual_limit_exceeded");
    });

    it("says nothing when the year stays within it", () => {
      const out = withEarlier(43750);
      expect(splitOf(out).MERIDIAN).toBe(28750);
      expect(codesOf(out, "MERIDIAN")).not.toContain("insurance_annual_limit_exceeded");
    });
  });

  it("a claim the clinic billed differently from the rules is flagged on that payer", () => {
    const d27 = clinicalOf("SC-D27");
    const out = build({ ...d27, billedCents: { MERIDIAN: cents(30000) } });
    expect(claimOf(out, "MERIDIAN").findings).toContainEqual(
      expect.objectContaining({ code: "billed_amount_differs", severity: "warning", params: { payer: "Meridian Dental Plan", billedCents: 30000, claimedCents: 28750 } }),
    );
    expect(codesOf(out, "CHAS")).not.toContain("billed_amount_differs");
  });

  it("CHAS rejected this visit's earlier claim: the lower payers say their amounts were based on it", () => {
    const history: PatientHistory = {
      visits: [],
      claims: [{ visitKey: "SC-D27", visitDate: "2026-11-07" as IsoDate, visitStartTime: null, scheme: "chas", status: "rejected", lines: [] }],
    };
    const out = build(clinicalOf("SC-D27"), { history });
    expect(claimOf(out, "MERIDIAN").findings).toContainEqual(expect.objectContaining({ code: "upstream_rejected", severity: "warning", params: { scheme: "chas" } }));
    expect(codesOf(out, "CHAS")).not.toContain("upstream_rejected");
  });

  it("a sent CHAS claim keeps its amount, and lower payers take what it left (F5)", () => {
    const out = build(clinicalOf("SC-D27"), { fixed: [{ payerId: "CHAS", scheme: "chas", claimedCents: cents(50000) }] });
    expect(out.claims.map((c) => c.payerId)).toEqual(["MERIDIAN"]);
    expect(splitOf(out)).toEqual({ CHAS: 50000, MERIDIAN: 37200, patient: 0 });
  });

  describe("what the CHAS claim's state means for Meridian below it on D27 (decisions-g2 #4, technical F5)", () => {
    const d27 = () => clinicalOf("SC-D27");
    const rejectedChas: PatientHistory = {
      visits: [],
      claims: [{ visitKey: "SC-D27", visitDate: "2026-11-07" as IsoDate, visitStartTime: null, scheme: "chas", status: "rejected", lines: [] }],
    };
    const benchmarkBelowFee = {
      ...clinic.settings,
      benchmarkOverrides: [{ procedureCode: "RCT_MOLAR", minCents: 5000, maxCents: 10000, sourceUrl: "https://example.test/benchmarks", asOf: "2026-11-01" }],
    } as DeskSettings;

    it.each<[string, () => ReturnType<typeof build>, { meridian: number; status: string; has: string[]; lacks: string[] }]>([
      [
        "blocked but fixable (benchmark exceeded): Meridian waits on CHAS",
        () => build(d27(), { settings: benchmarkBelowFee }),
        { meridian: 28750, status: "needs_attention", has: ["waiting_on_upper_payer"], lacks: ["upstream_rejected"] },
      ],
      [
        "never payable (card expired): CHAS pays $0 and Meridian goes ahead with the whole fee",
        () => build({ ...d27(), chasCards: d27().chasCards.map((c) => ({ ...c, expiry: "2026-01-31" as IsoDate })) }),
        { meridian: 87200, status: "ready", has: [], lacks: ["waiting_on_upper_payer", "upstream_rejected"] },
      ],
      [
        "never payable (CHAS Green): CHAS pays $0 and Meridian goes ahead with the whole fee",
        () => build({ ...d27(), chasCards: d27().chasCards.map((c) => ({ ...c, tier: "Green" as const })) }),
        { meridian: 87200, status: "ready", has: [], lacks: ["waiting_on_upper_payer", "upstream_rejected"] },
      ],
      [
        "already submitted: a fixed input, so Meridian takes what it left and does not wait",
        () => build(d27(), { fixed: [{ payerId: "CHAS", scheme: "chas", claimedCents: cents(58450) }] }),
        { meridian: 28750, status: "ready", has: [], lacks: ["waiting_on_upper_payer", "upstream_rejected"] },
      ],
      [
        "rejected: Meridian warns its amount was based on CHAS, and stays as if CHAS had paid",
        () => build(d27(), { history: rejectedChas }),
        { meridian: 28750, status: "ready", has: ["upstream_rejected"], lacks: ["waiting_on_upper_payer"] },
      ],
    ])("CHAS %s", (_name, run, want) => {
      const out = run();
      const meridian = claimOf(out, "MERIDIAN");
      expect(meridian.claimedCents).toBe(want.meridian);
      expect(meridian.status).toBe(want.status);
      for (const code of want.has) expect(meridian.findings).toContainEqual(expect.objectContaining({ code, params: { scheme: "chas" } }));
      for (const code of want.lacks) expect(codesOf(out, "MERIDIAN")).not.toContain(code);
    });
  });
});

describe("the history a build needs", () => {
  const longest = Math.max(...CHAS_RULE_SETS.flatMap((r) => Object.values(r.procedures).map((p) => p.limit.periodYears)));

  it("reaches back far enough for the longest frequency limit, including a visit completed in the next year", () => {
    expect(longest).toBe(3);
    expect(historyWindow("2026-11-07" as IsoDate)).toEqual({ from: "2023-01-01", to: "2026-11-07" });
  });

  it("reaches forward to every later visit whose limits this visit's claims count against", () => {
    expect(laterReach("2026-11-07" as IsoDate)).toBe("2029-12-31");
  });
});

describe("QA 03 D01: a waterfall reorder after MediSave was sent", () => {
  const d04b = () => clinicalOf("SC-D04b");
  const insuranceFirst = { ...clinic.settings, waterfall: ["chas", "insurance", "medisave"] } as DeskSettings;
  const sent = [
    { payerId: "CHAS", scheme: "chas" as const, claimedCents: cents(62000) },
    { payerId: "MEDISAVE_FLEXI", scheme: "medisave_flexi" as const, claimedCents: cents(40000) },
  ];

  it("D04b: sent CHAS $620 and sent Flexi $400 stay as sent; Meridian, now above MediSave, claims only what they left", () => {
    const out = build(d04b(), { settings: insuranceFirst, fixed: sent });
    expect(splitOf(out).MEDISAVE_FLEXI).toBe(40000);
    const meridian = claimOf(out, "MERIDIAN");
    expect(add(cents(62000), cents(40000), meridian.claimedCents)).toBeLessThanOrEqual(130800);
    expect(meridian.claimedCents).toBe(28800);
    expect(out.split.map((s) => s.payer)).toEqual(["CHAS", "MERIDIAN", "MEDISAVE_FLEXI", "patient"]);
  });

  it("D04b: Meridian warns that Flexi-MediSave, below it now, was sent first, and is not blocked by it", () => {
    const meridian = claimOf(build(d04b(), { settings: insuranceFirst, fixed: sent }), "MERIDIAN");
    expect(meridian.findings).toContainEqual(expect.objectContaining({ code: "lower_payer_sent_first", severity: "warning", params: { scheme: "medisave_flexi" } }));
    expect(meridian.status).toBe("ready");
  });

  it("D04b in the default order: nothing is sent out of turn, so Meridian claims $288 with no such warning", () => {
    const out = build(d04b(), { fixed: sent });
    expect(splitOf(out)).toMatchObject({ CHAS: 62000, MEDISAVE_FLEXI: 40000, MERIDIAN: 28800 });
    expect(codesOf(out, "MERIDIAN")).not.toContain("lower_payer_sent_first");
    expect(out.visitFindings.map((f) => f.code)).not.toContain("sent_claims_exceed_fee");
  });

  it("D04b: sent claims that add up to more than the fee block the visit, and the split still adds up", () => {
    const over = [...sent, { payerId: "MERIDIAN", scheme: "insurance" as const, claimedCents: cents(40000) }];
    const out = build(d04b(), { fixed: over });
    expect(out.visitFindings).toContainEqual(
      expect.objectContaining({ code: "sent_claims_exceed_fee", severity: "blocking", params: { sentCents: 142000, feeCents: 130800 } }),
    );
    expect(out.split.reduce((s, seg) => s + seg.cents, 0)).toBe(130800);
  });

  it("D04b at half the fee after CHAS and Flexi were sent: Meridian stays on the desk, blocked, until the sent claims are amended (QA 03 B1)", () => {
    const v = d04b();
    const halved = { ...v, treatments: v.treatments.map((t) => ({ ...t, feeCents: cents(Math.round(t.feeCents / 2)) })) };
    const out = build(halved, { fixed: sent });
    const fee = out.split.reduce((s, seg) => s + seg.cents, 0);
    expect(fee).toBeLessThan(102000);
    const over = { code: "sent_claims_exceed_fee", severity: "blocking", params: { sentCents: 102000, feeCents: fee } };
    const meridian = claimOf(out, "MERIDIAN");
    expect(meridian).toMatchObject({ claimedCents: 0, status: "needs_attention" });
    expect(meridian.findings).toContainEqual(expect.objectContaining(over));
    expect(out.visitFindings).toContainEqual(expect.objectContaining(over));
  });
});
