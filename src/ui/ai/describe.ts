/**
 * Reads back what `npm run connector -- describe` prints: table and column names, never a row. The
 * mapping proposal takes the schema this way so the connector's token never reaches the desk's AI
 * route (technical F8). Anything that is not that output is refused rather than guessed at.
 */
import { SourceSchemaSchema, type SourceSchema } from "../../domain/source-mapping";

const HEADING = /^A (sqlite|csv) source with (\d+) tables?:$/;

function tableLine(line: string): { name: string; columns: string[] } | null {
  const trimmed = line.trim();
  const at = trimmed.endsWith(":") && !trimmed.slice(0, -1).includes(": ") ? trimmed.length - 1 : trimmed.indexOf(": ");
  if (at <= 0) return null;
  const rest = trimmed.slice(at + 1).trim();
  return { name: trimmed.slice(0, at), columns: rest === "" ? [] : rest.split(", ").map((c) => c.trim()) };
}

export function parseDescribe(text: string): SourceSchema | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const heading = HEADING.exec(lines[0]?.trim() ?? "");
  if (!heading) return null;
  const tables = [];
  for (const line of lines.slice(1)) {
    const table = tableLine(line);
    if (!table) return null;
    tables.push(table);
  }
  if (tables.length !== Number(heading[2])) return null;
  const schema = SourceSchemaSchema.safeParse({ kind: heading[1], tables });
  return schema.success ? schema.data : null;
}
