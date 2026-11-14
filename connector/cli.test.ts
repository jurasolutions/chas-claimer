/**
 * The connector end to end: the synthetic clinic's SQLite file (or its CSV export), read through the
 * shipped mapping, posted page by page to the real import handler on an in-memory D1 through the
 * network stub. Every record here is synthetic.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { afterEach, describe, expect, it } from "vitest";
import { onRequestPost } from "../functions/api/imports/index";
import { writeSqlite } from "../mock/synthetic-clinic/write-sqlite";
import { importVisits, visitOrder } from "../server/services/imports";
import { maskNric } from "../src/domain/nric";
import { TEST_CONNECTOR_TOKEN } from "../tests/helpers/env";
import { CLINIC, configuredDesk, type Desk, OFFICER_ACTOR } from "../tests/helpers/fixtures";
import { call, SITE } from "../tests/helpers/http";
import { jsonAnswer, stubNetwork } from "../tests/helpers/network";
import { run } from "./cli";
import { exportCsv, recordsWithPreAuth, SHIPPED_MAPPING_PATH } from "./test-support";

const IMPORTS_URL = `${SITE}/api/imports`;
const MAPPING = fileURLToPath(SHIPPED_MAPPING_PATH);
const ENV = { CLAIMS_DESK_URL: SITE, CONNECTOR_TOKEN: TEST_CONNECTOR_TOKEN, CF_ACCESS_CLIENT_ID: "test.access", CF_ACCESS_CLIENT_SECRET: "test-access-secret" };
const noWait = async () => {};

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "connector-cli-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function clinicFile(bytes?: Uint8Array): Promise<string> {
  const file = join(tempDir(), "clinic.sqlite");
  writeFileSync(file, bytes ?? (await writeSqlite(CLINIC)));
  return file;
}

async function connector(args: string[], env: Record<string, string | undefined> = ENV) {
  const lines: string[] = [];
  const code = await run(args, (line) => void lines.push(line), env, { wait: noWait });
  return { code, text: lines.join("\n") };
}

/** Routes the connector's requests to the real import handler on `desk`. */
const toDesk = (desk: Desk) => stubNetwork({ [IMPORTS_URL]: (request) => call(onRequestPost, request, desk.env) });

const count = async (desk: Desk, sql: string) => (await desk.db.prepare(sql).first<{ n: number }>())!.n;
const hashes = async (desk: Desk) => (await desk.db.prepare("SELECT visit_key, content_hash FROM visits ORDER BY visit_key").all()).results;

function expectNoIdentifiers(text: string) {
  for (const p of CLINIC.records.patients) {
    expect(text).not.toContain(p.nric);
    expect(text).not.toContain(p.name);
    expect(text).not.toContain(p.phone);
  }
}

describe("describe", () => {
  it("prints the source's kind, tables and column names, never a value", async () => {
    stubNetwork({});
    const { code, text } = await connector(["describe", "--source", await clinicFile()], {});
    expect(code).toBe(0);
    expect(text).toContain("sqlite");
    expect(text).toMatch(/appointments: .*appt_no.*appt_date/);
    expectNoIdentifiers(text);
  });

  it("refuses a CSV export with no header row, naming positions and never a value", async () => {
    stubNetwork({});
    const dir = tempDir();
    const p = CLINIC.records.patients[0]!;
    writeFileSync(join(dir, "patients.csv"), `V-1,${p.nric},Test Patient Sentinel,2026-11-01\r\n`);
    const { code, text } = await connector(["describe", "--source", dir], {});
    expect(code).not.toBe(0);
    expect(text).toMatch(/no header row/);
    expect(text).toContain("columns 2, 4");
    for (const value of ["V-1", p.nric, "Test Patient Sentinel", "2026-11-01"]) expect(text).not.toContain(value);
  });
});

describe("dry-run (AC-7.1)", () => {
  it("prints the visit count and the first visit with its identifiers masked, and sends nothing", async () => {
    const fetch = stubNetwork({});
    const { code, text } = await connector(["dry-run", "--mapping", MAPPING, "--source", await clinicFile()], {});

    expect(code).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(text).toContain(`${CLINIC.visits.length} visits`);
    const first = [...CLINIC.visits].sort(visitOrder)[0]!;
    expect(text).toContain(first.visitKey);
    expect(text).toContain(maskNric(first.patient.nric));
    expect(text).toMatch(/nothing was sent/i);
    expectNoIdentifiers(text);
  });

  it("reads only visits on or after --since", async () => {
    stubNetwork({});
    const since = [...CLINIC.visits].sort(visitOrder)[100]!.date;
    const expected = CLINIC.visits.filter((v) => v.date >= since).length;
    const { code, text } = await connector(["dry-run", "--mapping", MAPPING, "--source", await clinicFile(), "--since", since], {});
    expect(code).toBe(0);
    expect(text).toContain(`${expected} visits`);
  });
});

describe("push", () => {
  it("imports the clinic page by page, at most 100 visits a page, and the desk builds claims", async () => {
    const desk = await configuredDesk();
    const fetch = toDesk(desk);
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()]);

    expect(code).toBe(0);
    const pages = await Promise.all(fetch.mock.calls.map(([input, init]) => new Request(input as RequestInfo, init).json() as Promise<{ visits: unknown[] }>));
    expect(pages.map((p) => p.visits.length)).toEqual([100, 100]);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM imports WHERE finished_at IS NOT NULL")).toBe(2);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visits")).toBe(CLINIC.visits.length);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM claims")).toBeGreaterThan(0);
    expect(text).toMatch(/page 1 of 2.*100 new/i);
    expectNoIdentifiers(text);
  });

  it("gives the desk the same visits as a direct synthetic load (AC-7.2)", async () => {
    const desk = await configuredDesk();
    toDesk(desk);
    expect((await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()])).code).toBe(0);

    const direct = await configuredDesk();
    await importVisits(direct.deps, { source: "synthetic", visits: CLINIC.visits }, OFFICER_ACTOR);
    expect(await hashes(desk)).toEqual(await hashes(direct));
  });

  it("sends no identifier, dentist's note or pre-authorisation reference into the clinical record", async () => {
    const desk = await configuredDesk();
    const fetch = toDesk(desk);
    const records = recordsWithPreAuth();
    await connector(["push", "--mapping", MAPPING, "--source", await clinicFile(await writeSqlite({ ...CLINIC, records }))]);
    const sent = fetch.mock.calls.map((c) => String(c[1]?.body ?? "")).join("\n");
    expect(sent).toMatch(/PAREF-TEST-/);
    const clinical = (await desk.db.prepare("SELECT clinical_json FROM visit_revisions").all<{ clinical_json: string }>()).results.map((r) => r.clinical_json).join("\n");
    expect(clinical).not.toBe("");
    expectNoIdentifiers(clinical);
    expect(clinical).not.toMatch(/PAREF-TEST-/);
    const notes = records.appointments.map((a) => a.dentistNote).filter((n): n is string => typeof n === "string" && n !== "");
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(sent).toContain(JSON.stringify(note).slice(1, -1));
      expect(clinical).not.toContain(note);
    }
  });

  it("changes nothing when run again", async () => {
    const desk = await configuredDesk();
    toDesk(desk);
    const file = await clinicFile();
    await connector(["push", "--mapping", MAPPING, "--source", file]);
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", file]);
    expect(code).toBe(0);
    expect(text).toMatch(/page 1 of 2.*0 new.*100 unchanged/i);
    expect(text).toMatch(/page 2 of 2.*0 new.*100 unchanged/i);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visit_revisions")).toBe(CLINIC.visits.length);
  });

  it("stops on a wrong token, says so, and imports nothing (AC-7.3)", async () => {
    const desk = await configuredDesk();
    const fetch = toDesk(desk);
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()], { ...ENV, CONNECTOR_TOKEN: "not-the-desk-token" });

    expect(code).not.toBe(0);
    expect(text).toContain("The desk refused the token");
    expect(text).not.toContain("not-the-desk-token");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM imports")).toBe(0);
  });

  it("stops when the desk cannot be reached, records nothing as complete, and a rerun imports everything once (AC-7.5)", async () => {
    const desk = await configuredDesk();
    const file = await clinicFile();
    stubNetwork({
      [IMPORTS_URL]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const down = await connector(["push", "--mapping", MAPPING, "--source", file]);
    expect(down.code).not.toBe(0);
    expect(down.text).toMatch(/could not reach the desk/i);
    expect(down.text).toMatch(/run .* again/i);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM imports")).toBe(0);

    toDesk(desk);
    const rerun = await connector(["push", "--mapping", MAPPING, "--source", file]);
    expect(rerun.code).toBe(0);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visits")).toBe(CLINIC.visits.length);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visit_revisions")).toBe(CLINIC.visits.length);
  });

  it("keeps the pages before a failure, and a rerun finishes the rest once (AC-7.5)", async () => {
    const desk = await configuredDesk();
    const file = await clinicFile();
    let requests = 0;
    stubNetwork({
      [IMPORTS_URL]: (request) => {
        requests += 1;
        return requests === 1 ? call(onRequestPost, request, desk.env) : jsonAnswer({ error: "internal" }, 500)(request);
      },
    });
    const broken = await connector(["push", "--mapping", MAPPING, "--source", file]);
    expect(broken.code).not.toBe(0);
    expect(broken.text).toMatch(/page 2 of 2/i);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM imports WHERE finished_at IS NOT NULL")).toBe(1);

    toDesk(desk);
    const rerun = await connector(["push", "--mapping", MAPPING, "--source", file]);
    expect(rerun.code).toBe(0);
    expect(rerun.text).toMatch(/page 1 of 2.*0 new.*100 unchanged/i);
    expect(rerun.text).toMatch(/page 2 of 2.*100 new/i);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visit_revisions")).toBe(CLINIC.visits.length);
  });

  it("skips a CSV row missing its visit date, naming its line, and imports the others (AC-7.4)", async () => {
    const desk = await configuredDesk();
    toDesk(desk);
    const dir = tempDir();
    await exportCsv(await withBlankDate(await writeSqlite(CLINIC), CLINIC.records.appointments[3]!.visitKey), dir);

    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", dir]);
    expect(code).toBe(0);
    expect(text).toContain("appointments.csv line 5: the visit date is missing.");
    expect(text).not.toMatch(/Invalid input|expected string|received undefined/);
    expect(await count(desk, "SELECT COUNT(*) AS n FROM visits")).toBe(CLINIC.visits.length - 1);
  });

  it("names the rows of a page the desk refused for a real identifier", async () => {
    stubNetwork({ [IMPORTS_URL]: jsonAnswer({ error: "real_identifier_refused", importId: "imp-1", indexes: [1] }, 422) });
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()]);
    expect(code).not.toBe(0);
    expect(text).toContain("real_identifier_refused");
    expect(text).toMatch(/appointments row \d+/);
  });

  it("explains an Access refusal by the service token variables", async () => {
    stubNetwork({ [IMPORTS_URL]: () => new Response(null, { status: 302, headers: { Location: "https://jura-test.cloudflareaccess.com/login" } }) });
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()]);
    expect(code).not.toBe(0);
    expect(text).toContain("CF_ACCESS_CLIENT_ID");
  });
});

describe("arguments and configuration", () => {
  it("refuses a missing command, an unknown option or a bad date with a usage line", async () => {
    stubNetwork({});
    const file = await clinicFile();
    expect((await connector([])).code).toBe(2);
    expect((await connector(["send", "--source", file])).code).toBe(2);
    expect((await connector(["dry-run", "--mapping", MAPPING, "--source", file, "--verbose"])).code).toBe(2);
    expect((await connector(["dry-run", "--mapping", MAPPING, "--source", file, "--since", "2026-13-01"])).code).toBe(2);
    expect((await connector(["dry-run", "--source", file])).text).toMatch(/usage/i);
  });

  it("names the missing environment variables before reading anything", async () => {
    const fetch = stubNetwork({});
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()], {});
    expect(code).toBe(2);
    expect(text).toContain("CLAIMS_DESK_URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("will not push to a desk that is not on this machine without the Access service token", async () => {
    const fetch = stubNetwork({});
    const { code, text } = await connector(["push", "--mapping", MAPPING, "--source", await clinicFile()], { CLAIMS_DESK_URL: SITE, CONNECTOR_TOKEN: TEST_CONNECTOR_TOKEN });
    expect(code).toBe(2);
    expect(text).toContain("CF_ACCESS_CLIENT_SECRET");
    expect(text).not.toContain(TEST_CONNECTOR_TOKEN);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names an invalid mapping's problems by path", async () => {
    stubNetwork({});
    const mapping = join(tempDir(), "mapping.json");
    writeFileSync(mapping, JSON.stringify({ amountUnit: "cents" }));
    const { code, text } = await connector(["dry-run", "--mapping", mapping, "--source", await clinicFile()], {});
    expect(code).toBe(2);
    expect(text).toContain("visits");
  });

  it("names a table the mapping expects and the source lacks", async () => {
    stubNetwork({});
    const dir = tempDir();
    writeFileSync(join(dir, "appointments.csv"), "appt_no,appt_date\r\nV-1,2026-11-01\r\n");
    const { code, text } = await connector(["dry-run", "--mapping", MAPPING, "--source", dir], {});
    expect(code).toBe(1);
    expect(text).toMatch(/appointments has no column/);
  });
});

/** The clinic file with one appointment's date left blank, as a hand-kept export may have it. */
async function withBlankDate(bytes: Uint8Array, visitKey: string): Promise<Uint8Array> {
  const db = new (await initSqlJs()).Database(bytes);
  try {
    db.run("UPDATE appointments SET appt_date = '' WHERE appt_no = ?", [visitKey]);
    return db.export();
  } finally {
    db.close();
  }
}
