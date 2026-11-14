import type { IdentifierKeys } from "../crypto";
import type { Env } from "../env";

/** What a service that takes data in needs: the database, the environment, the clock and the identifier keys. */
export interface Deps {
  db: D1Database;
  env: Env;
  now: number;
  keys: IdentifierKeys;
}
