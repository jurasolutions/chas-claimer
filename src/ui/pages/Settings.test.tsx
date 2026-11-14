// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticSettings } from "../../../mock/synthetic-clinic/config";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import type { CodeMapResponse, ResealProgress, ResealStatus, SettingsResponse } from "../../api/settings";
import type { IsoDate } from "../../domain/dates";
import type { RuleSetSummary } from "../../domain/rules";
import type { SourceMapping } from "../../domain/source-mapping";
import type { CodeMapEntry } from "../../domain/types";
import { MeContext } from "../me";
import { Settings } from "./Settings";

// Table and column names only: a mapping never carries a row value.
const { MAPPING } = vi.hoisted(() => ({
  MAPPING: {
    amountUnit: "cents",
    visits: {
      table: "appointments",
      fields: { visitKey: "appt_id", patientKey: "patient_id", branchId: "clinic_branch", dentistId: "doctor", date: "appt_date" },
    },
    patients: { table: "patients", key: "id", fields: { nric: "ic_no", name: "full_name", phone: "mobile", dateOfBirth: "dob" } },
    treatments: { table: "appointment_items", key: "appt_id", fields: { code: "item_code", description: "item_name", fee: "amount" } },
    chasCards: null,
    policies: { table: "insurance", key: "patient_id", fields: { payerId: "insurer", memberId: "member_no", plan: "plan" } },
    medisave: null,
  } satisfies SourceMapping,
}));

// The AI slots belong to ticket 09; here they are buttons that accept a fixed suggestion.
vi.mock("../ai", () => ({
  CodeSuggestion: ({ clinicCode, onAccept }: { clinicCode: string; onAccept(e: CodeMapEntry): void }) => (
    <button
      type="button"
      onClick={() =>
        onAccept({ clinicCode, target: "chas", payerId: "", targetCode: "PROC-SCALE", origin: "ai_accepted", updatedBy: "", updatedAt: "" })
      }
    >
      {`Use the suggestion for ${clinicCode}`}
    </button>
  ),
  MappingProposal: ({ onAccept }: { onAccept(m: SourceMapping): void }) => (
    <button type="button" onClick={() => onAccept(MAPPING)}>
      Use the proposed mapping
    </button>
  ),
}));

const ORIGIN = window.location.origin;
const SETTINGS = `${ORIGIN}/api/settings`;
const CODE_MAP = `${ORIGIN}/api/code-map`;
const REBUILD = `${ORIGIN}/api/settings/rebuild`;
const RESEAL = `${ORIGIN}/api/settings/reseal`;

const officer: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: false };
const reviewer: MeResponse = { email: "reviewer@clinic.test", roles: ["reviewer"], aiConfigured: false, demoMode: false };

const ruleSets: RuleSetSummary[] = [
  {
    id: "chas-2025-10",
    scheme: "chas",
    effectiveFrom: "2025-10-01",
    effectiveTo: null,
    sources: [{ url: "https://www.chas.sg/dental-subsidies", retrieved: "2026-11-13" }],
  },
  // 03 adds the MediSave schemes; until then RuleScheme is only "chas", so these are cast.
  {
    id: "medisave-flexi-2026",
    scheme: "medisave_flexi" as RuleSetSummary["scheme"],
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    sources: [{ url: "https://www.cpf.gov.sg/flexi-medisave", retrieved: "2026-11-12" }],
    note: "Start date unconfirmed",
  },
  {
    id: "medisave-tosp-2024",
    scheme: "medisave_tosp" as RuleSetSummary["scheme"],
    effectiveFrom: "2024-01-01",
    effectiveTo: "2025-12-31",
    sources: [{ url: "https://www.moh.gov.sg/tosp", retrieved: "2026-11-10" }],
    note: "TOSP table, 2024 edition.",
  },
];

function settingsResponse(over: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    version: 4,
    settings: { ...syntheticSettings(), benchmarkOverrides: [] },
    roles: { reviewers: ["reviewer@clinic.test", "owner@clinic.test"], officers: ["officer@clinic.test"] },
    ruleSets,
    approvedByChannel: [],
    ...over,
  };
}

const codeMap: CodeMapResponse = { items: [], unmapped: [] };

const NOTHING_STUCK = { remittanceFiles: 0, remittanceLines: 0 };
/** A desk with one key and nothing left to move. */
const SETTLED: ResealStatus = { version: 1, previousKeySet: false, remaining: 0, previousKeyMissing: false, cantMove: NOTHING_STUCK };

/** GET answers the settings; PUT records the body and answers `saved`. */
function settingsRoute(saved: unknown, status = 200, bodies: unknown[] = []): Answer {
  return async (request) => {
    if (request.method === "GET") return jsonAnswer(settingsResponse())(request);
    bodies.push(await request.json());
    return jsonAnswer(saved, status)(request);
  };
}

const type = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });

function openSettings(me: MeResponse, routes: Record<string, Answer> = {}) {
  const fetchStub = stubNetwork({ [SETTINGS]: jsonAnswer(settingsResponse()), [CODE_MAP]: jsonAnswer(codeMap), [RESEAL]: jsonAnswer(SETTLED), ...routes });
  render(
    <MeContext.Provider value={me}>
      <Settings />
    </MeContext.Provider>,
  );
  return fetchStub;
}

describe("Settings", () => {
  it("AC-8.5: lists reviewers and officers read-only, set in the deployment", async () => {
    openSettings(reviewer);

    const people = await screen.findByRole("region", { name: "People" });
    const [reviewers, officers] = within(people).getAllByRole("list") as [HTMLElement, HTMLElement];
    expect(within(reviewers).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["reviewer@clinic.test", "owner@clinic.test"]);
    expect(within(officers).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["officer@clinic.test"]);
    expect(within(people).queryByRole("textbox")).toBeNull();
    expect(people.textContent).toContain("set in the deployment");
  });

  it("AC-8.1: adds a benchmark override with its source, saves it and rebuilds every batch", async () => {
    const puts: unknown[] = [];
    const rebuilds: unknown[] = [];
    openSettings(reviewer, {
      [SETTINGS]: settingsRoute(
        { version: 5, rebuild: { considered: 100, rebuilt: 3, flagged: 0, remaining: 20, next: { scope: { kind: "all" }, after: "V-100" } } },
        200,
        puts,
      ),
      [REBUILD]: async (request) => {
        rebuilds.push(await request.json());
        return jsonAnswer({ considered: 20, rebuilt: 1, flagged: 1, remaining: 0, next: null })(request);
      },
    });

    const overrides = await screen.findByRole("region", { name: "Benchmark overrides" });
    fireEvent.click(within(overrides).getByRole("button", { name: "Add an override" }));
    const row = within(overrides).getByRole("group", { name: "Override 1" });
    type(within(row).getByLabelText("CHAS procedure"), "CONSULTATION");
    type(within(row).getByLabelText("Lowest fee"), "21.00");
    type(within(row).getByLabelText("Highest fee"), "31.00");
    type(within(row).getByLabelText("Source"), "https://www.example.test/fee-benchmarks");
    type(within(row).getByLabelText("As of"), "2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const status = await screen.findByText("Settings saved. Claims rebuilt for 4 visits; 1 sent claim is marked changed after submission.");
    expect(status.closest("[role=status]")).not.toBeNull();
    expect(puts).toEqual([
      {
        expectedVersion: 4,
        settings: {
          ...settingsResponse().settings,
          benchmarkOverrides: [
            { procedureCode: "CONSULTATION", minCents: 2100, maxCents: 3100, sourceUrl: "https://www.example.test/fee-benchmarks", asOf: "2026-11-01" },
          ],
        },
      },
    ]);
    expect(rebuilds).toEqual([{ scope: { kind: "all" }, after: "V-100" }]);
  });

  it("AC-8.1: refuses an override with no source and sends nothing", async () => {
    const puts: unknown[] = [];
    openSettings(reviewer, { [SETTINGS]: settingsRoute({}, 200, puts) });

    const overrides = await screen.findByRole("region", { name: "Benchmark overrides" });
    fireEvent.click(within(overrides).getByRole("button", { name: "Add an override" }));
    const row = within(overrides).getByRole("group", { name: "Override 1" });
    type(within(row).getByLabelText("CHAS procedure"), "CONSULTATION");
    type(within(row).getByLabelText("Lowest fee"), "21.00");
    type(within(row).getByLabelText("Highest fee"), "31.00");
    type(within(row).getByLabelText("As of"), "2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was saved");
    const source = within(row).getByLabelText("Source");
    expect(source.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(source.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Add the page this range comes from.");
    await waitFor(() => expect(document.activeElement).toBe(source));
    expect(puts).toEqual([]);
  });

  it("AC-8.1: removes an override already on file and saves without it", async () => {
    const onFile = { procedureCode: "CONSULTATION", minCents: 2100, maxCents: 3100, sourceUrl: "https://www.example.test/fee-benchmarks", asOf: "2026-11-01" as IsoDate };
    const kept = { ...onFile, procedureCode: "SCALING" };
    const stored = settingsResponse({ settings: { ...syntheticSettings(), benchmarkOverrides: [onFile, kept] } });
    const puts: Array<{ settings: SettingsResponse["settings"] }> = [];
    openSettings(reviewer, {
      [SETTINGS]: async (request) => {
        if (request.method === "GET") return jsonAnswer(stored)(request);
        puts.push((await request.json()) as { settings: SettingsResponse["settings"] });
        return jsonAnswer({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } })(request);
      },
    });

    const overrides = await screen.findByRole("region", { name: "Benchmark overrides" });
    fireEvent.click(within(overrides).getByRole("button", { name: "Remove override 1" }));
    expect(within(overrides).getAllByRole("group").map((g) => (within(g).getByLabelText("CHAS procedure") as HTMLInputElement).value)).toEqual(["SCALING"]);
    await waitFor(() => expect(document.activeElement).toBe(within(overrides).getByRole("button", { name: "Add an override" })));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]?.settings.benchmarkOverrides).toEqual([kept]);
  });

  it("AC-8.4: an officer reads every setting but cannot change or save one", async () => {
    openSettings(officer);

    const overrides = await screen.findByRole("region", { name: "Benchmark overrides" });
    expect(screen.getByText("Only reviewers change settings. You can read them here.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(within(overrides).getByRole("button", { name: "Add an override" }).closest("fieldset")?.disabled).toBe(true);
  });

  it("AC-8.2: switches a dentist's MediSave accreditation off and saves it", async () => {
    const puts: Array<{ settings: SettingsResponse["settings"] }> = [];
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 2, rebuilt: 2, flagged: 0, remaining: 0, next: null } }, 200, puts) });

    const dentists = await screen.findByRole("region", { name: "Dentists" });
    const dentistB = within(dentists).getByRole("checkbox", { name: "Dentist B is MediSave accredited" });
    expect((dentistB as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dentistB);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. Claims rebuilt for 2 visits.");
    expect(puts[0]?.settings.dentists.find((d) => d.id === "DR-B")?.medisaveAccredited).toBe(false);
  });

  it("records a branch's GST and scheme registrations", async () => {
    const puts: Array<{ settings: SettingsResponse["settings"] }> = [];
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } }, 200, puts) });

    const west = await screen.findByRole("group", { name: "West branch" });
    expect((within(west).getByRole("checkbox", { name: "GST registered" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(west).getByRole("checkbox", { name: "GST registered" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. No claims needed rebuilding.");
    expect(puts[0]?.settings.branches.find((b) => b.id === "BR-WEST")).toMatchObject({ gstRegistered: true, chasRegistered: true, medisaveRegistered: true });
  });

  it("puts focus on what the save did once its rebuild settles (QA 03 D02f)", async () => {
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } }) });

    const west = await screen.findByRole("group", { name: "West branch" });
    fireEvent.click(within(west).getByRole("checkbox", { name: "GST registered" }));
    const saveButton = screen.getByRole("button", { name: "Save settings" });
    saveButton.focus();
    fireEvent.click(saveButton);

    const status = (await screen.findByText("Settings saved. No claims needed rebuilding.")).closest("[role=status]");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("reorders the payer waterfall", async () => {
    const puts: Array<{ settings: SettingsResponse["settings"] }> = [];
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } }, 200, puts) });

    const waterfall = await screen.findByRole("region", { name: "Payer waterfall" });
    const order = () => within(waterfall).getAllByRole("listitem").map((li) => li.querySelector(".settings-waterfall__name")?.textContent);
    expect(order()).toEqual(["CHAS", "MediSave", "Insurance"]);
    expect((within(waterfall).getByRole("button", { name: "Move CHAS up" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(waterfall).getByRole("button", { name: "Move Insurance up" }));
    expect(order()).toEqual(["CHAS", "Insurance", "MediSave"]);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. No claims needed rebuilding.");
    expect(puts[0]?.settings.waterfall).toEqual(["chas", "insurance", "medisave"]);
  });

  it("says, beside the waterfall, that a change rebuilds unsent claims and a withdrawn one can't come back from the desk yet", async () => {
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } }) });

    const waterfall = await screen.findByRole("region", { name: "Payer waterfall" });
    const note = within(waterfall).getByText(/rebuilds unsent claims/);
    expect(note.textContent).toBe(
      "Changing the order rebuilds unsent claims. A claim the new order no longer builds is withdrawn, and you can't bring it back from the desk yet.",
    );
  });

  it("shows each rule set read-only, with when it applies and where it came from", async () => {
    openSettings(reviewer);

    const rules = await screen.findByRole("region", { name: "Rule sets" });
    const [chas, flexi, tosp] = within(rules).getAllByRole("article") as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(chas).getByRole("heading").textContent).toBe("CHAS");
    expect(chas.textContent).toContain("From 1 Oct 2025");
    const source = within(chas).getByRole("link", { name: "https://www.chas.sg/dental-subsidies" });
    expect(source.getAttribute("href")).toBe("https://www.chas.sg/dental-subsidies");
    expect(chas.textContent).toContain("as of 13 Nov 2026");

    expect(within(flexi).getByRole("heading").textContent).toBe("Flexi-MediSave");
    expect(flexi.textContent).toContain("Start date unconfirmed");
    expect(within(tosp).getByRole("heading").textContent).toBe("Surgical MediSave (TOSP)");
    expect(tosp.textContent).toContain("1 Jan 2024 to 31 Dec 2025");
    expect(tosp.textContent).toContain("TOSP table, 2024 edition.");
    expect(within(rules).queryByRole("textbox")).toBeNull();
  });

  it("S15: changing a payer's channel says approved claims keep the channel they were approved with", async () => {
    const puts: unknown[] = [];
    openSettings(reviewer, {
      [SETTINGS]: async (request) =>
        request.method === "GET"
          ? jsonAnswer(settingsResponse({ approvedByChannel: [{ payerId: "HARBOUR", channel: "file", count: 3 }] }))(request)
          : settingsRoute({}, 200, puts)(request),
    });

    const harbour = await screen.findByRole("group", { name: "Harbour TPA" });
    expect(within(harbour).queryByText(/approved claims/)).toBeNull();

    fireEvent.change(within(harbour).getByLabelText("Channel"), { target: { value: "api" } });

    const hint = within(harbour).getByText("3 approved claims will still use the file channel.");
    expect(within(harbour).getByLabelText("Channel").getAttribute("aria-describedby")).toContain(hint.id);
  });
});

const entry = (over: Partial<CodeMapEntry>): CodeMapEntry => ({
  clinicCode: "XRAY-BW",
  target: "chas",
  payerId: "",
  targetCode: null,
  origin: "manual",
  updatedBy: "reviewer@clinic.test",
  updatedAt: "2026-11-01T02:00:00.000Z",
  ...over,
});

const mapped: CodeMapEntry[] = [entry({}), entry({ clinicCode: "CROWN-01", target: "benefit", payerId: "MERIDIAN", targetCode: "B-CROWN" })];
const SCALE = { clinicCode: "SCALE-01", description: "Scaling and polishing", visits: 3 };

/** GET answers the map, with SCALE-01 unmapped until a PUT maps it; each PUT body is recorded. */
function codeMapRoutes(puts: Array<{ url: string; body: unknown }>, rebuilds: unknown[] = []): Record<string, Answer> {
  let saved: CodeMapEntry | null = null;
  const put: Answer = async (request) => {
    const body = (await request.json()) as { targetCode: string | null; origin: CodeMapEntry["origin"] };
    puts.push({ url: request.url.slice(ORIGIN.length), body });
    saved = entry({ clinicCode: "SCALE-01", targetCode: body.targetCode, origin: body.origin });
    return jsonAnswer({
      entry: saved,
      rebuild: { considered: 3, rebuilt: 3, flagged: 0, remaining: 2, next: { scope: { kind: "clinic_code", clinicCode: "SCALE-01" }, after: "V-3" } },
    })(request);
  };
  return {
    [CODE_MAP]: (request) => jsonAnswer(saved ? { items: [...mapped, saved], unmapped: [] } : { items: mapped, unmapped: [SCALE] })(request),
    [`${CODE_MAP}/SCALE-01/chas/-`]: put,
    [`${CODE_MAP}/SCALE-01/benefit/HARBOUR`]: put,
    [REBUILD]: async (request) => {
      rebuilds.push(await request.json());
      return jsonAnswer({ considered: 2, rebuilt: 2, flagged: 0, remaining: 0, next: null })(request);
    },
  };
}

function addOverride(overrides: HTMLElement) {
  fireEvent.click(within(overrides).getByRole("button", { name: "Add an override" }));
  const row = within(overrides).getByRole("group", { name: "Override 1" });
  type(within(row).getByLabelText("CHAS procedure"), "CONSULTATION");
  type(within(row).getByLabelText("Lowest fee"), "21.00");
  type(within(row).getByLabelText("Highest fee"), "31.00");
  type(within(row).getByLabelText("Source"), "https://www.example.test/fee-benchmarks");
  type(within(row).getByLabelText("As of"), "2026-11-01");
  return row;
}

const refused: Answer = () => {
  throw new TypeError("Failed to fetch");
};

describe("Settings: when a save fails", () => {
  it("marks the field the server refused, and keeps the draft", async () => {
    openSettings(reviewer, {
      [SETTINGS]: settingsRoute(
        {
          error: "invalid",
          issues: [{ path: "settings.benchmarkOverrides.0.procedureCode", message: "MOH publishes a benchmark for CONSULTATION, so the desk uses that one." }],
        },
        400,
      ),
    });

    const row = addOverride(await screen.findByRole("region", { name: "Benchmark overrides" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was saved.");
    const code = within(row).getByLabelText("CHAS procedure") as HTMLInputElement;
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(code.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "MOH publishes a benchmark for CONSULTATION, so the desk uses that one.",
    );
    expect(code.value).toBe("CONSULTATION");
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Saving settings|Settings saved/)).toBeNull();
  });

  it("says when someone else saved first, and loads their settings on request", async () => {
    const fetchStub = openSettings(reviewer, { [SETTINGS]: settingsRoute({ error: "stale", currentVersion: 5 }, 409) });

    addOverride(await screen.findByRole("region", { name: "Benchmark overrides" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was saved.");
    expect(alert.textContent).toContain("Someone else saved settings after you opened this page.");
    fireEvent.click(within(alert).getByRole("button", { name: "Load the latest settings" }));

    const overrides = await screen.findByRole("region", { name: "Benchmark overrides" });
    expect(within(overrides).queryByRole("group", { name: "Override 1" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const reads = fetchStub.mock.calls.filter(([input, init]) => String(input) === SETTINGS && (init?.method ?? "GET") === "GET");
    expect(reads).toHaveLength(2);
  });

  it("says nothing was saved when the connection fails, and lets you try again", async () => {
    openSettings(reviewer, { [SETTINGS]: (request) => (request.method === "GET" ? jsonAnswer(settingsResponse())(request) : refused(request)) });

    addOverride(await screen.findByRole("region", { name: "Benchmark overrides" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was saved.");
    expect(alert.textContent).toContain("Check your connection, then try again.");
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says the save was refused when you are no longer a reviewer", async () => {
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ error: "forbidden" }, 403) });

    addOverride(await screen.findByRole("region", { name: "Benchmark overrides" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Only reviewers change settings.");
  });

  it("shows only the latest outcome: a refused save clears the earlier 'Settings saved' (QA D08)", async () => {
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 7, rebuilt: 7, flagged: 0, remaining: 0, next: null } }) });

    const dentists = await screen.findByRole("region", { name: "Dentists" });
    fireEvent.click(within(dentists).getByRole("checkbox", { name: "Dentist B is MediSave accredited" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved. Claims rebuilt for 7 visits.");

    const overrides = screen.getByRole("region", { name: "Benchmark overrides" });
    fireEvent.click(within(overrides).getByRole("button", { name: "Add an override" }));
    const row = within(overrides).getByRole("group", { name: "Override 1" });
    type(within(row).getByLabelText("CHAS procedure"), "CONSULTATION");
    type(within(row).getByLabelText("Lowest fee"), "21.00");
    type(within(row).getByLabelText("Highest fee"), "31.00");
    type(within(row).getByLabelText("As of"), "2026-11-01");
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Nothing was saved.");
    expect(screen.queryByText(/Settings saved/)).toBeNull();
  });

  it("says where a rebuild stopped, and carries on from there", async () => {
    const rebuilds: unknown[] = [];
    let attempts = 0;
    openSettings(reviewer, {
      [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 100, rebuilt: 3, flagged: 0, remaining: 20, next: { scope: { kind: "all" }, after: "V-100" } } }),
      [REBUILD]: async (request) => {
        attempts += 1;
        if (attempts === 1) return refused(request);
        rebuilds.push(await request.json());
        return jsonAnswer({ considered: 20, rebuilt: 1, flagged: 1, remaining: 0, next: null })(request);
      },
    });

    addOverride(await screen.findByRole("region", { name: "Benchmark overrides" }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. Rebuilding claims stopped with 20 visits still to go.");
    fireEvent.click(screen.getByRole("button", { name: "Carry on rebuilding" }));

    await screen.findByText("Settings saved. Claims rebuilt for 4 visits; 1 sent claim is marked changed after submission.");
    expect(rebuilds).toEqual([{ scope: { kind: "all" }, after: "V-100" }]);
    expect(screen.queryByRole("button", { name: "Carry on rebuilding" })).toBeNull();
  });
});

describe("Settings: code map", () => {
  it("lists each mapping under its clinic code, with its target, and what nothing claims", async () => {
    openSettings(reviewer, codeMapRoutes([]));

    const map = await screen.findByRole("region", { name: "Code map" });
    const xray = within(await within(map).findByRole("list", { name: "XRAY-BW" })).getAllByRole("listitem");
    expect(xray).toHaveLength(1);
    expect(xray[0]?.textContent).toContain("CHAS procedure");
    expect(xray[0]?.textContent).toContain("Not claimable");
    const crown = within(within(map).getByRole("list", { name: "CROWN-01" })).getAllByRole("listitem");
    expect(crown[0]?.textContent).toContain("Insurer benefit code, Meridian Dental Plan");
    expect(crown[0]?.textContent).toContain("B-CROWN");
    expect(within(map).getByRole("form", { name: "SCALE-01" }).textContent).toContain("Scaling and polishing, on 3 visits");
  });

  it("says that a mapping change rebuilds unsent claims and a withdrawn one can't come back from the desk yet", async () => {
    openSettings(reviewer, codeMapRoutes([]));

    const map = await screen.findByRole("region", { name: "Code map" });
    await within(map).findByRole("list", { name: "XRAY-BW" });
    expect(within(map).getByText(/rebuilds unsent claims/).textContent).toBe(
      "Each change rebuilds unsent claims for visits carrying that code. A claim the change no longer builds is withdrawn, and you can't bring it back from the desk yet.",
    );
  });

  it("maps an unmapped clinic code, then rebuilds every visit carrying it", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    const rebuilds: unknown[] = [];
    openSettings(reviewer, codeMapRoutes(puts, rebuilds));

    const map = await screen.findByRole("region", { name: "Code map" });
    const form = await within(map).findByRole("form", { name: "SCALE-01" });
    fireEvent.click(within(form).getByRole("button", { name: "Save mapping" }));
    expect(within(form).getByText("Enter the code, or mark it not claimable.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText("Code")));
    expect(puts).toEqual([]);

    type(within(form).getByLabelText("Code"), " PROC-SCALE ");
    fireEvent.click(within(form).getByRole("button", { name: "Save mapping" }));

    expect(await within(map).findByText("SCALE-01 mapped. Claims rebuilt for 5 visits.")).toBeTruthy();
    expect(puts).toEqual([{ url: "/api/code-map/SCALE-01/chas/-", body: { targetCode: "PROC-SCALE", origin: "manual" } }]);
    expect(rebuilds).toEqual([{ scope: { kind: "clinic_code", clinicCode: "SCALE-01" }, after: "V-3" }]);
    expect(within(map).queryByRole("form", { name: "SCALE-01" })).toBeNull();
  });

  it("puts focus on what the mapping did once its rebuild settles, as its form goes (QA 03 D02b)", async () => {
    openSettings(reviewer, codeMapRoutes([]));

    const map = await screen.findByRole("region", { name: "Code map" });
    const form = await within(map).findByRole("form", { name: "SCALE-01" });
    type(within(form).getByLabelText("Code"), "PROC-SCALE");
    const saveButton = within(form).getByRole("button", { name: "Save mapping" });
    saveButton.focus();
    fireEvent.click(saveButton);

    const status = (await within(map).findByText("SCALE-01 mapped. Claims rebuilt for 5 visits.")).closest("[role=status]");
    await waitFor(() => expect(within(map).queryByRole("form", { name: "SCALE-01" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(status);
  });

  it("says the mapping was saved when its rebuild stops, and carries on from there", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    const rebuilds: unknown[] = [];
    const routes = codeMapRoutes(puts, rebuilds);
    const rebuild = routes[REBUILD] as Answer;
    let attempts = 0;
    openSettings(reviewer, {
      ...routes,
      [REBUILD]: (request) => {
        attempts += 1;
        return attempts === 1 ? refused(request) : rebuild(request);
      },
    });

    const map = await screen.findByRole("region", { name: "Code map" });
    const form = await within(map).findByRole("form", { name: "SCALE-01" });
    type(within(form).getByLabelText("Code"), "PROC-SCALE");
    fireEvent.click(within(form).getByRole("button", { name: "Save mapping" }));

    expect(await within(map).findByText("SCALE-01 mapped. Rebuilding claims stopped with 2 visits still to go.")).toBeTruthy();
    expect(within(map).queryByRole("alert")).toBeNull();
    expect(within(map).queryByRole("form", { name: "SCALE-01" })).toBeNull();
    fireEvent.click(within(map).getByRole("button", { name: "Carry on rebuilding" }));

    expect(await within(map).findByText("SCALE-01 mapped. Claims rebuilt for 5 visits.")).toBeTruthy();
    expect(rebuilds).toEqual([{ scope: { kind: "clinic_code", clinicCode: "SCALE-01" }, after: "V-3" }]);
    expect(within(map).queryByRole("button", { name: "Carry on rebuilding" })).toBeNull();
  });

  it("marks a code not claimable under one insurer", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    openSettings(reviewer, codeMapRoutes(puts));

    const form = await screen.findByRole("form", { name: "SCALE-01" });
    fireEvent.change(within(form).getByLabelText("Map to"), { target: { value: "benefit" } });
    fireEvent.change(within(form).getByLabelText("Insurer"), { target: { value: "HARBOUR" } });
    fireEvent.click(within(form).getByLabelText("Not claimable"));
    expect((within(form).getByLabelText("Code") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Save mapping" }));

    await screen.findByText("SCALE-01 mapped. Claims rebuilt for 5 visits.");
    expect(puts).toEqual([{ url: "/api/code-map/SCALE-01/benefit/HARBOUR", body: { targetCode: null, origin: "manual" } }]);
  });

  it("offers the AI code suggestion and records an accepted one as accepted from AI", async () => {
    const puts: Array<{ url: string; body: unknown }> = [];
    openSettings(reviewer, codeMapRoutes(puts));

    fireEvent.click(await screen.findByRole("button", { name: "Use the suggestion for SCALE-01" }));

    await screen.findByText("SCALE-01 mapped. Claims rebuilt for 5 visits.");
    expect(puts).toEqual([{ url: "/api/code-map/SCALE-01/chas/-", body: { targetCode: "PROC-SCALE", origin: "ai_accepted" } }]);
  });

  it("AC-8.4: an officer reads the code map but cannot map a code", async () => {
    openSettings(officer, codeMapRoutes([]));

    const form = await screen.findByRole("form", { name: "SCALE-01" });
    expect(within(form).getByRole("button", { name: "Save mapping" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Use the suggestion for SCALE-01" })).toBeNull();
    const crown = screen.getByRole("list", { name: "CROWN-01" }).closest("li") as HTMLElement;
    expect(within(crown).queryAllByRole("button")).toEqual([]);
  });
});

type Call = { method: string; url: string; body?: unknown };

/** The mapped entries, each changeable and removable; every PUT and DELETE is recorded and lands. */
function editableRoutes(calls: Call[], answers: Partial<Record<string, Answer>> = {}): Record<string, Answer> {
  let items = [...mapped];
  const done = { considered: 1, rebuilt: 1, flagged: 0, remaining: 0, next: null };
  const keyed =
    (clinicCode: string, target: CodeMapEntry["target"], payerId: string): Answer =>
    async (request) => {
      const url = request.url.slice(ORIGIN.length);
      items = items.filter((e) => !(e.clinicCode === clinicCode && e.target === target && e.payerId === payerId));
      if (request.method === "DELETE") {
        calls.push({ method: "DELETE", url });
        return jsonAnswer({ rebuild: done })(request);
      }
      const body = (await request.json()) as { targetCode: string | null; origin: CodeMapEntry["origin"] };
      calls.push({ method: request.method, url, body });
      const saved = entry({ clinicCode, target, payerId, targetCode: body.targetCode, origin: body.origin });
      items = [...items, saved];
      return jsonAnswer({ entry: saved, rebuild: done })(request);
    };
  const routes: Record<string, Answer> = {
    [CODE_MAP]: (request) => jsonAnswer({ items, unmapped: [] })(request),
    [`${CODE_MAP}/XRAY-BW/chas/-`]: keyed("XRAY-BW", "chas", ""),
    [`${CODE_MAP}/CROWN-01/benefit/MERIDIAN`]: keyed("CROWN-01", "benefit", "MERIDIAN"),
    [`${CODE_MAP}/CROWN-01/tosp/-`]: keyed("CROWN-01", "tosp", ""),
  };
  for (const [url, answer] of Object.entries(answers)) if (answer) routes[url] = answer;
  return routes;
}

/** The list item holding one clinic code's mappings and their actions. */
const group = async (clinicCode: string) => (await screen.findByRole("list", { name: clinicCode })).closest("li") as HTMLElement;

describe("Settings: changing the code map", () => {
  it("corrects a mapping already on file, keeping its target", async () => {
    const calls: Call[] = [];
    openSettings(reviewer, editableRoutes(calls));

    const crown = await group("CROWN-01");
    fireEvent.click(within(crown).getByRole("button", { name: "Change CROWN-01, Insurer benefit code, Meridian Dental Plan" }));
    const form = within(crown).getByRole("form", { name: "Change CROWN-01, Insurer benefit code, Meridian Dental Plan" });
    expect(within(form).queryByLabelText("Map to")).toBeNull();
    const code = within(form).getByLabelText("Code") as HTMLInputElement;
    expect(code.value).toBe("B-CROWN");
    await waitFor(() => expect(document.activeElement).toBe(code));
    type(code, "B-CROWN-2");
    fireEvent.click(within(form).getByRole("button", { name: "Save change" }));

    expect(await screen.findByText("CROWN-01 mapped. Claims rebuilt for 1 visit.")).toBeTruthy();
    expect(calls).toEqual([{ method: "PUT", url: "/api/code-map/CROWN-01/benefit/MERIDIAN", body: { targetCode: "B-CROWN-2", origin: "manual" } }]);
    const after = await group("CROWN-01");
    await waitFor(() => expect(within(after).queryByRole("form")).toBeNull());
    expect(after.textContent).toContain("B-CROWN-2");
  });

  it("turns a not-claimable mapping into a code, and cancels a change without saving", async () => {
    const calls: Call[] = [];
    openSettings(reviewer, editableRoutes(calls));

    const xray = await group("XRAY-BW");
    const change = within(xray).getByRole("button", { name: "Change XRAY-BW, CHAS procedure" });
    fireEvent.click(change);
    let form = within(xray).getByRole("form");
    expect((within(form).getByRole("checkbox", { name: "Not claimable" }) as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText("Code") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(within(xray).queryByRole("form")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(xray).getByRole("button", { name: "Change XRAY-BW, CHAS procedure" })));
    expect(calls).toEqual([]);

    fireEvent.click(within(xray).getByRole("button", { name: "Change XRAY-BW, CHAS procedure" }));
    form = within(xray).getByRole("form");
    fireEvent.click(within(form).getByRole("checkbox", { name: "Not claimable" }));
    type(within(form).getByLabelText("Code"), "PROC-SCALE");
    fireEvent.click(within(form).getByRole("button", { name: "Save change" }));

    await screen.findByText("XRAY-BW mapped. Claims rebuilt for 1 visit.");
    expect(calls).toEqual([{ method: "PUT", url: "/api/code-map/XRAY-BW/chas/-", body: { targetCode: "PROC-SCALE", origin: "manual" } }]);
  });

  it("removes a mapping once you confirm, then rebuilds the visits carrying the code", async () => {
    const calls: Call[] = [];
    openSettings(reviewer, editableRoutes(calls));

    const xray = await group("XRAY-BW");
    fireEvent.click(within(xray).getByRole("button", { name: "Remove XRAY-BW, CHAS procedure" }));
    expect(calls).toEqual([]);
    fireEvent.click(within(xray).getByRole("button", { name: "Keep it" }));
    expect(within(xray).queryByRole("button", { name: "Yes, remove it" })).toBeNull();

    fireEvent.click(within(xray).getByRole("button", { name: "Remove XRAY-BW, CHAS procedure" }));
    fireEvent.click(within(xray).getByRole("button", { name: "Yes, remove it" }));

    expect(await screen.findByText("XRAY-BW mapping removed. Claims rebuilt for 1 visit.")).toBeTruthy();
    expect(calls).toEqual([{ method: "DELETE", url: "/api/code-map/XRAY-BW/chas/-" }]);
    await waitFor(() => expect(screen.queryByRole("list", { name: "XRAY-BW" })).toBeNull());
  });

  it("keeps focus off the body after adding a mapping and after a remove (QA 03 D02b)", async () => {
    openSettings(reviewer, editableRoutes([]));

    const crown = await group("CROWN-01");
    fireEvent.click(within(crown).getByRole("button", { name: "Add a mapping for CROWN-01" }));
    const form = within(crown).getByRole("form", { name: "Add a mapping for CROWN-01" });
    fireEvent.change(within(form).getByLabelText("Map to"), { target: { value: "tosp" } });
    type(within(form).getByLabelText("Code"), "T-CROWN");
    const saveButton = within(form).getByRole("button", { name: "Save mapping" });
    saveButton.focus();
    fireEvent.click(saveButton);

    const map = screen.getByRole("region", { name: "Code map" });
    const status = (await within(map).findByText("CROWN-01 mapped. Claims rebuilt for 1 visit.")).closest("[role=status]");
    await waitFor(() => expect(within(map).queryByRole("form", { name: "Add a mapping for CROWN-01" })).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect([status, within(crown).queryByRole("button", { name: "Add a mapping for CROWN-01" })]).toContain(document.activeElement);

    const xray = await group("XRAY-BW");
    fireEvent.click(within(xray).getByRole("button", { name: "Remove XRAY-BW, CHAS procedure" }));
    const yes = within(xray).getByRole("button", { name: "Yes, remove it" });
    yes.focus();
    fireEvent.click(yes);

    await within(map).findByText("XRAY-BW mapping removed. Claims rebuilt for 1 visit.");
    await waitFor(() => expect(screen.queryByRole("list", { name: "XRAY-BW" })).toBeNull());
    expect(document.activeElement).toBe(status);
  });

  it("says nothing was removed when the connection fails", async () => {
    const calls: Call[] = [];
    openSettings(reviewer, editableRoutes(calls, { [`${CODE_MAP}/XRAY-BW/chas/-`]: refused }));

    const xray = await group("XRAY-BW");
    fireEvent.click(within(xray).getByRole("button", { name: "Remove XRAY-BW, CHAS procedure" }));
    fireEvent.click(within(xray).getByRole("button", { name: "Yes, remove it" }));

    const alert = await within(xray).findByRole("alert");
    expect(alert.textContent).toContain("Nothing was removed.");
    expect(alert.textContent).toContain("Check your connection, then try again.");
    expect(within(xray).getByRole("button", { name: "Remove XRAY-BW, CHAS procedure" })).toBeTruthy();
  });

  it("adds a mapping for another target, offering only the ones not yet on file", async () => {
    const calls: Call[] = [];
    openSettings(reviewer, editableRoutes(calls));

    const crown = await group("CROWN-01");
    fireEvent.click(within(crown).getByRole("button", { name: "Add a mapping for CROWN-01" }));
    const form = within(crown).getByRole("form", { name: "Add a mapping for CROWN-01" });
    fireEvent.change(within(form).getByLabelText("Map to"), { target: { value: "benefit" } });
    const insurers = within(within(form).getByLabelText("Insurer")).getAllByRole("option").map((o) => o.textContent);
    expect(insurers).not.toContain("Meridian Dental Plan");
    expect(insurers.length).toBeGreaterThan(0);
    fireEvent.change(within(form).getByLabelText("Map to"), { target: { value: "tosp" } });
    type(within(form).getByLabelText("Code"), "T-CROWN");
    fireEvent.click(within(form).getByRole("button", { name: "Save mapping" }));

    await screen.findByText("CROWN-01 mapped. Claims rebuilt for 1 visit.");
    expect(calls).toEqual([{ method: "PUT", url: "/api/code-map/CROWN-01/tosp/-", body: { targetCode: "T-CROWN", origin: "manual" } }]);
    const xray = await group("XRAY-BW");
    fireEvent.click(within(xray).getByRole("button", { name: "Add a mapping for XRAY-BW" }));
    const targets = within(within(xray).getByLabelText("Map to")).getAllByRole("option").map((o) => o.textContent);
    expect(targets).not.toContain("CHAS procedure");
  });
});

// jsdom's Blob has no text(); FileReader is what it does implement.
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe("Settings: clinic database", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the AI mapping proposal and saves an accepted one with the settings", async () => {
    const puts: Array<{ settings: SettingsResponse["settings"] }> = [];
    openSettings(reviewer, { [SETTINGS]: settingsRoute({ version: 5, rebuild: { considered: 0, rebuilt: 0, flagged: 0, remaining: 0, next: null } }, 200, puts) });

    const database = await screen.findByRole("region", { name: "Clinic database" });
    expect(database.textContent).toContain("No mapping is saved yet.");
    expect(within(database).queryByRole("button", { name: "Download mapping file" })).toBeNull();

    fireEvent.click(within(database).getByRole("button", { name: "Use the proposed mapping" }));

    expect(within(database).getByText("Mapping accepted. Save settings to keep it.")).toBeTruthy();
    const tables = within(database).getByRole("list", { name: "Mapped tables" });
    expect(within(tables).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Visits: appointments",
      "Patients: patients",
      "Treatment lines: appointment_items",
      "CHAS cards: not held",
      "Insurance policies: insurance",
      "MediSave details: not held",
      "Amounts: in cents",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await screen.findByText("Settings saved. No claims needed rebuilding.");
    expect(puts[0]?.settings.sourceMapping).toEqual(MAPPING);
  });

  it("downloads the saved mapping as a file, for an officer too", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:mapping";
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const withMapping = settingsResponse();
    withMapping.settings.sourceMapping = MAPPING;
    openSettings(officer, { [SETTINGS]: jsonAnswer(withMapping) });

    const database = await screen.findByRole("region", { name: "Clinic database" });
    expect(within(database).queryByRole("button", { name: "Use the proposed mapping" })).toBeNull();
    fireEvent.click(within(database).getByRole("button", { name: "Download mapping file" }));

    expect(clicked.map((a) => [a.download, a.href])).toEqual([["clinic-database-mapping.json", "blob:mapping"]]);
    expect(JSON.parse(await blobText(created[0] as Blob))).toEqual(MAPPING);
    expect(created[0]?.type).toBe("application/json");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mapping");
  });
});

describe("Settings: identifier key (infra I1, review B1)", () => {
  const rotated: ResealStatus = { version: 2, previousKeySet: true, remaining: 120, previousKeyMissing: false, cantMove: NOTHING_STUCK };
  const batch = (over: Partial<ResealProgress>): ResealProgress => ({
    moved: 0,
    failed: 0,
    failures: [],
    remaining: 0,
    previousKeyMissing: false,
    cantMove: NOTHING_STUCK,
    next: null,
    ...over,
  });

  /** GET answers `status`; each POST records its body and gets the next answer in turn. */
  function resealRoute(status: ResealStatus, answers: Answer[] = [], bodies: unknown[] = []): Answer {
    let i = 0;
    return async (request) => {
      if (request.method === "GET") return jsonAnswer(status)(request);
      bodies.push(await request.clone().json());
      const answer = answers[i] ?? refused;
      i += 1;
      return answer(request);
    };
  }

  it("moves stored identities batch by batch, lists the ones it could not open, and says what can't move", async () => {
    const bodies: unknown[] = [];
    openSettings(reviewer, {
      [RESEAL]: resealRoute(
        rotated,
        [
          jsonAnswer(batch({ moved: 50, remaining: 70, next: { after: "cursor-1" } })),
          jsonAnswer(
            batch({
              moved: 68,
              failed: 2,
              failures: [
                { visitKey: "SC-D07", revision: 1 },
                { visitKey: "SC-D07", revision: 2 },
              ],
              remaining: 2,
              cantMove: { remittanceFiles: 1, remittanceLines: 3 },
            }),
          ),
        ],
        bodies,
      ),
    });

    const key = await screen.findByRole("region", { name: "Identifier key" });
    await within(key).findByText("The desk seals identifiers with key version 2.");
    expect(key.textContent).toContain("120 stored revisions are still under the previous key.");
    fireEvent.click(within(key).getByRole("button", { name: "Move stored identities" }));

    await within(key).findByText("Moved 118 revisions. 2 couldn't be opened and were left as they were.");
    expect(bodies).toEqual([{ after: "" }, { after: "cursor-1" }]);
    const failed = within(key).getByRole("list", { name: "Revisions left as they were" });
    expect(within(failed).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["SC-D07, revision 1", "SC-D07, revision 2"]);
    expect(key.textContent).toContain("2 stored revisions are still under the previous key.");

    const stuck = within(key).getByRole("note");
    expect(stuck.textContent).toContain("1 payment statement and 3 statement lines stay under the previous key.");
    expect(stuck.textContent).toContain("matched by reference or by hand");
    expect(stuck.textContent).toContain("possible duplicate");
  });

  it("says where moving stopped, and carries on from the last batch that landed", async () => {
    const bodies: unknown[] = [];
    openSettings(reviewer, {
      [RESEAL]: resealRoute(rotated, [jsonAnswer(batch({ moved: 50, remaining: 70, next: { after: "cursor-1" } })), refused, jsonAnswer(batch({ moved: 70 }))], bodies),
    });

    const key = await screen.findByRole("region", { name: "Identifier key" });
    fireEvent.click(await within(key).findByRole("button", { name: "Move stored identities" }));

    await within(key).findByText("Moving stopped with 70 revisions still to go. Check your connection, then carry on.");
    fireEvent.click(within(key).getByRole("button", { name: "Carry on moving" }));

    await within(key).findByText("Moved 120 revisions.");
    expect(bodies).toEqual([{ after: "" }, { after: "cursor-1" }, { after: "cursor-1" }]);
    expect(key.textContent).toContain("Every stored identity is under the current key.");
    expect(within(key).queryByRole("button", { name: "Move stored identities" })).toBeNull();
  });

  it("warns when the previous key is missing, and offers nothing to run", async () => {
    openSettings(reviewer, { [RESEAL]: jsonAnswer({ ...rotated, previousKeySet: false, previousKeyMissing: true } satisfies ResealStatus) });

    const key = await screen.findByRole("region", { name: "Identifier key" });
    const alert = await within(key).findByRole("alert");
    expect(alert.textContent).toContain("120 stored revisions can't be opened");
    expect(alert.textContent).toContain("IDENTIFIER_KEY_PREVIOUS");
    expect(within(key).queryByRole("button", { name: "Move stored identities" })).toBeNull();
  });

  it("is for reviewers only: an officer never asks where the key stands", async () => {
    const fetchStub = openSettings(officer);

    await screen.findByRole("region", { name: "People" });
    expect(screen.queryByRole("region", { name: "Identifier key" })).toBeNull();
    expect(fetchStub.mock.calls.map(([input]) => new Request(input as RequestInfo).url)).not.toContain(RESEAL);
  });
});
