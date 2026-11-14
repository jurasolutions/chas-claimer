/**
 * Propose mapping (AC-6.5): a first source mapping for a clinic's database, from its table and
 * column names only. The schema description holds no row value, and it still goes through the
 * pattern scrub in case a column is named after a person. Nothing is saved: the mapping comes back
 * for the reviewer to check, and becomes the clinic's only through the mapping screen's save.
 */
import { z } from "zod";
import type { SourceMappingRequest, SourceMappingResponse } from "../../../src/api/ai";
import { err, ok, type Result } from "../../../src/domain/result";
import { parseSourceMapping, SourceMappingSchema, type SourceMapping, type SourceSchema } from "../../../src/domain/source-mapping";
import type { Env } from "../../env";
import { deidentify } from "../deidentify";
import type { AiTaskError } from "../http";
import { isRecord, MAX_ANSWER_TEXT } from "../read";
import { runAi } from "../run";

const SYSTEM = [
  "You help a Singapore dental clinic connect its own patient database to a claims desk.",
  "You are given the database's table names and column names. You never see a row.",
  "Answer with the mapping: which table holds visits, patients, treatment lines, CHAS cards, insurance policies, MediSave details and pre-authorisations, and which column holds each field.",
  "Use only table and column names exactly as given. Use null for an optional field the database does not hold, and null for a whole table the database does not hold where null is allowed.",
  "Set amountUnit to cents when money columns look like whole cents, and dollars otherwise.",
  "In notes, say in two to four plain sentences which choices the reviewer should check, and why.",
].join("\n");

const UNSUPPORTED = new Set(["$schema", "pattern", "minLength", "maxLength"]);

/**
 * The mapping's JSON schema in the form structured outputs takes: every property required, an
 * optional one as "or null", and no string-length or pattern constraints (the desk checks those
 * itself on the way back in).
 */
function forModel(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forModel);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) if (!UNSUPPORTED.has(key)) out[key] = forModel(value);
  if (isRecord(out.properties)) {
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const properties: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(out.properties)) {
      properties[name] = required.has(name) ? schema : { anyOf: [schema, { type: "null" }] };
    }
    out.properties = properties;
    out.required = Object.keys(properties);
  }
  return out;
}

const SCHEMA = {
  type: "object",
  properties: {
    mapping: forModel(z.toJSONSchema(SourceMappingSchema)),
    notes: { type: "string" },
  },
  required: ["mapping", "notes"],
  additionalProperties: false,
};

const ENTITIES = ["visits", "patients", "treatments", "chasCards", "policies", "medisave", "preAuths"] as const;

/** The model answers null for an optional field it has no column for; the mapping leaves it out. */
function withoutNullFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const name of ENTITIES) {
    const entity = out[name];
    if (!isRecord(entity) || !isRecord(entity.fields)) continue;
    out[name] = { ...entity, fields: Object.fromEntries(Object.entries(entity.fields).filter(([, column]) => column !== null)) };
  }
  if (out.preAuths === null) delete out.preAuths;
  return out;
}

/** True when every table and column the mapping names is one the clinic's database has. */
function namesOnlyWhatExists(mapping: SourceMapping, schema: SourceSchema): boolean {
  const tables = new Map(schema.tables.map((t) => [t.name, new Set(t.columns)]));
  return ENTITIES.every((name) => {
    const entity = mapping[name];
    if (!entity) return true;
    const columns = tables.get(entity.table);
    if (!columns) return false;
    const named = [..."key" in entity ? [entity.key] : [], ...Object.values(entity.fields)];
    return named.every((column) => column === undefined || columns.has(column));
  });
}

function reader(schema: SourceSchema) {
  return (value: unknown): SourceMappingResponse["suggestion"] | null => {
    if (!isRecord(value) || !isRecord(value.mapping) || typeof value.notes !== "string") return null;
    const notes = value.notes.trim();
    if (notes.length > MAX_ANSWER_TEXT) return null;
    const mapping = parseSourceMapping(withoutNullFields(value.mapping));
    if (!mapping.ok || !namesOnlyWhatExists(mapping.value, schema)) return null;
    return { mapping: mapping.value, notes };
  };
}

function describe(schema: SourceSchema): string {
  const tables = schema.tables.map((t) => `- Table ${t.name}: ${t.columns.join(", ") || "(no columns)"}`);
  return [`A ${schema.kind} database with ${schema.tables.length} tables.`, ...tables].join("\n");
}

export async function proposeMapping(
  env: Env,
  now: number,
  request: SourceMappingRequest,
): Promise<Result<SourceMappingResponse["suggestion"], AiTaskError>> {
  const prompt = deidentify(describe(request.schema));
  if (!prompt.ok) return err("ai_identifiers_remain");
  const answer = await runAi(env, now, { system: SYSTEM, prompt: prompt.value, schema: SCHEMA, read: reader(request.schema) });
  return answer.ok ? ok(answer.value) : answer;
}
