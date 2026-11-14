/** `npm run mock:clinic -- --seed <n> --as-of <date> --out <file>`: writes the files, prints counts only. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseIsoDate, type IsoDate } from "../../src/domain/dates";
import { run } from "./cli";
import { generateClinic } from "./generate";
import { readSqlite } from "./write-sqlite";

const T = parseIsoDate("2026-11-13") as IsoDate;
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "synthetic-clinic-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("mock:clinic CLI", () => {
  it("writes the clinic's SQLite file and the R1 and R2 statements beside it", async () => {
    const out = join(tempDir(), "clinic.sqlite");
    const lines: string[] = [];
    const code = await run(["--seed", "7", "--as-of", "2026-11-13", "--out", out], (l) => lines.push(l));

    expect(code).toBe(0);
    const clinic = generateClinic({ seed: 7, asOf: T });
    expect((await readSqlite(readFileSync(out))).visits).toEqual(clinic.visits);
    expect(readFileSync(join(out, "..", "clinic.r1-chas.csv"), "utf8")).toBe(clinic.remittances.r1Chas);
    expect(readFileSync(join(out, "..", "clinic.r2-meridian.csv"), "utf8")).toBe(clinic.remittances.r2Meridian);
    expect(lines.join("\n")).toContain("60 patients, 200 visits");
  });

  it("prints counts only: no identifier, name or phone number", async () => {
    const lines: string[] = [];
    await run(["--seed", "7", "--as-of", "2026-11-13", "--out", join(tempDir(), "c.sqlite")], (l) => lines.push(l));
    const printed = lines.join("\n");
    expect(printed).not.toMatch(/T9\d{6}[A-Z]/);
    for (const p of generateClinic({ seed: 7, asOf: T }).records.patients) {
      expect(printed).not.toContain(p.name);
      expect(printed).not.toContain(p.phone);
    }
  });

  it("refuses a missing or malformed argument, and writes nothing", async () => {
    const dir = tempDir();
    for (const args of [
      ["--as-of", "2026-11-13", "--out", join(dir, "a.sqlite")],
      ["--seed", "x", "--as-of", "2026-11-13", "--out", join(dir, "b.sqlite")],
      ["--seed", "7", "--as-of", "2026-02-30", "--out", join(dir, "c.sqlite")],
      ["--seed", "7", "--as-of", "2026-11-13"],
    ]) {
      const lines: string[] = [];
      expect(await run(args, (l) => lines.push(l))).toBe(2);
      expect(lines.join("\n")).toMatch(/usage/i);
    }
    expect(() => readFileSync(join(dir, "a.sqlite"))).toThrow();
  });
});
