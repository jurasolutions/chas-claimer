# Code review: final-fix

- **Branch:** `crew/chas-claimer-final-fix` at `3e2ea6c`
- **Base:** `68892cf` (merge-base, the tip of the reviewed `crew/chas-claimer` final)
- **Range:** 15 commits, 48 files, +568 / -195
- **Date:** 2026-11-14
- **Context:** `reviews/code-review-final.md` (changes-requested), `reviews/test-strategy.md`, ADR 0003, `GLOSSARY.md`
- **Method:** I read every changed file. I ran the Standards and Spec axes and the security checklist by hand against the merge-base. The mattpocock `code-review` and `security-review` skills were not invoked in this session. I reproduced each finding below with a command, listed under Evidence.

## Verdict: approve

Nothing blocks. The blockers from the final review are closed at HEAD:

- **S-B1.** The issued NRIC is gone. `git grep S0000` finds nothing.
- **SP-B1.** The synthetic-data guard exists and actually fails. I proved it with ten probes (see Evidence).
- **SP-B2.** The SC2.12 and SC2.13 properties exist, with `numRuns` set to 300 and 200.

The should-fix items below are worth one more small pass before the first push. None of them changes the release call.

Q1 (author metadata) and Q2 (history rewrite or squash-merge) from the final review are still open. Both are for a human to decide; they are not code findings.

## Security

### Should fix

**SE-S1. The guard misses phone numbers glued to `:` or `#`.**
- **Where:** `tests/synthetic-data.test.ts:25`. The lookbehind of `PHONE_LOCAL`, `(?<![A-Za-z0-9_+\-/:#]|\d[.,])`, skips any match that comes right after `:` or `#`.
- **Breaks:** test-strategy SC7.6, which asks for a scan that fails on any Singapore phone shape outside `+65 0000`.
- **Repro:** I appended three local-number probes to README.md and ran the guard: one straight after `Tel:`, one after `Phone:` and one after `#`. It passed all three. It caught the same number after `Tel: ` (with a space), after `HP: ` and `phone=`, in brackets and in `+65` form. (The probe strings are left out of this note so the guard can scan it.)
- **Fix:** take `:` and `#` out of the lookbehind. If they are there to skip times or anchors, exempt those shapes directly. Add the three strings above as failing cases.

**SE-S2. A local scratchpad path is still committed, and the guard can't see it.**
- **Where:** `.scratch/chas-claimer/reviews/code-review-04.md:99`. It holds a session temp path whose folder slug spells out the local home directory, username included.
- **Breaks:** final-review S-S1, which asked for every committed path to be repo-relative. The issues files were fixed; this line was not. The standing rule is "This repo is public".
- **Why the guard passes:** `HOME_PATH` (`tests/synthetic-data.test.ts:27`) only matches `/Users/`, `/home/` and `X:\Users\`. A slug like `-Users-<name>-` and a `/private/tmp/claude-` path both slip past it.
- **Fix:** replace the path with "the session scratchpad". Add a guard pattern for `/private/tmp/`, `/tmp/claude-` and the `-Users-<name>-` slug. The history fix is the same one Q2 already covers.

### Nit

**SE-N1. Lowercase NRICs are not detected.** The `NRIC` regex (`tests/synthetic-data.test.ts:19`) is uppercase only, so a lowercase NRIC shape passes the guard. Add the `i` flag. Keep the T9 exemption case-insensitive too.

**SE-N2. No test sends a too-low or lying Content-Length.** `server/bytes.ts:51` only refuses early when the header says the body is over the cap. The streaming read still caps the body when the header is missing, too low, negative or not a number. I probed a 2000-byte body against a cap of 100 with headers of `10`, none, `abc`, `-5` and `2000`, and every one returned null. `server/bytes.test.ts` doesn't pin that behaviour down; line 40 only covers a header larger than the body. Add one case with a low header and a body over the cap.

**SE-N3. The author address is outside the guard's reach.** Commit author metadata on this branch still carries a LAN host address. The guard scans tracked files, not git metadata. This is Q1 from the final review and is listed here only so it isn't lost.

### Checked and clean
- **Blocked paths.** Nothing under `src/design-system/`, `jurasolutions/design-system/`, `inputs/`, `.env`, `.dev.vars` or `dist/` changed.
- **Network.** The only new URL is `new Request("https://desk.example/")` in `server/bytes.test.ts`. It builds an object and is never fetched.
- **Synthetic data.** The new fixtures use T9 NRICs, `+65 0000` phones and "Test Person Two". `docs/design.md` now shows "Test P. T••••018H". There are no real identifiers, secrets or tokens in the diff.

## Spec

### Should fix

**SP-S1. SC1.8: MediSave's per-system cap is not enforced, and the new test marks a probably over-cap case as ready.**
- **Where:**
  - The rule: `src/domain/claims/medisave.ts:83-85`, which checks only `maxProcedures` (3) and `maxSystems` (2).
  - The rule set: `src/domain/rules/data/medisave-tosp-2024-01-01.json:12-13`, which has no per-system field.
  - The new test: `src/domain/claims/build-cases.test.ts:293-296`. It puts three copies of the same TOSP code on teeth 38, 48 and 18, so all three are in one system, and expects `status` to be "ready".
- **Source:** `docs/research/sg-dental-claims.md:242-243` (CPF withdrawal limits, rated High): "At most 3 surgical procedures, across no more than 2 anatomical systems with no more than 2 procedures each."
- **Gap:** test-strategy SC1.8 says only "at most 3 procedures per episode", so the letter of the criterion is met. But the research note it cites limits each system to 2 procedures, and the new test locks in a case that rule forbids. In production, a 3-in-one-system claim would leave the desk as "ready" and come back as a payer rejection.
- **Fix:** add `maxPerSystem: 2` to the rule set and a blocking `tosp_too_many_in_system` finding. Change the test so 2+1 across two systems is ready and 3 in one system is held.
- **Question:** whether "each" means each system. My recommended answer is yes: that is the plain reading, and it matches the "2 systems" clause next to it. The gap predates this branch; the branch's new test is what fixes it in place.

### Nit

**SP-N1. The SC2.12 history leaves out more than it needs to.** `src/domain/claims/findings.property.test.ts:66,75,86` draws only earlier days and `SC-EARLIER-n` keys. ADR 0003 says the same-day duplicate may block, so leaving out same-day history is correct. But it also rules out the visit's own earlier rejection, which raises `upstream_rejected`, and that is only a warning. Allowing it would widen the property at no cost.

### Verified
- **SC2.12 and SC2.13.** Both properties are real and run 300 and 200 times. SC2.12 compares sorted blocking findings with history against those with empty history. SC2.13 compares visit findings, visit notes and each claim's payer, findings and status after a `structuredClone` rerun.
- **SP-S5.** `justification.test.ts` and `clinic.test.ts` now use `numRuns: 100`.
- **SC7.2.** `src/domain/rules/index.test.ts` holds all 21 table limits and the MSP rankings. I checked each one against research §2.1. The range codes are null. The $830 ward limit is left out, with a stated reason, which the conductor accepted.
- **SC1.8.** Three procedures pass the overall cap and four raise blocking `{max:3,count:4}`, apart from SP-S1 above.

## Standards

### Should fix

**ST-S1. `formatSgd` garbles negative and fractional values without any error, and duplicates `formatDecimal`.**
- **Where:** `src/domain/money.ts:43-46`.
- **Breaks:**
  - The file's own rule that money is integer cents, never a float.
  - The no-behaviour-change refactor in this ticket. The old `format()` printed `-$0.50` for -50.
  - The reuse rule. `formatDecimal` (`money.ts:52-56`) already does the dollars and cents split, with a sign and a `RangeError` guard.
- **Repro:** run with tsx. `formatSgd(-50)` gives `"$-1.-50"`, `formatSgd(-12345)` gives `"$-124.-45"` and `formatSgd(1.5)` gives `"$0.1.5"`.
- **Reach:** `src/ui/components/ClaimHistory.tsx:19` casts any finite audit-detail number `as Cents` without checking it. Audit values are written today through `cents()` and `subtract()`, so no current caller sends a negative. The bug is latent.
- **Fix:** build `formatSgd` on `formatDecimal`, putting the sign before `$` and adding thousands separators. Add `-50` and a non-integer to the money tests.

### Nit

**ST-N1. "old key" is still in two comments.** `server/crypto.ts:7` and `server/env.ts:22` use it. GLOSSARY.md:225 says to avoid it in favour of **previous key**. The README runbook and the UI are fixed.

**ST-N2. Test fixtures still use the old `T****` mask.** `maskNric` and the corrected comment in `MaskedIdentifier.tsx:9` both use `T••••`, but these fixtures don't:
- `src/ui/components/MaskedIdentifier.test.tsx:12,14,27,40,46,53,58`
- `server/repo/patients.test.ts:7`
- `src/domain/lifecycle.test.ts:44`
- `src/ui/pages/Remittances.test.tsx:244,249,376`

The tests pass because they feed the mask in directly, but they no longer show what the real output looks like.

### Verified (refactors and removals change no behaviour)
- **`readCapped`.** There is now one version in `server/bytes.ts`, used by both callers. A missing or lying length is still capped by the read (see SE-N2).
- **Dates.** `formatDateTime` uses the same options as the removed `startedFormat` in Imports, and its space replacement is now global.
- **`inSentence`.** It handles every label in `src/domain/packet.ts` correctly, plus the snake_case fallback.
- **`sha256Hex`.** `server/services/claims.ts` now uses it instead of building the hash by hand.
- **Settings.** `Settings.tsx` no longer uses `toFixed`.
- **Dead code.** `unsubmittedVisitKeys`, `StaleBody`, `BenchmarkOverride`, `formatSgdDifference`, `amountCell` and `formatStarted` are gone, with no references left.
- **Test-only exports moved.**
  - `SYNTHETIC_PAYER_IDS` now lives in the e2e test.
  - `EMPTY_HISTORY` is now local test constants.
  - `REGISTERED_ICONS` is now worked out from `window.lucide.icons` after `registerIcons()`, which gives the same result.
  - `readSqlite` stays in `mock/` and only tests use it, which is acceptable.
  - `UNSENT_STATUSES` is still used.
- **Copy (ST-S1, ST-S5).**
  - The buttons read "Copy visit date".
  - "CHAS procedure" replaces "CHAS code" in the UI, the README, `src/api/ai.ts` and Settings.
  - The runbook says "previous key".
  - GLOSSARY gained "Synthetic phone number".
- **Comments (ST-S4).** `docs/agents/crew.md:15` is verified (2026-11-14), and `App.tsx:3` is rewritten.

## Evidence (run by the reviewer in the worktree at `3e2ea6c`)

| Command | Result |
|---|---|
| `npx vitest run` | 100 files, 1402 tests passed |
| `npx vitest run` on the 20 touched test files | 407 / 407 passed |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 |
| Guard probes: append to README.md, run `npx vitest run tests/synthetic-data.test.ts`, then `git checkout -- README.md` | Failed, as it should, on 14 probes: three NRIC/FIN shapes, four phone shapes, five home-directory shapes (macOS, Linux, Windows with either slash) and two LAN addresses. Passed (gaps) on four: a local number after `Tel:`, `Phone:` or `#`, and a lowercase NRIC. Round 2 closed all four. The probe strings are left out so the guard can scan this note |
| `git grep -nE "Users-[a-z]+-\|/private/tmp\|claude-501"` | `code-review-04.md:99` (the full path) |
| tsx: `formatSgd(-50)`, `formatSgd(-12345)`, `formatSgd(1.5)` | `$-1.-50`, `$-124.-45`, `$0.1.5` |
| tsx: `readCapped` with a 2000-byte body and cap 100, headers `10`, none, `abc`, `-5`, `2000` | null in every case. With cap 5000 it returns 2000 bytes |
| `git status --short` after all probes | `?? node_modules` only |
