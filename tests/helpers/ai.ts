/**
 * The Anthropic stand-in for AI route tests. Each test names the model's answer; the stub serves it,
 * keeps every request body the desk sent, and serves the Access certs so routes can sign people in.
 * Any other URL still throws.
 */
import type { AccessTeam } from "./access";
import { TEST_TEAM_DOMAIN } from "./env";
import { jsonAnswer, stubNetwork, type Answer } from "./network";

export const MESSAGES = "https://api.anthropic.com/v1/messages";

/** A Messages API answer whose only text block is `text`. */
export const modelText = (text: string, stop_reason = "end_turn"): Answer =>
  jsonAnswer({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200 },
  });

/** A structured answer: `value` as the JSON the model wrote. */
export const modelJson = (value: unknown): Answer => modelText(JSON.stringify(value));

export const apiError = (status: number, type: string, message = "test"): Answer => jsonAnswer({ type: "error", error: { type, message } }, status);

/** Stubs the network with the Access certs and `answer` for the Messages API. */
export function stubModel(team: AccessTeam, answer: Answer) {
  const sent: string[] = [];
  const fetchStub = stubNetwork({
    [`https://${TEST_TEAM_DOMAIN}/cdn-cgi/access/certs`]: jsonAnswer({ keys: team.jwks.keys }),
    [MESSAGES]: async (request) => {
      sent.push(await request.clone().text());
      return answer(request);
    },
  });
  /** How many times the desk called the model. */
  const calls = () => fetchStub.mock.calls.filter(([input]) => new Request(input as RequestInfo).url === MESSAGES).length;
  return { sent, calls };
}

/**
 * Every row the desk holds except the AI call counters, so a test can show a suggestion changed
 * nothing: no claim, code-map entry, setting or audit event.
 */
export async function deskRows(db: D1Database): Promise<Record<string, unknown[]>> {
  const { results: tables } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'ai_usage' AND name <> 'd1_migrations' ORDER BY name")
    .all<{ name: string }>();
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) rows[name] = (await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()).results;
  return rows;
}
