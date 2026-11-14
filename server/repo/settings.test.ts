import { createD1 } from "../../tests/helpers/d1";
import { DEFAULT_SETTINGS, type DeskSettings } from "../../src/domain/settings";
import { get, InvalidSettingsError, saveStatement } from "./settings";

const AT = "2026-07-02T01:00:00.000Z";
const renamed: DeskSettings = {
  ...DEFAULT_SETTINGS,
  branches: [{ id: "BR-NORTH", name: "North branch", gstRegistered: true, chasRegistered: true, medisaveRegistered: true }],
};

describe("the settings repository", () => {
  it("gives the defaults at version 0 before anything is saved", async () => {
    const db = await createD1();
    expect(await get(db)).toEqual({ version: 0, settings: DEFAULT_SETTINGS });
  });

  it("saves the first document as version 1 and each later one a version on", async () => {
    const db = await createD1();
    await saveStatement(db, DEFAULT_SETTINGS, 0, "reviewer@example.com", AT).run();
    await saveStatement(db, renamed, 1, "reviewer@example.com", AT).run();

    expect(await get(db)).toEqual({ version: 2, settings: renamed });
  });

  it("changes nothing when the expected version is stale", async () => {
    const db = await createD1();
    await saveStatement(db, renamed, 0, "a@example.com", AT).run();

    const firstAgain = await saveStatement(db, DEFAULT_SETTINGS, 0, "b@example.com", AT).run();
    await saveStatement(db, renamed, 1, "a@example.com", AT).run();
    const behind = await saveStatement(db, DEFAULT_SETTINGS, 1, "b@example.com", AT).run();

    expect(firstAgain.meta.changes).toBe(0);
    expect(behind.meta.changes).toBe(0);
    expect(await get(db)).toEqual({ version: 2, settings: renamed });
  });

  it("refuses to write a document missing a required field, naming the field", async () => {
    const db = await createD1();
    const { payers: _dropped, ...withoutPayers } = DEFAULT_SETTINGS;

    const save = () => saveStatement(db, withoutPayers as DeskSettings, 0, "a@example.com", AT);

    expect(save).toThrow(InvalidSettingsError);
    expect(save).toThrow(expect.objectContaining({ issues: [expect.objectContaining({ path: "payers" })] }));
    expect(await get(db)).toEqual({ version: 0, settings: DEFAULT_SETTINGS });
  });

  it("refuses to read a stored document missing a required field", async () => {
    const db = await createD1();
    const { branches: _dropped, ...withoutBranches } = DEFAULT_SETTINGS;
    await db
      .prepare("INSERT INTO settings (id, version, doc_json, updated_by, updated_at) VALUES (1, 3, ?, 'a@example.com', ?)")
      .bind(JSON.stringify(withoutBranches), AT)
      .run();

    await expect(get(db)).rejects.toThrow(InvalidSettingsError);
  });
});
