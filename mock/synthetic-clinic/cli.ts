/**
 * `npm run mock:clinic -- --seed <n> --as-of <YYYY-MM-DD> --out <file.sqlite>`
 *
 * Writes the synthetic clinic's SQLite file, and the R1 and R2 remittance statements beside it as
 * `<name>.r1-chas.csv` and `<name>.r2-meridian.csv`. Prints counts and file paths only, never a
 * row: even synthetic identifiers stay out of terminal logs.
 */
import { writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseIsoDate } from "../../src/domain/dates";
import { generateClinic } from "./generate";
import { writeSqlite } from "./write-sqlite";

const USAGE = "usage: npm run mock:clinic -- --seed <non-negative integer> --as-of <YYYY-MM-DD> --out <file.sqlite>";

/** Runs the CLI. Returns the exit code: 0 on success, 2 on a bad argument. */
export async function run(args: string[], print: (line: string) => void): Promise<number> {
  let values: { seed?: string; "as-of"?: string; out?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: { seed: { type: "string" }, "as-of": { type: "string" }, out: { type: "string" } },
      strict: true,
    }));
  } catch (e) {
    print(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const seed = values.seed !== undefined && /^\d{1,10}$/.test(values.seed) ? Number(values.seed) : null;
  const asOf = values["as-of"] !== undefined ? parseIsoDate(values["as-of"]) : null;
  const out = values.out;
  if (seed === null || seed > 2 ** 32 - 1 || asOf === null || !out) {
    print(USAGE);
    return 2;
  }

  const clinic = generateClinic({ seed, asOf });
  const file = resolve(out);
  const stem = join(dirname(file), basename(file, extname(file)));
  writeFileSync(file, await writeSqlite(clinic));
  writeFileSync(`${stem}.r1-chas.csv`, clinic.remittances.r1Chas);
  writeFileSync(`${stem}.r2-meridian.csv`, clinic.remittances.r2Meridian);

  const r1Lines = clinic.remittances.r1Chas.trimEnd().split("\r\n").length - 1;
  const r2Lines = clinic.remittances.r2Meridian.trimEnd().split("\r\n").length - 1;
  print(`Synthetic clinic, seed ${seed}, as of ${asOf}:`);
  print(`  ${clinic.records.patients.length} patients, ${clinic.visits.length} visits, ${Object.keys(clinic.cases).length} cases -> ${file}`);
  const lines = (n: number) => `${n} ${n === 1 ? "line" : "lines"}`;
  print(`  R1 CHAS statement, ${lines(r1Lines)} -> ${stem}.r1-chas.csv`);
  print(`  R2 Meridian statement, ${lines(r2Lines)} -> ${stem}.r2-meridian.csv`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : "failed");
      process.exit(1);
    },
  );
}
