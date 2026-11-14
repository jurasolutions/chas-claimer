import { parseSourceMapping, SourceSchemaSchema } from "./source-mapping";

const mapping = {
  amountUnit: "cents",
  visits: {
    table: "appointments",
    fields: { visitKey: "appt_id", patientKey: "patient_id", branchId: "clinic_branch", dentistId: "doctor", date: "appt_date", voided: "is_void" },
  },
  patients: {
    table: "patients",
    key: "id",
    fields: { nric: "ic_no", name: "full_name", phone: "mobile", dateOfBirth: "dob" },
  },
  treatments: {
    table: "appointment_items",
    key: "appt_id",
    fields: { code: "item_code", description: "item_name", fee: "amount", quantity: "qty", tooth: "tooth_no" },
  },
  chasCards: null,
  policies: null,
  medisave: null,
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("source mapping", () => {
  it("accepts a mapping from the desk's visit fields to the clinic's tables and columns", () => {
    const parsed = parseSourceMapping(mapping);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.visits.fields.visitKey).toBe("appt_id");
    expect(parsed.value.chasCards).toBeNull();
  });

  it("refuses a mapping missing a required field and names the path", () => {
    const doc = clone(mapping);
    delete (doc.patients.fields as Record<string, string>).nric;
    const parsed = parseSourceMapping(doc);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContainEqual(expect.objectContaining({ path: "patients.fields.nric" }));
  });

  it("refuses a field the desk does not know", () => {
    const doc = clone(mapping);
    (doc.patients.fields as Record<string, string>).religion = "religion";
    expect(parseSourceMapping(doc).ok).toBe(false);
  });

  it("refuses table and column names that could break out of a quoted SQL identifier", () => {
    for (const bad of ['patients"; DROP TABLE x; --', "a`b", "", "x".repeat(65)]) {
      const doc = clone(mapping);
      doc.patients.table = bad;
      expect(parseSourceMapping(doc).ok, bad).toBe(false);
    }
    const spaced = clone(mapping);
    spaced.patients.fields.name = "Full Name";
    expect(parseSourceMapping(spaced).ok).toBe(true);
  });

  it("maps dentist notes, policy validity and visit-keyed pre-authorisations, and an older mapping without them still parses", () => {
    const doc = clone(mapping) as Record<string, unknown> & typeof mapping;
    (doc.visits.fields as Record<string, string>).notes = "doctor_note";
    (doc as Record<string, unknown>).policies = {
      table: "insurance_policies",
      key: "patient_id",
      fields: { payerId: "insurer_code", memberId: "member_no", plan: "plan_name", validFrom: "valid_from", validTo: "valid_to" },
    };
    (doc as Record<string, unknown>).preAuths = {
      table: "preauthorisations",
      key: "appt_no",
      fields: { payerId: "insurer_code", benefitCode: "benefit_code", reference: "preauth_ref", approvedOn: "approved_on" },
    };
    const parsed = parseSourceMapping(doc);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.visits.fields.notes).toBe("doctor_note");
    expect(parsed.value.policies?.fields.validTo).toBe("valid_to");
    expect(parsed.value.preAuths?.fields.reference).toBe("preauth_ref");

    expect(parseSourceMapping(mapping).ok).toBe(true);
    const noPreAuths = clone(doc) as Record<string, unknown>;
    noPreAuths.preAuths = null;
    expect(parseSourceMapping(noPreAuths).ok).toBe(true);
  });

  it("describes a source by table and column names only", () => {
    expect(SourceSchemaSchema.safeParse({ kind: "sqlite", tables: [{ name: "patients", columns: ["id", "ic_no"] }] }).success).toBe(true);
    expect(SourceSchemaSchema.safeParse({ kind: "sqlite", tables: [{ name: "patients", columns: ["id"], rows: [["1"]] }] }).success).toBe(false);
  });
});
