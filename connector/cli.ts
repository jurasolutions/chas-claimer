/**
 * `npm run connector -- describe --source <path>`
 * `npm run connector -- dry-run --mapping <file.json> --source <path> [--since YYYY-MM-DD]`
 * `npm run connector -- push --mapping <file.json> --source <path> [--since YYYY-MM-DD]`
 *
 * Runs at the clinic. Reads visits from the clinic's SQLite file or CSV folder through a source
 * mapping and sends them to the desk's `POST /api/imports`, at most 100 visits a page, each page
 * its own import. The desk's address and tokens come from the environment only (see `post.ts`).
 *
 * Output carries counts, names, positions and masked identifiers, never a raw identifier: the
 * terminal at a clinic is not a private place. Exit codes: 0 done (rows may have been skipped),
 * 1 the source or the desk failed, 2 a bad argument, mapping or environment.
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MAX_VISITS_PER_IMPORT } from "../src/api/imports";
import { type IsoDate, parseIsoDate } from "../src/domain/dates";
import { maskNric } from "../src/domain/nric";
import { parseSourceMapping, type SourceMapping } from "../src/domain/source-mapping";
import type { SourceVisit } from "../src/domain/source-visit";
import { visitOrder } from "../server/services/imports";
import { readVisits } from "./mapping";
import { deskFromEnv, postVisits, RETRIES, type Desk } from "./post";
import { openCsv } from "./sources/csv";
import { SourceShapeError, type TableSource } from "./sources/source";
import { openSqlite } from "./sources/sqlite";

const USAGE = [
  "usage: npm run connector -- describe --source <file.sqlite | csv folder>",
  "       npm run connector -- dry-run --mapping <mapping.json> --source <file.sqlite | csv folder> [--since YYYY-MM-DD]",
  "       npm run connector -- push --mapping <mapping.json> --source <file.sqlite | csv folder> [--since YYYY-MM-DD]",
].join("\n");

const COMMANDS = ["describe", "dry-run", "push"] as const;
type Command = (typeof COMMANDS)[number];

export type Print = (line: string) => void;

export interface RunDeps {
  /** Waits between retries; a test passes one that returns at once. */
  wait?: (ms: number) => Promise<void>;
}

const HIDDEN = "•••";

/** Runs the connector. Returns the exit code. */
export async function run(args: string[], print: Print, env: Record<string, string | undefined> = process.env, deps: RunDeps = {}): Promise<number> {
  let positionals: string[];
  let values: { mapping?: string; source?: string; since?: string };
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: { mapping: { type: "string" }, source: { type: "string" }, since: { type: "string" } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    print(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  const [command, ...extra] = positionals;
  if (!isCommand(command) || extra.length > 0 || !values.source || (command !== "describe" && !values.mapping)) {
    print(USAGE);
    return 2;
  }
  let since: IsoDate | undefined;
  if (values.since !== undefined) {
    const parsed = parseIsoDate(values.since);
    if (!parsed) {
      print(`--since must be a date as YYYY-MM-DD.\n${USAGE}`);
      return 2;
    }
    since = parsed;
  }

  // Configuration first, so a missing variable or a broken mapping stops the run before the source is read.
  let desk: Desk | undefined;
  if (command === "push") {
    const fromEnv = deskFromEnv(env);
    if (!fromEnv.ok) {
      print(fromEnv.error);
      return 2;
    }
    desk = fromEnv.value;
  }
  let mapping: SourceMapping | undefined;
  if (values.mapping) {
    const loaded = loadMapping(values.mapping);
    if (!loaded.ok) {
      for (const line of loaded.lines) print(line);
      return 2;
    }
    mapping = loaded.mapping;
  }

  let source: TableSource;
  try {
    source = await openSource(values.source);
  } catch (e) {
    print(sourceFailure(e));
    return isMissing(e) ? 2 : 1;
  }

  try {
    if (command === "describe") return await describeSource(source, print);
    const visits = await collect(source, mapping!, since, print);
    if (command === "dry-run") return dryRun(visits, print);
    return await push(desk!, visits, print, deps);
  } catch (e) {
    print(sourceFailure(e, command));
    return 1;
  } finally {
    source.close();
  }
}

const isCommand = (c: string | undefined): c is Command => COMMANDS.includes(c as Command);

function loadMapping(path: string): { ok: true; mapping: SourceMapping } | { ok: false; lines: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ok: false, lines: [`The mapping file ${path} could not be read as JSON.`] };
  }
  const parsed = parseSourceMapping(json);
  if (parsed.ok) return { ok: true, mapping: parsed.value };
  return { ok: false, lines: [`The mapping file ${path} is not a valid mapping:`, ...parsed.error.map((i) => `  ${i.path || "(top level)"}: ${i.message}`)] };
}

/** A folder is a CSV export (one `<table>.csv` per table); a file is a SQLite database. */
async function openSource(path: string): Promise<TableSource> {
  return statSync(path).isDirectory() ? openCsv(path) : openSqlite(new Uint8Array(readFileSync(path)));
}

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Says what went wrong without echoing a driver's message, which may quote a row. */
function sourceFailure(e: unknown, command?: Command): string {
  if (e instanceof SourceShapeError) return `${command === "describe" ? "The source cannot be described" : "The source does not match the mapping"}: ${e.message}.`;
  if (isMissing(e)) return "The source was not found. --source takes a SQLite file or a folder of CSV files.";
  return "The source could not be read. --source takes a SQLite file or a folder of CSV files.";
}

async function describeSource(source: TableSource, print: Print): Promise<number> {
  const schema = await source.describe();
  print(`A ${schema.kind} source with ${schema.tables.length} ${schema.tables.length === 1 ? "table" : "tables"}:`);
  for (const t of schema.tables) print(`  ${t.name}: ${t.columns.join(", ")}`);
  return 0;
}

interface Located {
  where: string;
  visit: SourceVisit;
}

/** Every visit the mapping can read, in import order; prints each skipped row by where it sits. */
async function collect(source: TableSource, mapping: SourceMapping, since: IsoDate | undefined, print: Print): Promise<Located[]> {
  const visits: Located[] = [];
  const skipped: string[] = [];
  for await (const read of readVisits(source, mapping, since ? { since } : {})) {
    if (read.ok) visits.push({ where: read.where, visit: read.visit });
    else for (const p of read.problems) skipped.push(`  ${read.where}: ${p.message}.`);
  }
  visits.sort((a, b) => visitOrder(a.visit, b.visit));
  print(`Read ${visits.length} ${visits.length === 1 ? "visit" : "visits"}${since ? ` on or after ${since}` : ""}.`);
  if (skipped.length > 0) {
    print(`Skipped these rows; fix them at the source and run again:`);
    for (const line of skipped) print(line);
  }
  return visits;
}

function dryRun(visits: Located[], print: Print): number {
  const first = visits[0];
  if (first) {
    print(`First visit (${first.where}), identifiers masked:`);
    for (const line of JSON.stringify(masked(first.visit), null, 2).split("\n")) print(`  ${line}`);
  }
  print("Nothing was sent: this was a dry run.");
  return 0;
}

/** The visit as a person checking a mapping needs it, with every identifier masked. */
export function masked(v: SourceVisit): unknown {
  return {
    ...v,
    patient: {
      nric: maskNric(v.patient.nric),
      name: HIDDEN,
      phone: HIDDEN,
      dateOfBirth: `${v.patient.dateOfBirth.slice(0, 4)}-••-••`,
      address: v.patient.address === null ? null : HIDDEN,
    },
    notes: v.notes === null ? null : `(${v.notes.length} characters withheld)`,
    policies: v.policies.map((p) => ({
      ...p,
      memberId: HIDDEN,
      employer: p.employer === null ? null : HIDDEN,
      preAuths: p.preAuths.map((a) => ({ ...a, reference: HIDDEN })),
    })),
    medisave:
      v.medisave === null
        ? null
        : { ...v.medisave, accountHolder: { ...v.medisave.accountHolder, nric: v.medisave.accountHolder.nric === null ? null : maskNric(v.medisave.accountHolder.nric) } },
  };
}

async function push(desk: Desk, visits: Located[], print: Print, deps: RunDeps): Promise<number> {
  if (visits.length === 0) {
    print("No visits to send.");
    return 0;
  }
  const pages: Located[][] = [];
  for (let i = 0; i < visits.length; i += MAX_VISITS_PER_IMPORT) pages.push(visits.slice(i, i + MAX_VISITS_PER_IMPORT));

  for (const [i, page] of pages.entries()) {
    const label = `Page ${i + 1} of ${pages.length}`;
    const done = i === 0 ? "" : ` Pages 1 to ${i} are imported and complete.`;
    const rerun = " Run the same command again when the desk is back: it is safe, and visits already imported are left unchanged.";
    const outcome = await postVisits(
      desk,
      page.map((p) => p.visit),
      deps.wait ? { wait: deps.wait } : {},
    );
    switch (outcome.kind) {
      case "imported": {
        const s = outcome.summary;
        print(`${label}: ${s.new} new, ${s.changed} changed, ${s.unchanged} unchanged, ${s.flagged} flagged, ${s.refused} refused, ${s.ignored.length} ignored.`);
        for (const r of s.refusedVisits) {
          for (const issue of r.issues) print(`  refused ${page[r.index]?.where ?? `visit ${r.index + 1} of the page`}: ${issue.path || "(visit)"} — ${issue.message}`);
        }
        for (const ig of s.ignored) print(`  ignored ${page.find((p) => p.visit.visitKey === ig.visitKey)?.where ?? "a visit"}: the desk holds a newer revision`);
        break;
      }
      case "token_refused":
        print(`${label}: The desk refused the token. Check that CONNECTOR_TOKEN matches the desk's. Nothing from this page was imported.${done}`);
        return 1;
      case "access_refused":
        print(
          `${label}: Cloudflare Access stopped the request before it reached the desk (HTTP ${outcome.status}). Check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.${done}`,
        );
        return 1;
      case "refused":
        print(`${label}: The desk refused the page (HTTP ${outcome.status}, ${outcome.code}). Nothing from this page was imported.${done}`);
        for (const index of outcome.indexes ?? []) print(`  ${page[index]?.where ?? `visit ${index + 1} of the page`}`);
        return 1;
      case "unreachable":
        print(`${label}: Could not reach the desk${outcome.status ? ` (HTTP ${outcome.status} after ${RETRIES} retries)` : ` after ${RETRIES} retries`}.${done}${rerun}`);
        return 1;
      case "unexpected":
        print(`${label}: The desk gave an answer the connector does not understand (HTTP ${outcome.status}).${done}${rerun}`);
        return 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2), (line) => console.log(line)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof SourceShapeError ? e.message : "The connector failed.");
      process.exit(1);
    },
  );
}
