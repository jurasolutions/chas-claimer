import { DEFAULT_SETTINGS, parseDeskSettings, payerTokenName } from "./settings";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("desk settings", () => {
  it("ships defaults that parse: two branches, three dentists, the five synthetic payers", () => {
    const parsed = parseDeskSettings(clone(DEFAULT_SETTINGS));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.branches).toHaveLength(2);
    expect(parsed.value.dentists).toHaveLength(3);
    expect(parsed.value.payers.map((p) => p.id)).toEqual(["CHAS", "MEDISAVE_TOSP", "MEDISAVE_FLEXI", "MERIDIAN", "HARBOUR"]);
    expect(parsed.value.waterfall).toEqual(["chas", "medisave", "insurance"]);
    expect(parsed.value.benchmarkOverrides).toEqual([]);
    expect(parsed.value.sourceMapping).toBeNull();
  });

  it("leaves MediSave and insurance deadlines blank by default (blank means no check)", () => {
    const byId = new Map(DEFAULT_SETTINGS.payers.map((p) => [p.id, p]));
    expect(byId.get("MEDISAVE_TOSP")?.deadlineDays).toBeNull();
    expect(byId.get("MEDISAVE_FLEXI")?.deadlineDays).toBeNull();
    expect(byId.get("MERIDIAN")?.deadlineDays).toBeNull();
    expect(byId.get("HARBOUR")?.deadlineDays).toBeNull();
  });

  it("refuses a document missing a required field and names the path", () => {
    const doc = clone(DEFAULT_SETTINGS) as unknown as { branches: Record<string, unknown>[] };
    delete doc.branches[0]!.gstRegistered;
    const parsed = parseDeskSettings(doc);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContainEqual(expect.objectContaining({ path: "branches.0.gstRegistered" }));
  });

  it("refuses a document with no payers list at all", () => {
    const doc = clone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
    delete doc.payers;
    expect(parseDeskSettings(doc).ok).toBe(false);
    expect(parseDeskSettings(null).ok).toBe(false);
  });

  it("accepts a benchmark override only with an https source and an as-of date", () => {
    const withOverride = (o: unknown) => ({ ...clone(DEFAULT_SETTINGS), benchmarkOverrides: [o] });
    const good = { procedureCode: "SCALING", minCents: 3000, maxCents: 8000, sourceUrl: "https://example.test/fees", asOf: "2026-11-01" };
    expect(parseDeskSettings(withOverride(good)).ok).toBe(true);
    const { sourceUrl: _s, ...noSource } = good;
    const { asOf: _a, ...noDate } = good;
    expect(parseDeskSettings(withOverride(noSource)).ok).toBe(false);
    expect(parseDeskSettings(withOverride(noDate)).ok).toBe(false);
    expect(parseDeskSettings(withOverride({ ...good, sourceUrl: "http://example.test/fees" })).ok).toBe(false);
    expect(parseDeskSettings(withOverride({ ...good, asOf: "2026-02-30" })).ok).toBe(false);
    expect(parseDeskSettings(withOverride({ ...good, minCents: 9000 })).ok).toBe(false);
  });

  it("refuses an API URL that is not https, is an IP literal or is localhost", () => {
    const withUrl = (apiUrl: string) => {
      const doc = clone(DEFAULT_SETTINGS);
      doc.payers[3] = { ...doc.payers[3]!, channel: "api", apiUrl, apiAuthHeader: "Authorization" };
      return parseDeskSettings(doc);
    };
    expect(withUrl("https://claims.meridian.example/v1/claims").ok).toBe(true);
    for (const bad of [
      "http://claims.meridian.example/v1",
      "https://10.0.0.5/v1",
      "https://[::1]/v1",
      "https://localhost/v1",
      "https://api.localhost/v1",
      "https://127.0.0.1/v1",
      "https://user:pw@claims.meridian.example/v1",
      "not a url",
    ]) {
      expect(withUrl(bad).ok, bad).toBe(false);
    }
  });

  it("caps a payer's template at 12 fields", () => {
    const withFields = (n: number) => {
      const doc = clone(DEFAULT_SETTINGS) as unknown as { payers: Record<string, unknown>[] };
      doc.payers[0] = { ...doc.payers[0]!, templateFields: Array.from({ length: n }, (_, i) => `field_${i + 1}`) };
      return parseDeskSettings(doc);
    };
    expect(withFields(12).ok).toBe(true);
    expect(withFields(13).ok).toBe(false);
    expect(DEFAULT_SETTINGS.payers.every((p) => p.templateFields.length <= 12)).toBe(true);
  });

  it("takes an optional portal URL per payer, https only, with the API URL's host rules", () => {
    const withPortal = (portalUrl: unknown) => {
      const doc = clone(DEFAULT_SETTINGS) as unknown as { payers: Record<string, unknown>[] };
      doc.payers[0] = { ...doc.payers[0]!, portalUrl };
      return parseDeskSettings(doc);
    };
    const good = withPortal("https://portal.chas.example/claims");
    expect(good.ok && good.value.payers[0]!.portalUrl).toBe("https://portal.chas.example/claims");
    expect(withPortal(null).ok).toBe(true);
    for (const bad of [
      "http://portal.chas.example/claims",
      "https://10.0.0.5/claims",
      "https://localhost/claims",
      "https://user:pw@portal.chas.example/claims",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(withPortal(bad).ok, bad).toBe(false);
    }
  });

  it("ships every portal URL blank, and reads a stored document saved before portal URLs as blank", () => {
    expect(DEFAULT_SETTINGS.payers.map((p) => p.portalUrl)).toEqual(DEFAULT_SETTINGS.payers.map(() => null));
    const older = clone(DEFAULT_SETTINGS) as unknown as { payers: Record<string, unknown>[] };
    for (const p of older.payers) delete p.portalUrl;
    const parsed = parseDeskSettings(older);
    expect(parsed.ok && parsed.value.payers.every((p) => p.portalUrl === null)).toBe(true);
  });

  it("requires an API URL for a payer on the api channel", () => {
    const doc = clone(DEFAULT_SETTINGS);
    doc.payers[3] = { ...doc.payers[3]!, channel: "api", apiUrl: null };
    expect(parseDeskSettings(doc).ok).toBe(false);
  });

  it("refuses payer IDs outside the token-name pattern and duplicate IDs", () => {
    const doc = clone(DEFAULT_SETTINGS);
    doc.payers[3] = { ...doc.payers[3]!, id: "meridian-1" };
    expect(parseDeskSettings(doc).ok).toBe(false);
    const dup = clone(DEFAULT_SETTINGS);
    dup.payers[4] = { ...dup.payers[4]!, id: "MERIDIAN" };
    expect(parseDeskSettings(dup).ok).toBe(false);
  });

  it("refuses a waterfall that is not an order of the three payer levels", () => {
    expect(parseDeskSettings({ ...clone(DEFAULT_SETTINGS), waterfall: ["chas", "chas", "insurance"] }).ok).toBe(false);
    expect(parseDeskSettings({ ...clone(DEFAULT_SETTINGS), waterfall: ["insurance", "medisave", "chas"] }).ok).toBe(true);
  });

  it("derives the API token's variable name from the payer ID, never from settings", () => {
    expect(payerTokenName("MERIDIAN")).toBe("PAYER_MERIDIAN_API_TOKEN");
    expect(() => payerTokenName("ANTHROPIC_API_KEY\n")).toThrow();
  });
});
