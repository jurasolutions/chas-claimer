/**
 * A patient's hash across a key rotation (infra I1). Rows written before the rotation carry the
 * patient's hash under the previous key; when the desk next sees the patient's NRIC it computes both
 * and moves every row to the current one, so lookups by the current hash find the patient's whole
 * history. The re-seal route moves the patients who don't come back.
 */

const TABLES = ["visits", "claims", "remittance_lines"] as const;

/**
 * Statements that move every row carrying a patient's older hash to their current one. Each entry is
 * one patient's hashes, current first, as `patientHashes` gives them; the same patient may appear
 * more than once. A remittance line also takes the current key's `version` beside its hash, so the
 * re-seal route stops counting it as left under a retired key. One statement per table however many
 * patients, and none when nothing moves.
 */
export function adoptStatements(db: D1Database, version: number, patients: Iterable<readonly string[]>): D1PreparedStatement[] {
  const moves = new Map<string, string>();
  for (const [current, ...older] of patients) {
    if (current === undefined) continue;
    for (const hash of older) if (hash !== current) moves.set(hash, current);
  }
  if (moves.size === 0) return [];
  const json = JSON.stringify([...moves]);
  return TABLES.map((table) =>
    db
      .prepare(
        `UPDATE ${table} SET patient_hash = (SELECT json_extract(m.value, '$[1]') FROM json_each(?1) AS m WHERE json_extract(m.value, '$[0]') = ${table}.patient_hash)${table === "remittance_lines" ? ", key_version = ?2" : ""}
         WHERE patient_hash IN (SELECT json_extract(value, '$[0]') FROM json_each(?1))`,
      )
      .bind(...(table === "remittance_lines" ? [json, version] : [json])),
  );
}
