# Code review: final (whole branch)

- **Branch:** `crew/chas-claimer` at `6f05fdb`
- **Base:** `main` at `bcbd9f6` (this is the merge-base; main holds planning docs only)
- **Range:** 346 commits, 334 files, +45,378 / -67
- **Date:** 2026-11-14
- **Scope:** the whole branch as one release. Every ticket except ticket 10 (e2e) already has a review in this folder: 01, 01b, 02, 02a, 03 to 09, 11, 12, infra and qa-01. This review does not repeat them line by line. It covers:
  - ticket 10, which had no review
  - consistency across tickets: duplicates, dead code, stale comments, glossary words
  - the spec and the test-strategy exit criteria
  - a security and public-repo pass over the whole history, since nothing has been pushed yet

## Verdict: changes-requested

Three findings block the release (S-B1, SP-B1, SP-B2). The verdict rests on those three alone.

1. **S-B1.** A real, issued NRIC is committed in the crew log. The repo will be public.
2. **SP-B1.** The synthetic-data guard (SC7.6) is missing, so exit criterion 6 fails.
3. **SP-B2.** The SC2.12 and SC2.13 property tests are missing, so exit criterion 4 fails.

All three are small fixes. Everything else is either should-fix or nit. The code itself is in good shape:
- Tests, typecheck and build are green.
- The design system is untouched.
- No secrets are in history.
- No network access escapes the test stubs.
- The AI path de-identifies before it calls out and fails closed.

## Evidence (run by the reviewer at 6f05fdb, clean tree)

| Command | Result |
|---|---|
| `npx vitest run --reporter=dot` | 98 files, 1333 tests passed, exit 0 |
| `npm run typecheck` | clean |
| `npm run build` | ok, `dist/assets/index-CAzS6IHZ.js` 417 kB |
| `git log bcbd9f6..HEAD -- src/design-system` and `diff -rq` against the sync output | no commits; identical |
| `git log --all --diff-filter=A --name-only` for `.env`, `.dev.vars`, `wrangler.toml` | never committed |
| grep for `node:http`, `https`, `net`, `tls`, `dgram`, `WebSocket` imports | none. `tests/setup.ts` stubs `fetch` to throw; the e2e test uses `stubNetwork` |
| grep for `.skip(`, `.only(`, `.todo(` in tests | none |
| `git grep -n ls-files -- '*.test.ts' tests/` | empty, so there is no SC7.6 guard |
| `git grep -n "numRuns: [0-9]"` | `20` in `functions/api/ai/justification.test.ts:102`; `25` in `mock/synthetic-clinic/clinic.test.ts:79` |
| `git grep -n` for the S0000 block in `.scratch/` | hit at `.scratch/chas-claimer/crew-log.md:43` |
| `git branch -r` | empty, so nothing has been pushed to `origin` |

---

## Security

### Blocking

**S-B1. A real issued NRIC is in the repo.** It is at `.scratch/chas-claimer/crew-log.md:43` and was added in commit `3885cec`. The log line itself calls it "widely reported as issued" (an early S0000 number). It breaks the CLAUDE.md standing rule "This repo is public. No real patient data, ever" and GLOSSARY.md:203-205 (synthetic NRICs come from the reserved T9 block only). This review does not repeat the number.
- **Fix:** redact it at HEAD.
- **History:** a HEAD fix alone is not enough, because the number stays in branch history. Either squash-merge to `main` and never push `crew/*`, or rewrite history before the first push. See question Q2.
- **Release:** blocks release.

### Should fix

**S-S1. Absolute local paths in committed docs.**
- They give away the local username and folder layout, and they leak through history too.
- **Where:**
  - the "Read first" lines of `.scratch/chas-claimer/issues/01-*.md` to `09-*.md`, from commit `fea9c9b`
  - a session scratchpad path (`/private/tmp/claude-` and a user id) in `.scratch/chas-claimer/reviews/code-review-04.md`, from commit `5c367a6`
- **Fix:** make the paths repo-relative. The history fix is the same as for S-B1.
- **Release:** follow-up, but do it in the same pass as S-B1.

**S-S2. Third-party names reach Anthropic.** `deidentify` (`server/ai/deidentify.ts`) removes the visit's own identity. Free text that names a third party (a referring dentist, a family member) goes through unchanged.
- This is accepted and documented in `docs/adr/0004-ai-proposes-never-decides.md:7` and in code-review-09 nit 2.
- It is still a known gap against the standing rule "nothing sent to Anthropic carries ... a name".
- `code-suggestion.ts:49` also calls `deidentify` without the visit identity, so it relies on pattern matching alone. Code-review-09 nit 3 accepted this.
- **Fix:** add the gap to `.scratch/chas-claimer/follow-ups.md` so it doesn't stay buried in an ADR.
- **Release:** follow-up.

### Nit

**S-N1. NRIC outside the T9 block.** `functions/api/ai/source-mapping.test.ts:142` uses `"an S0000-block value"`. It is not a valid issued number, but it breaks GLOSSARY.md:203-205. The SP-B1 guard would flag it, so it has to change when the guard lands.

**S-N2. Phone numbers outside the `+65 0000` convention:**
- `a +65 9 number` in `server/crypto.test.ts`
- `a real-format mobile number` in `functions/api/ai/code-suggestion.test.ts`, `server/ai/deidentify.test.ts` and `.scratch/chas-claimer/reviews/code-review-09.md`

**S-N3. Realistic personal names.**
- "Mdm Lim Mei Ling" appears in `code-suggestion.test.ts` and code-review-09.
- `docs/design.md:69` shows "Tan W. S••••567D", a realistic name with an S-block mask.
- **Fix:** use obviously fictional names and the T9 block.

**S-N4. Real contact details and a real company in docs.**
- A real insurer staff email at `docs/research/sg-dental-claims.md:335`. It is public research data, but it doesn't need to be in the repo.
- `GLOSSARY.md:88` names a real insurer as an example. The fictional MERIDIAN or HARBOUR would do.

**S-N5. AI pricing table is incomplete.** `server/ai/anthropic.ts:71` `PRICES_NANO_USD` ignores the >100K-input-token price tier. The figure is internal only and is never published, and prompts are far below that size.

### Checked and clean
- **Secrets:**
  - No `.env`, `.dev.vars` or `wrangler.toml` was ever committed.
  - No key-shaped tokens are in history.
  - `.dev.vars.example` holds placeholders only.
- **Dev identifier key:** the key in `package.json` is published on purpose. `server/crypto.ts:42` (`DEV_KEY_FINGERPRINT`) refuses it outside loopback.
- **Synthetic data:** `mock/synthetic-clinic/identities.ts` uses T9 NRICs, `+65 0000` phones and `TEST-` member IDs.
- **AI path:** `server/ai/run.ts` `runAi` is the only Anthropic call.
  - The prompt type is the branded `DeidentifiedText`.
  - `deidentify` fails closed with `identifiers_remain`, which becomes HTTP 422.
  - `source-mapping.ts:108` sends schema names only.
  - The daily cap (`AI_DAILY_CALL_CAP`) is taken atomically.
  - Client settings: `maxRetries` 0, 60 s timeout, logging off.
- **CI:** `.github/workflows/ci.yml` uses no secrets, gives `contents: read` and sets `persist-credentials: false`.

### Needs a human decision (not a code finding)
- **Author metadata.** All 346 branch commits, and the commits on `main`, use an author email made of the local username and a LAN IP address. It goes public on the first push. See question Q1.

---

## Spec

The spec is `.scratch/chas-claimer/spec.md`. The test strategy is `docs/test-strategy.md`. Coverage:
- SC4, SC5, SC6 and SC8 are fully covered.
- SC1, SC2, SC3 and SC7 have gaps, listed below.
- All 58 acceptance criteria trace to at least one test.

### Blocking

**SP-B1. SC7.6 synthetic-data guard missing.**
- **What the strategy requires:** test-strategy.md:177 asks for a test that runs `git ls-files` and fails on any NRIC or phone shape outside the reserved blocks. Exit criterion 6 (test-strategy.md:371) requires it to pass on the gated commit.
- **What exists:** no test does this.
- **Impact:** the guard would have caught both S-B1 and S-N1.
- **Fix:**
  1. Add the guard.
  2. Make it cover `.scratch/` and `docs/`, not just `src/`.
  3. Get it green, which means fixing S-B1 and S-N1 first.
- **Release:** blocks release.

**SP-B2. SC2.12 and SC2.13 property tests missing.**
- **What the strategy requires:** test-strategy.md:111-112 asks for two properties.
  - SC2.12: claim history never adds or removes a blocking finding.
  - SC2.13: findings are deterministic.
- **What exists:** `src/domain/claims/findings.test.ts` has no `fc.` property at all.
- **Impact:** exit criterion 4 ("every property in §2 exists, numRuns ≥ 100") fails.
- **Release:** blocks release.

### Should fix

**SP-S1. SC1.8, the MediSave 3-procedure cap, is never exercised.** The rule is `src/domain/claims/medisave.ts:83` (`tosp_too_many_procedures`). `findings.test.ts:115,130` only check its message and severity. No test builds a visit with 4 procedures and checks that the finding fires, and that 3 procedures do not.

**SP-S2. SC7.2 transcription check is a spot check.** `src/domain/rules/index.test.ts:117-125` checks 4 TOSP codes. The criterion asks for all 21 limits plus the $830 ward limit, each checked against its source.

**SP-S3. QA has not been re-run on the release commit.**
- qa-01 ran at `8e6bec9`, before tickets 11 and 12.
- UAT §4, §5 and §10 defects are fixed in code and have tests, but nobody has re-checked them in the browser.
- Exit criterion 11 is unproven at `6f05fdb`.
- This is the quality gate's call. See question Q4.

**SP-S4. UAT 5.8 / SC3.7 timed check: neither run nor waived.** This is exit criterion 9. `.scratch/chas-claimer/crew-log.md:1059` lists it as open. See question Q3.

**SP-S5. Two property tests run below 100.**
- `functions/api/ai/justification.test.ts:102` uses `numRuns: 20`.
- `mock/synthetic-clinic/clinic.test.ts:79` uses `numRuns: 25`.
- Both break the rule at `tests/setup.ts:6` ("numRuns is never below 100") and exit criterion 4.
- The `fc.sample(..., { numRuns: 1 })` calls in `server/crypto.test.ts` only draw samples, so they are fine.

### Nit
- **SP-N1. SC2.4 duplicate check is thin.** It has no cross-branch case and no 00:30 SGT day-boundary case.
- **SP-N2. SC2.10 has no boundary case.** Nothing tests $31.00 against $31.01.
- **SP-N3. `server/channels/` coverage is light.** Only `api.ts` has a unit test, and there is no CSV round-trip property for the file channel. The e2e test covers the main path.
- **SP-N4. Many criteria are hard to trace.** About 50 SC IDs and 10 AC IDs appear in no test name. They are covered, but you have to read the test to find them.
- **SP-N5. AI UAT 8.2 to 8.6 have not been run against the live API.** Expected while no key is provisioned.

### Ticket 10 (e2e), first review
- The test uses `stubNetwork` with named URLs only.
- It drives the synthetic clinic, the connector, the build, submission and remittance from end to end, with no skips.
- It passes in the run above.
- No findings beyond SP-N3.

### Already logged and acceptable
- Follow-up #15: staging environment.
- Follow-up #7: undo for a hand match.

---

## Standards

### Should fix

**ST-S1. Copy breaks sentence case.**
- **Where:**
  - `src/ui/pages/AssistedSubmit.tsx:337` builds `` `Copied ${field.label}.` ``.
  - The copy and show buttons build names like "Copy Visit date" and "Show Patient NRIC/FIN".
  - All three put a capitalised label in the middle of a sentence.
- **Rule:** design-system README §3, sentence case everywhere.
- **Fix:** lowercase the label when it sits mid-sentence. `AssistedSubmit.test.tsx:107-111,142` assert the current text and need updating too.

**ST-S2. Duplicated helpers (reuse).**
- **Capped stream reader.** `server/http.ts:152` and `server/channels/api.ts:104` both define `readCapped`, and the loop is copied line for line. Make one version that takes a `Body` and put it in `server/bytes.ts`.
- **Hand-written SHA-256.** `server/services/claims.ts:511-512` builds the hash itself (`crypto.subtle.digest` + `toHex`). That duplicates `sha256Hex` (`server/bytes.ts:44`), which `server/services/submissions.ts:193,339` already uses for the same masked-packet hash. If one copy changes and the other doesn't, the hashes stop matching.
- **Cents to a decimal string, written four times:**
  - `src/domain/csv.ts:36-41` (`amountCell`)
  - `src/domain/packet.ts:184-189` (`cellText`)
  - close to `format()` in `src/domain/money.ts:52-58`
  - `src/ui/pages/Settings.tsx:68`, as `(cents / 100).toFixed(2)`. That is float maths and breaks money.ts's "never a float" rule.

  Add one `formatDecimal(cents)` to `money.ts`.
- **Date formatting.** `src/ui/pages/Imports.tsx:19-28` repeats the `Intl.DateTimeFormat` options of `formatDateTime` (`src/ui/format.ts:14-26`). Its only addition is the narrow no-break space fix. Move that fix into `formatDateTime`.

**ST-S3. Dead code.**
- `unsubmittedVisitKeys` (`server/repo/claims.ts:373`) has no caller. Only the ticket plan mentions it.
- `StaleBody` (`src/api/common.ts:90`) is never referenced.
- The `BenchmarkOverride` type (`src/domain/settings.ts:141`) is never referenced.
- These are exported only for tests and unused in production. Move them to test support or delete them:
  - `formatSgdDifference` (`src/domain/money.ts:48`)
  - `SYNTHETIC_PAYER_IDS` (`src/domain/types.ts:71`)
  - `EMPTY_HISTORY` (`src/domain/claims/build.ts:50`)
  - `readSqlite` (`mock/synthetic-clinic/write-sqlite.ts:82`)
  - `REGISTERED_ICONS` (`src/lib/icons.ts:125`)

**ST-S4. Comments that no longer match the code.**
- `docs/agents/crew.md:15` says the run command is "unverified until the first Function lands". The Functions have shipped, so verify the command and update the line.
- `src/ui/App.tsx:3` says "Later tickets replace the files under `pages/`; they never change this file". That was guidance for the parallel build and is now false.
- `server/services/claims.ts:498-499` still describes ticket 07 as future work. Ticket 07 has landed.

**ST-S5. Words the glossary avoids.**
- "Procedure code" at `src/ui/pages/Settings.tsx:437` should be "CHAS procedure".
- "CHAS code" at `src/ui/ai/index.tsx:156`, `README.md:345` and `src/api/ai.ts:18` should be **CHAS procedure**.
- "old key" in the key-rotation runbook (`README.md:565,566,578,584,607`) should be **previous key**. Line 578 quotes the UI, which already says "previous key".

### Nit

**ST-N1. Comments and labels that read as process notes:**
- Ticket and block provenance tags appear in code about 12 times. Examples: `src/domain/rules/index.ts:2`, `src/domain/claims/state.ts:3`, `src/domain/settings.ts:3`, `server/services/submissions.ts:2`.
- `README.md:42-43` say "(ticket 05)" and "(ticket 02a)".
- `src/ui/components/MaskedIdentifier.tsx:9` shows `T****000J`, but `maskNric` produces `T••••000J`.

**ST-N2. Exports nothing else imports.** About 30 symbols could drop `export`. Examples: `bytesToBase64`, `rolesFor`, `priceOf`, `REDACTED`, `fieldLabel`, `mayAct`.

**ST-N3. Helpers that could be shared:**
- `formatDay` (`src/domain/claims/findings.ts:18-26`) duplicates `formatDate` (`src/ui/format.ts:7-12`).
- `canonicalJson` lives in `src/domain/source-visit.ts:318`, but five services use it, so it belongs in a utility module.
- `parseAmount` (`src/domain/statement.ts:37`) belongs in money.ts.
- `parseCsv` (`src/domain/csv.ts:45`) is used only by tests.

**ST-N4. Glossary nits:**
- "identity key" at `src/ui/components/MaskedIdentifier.tsx:23` should be "identifier key".
- The problem code `"stale"` (an optimistic-concurrency refusal) clashes with the glossary, which avoids "stale". Either add a note to GLOSSARY.md or rename the code to `conflict`.
- "payload" at `src/api/imports.ts:31,61` should be "revision".

**ST-N5. Voice and copy:**
- "We can't find that page": `src/ui/App.tsx:72,261`.
- "API" in staff-facing copy: `AssistedSubmit.tsx:541,634`, `ClaimHistory.tsx:28`, `Settings.tsx:318`.
- "This, not that" sentences: `Settings.tsx:186,217`.
- "Qty" and "Considered" column headers: `ClaimDetail.tsx:145,151`.
- Alert titles end in a full stop in one place and not another: `ClaimDetail.tsx:112` against `Queue.tsx:117`.
- The access help text has two wordings: `App.tsx:335` against `Queue.tsx:119`.
- An ellipsis in a placeholder: `Simulator.tsx:336`.
- A raw event code can show up: `ClaimHistory.tsx:139`.
- A bare "failed" message: `mock/synthetic-clinic/cli.ts:61`.

  There are no exclamation marks, buzzwords, emoji or urgency, and the numbers rule passes.

**ST-N6. README gaps:**
- `JURA_DS_PATH` (`scripts/sync-design-system.mjs:17`) is not in the config table.
- The Layout table leaves out `scripts/`, `.github/`, `docs/research/`, `GLOSSARY.md` and `.scratch/`.

### Checked and clean
- **Rule sets:** all three files in `src/domain/rules/data/` have `effectiveFrom` / `effectiveTo` and dated `sources[]`. Subsidy amounts are configuration, not hard-coded truth. The only other amounts are the fictional insurers' editable defaults at `src/domain/settings.ts:227,243`.
- **Environment variables:** every field in `Env` (`server/env.ts`), `PAYER_<ID>_API_TOKEN` and the connector variables is in the README config table.
- **README:** the migrations section matches migrations 0001 to 0003, and the key-rotation runbook is complete.
- **Blocked paths:** no changes under `src/design-system/` or `dist/`. Nothing under `jurasolutions/design-system/` or `jurasolutions/inputs/`. No `.env` or `.dev.vars` committed.
- **Release prep:** there is no `CHANGELOG.md` yet. That is for the release manager.

---

## Questions for a human (each with a recommended answer)

1. **Q1. Rewrite the author email before the first push?** Recommend yes. Use a Jura noreply address (`git filter-repo --mailmap`) on whatever gets pushed.
2. **Q2. Squash merge or history rewrite, to keep the NRIC and local paths out of the public remote?** Recommend:
   - Redact at HEAD (S-B1, S-S1).
   - Squash-merge `crew/chas-claimer` into `main`, together with the Q1 author fix.
   - Push only `main`. Never push the `crew/*` branches.
3. **Q3. UAT 5.8 / SC3.7 timed check?** Recommend running it once against the synthetic clinic before G4. If it can't be run, record a written waiver in the quality-gate report.
4. **Q4. Re-run QA at the release commit before G4?** Recommend yes. Re-check UAT §4, §5 and §10 in the browser on the commit that gets merged.
