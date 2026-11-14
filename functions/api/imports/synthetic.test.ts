import { generateClinic } from "../../../mock/synthetic-clinic/generate";
import * as codeMap from "../../../server/repo/code-map";
import * as settings from "../../../server/repo/settings";
import { MAX_VISITS_PER_IMPORT, type SyntheticImportPage } from "../../../src/api/imports";
import { sgtDay } from "../../../src/domain/dates";
import type { DeskSettings } from "../../../src/domain/settings";
import type { Env } from "../../../server/env";
import { accessClaims, accessTeam, stubAccessCerts } from "../../../tests/helpers/access";
import { OFFICER, REVIEWER, STRANGER } from "../../../tests/helpers/env";
import { CLINIC, emptyDesk } from "../../../tests/helpers/fixtures";
import { apiRequest, call } from "../../../tests/helpers/http";
import { onRequestPost } from "./synthetic";

const team = await accessTeam();
const load = async (who: string, json: unknown = {}) => apiRequest("/api/imports/synthetic", { json, jwt: await team.sign(accessClaims(who)) });
/** The route generates the clinic for the day it runs, as the officer would see it. */
const clinicToday = () => generateClinic({ seed: 7, asOf: sgtDay(Date.now()) });

/** Posts page after page from the start, as the desk's button does, and keeps every page. */
async function loadAll(env: Env, who: string): Promise<SyntheticImportPage[]> {
  const pages: SyntheticImportPage[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const res = await call(onRequestPost, await load(who, { offset }), env);
    expect(res.status).toBe(200);
    const page = (await res.json()) as SyntheticImportPage;
    pages.push(page);
    offset = page.next;
  }
  return pages;
}

const total = (pages: SyntheticImportPage[], key: "received" | "new" | "unchanged") => pages.reduce((n, p) => n + p[key], 0);

describe("POST /api/imports/synthetic", () => {
  it("loads the first page of the synthetic clinic into an empty desk, with settings, code map and where the next page starts", async () => {
    const { env, db } = await emptyDesk({ DEMO_MODE: "yes" });
    stubAccessCerts(team);

    const res = await call(onRequestPost, await load(OFFICER), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: MAX_VISITS_PER_IMPORT,
      new: MAX_VISITS_PER_IMPORT,
      changed: 0,
      unchanged: 0,
      refused: 0,
      next: MAX_VISITS_PER_IMPORT,
    } satisfies Partial<SyntheticImportPage>);
    expect((await settings.get(db)).version).toBe(1);
    expect(await codeMap.get(db)).toHaveLength(CLINIC.codeMap.length);
  });

  it("loads every visit page by page, no page over the connector's cap (Sp-4)", async () => {
    const { env } = await emptyDesk({ DEMO_MODE: "yes" });
    stubAccessCerts(team);

    const pages = await loadAll(env, OFFICER);

    const visits = clinicToday().visits.length;
    expect(pages.length).toBe(Math.ceil(visits / MAX_VISITS_PER_IMPORT));
    expect(pages.every((p) => p.received <= MAX_VISITS_PER_IMPORT)).toBe(true);
    expect(total(pages, "received")).toBe(visits);
    expect(total(pages, "new")).toBe(visits);
  });

  it("refuses an offset that is not a whole number of visits from the start", async () => {
    const { env } = await emptyDesk({ DEMO_MODE: "yes" });
    stubAccessCerts(team);

    const res = await call(onRequestPost, await load(OFFICER, { offset: -1 }), env);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid" });
  });

  it("a second load changes nothing and keeps settings an officer has edited since", async () => {
    const { env, db } = await emptyDesk({ DEMO_MODE: "yes" });
    stubAccessCerts(team);
    await loadAll(env, OFFICER);
    const edited: DeskSettings = { ...CLINIC.settings, waterfall: ["insurance", "chas", "medisave"] };
    await settings.saveStatement(db, edited, 1, OFFICER).run();

    const pages = await loadAll(env, REVIEWER);

    const visits = clinicToday().visits.length;
    expect(total(pages, "received")).toBe(visits);
    expect(total(pages, "new")).toBe(0);
    expect(total(pages, "unchanged")).toBe(visits);
    const now = await settings.get(db);
    expect(now.version).toBe(2);
    expect(now.settings.waterfall).toEqual(["insurance", "chas", "medisave"]);
  });

  it("is not there unless demo mode is on", async () => {
    const { env } = await emptyDesk();
    stubAccessCerts(team);

    const res = await call(onRequestPost, await load(OFFICER), env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("is not there unless demo mode is on, even where identifiers are not configured or the caller is unknown (Sec-1)", async () => {
    const { env } = await emptyDesk();
    delete env.IDENTIFIER_KEY;
    stubAccessCerts(team);

    const unconfigured = await call(onRequestPost, await load(OFFICER), env);
    const anonymous = await call(onRequestPost, apiRequest("/api/imports/synthetic", { json: {} }), env);

    expect(unconfigured.status).toBe(404);
    expect(await unconfigured.json()).toEqual({ error: "not_found" });
    expect(unconfigured.headers.get("Cache-Control")).toBe("no-store");
    expect(anonymous.status).toBe(404);
  });

  it("is there on a developer's own machine without DEMO_MODE, where the desk shows its button", async () => {
    const { env } = await emptyDesk({ DEV_USER: OFFICER, ACCESS_AUD: undefined, ACCESS_TEAM_DOMAIN: undefined });

    const res = await call(onRequestPost, apiRequest("/api/imports/synthetic", { json: {}, site: "http://localhost:8788" }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: MAX_VISITS_PER_IMPORT });
  });

  it("refuses someone on neither role list", async () => {
    const { env } = await emptyDesk({ DEMO_MODE: "yes" });
    stubAccessCerts(team);

    const res = await call(onRequestPost, await load(STRANGER), env);

    expect(res.status).toBe(403);
  });
});
