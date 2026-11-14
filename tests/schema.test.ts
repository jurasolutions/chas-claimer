import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createD1 } from "./helpers/d1";
import {
  AUDIT_ENTITY_TYPES,
  CHANNELS,
  CLAIM_STATUSES,
  CODE_MAP_ORIGINS,
  CODE_MAP_TARGETS,
  IMPORT_SOURCES,
  MATCH_KINDS,
  SCHEMES,
  SEVERITIES,
  SIM_STATES,
  SUBMISSION_RESULTS,
} from "../src/domain/types";

const AT = "2026-07-01T02:00:00.000Z";

/** One import, one visit and one claim: the rows the other tables point at. */
async function seeded() {
  const db = await createD1();
  await db.batch([
    db
      .prepare("INSERT INTO imports (id, source, actor, started_at) VALUES ('imp-1', 'synthetic', 'a@example.com', ?)")
      .bind(AT),
    db
      .prepare(
        `INSERT INTO visits (visit_key, current_revision, content_hash, branch_id, visit_date, patient_hash, patient_mask)
         VALUES ('V-1', 1, 'h1', 'BR-CENTRAL', '2026-07-01', 'v1:aa', 'T****000J')`,
      ),
    db.prepare(
      `INSERT INTO visit_revisions (visit_key, revision, import_id, content_hash, clinical_json, identity_sealed, created_at)
       VALUES ('V-1', 1, 'imp-1', 'h1', '{}', 'sealed', ?)`,
    ).bind(AT),
    db.prepare(claimInsert("C-1", "CHAS", "chas", "ready")),
    db.prepare(
      `INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines, matched)
       VALUES ('R-1', 'CHAS', 'r.csv', 'fh', '${AT}', 'a@example.com', 0, 0)`,
    ),
  ]);
  return db;
}

function claimInsert(id: string, payerId: string, scheme: string, status: string, channel: string | null = null) {
  return `INSERT INTO claims (id, visit_key, payer_id, scheme, branch_id, status, last_action, rule_set_id, built_from_revision,
            fee_cents, claimed_cents, patient_hash, patient_mask, visit_date, channel, created_at, updated_at)
          VALUES ('${id}', 'V-1', '${payerId}', '${scheme}', 'BR-CENTRAL', '${status}', 'n0', 'chas-2026', 1,
            8000, 6000, 'v1:aa', 'T****000J', '2026-07-01', ${channel === null ? "NULL" : `'${channel}'`}, '${AT}', '${AT}')`;
}

/** Each closed column, an insert that writes one value into it, and the union it must accept exactly. */
const closedColumns: { column: string; values: readonly string[]; insert: (v: string, i: number) => string }[] = [
  {
    column: "imports.source",
    values: IMPORT_SOURCES,
    insert: (v, i) => `INSERT INTO imports (id, source, actor, started_at) VALUES ('imp-x${i}', '${v}', 'a', '${AT}')`,
  },
  { column: "claims.status", values: CLAIM_STATUSES, insert: (v, i) => claimInsert(`C-s${i}`, `P${i}S`, "insurance", v) },
  { column: "claims.scheme", values: SCHEMES, insert: (v, i) => claimInsert(`C-k${i}`, `P${i}K`, v, "ready") },
  { column: "claims.channel", values: CHANNELS, insert: (v, i) => claimInsert(`C-c${i}`, `P${i}C`, "insurance", "approved", v) },
  {
    column: "findings.severity",
    values: SEVERITIES,
    insert: (v, i) => `INSERT INTO findings (claim_id, seq, code, severity, params_json, rule_ref) VALUES ('C-1', ${i}, 'x', '${v}', '{}', 'r')`,
  },
  {
    column: "submissions.channel",
    values: CHANNELS,
    insert: (v, i) =>
      `INSERT INTO submissions (id, claim_id, attempt, channel, packet_masked_json, packet_hash, result, actor, at)
       VALUES ('S-c${i}', 'C-1', ${i + 1}, '${v}', '{}', 'ph', 'sent', 'a', '${AT}')`,
  },
  {
    column: "submissions.result",
    values: SUBMISSION_RESULTS,
    insert: (v, i) =>
      `INSERT INTO submissions (id, claim_id, attempt, channel, packet_masked_json, packet_hash, result, actor, at)
       VALUES ('S-r${i}', 'C-1', ${i + 100}, 'simulator', '{}', 'ph', '${v}', 'a', '${AT}')`,
  },
  {
    column: "audit_events.entity_type",
    values: AUDIT_ENTITY_TYPES,
    insert: (v) => `INSERT INTO audit_events (at, actor, action, entity_type, entity_id, detail_json) VALUES ('${AT}', 'a', 'built', '${v}', 'x', '{}')`,
  },
  {
    column: "remittance_lines.match_kind",
    values: MATCH_KINDS,
    insert: (v, i) =>
      `INSERT INTO remittance_lines (remittance_id, line_no, amount_cents, claim_id, match_kind)
       VALUES ('R-1', ${i + 1}, 6000, NULL, '${v}')`,
  },
  {
    column: "code_map.target",
    values: CODE_MAP_TARGETS,
    insert: (v) =>
      `INSERT INTO code_map (clinic_code, target, payer_id, target_code, origin, updated_by, updated_at)
       VALUES ('SCALE', '${v}', '', 'T1', 'manual', 'a', '${AT}')`,
  },
  {
    column: "code_map.origin",
    values: CODE_MAP_ORIGINS,
    insert: (v, i) =>
      `INSERT INTO code_map (clinic_code, target, payer_id, target_code, origin, updated_by, updated_at)
       VALUES ('X${i}', 'chas', '', 'T1', '${v}', 'a', '${AT}')`,
  },
  {
    column: "sim_inbox.state",
    values: SIM_STATES,
    insert: (v, i) =>
      `INSERT INTO sim_inbox (id, claim_id, payer_id, packet_masked_json, state, updated_at)
       VALUES ('SIM-${i}', 'C-1', 'CHAS', '{}', '${v}', '${AT}')`,
  },
];

describe("the D1 schema", () => {
  it("applies to an empty database and holds every table the desk uses", async () => {
    const db = await createD1();
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([
      "ai_usage",
      "audit_events",
      "claim_lines",
      "claims",
      "code_map",
      "findings",
      "imports",
      "remittance_lines",
      "remittances",
      "settings",
      "sim_inbox",
      "submissions",
      "visit_revisions",
      "visits",
    ]);
  });

  it("keeps every count an import reports on its log row, each starting at zero", async () => {
    const db = await createD1();
    const { results } = await db.prepare("SELECT name, dflt_value FROM pragma_table_info('imports') WHERE type = 'INTEGER' ORDER BY cid").all<{ name: string; dflt_value: string }>();
    expect(results).toEqual(["received", "new", "changed", "unchanged", "ignored", "flagged", "refused"].map((name) => ({ name, dflt_value: "0" })));
  });

  for (const { column, values, insert } of closedColumns) {
    it(`${column} accepts exactly its closed union`, async () => {
      const db = await seeded();
      for (const [i, v] of values.entries()) {
        await expect(db.prepare(insert(v, i)).run(), v).resolves.toBeDefined();
      }
      await expect(db.prepare(insert("not_a_member", values.length)).run()).rejects.toThrow(/CHECK/);
    });
  }

  it("refuses to update or delete an audit event", async () => {
    const db = await seeded();
    await db.prepare(`INSERT INTO audit_events (at, actor, action, entity_type, entity_id, detail_json) VALUES ('${AT}', 'a', 'approve', 'claim', 'C-1', '{}')`).run();
    await expect(db.prepare("UPDATE audit_events SET actor = 'b'").run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM audit_events").run()).rejects.toThrow(/append-only/);
    await expect(
      db.prepare(`INSERT OR REPLACE INTO audit_events (id, at, actor, action, entity_type, entity_id, detail_json) VALUES (1, '${AT}', 'b', 'approve', 'claim', 'C-1', '{}')`).run(),
    ).rejects.toThrow(/append-only/);
    expect(await db.prepare("SELECT actor FROM audit_events").all()).toMatchObject({ results: [{ actor: "a" }] });
  });

  it("refuses to change or remove a stored visit revision", async () => {
    const db = await seeded();
    await expect(db.prepare("UPDATE visit_revisions SET clinical_json = '[]'").run()).rejects.toThrow(/immutable/);
    await expect(db.prepare("DELETE FROM visit_revisions").run()).rejects.toThrow(/immutable/);
  });

  describe("re-keying a stored visit revision (infra I1)", () => {
    const rekey = (db: D1Database, set: string) => db.prepare(`UPDATE visit_revisions SET ${set} WHERE visit_key = 'V-1' AND revision = 1`).run();

    it("lets the seal and the content hash move together to another key version", async () => {
      const db = await seeded();
      await rekey(db, "identity_sealed = 'v2:s', content_hash = 'v2:h'");
      await rekey(db, "identity_sealed = 'v3:s', content_hash = 'v3:h'");
      expect(await db.prepare("SELECT identity_sealed, content_hash, clinical_json FROM visit_revisions").first()).toEqual({
        identity_sealed: "v3:s",
        content_hash: "v3:h",
        clinical_json: "{}",
      });
    });

    it("refuses a re-key that changes anything else, keeps the version, splits the versions or drops the prefix", async () => {
      const db = await seeded();
      await rekey(db, "identity_sealed = 'v2:s', content_hash = 'v2:h'");
      for (const set of [
        "identity_sealed = 'v3:s', content_hash = 'v3:h', clinical_json = '[]'",
        "identity_sealed = 'v3:s', content_hash = 'v3:h', import_id = 'imp-2'",
        "identity_sealed = 'v3:s', content_hash = 'v3:h', created_at = 'later'",
        "identity_sealed = 'v3:s', content_hash = 'v3:h', revision = 2",
        "identity_sealed = 'v2:other', content_hash = 'v2:other'",
        "identity_sealed = 'v3:s', content_hash = 'v2:h'",
        "identity_sealed = 's', content_hash = 'h'",
        "identity_sealed = 'x3:s', content_hash = 'x3:h'",
        "identity_sealed = 'v3x:s', content_hash = 'v3x:h'",
        "identity_sealed = 'v03:s', content_hash = 'v03:h'",
        "identity_sealed = 'v1000:s', content_hash = 'v1000:h'",
      ]) {
        await expect(rekey(db, set), set).rejects.toThrow(/immutable/);
      }
    });
  });

  it("records the key version beside each payment statement's hashes, read from the prefix of rows written before it was stored", async () => {
    const db = await createD1({ migrate: false });
    const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
    const apply = (file: string) => db.exec(fs.readFileSync(path.join(migrations, file), "utf8"));
    await db.exec("PRAGMA foreign_keys = ON;");
    await apply("0001_init.sql");
    await db.batch([
      db.prepare(`INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines, matched) VALUES ('R-1', 'CHAS', 'r.csv', 'v2:fh', '${AT}', 'a', 4, 0), ('R-2', 'CHAS', 'r2.csv', 'fh', '${AT}', 'a', 0, 0)`),
      db.prepare(
        "INSERT INTO remittance_lines (remittance_id, line_no, patient_hash, amount_cents) VALUES ('R-1', 1, 'v1:aa', 1), ('R-1', 2, NULL, 1), ('R-1', 3, 'aa', 1), ('R-1', 4, 'v12:bb', 1)",
      ),
    ]);
    await apply("0002_key_rotation.sql");

    const files = await db.prepare("SELECT id, key_version FROM remittances ORDER BY id").all();
    expect(files.results).toEqual([
      { id: "R-1", key_version: 2 },
      { id: "R-2", key_version: null },
    ]);
    const lines = await db.prepare("SELECT line_no, key_version FROM remittance_lines ORDER BY line_no").all();
    expect(lines.results).toEqual([
      { line_no: 1, key_version: 1 },
      { line_no: 2, key_version: null },
      { line_no: 3, key_version: null },
      { line_no: 4, key_version: 12 },
    ]);
  });

  it("allows one claim per visit and payer", async () => {
    const db = await seeded();
    await expect(db.prepare(claimInsert("C-2", "CHAS", "chas", "ready")).run()).rejects.toThrow(/UNIQUE/);
  });

  it("lets a claim be paid from several remittance files but only once per file", async () => {
    const db = await seeded();
    await db.prepare(`INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines, matched) VALUES ('R-2', 'CHAS', 'r2.csv', 'fh2', '${AT}', 'a', 0, 0)`).run();
    const line = (rem: string, no: number) =>
      db.prepare(`INSERT INTO remittance_lines (remittance_id, line_no, amount_cents, claim_id, match_kind) VALUES ('${rem}', ${no}, 3000, 'C-1', 'reference')`).run();
    await line("R-1", 1);
    await line("R-2", 1);
    await expect(line("R-1", 2)).rejects.toThrow(/UNIQUE/);
    await db.prepare("INSERT INTO remittance_lines (remittance_id, line_no, amount_cents) VALUES ('R-1', 3, 100), ('R-1', 4, 100)").run();
  });

  it("refuses the same remittance file twice for a payer", async () => {
    const db = await seeded();
    await expect(
      db.prepare(`INSERT INTO remittances (id, payer_id, file_name, file_hash, imported_at, actor, lines, matched) VALUES ('R-9', 'CHAS', 'again.csv', 'fh', '${AT}', 'a', 0, 0)`).run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("keeps the claim line a finding concerns, or none for a claim-wide finding", async () => {
    const db = await seeded();
    await db
      .prepare(
        `INSERT INTO findings (claim_id, seq, code, severity, rule_ref, line_no) VALUES ('C-1', 1, 'x', 'warning', 'r', 2), ('C-1', 2, 'y', 'blocking', 'r', NULL)`,
      )
      .run();
    const { results } = await db.prepare("SELECT seq, line_no FROM findings WHERE claim_id = 'C-1' ORDER BY seq").all();
    expect(results).toEqual([
      { seq: 1, line_no: 2 },
      { seq: 2, line_no: null },
    ]);
  });

  it("holds one settings row at most", async () => {
    const db = await createD1();
    await expect(db.prepare(`INSERT INTO settings (id, version, doc_json, updated_by, updated_at) VALUES (2, 1, '{}', 'a', '${AT}')`).run()).rejects.toThrow(/CHECK/);
  });
});
