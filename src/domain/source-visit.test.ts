import fc from "fast-check";
import { generateClinic } from "../../mock/synthetic-clinic/generate";
import { arbSyntheticNric } from "../../tests/helpers/arbitraries";
import type { IsoDate } from "./dates";
import { nricCheckLetter } from "./nric";
import { canonicalJson, joinVisit, parseSourceVisit, splitVisit, type SourceVisit } from "./source-visit";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A synthetic visit as the connector posts it. The only NRIC literal is the reserved T9000000J. */
const visit = {
  visitKey: "V-1001",
  patient: { nric: "t9000000j ", name: "Test Patient One", phone: "0000 0000", dateOfBirth: "1966-07-01" },
  branchId: "BR-CENTRAL",
  dentistId: "DR-A",
  date: "2026-07-01",
  treatments: [
    { code: "SCALE", description: "Scaling and polishing", feeCents: 8000 },
    { code: "CROWN", description: "Crown, porcelain", feeCents: 95000, gstCents: 8550, tooth: "16", completion: "in_progress" },
  ],
  notes: "Test Patient One asked for a longer consultation.",
  chasCards: [{ tier: "Blue", expiry: "2027-03-31" }],
  policies: [
    {
      payerId: "MERIDIAN",
      memberId: "MDP-000123",
      plan: "Gold",
      limitCents: 100000,
      validFrom: "2026-01-01",
      preAuths: [{ benefitCode: "MDP-CROWN", reference: "PA-0001", approvedOn: "2026-06-20" }],
    },
  ],
  medisave: { mcaf: { type: "standing", validFrom: "2026-01-01" } },
};

describe("source visit parsing", () => {
  it("accepts a connector visit and fills the documented defaults", () => {
    const parsed = parseSourceVisit(visit);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const v = parsed.value;
    expect(v.patient.nric).toBe("T9000000J");
    expect(v.voided).toBe(false);
    expect(v.startTime).toBeNull();
    expect(v.patient.address).toBeNull();
    expect(v.treatments[0]).toEqual({
      code: "SCALE",
      description: "Scaling and polishing",
      feeCents: 8000,
      gstCents: null,
      tooth: null,
      quantity: 1,
      completion: "complete",
      completedOn: null,
    });
    expect(v.treatments[1]!.completion).toBe("in_progress");
    expect(v.medisave?.accountHolder).toEqual({ relationship: "self", age: null, nric: null });
    expect(v.medisave?.mcaf).toEqual({ type: "standing", validFrom: "2026-01-01", validTo: null, revokedOn: null });
    expect(v.billedCents).toEqual({});
  });

  it("treats notes, CHAS cards, policies and MediSave as optional", () => {
    const { notes: _n, chasCards: _c, policies: _p, medisave: _m, ...bare } = clone(visit);
    const parsed = parseSourceVisit(bare);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.notes).toBeNull();
    expect(parsed.value.chasCards).toEqual([]);
    expect(parsed.value.policies).toEqual([]);
    expect(parsed.value.medisave).toBeNull();
  });

  it("leaves a policy's validity open and its pre-authorisations empty when the source has none", () => {
    const doc = clone(visit) as unknown as { policies: Record<string, unknown>[] };
    delete doc.policies[0]!.validFrom;
    delete doc.policies[0]!.preAuths;
    const parsed = parseSourceVisit(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policies[0]).toMatchObject({ validFrom: null, validTo: null, preAuths: [] });
  });

  it("carries every CHAS card the patient holds, in source order", () => {
    const doc = { ...clone(visit), chasCards: [{ tier: "MG", expiry: "2027-01-31" }, { tier: "Blue", expiry: "2027-03-31" }] };
    const parsed = parseSourceVisit(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.chasCards.map((c) => c.tier)).toEqual(["MG", "Blue"]);
  });

  it("refuses a pre-authorisation with no reference or an impossible approval date", () => {
    const noRef = clone(visit) as unknown as { policies: { preAuths: Record<string, unknown>[] }[] };
    delete noRef.policies[0]!.preAuths[0]!.reference;
    expect(parseSourceVisit(noRef).ok).toBe(false);
    const badDate = clone(visit);
    badDate.policies[0]!.preAuths[0]!.approvedOn = "2026-02-30";
    const parsed = parseSourceVisit(badDate);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContainEqual(expect.objectContaining({ path: "policies.0.preAuths.0.approvedOn" }));
  });

  it("refuses an NRIC with the wrong check letter, names the path and never echoes the value", () => {
    const doc = clone(visit);
    doc.patient.nric = "T9000000A";
    const parsed = parseSourceVisit(doc);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContainEqual(expect.objectContaining({ path: "patient.nric" }));
    expect(JSON.stringify(parsed.error)).not.toContain("T9000000A");
  });

  it("refuses fees that are not whole, non-negative cents", () => {
    for (const fee of [80.5, -1, "8000"]) {
      const doc = clone(visit) as unknown as { treatments: Record<string, unknown>[] };
      doc.treatments[0]!.feeCents = fee;
      const parsed = parseSourceVisit(doc);
      expect(parsed.ok, String(fee)).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error).toContainEqual(expect.objectContaining({ path: "treatments.0.feeCents" }));
    }
  });

  it("refuses impossible dates, unknown tiers and fields the desk does not know", () => {
    const badDate = clone(visit);
    badDate.date = "2026-02-30";
    expect(parseSourceVisit(badDate).ok).toBe(false);
    const badTier = clone(visit);
    badTier.chasCards[0]!.tier = "Purple";
    expect(parseSourceVisit(badTier).ok).toBe(false);
    const extra = { ...clone(visit), religion: "x" };
    expect(parseSourceVisit(extra).ok).toBe(false);
    expect(parseSourceVisit(null).ok).toBe(false);
  });

  it("requires another account holder's NRIC and age, and refuses an NRIC for the patient's own account", () => {
    const spouse = clone(visit) as unknown as { medisave: Record<string, unknown> };
    spouse.medisave.accountHolder = { relationship: "spouse", age: 62 };
    expect(parseSourceVisit(spouse).ok).toBe(false);
    const self = clone(visit) as unknown as { medisave: Record<string, unknown> };
    self.medisave.accountHolder = { relationship: "self", age: 60, nric: "T9000000J" };
    expect(parseSourceVisit(self).ok).toBe(false);
  });
});

const parsed = (doc: unknown): SourceVisit => {
  const r = parseSourceVisit(doc);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("identity and clinical split", () => {
  it("puts identifiers in identity and the de-identified visit in clinical", () => {
    const { identity, clinical } = splitVisit(parsed(visit));
    expect(identity).toEqual({
      nric: "T9000000J",
      name: "Test Patient One",
      phone: "0000 0000",
      dateOfBirth: "1966-07-01",
      address: null,
      memberIds: [{ payerId: "MERIDIAN", memberId: "MDP-000123" }],
      accountHolderNric: null,
      notes: "Test Patient One asked for a longer consultation.",
      preAuthRefs: [{ payerId: "MERIDIAN", benefitCode: "MDP-CROWN", reference: "PA-0001" }],
    });
    expect(clinical).toMatchObject({
      visitKey: "V-1001",
      branchId: "BR-CENTRAL",
      dentistId: "DR-A",
      date: "2026-07-01",
      ageAtVisit: 60,
      chasCards: [{ tier: "Blue", expiry: "2027-03-31" }],
      policies: [
        {
          payerId: "MERIDIAN",
          plan: "Gold",
          employer: null,
          limitCents: 100000,
          validFrom: "2026-01-01",
          validTo: null,
          preAuths: [{ benefitCode: "MDP-CROWN", approvedOn: "2026-06-20" }],
        },
      ],
      medisave: {
        accountHolder: { relationship: "self", ageAtVisit: 60 },
        mcaf: { type: "standing", validFrom: "2026-01-01", validTo: null, revokedOn: null },
      },
    });
    expect(clinical.treatments).toHaveLength(2);
    expect(clinical).not.toHaveProperty("patient");
    expect(clinical).not.toHaveProperty("notes");
  });

  it("computes age at the visit from the date of birth: 60 on the birthday, 59 the day before", () => {
    expect(splitVisit(parsed({ ...clone(visit), date: "2026-07-01" })).clinical.ageAtVisit).toBe(60);
    expect(splitVisit(parsed({ ...clone(visit), date: "2026-06-30" })).clinical.ageAtVisit).toBe(59);
  });

  it("keeps another account holder's NRIC in identity and only the relationship and age in clinical", () => {
    const doc = clone(visit) as unknown as { medisave: Record<string, unknown> };
    const holder = "T9000001" + nricCheckLetter("T", "9000001");
    doc.medisave.accountHolder = { relationship: "spouse", age: 62, nric: holder };
    const { identity, clinical } = splitVisit(parsed(doc));
    expect(identity.accountHolderNric).toBe(holder);
    expect(clinical.medisave?.accountHolder).toEqual({ relationship: "spouse", ageAtVisit: 62 });
  });

  it("never lets an identifier into the clinical part", () => {
    fc.assert(
      fc.property(
        arbSyntheticNric,
        arbSyntheticNric,
        fc.stringMatching(/^MDP-[0-9]{6}$/),
        fc.stringMatching(/^PA-[0-9]{6}$/),
        (nric, holder, memberId, preAuthRef) => {
        const doc = clone(visit) as unknown as Record<string, any>;
        doc.patient.nric = nric;
        doc.patient.address = "1 Synthetic Road";
        doc.notes = `Spoke to the patient, ${nric}, on 0000 0000.`;
        doc.policies[0].memberId = memberId;
        doc.policies[0].preAuths[0].reference = preAuthRef;
        doc.medisave.accountHolder = { relationship: "parent", age: 70, nric: holder };
        const { identity, clinical } = splitVisit(parsed(doc));
        const text = JSON.stringify(clinical);
        for (const value of [nric, holder, memberId, preAuthRef, "Test Patient One", "0000 0000", "1966-07-01", "1 Synthetic Road"]) {
          expect(text).not.toContain(value);
        }
        expect(identity.nric).toBe(nric);
        expect(identity.address).toBe("1 Synthetic Road");
        expect(identity.notes).toContain(nric);
        expect(identity.preAuthRefs[0]?.reference).toBe(preAuthRef);
        },
      ),
    );
  });
});

describe("joining the parts back into the visit", () => {
  // The re-seal route rebuilds a stored revision's content hash from its two stored halves, so the
  // join must give back the very visit the import hashed, after both halves went through JSON.
  const roundTrip = (v: SourceVisit) => {
    const { identity, clinical } = clone(splitVisit(v));
    return canonicalJson(joinVisit(identity, clinical));
  };

  it("gives back every synthetic clinic visit exactly", () => {
    const clinic = generateClinic({ seed: 7, asOf: "2026-11-13" as IsoDate });
    for (const v of clinic.visits) expect(roundTrip(v)).toBe(canonicalJson(v));
  });

  it("gives back another account holder, several policies and their pre-authorisations in order", () => {
    const doc = clone(visit) as unknown as Record<string, any>;
    doc.patient.address = "1 Synthetic Road";
    doc.medisave.accountHolder = { relationship: "parent", age: 70, nric: "T9000001" + nricCheckLetter("T", "9000001") };
    doc.policies.push({
      payerId: "HARBOUR",
      memberId: "HB-000456",
      plan: "Staff",
      employer: "Synthetic Pte Ltd",
      preAuths: [
        { benefitCode: "HB-ROOT", reference: "PA-0002", approvedOn: "2026-06-21" },
        { benefitCode: "HB-CROWN", reference: "PA-0003", approvedOn: "2026-06-22" },
      ],
    });
    doc.policies.push({ payerId: "QUAY", memberId: "QY-1", plan: "Basic" });
    const v = parsed(doc);
    expect(roundTrip(v)).toBe(canonicalJson(v));
  });

  it("gives back a visit with no MediSave, no policies and no note", () => {
    const doc = clone(visit) as unknown as Record<string, any>;
    delete doc.medisave;
    delete doc.policies;
    delete doc.notes;
    const v = parsed(doc);
    expect(roundTrip(v)).toBe(canonicalJson(v));
  });
});

describe("canonical JSON", () => {
  it("sorts keys at every depth, keeps array order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
    expect(canonicalJson(["b", null, "a"])).toBe('["b",null,"a"]');
    expect(canonicalJson('x"y')).toBe('"x\\"y"');
  });

  it("gives the same text for the same visit whatever the key order", () => {
    const a = splitVisit(parsed(visit)).clinical;
    const reordered = Object.fromEntries(Object.entries(clone(visit)).reverse());
    const b = splitVisit(parsed(reordered)).clinical;
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });
});
