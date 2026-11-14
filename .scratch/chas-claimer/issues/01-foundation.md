# 01: Backend foundation the other tickets build on

**What to build:** the shared backend ground every later ticket codes against, landed complete so parallel work never fights over it: the whole D1 schema in one migration (technical §5 plus the lifecycle columns in decisions-g2 §2), the pure domain primitives (result, money in cents, SGT dates, NRIC with the synthetic `T9` check and masking, the complete closed unions in types, source-visit parsing and the identity/clinical split, source mapping, desk settings schema and defaults, CSV write with formula escaping and parse), the API types every area shares (`src/api/common.ts`), the server spine (env, `route()` with JSON/Origin/size checks and no-store, Access JWT verification failing closed, `DEV_USER` on localhost only, connector token check in constant time, identifier keys with HKDF/HMAC/AES-GCM, audit and settings repositories with the version+nonce guard), `GET /api/me`, `public/_headers`, test helpers (env, http request builder, network stub), config changes (zod, tsx, sql.js to dependencies, connector/ and mock/ in tsconfig and vitest includes, `dev:functions` with public dev-only bindings), and a README skeleton with the environment table and the Cloudflare Access set-up. The UI shell is ticket 01b; the synthetic clinic is ticket 02a.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] Property tests (fast-check): money add/subtract/min never produce fractions or negatives; NRIC check letters round-trip for S/T/F/G/M; `isSynthetic` accepts only valid `T9` numbers; CSV write→parse round-trips arbitrary text, and every formula-leading cell is neutralised.
- [ ] `verifyAccessJwt` accepts a token signed by a test key set (stubbed fetch) with the right audience and refuses wrong audience, expired, bad signature and missing config (503 `auth_not_configured`); `DEV_USER` is ignored unless the host is localhost.
- [ ] `sealIdentity`/`openIdentity` round-trip; `patientHash` is stable per key and differs across keys; every identity route fails closed without `IDENTIFIER_KEY`.
- [ ] The migration applies to the in-memory D1; audit events refuse UPDATE and DELETE; the version+nonce guard turns a stale write into 0 changes and no audit row.
- [ ] Mutating routes refuse non-JSON bodies and a foreign Origin (403); every API response has `Cache-Control: no-store`.
- [ ] `GET /api/me` returns email, roles, ai configured, demo mode; an email on neither role list gets 403.
- [ ] `DeskSettings` defaults parse; a settings document missing a required field is refused on read and on write.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Land `DeskSettings` complete, so no later ticket edits `src/domain/settings.ts`: branches (GST registration, CHAS and MediSave registrations), dentists (MediSave accreditation), payers (scheme, channel, panel yes/no, co-pay percentage, annual policy limit, pre-auth-required benefit codes, deadline days with blank meaning no check, template fields in order, API URL, remittance column mapping), benchmark overrides with source URL, waterfall order, and the accepted source mapping.
- Declare `SourceSchema` and `SourceMapping` (types plus zod schema) in `src/domain/source-mapping.ts`. The `MappingProposal` stub (01b), the connector (05) and the AI task (09) all use this one definition.
- `src/domain/types.ts` declares every type the UI shell's props need (`CodeMapEntry`, `Finding`, `SplitSegment`, claim statuses, identity fields), so 01b adds no domain types.
- `Actor` includes the system actors `connector`, `simulator` and `remittance`, so 07 and 08 record outcomes through `act` without changing the type.
- Schema, beyond technical §5: claims carry `accepted_cents`, `overpaid`, `checkout_by`, `checkout_until` and `channel` (stamped at approval, S15); `remittances` carries `file_hash` with UNIQUE (`payer_id`, `file_hash`) so a repeated file adds no lines (S12); the remittance line index is UNIQUE (`remittance_id`, `claim_id`) WHERE `claim_id` IS NOT NULL, not a global UNIQUE (`claim_id`), because a claim paid in part can be paid again from a later file.
- `package.json` gets every script the build needs now (`connector` through `tsx connector/cli.ts`, `mock:clinic` through `tsx mock/synthetic-clinic/cli.ts`), and no later ticket changes dependencies or the lockfile. `@anthropic-ai/sdk` is already a dependency.
- The README's environment table lists every variable from the start, including `PAYER_<ID>_API_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and `AI_DAILY_CALL_CAP`, and the README has an empty section for each later ticket to fill: "The synthetic clinic" (02a), "Running the connector at the clinic" (05), "Payer channels and API tokens" (07), "AI suggestions" (09).
