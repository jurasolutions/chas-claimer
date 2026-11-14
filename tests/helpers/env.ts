/**
 * A test environment: an in-memory D1 with the migrations applied and every variable a route needs,
 * all synthetic. The identifier keys are test-only constants, never a deployed key.
 */
import type { Env } from "../../server/env";
import { createD1 } from "./d1";

export const TEST_TEAM_DOMAIN = "jura-test.cloudflareaccess.com";
export const TEST_AUD = "test-audience-tag";
export const REVIEWER = "reviewer@example.test";
export const OFFICER = "officer@example.test";
export const STRANGER = "stranger@example.test";
/** base64 of the 32 ASCII bytes "chas-claimer-test-key-number-one". */
export const TEST_IDENTIFIER_KEY = "Y2hhcy1jbGFpbWVyLXRlc3Qta2V5LW51bWJlci1vbmU=";
/** base64 of the 32 ASCII bytes "chas-claimer-test-key-number-two". */
export const OTHER_IDENTIFIER_KEY = "Y2hhcy1jbGFpbWVyLXRlc3Qta2V5LW51bWJlci10d28=";
/**
 * The key `npm run dev:functions` binds, published in package.json: base64 of the 32 ASCII bytes
 * "chas-claimer-dev-key-not-secret!". Only a loopback request may use it.
 */
export const DEV_IDENTIFIER_KEY = "Y2hhcy1jbGFpbWVyLWRldi1rZXktbm90LXNlY3JldCE=";
export const TEST_CONNECTOR_TOKEN = "test-connector-token-0123456789abcdef0123456789abcdef";

export async function testEnv(overrides: Partial<Env> = {}): Promise<Env> {
  return {
    DB: await createD1(),
    ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
    ACCESS_AUD: TEST_AUD,
    ROLE_REVIEWERS: REVIEWER,
    ROLE_OFFICERS: OFFICER,
    CONNECTOR_TOKEN: TEST_CONNECTOR_TOKEN,
    IDENTIFIER_KEY: TEST_IDENTIFIER_KEY,
    ...overrides,
  };
}
