import { describe, expect, it } from "vitest";
import { MAX_VISITS_PER_IMPORT, type SyntheticImportPage } from "../../src/api/imports";
import { CLINIC, emptyDesk, OFFICER_ACTOR, seededDesk } from "../../tests/helpers/fixtures";
import * as codeMap from "../repo/code-map";
import * as imports from "../repo/imports";
import * as settings from "../repo/settings";
import { loadSyntheticClinic } from "./synthetic";

/** Every claim as the desk holds it, without the IDs and nonces each run makes up. */
async function claimRows(db: D1Database) {
  const { results } = await db
    .prepare("SELECT visit_key, payer_id, scheme, status, built_from_revision, fee_cents, claimed_cents, deadline_date FROM claims ORDER BY visit_key, payer_id")
    .all();
  return results;
}

/** Calls the service page by page, the way the desk's button does, and keeps every page. */
async function loadAll(deps: Parameters<typeof loadSyntheticClinic>[0]): Promise<SyntheticImportPage[]> {
  const pages: SyntheticImportPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await loadSyntheticClinic(deps, OFFICER_ACTOR, offset);
    pages.push(page);
    offset = page.next;
  }
  return pages;
}

describe("loadSyntheticClinic", () => {
  it("imports at most one page of visits per call, each page its own import, until there is no next page (Sp-4)", async () => {
    const { db, deps } = await emptyDesk({ DEMO_MODE: "yes" });

    const pages = await loadAll(deps);

    expect(pages.length).toBe(Math.ceil(CLINIC.visits.length / MAX_VISITS_PER_IMPORT));
    for (const page of pages) expect(page.received).toBeLessThanOrEqual(MAX_VISITS_PER_IMPORT);
    expect(pages.map((p) => p.next)).toEqual([...pages.slice(1).map((_, i) => (i + 1) * MAX_VISITS_PER_IMPORT), null]);
    expect(pages.reduce((n, p) => n + p.received, 0)).toBe(CLINIC.visits.length);
    expect(pages.reduce((n, p) => n + p.new, 0)).toBe(CLINIC.visits.length);
    const log = await imports.recent(db);
    expect(log).toHaveLength(pages.length);
    expect(log.every((row) => row.source === "synthetic")).toBe(true);
  });

  it("lands the same claims as importing the whole clinic at once", async () => {
    const paged = await emptyDesk({ DEMO_MODE: "yes" });
    await loadAll(paged.deps);
    const whole = await seededDesk({ DEMO_MODE: "yes" });

    expect(await claimRows(paged.db)).toEqual(await claimRows(whole.db));
  });

  it("sets up the generator's settings and code map on an empty desk only", async () => {
    const { db, deps } = await emptyDesk({ DEMO_MODE: "yes" });

    await loadSyntheticClinic(deps, OFFICER_ACTOR, 0);
    await loadSyntheticClinic(deps, OFFICER_ACTOR, MAX_VISITS_PER_IMPORT);

    expect((await settings.get(db)).version).toBe(1);
    expect(await codeMap.get(db)).toHaveLength(CLINIC.codeMap.length);
  });
});
