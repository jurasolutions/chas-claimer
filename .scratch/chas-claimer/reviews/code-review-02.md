# Code review: ticket 02 (walking skeleton)

- **Branch:** `crew/chas-claimer-02-walking-skeleton` at cb8e8f9 (worktree `.claude/worktrees/agent-ae648e114cb0b34f4`)
- **Compared with:** `git diff crew/chas-claimer...crew/chas-claimer-02-walking-skeleton`. The merge-base is 454a184. The range holds 13 commits (e26eaed..cb8e8f9) and touches 36 files, +3937 / -15.
- **Spec:** `.scratch/chas-claimer/issues/02-walking-skeleton.md`, `decisions-g2.md` (wins on conflict), `reviews/functional.md`, `reviews/technical.md`, `reviews/uat-script.md`
- **Reviewer:** crew reviewer, 2026-11-14

## Verdict: changes-requested

The verdict rests on one blocking finding: **B-1**. When a claim keeps its approval through a re-import, the approval is pinned to the old revision. The claim then shows as `approved` but can never be submitted. I reproduced this end to end.

Everything else is should fix or nit. S-1, Sp-1 and Sp-2 are the most worthwhile to fix in the same round.

## Evidence (all run by the reviewer in the worktree)

| Check | Result |
|---|---|
| `npm install` | 0 vulnerabilities |
| `npx vitest run` | 42 files, 422 tests passed. The only noise is React `act()` warnings. |
| `npm run typecheck` | clean |
| `npm run build` | exit 0 |
| Blocked paths: `git diff --stat crew/chas-claimer...HEAD -- src/design-system dist .dev.vars .env wrangler.toml` | empty. No blocked path is touched and no `wrangler.toml` is added. |
| B-1, SQL check (sql.js) | `UPDATE c SET built_from_revision = 2, approved_revision = built_from_revision` returns `[["a",2,1]]` |
| B-1, end to end | Ran in an isolated copy under the session scratchpad, so the worktree was not changed. The test imports SC-D15, approves it, then re-imports it with only `notes` changed. Output: `RESULT {"status":"approved","built":2,"approved":1}`. The assertion fails with `expected 1 to be 2`. |
| `security-review` skill | failed (`fatal: ambiguous argument 'origin/HEAD...'`; the repo has no `origin/HEAD`), so I did the security pass by hand. Findings are below. |
| `web-design-review` | run on `src/ui/pages/Queue.tsx`, `src/ui/pages/Imports.tsx`, `src/ui/components/LoadSyntheticClinic.tsx` and `src/ui/app.css` |
| Logging | no `console.*` calls in server, functions, domain or UI code outside tests. `ApiError.body` is never logged. |
| Identifiers | the only NRIC-shaped literals are T9 values. `T8999999…` is used as the deliberate refusal case. |

I read every one of the 36 changed files.

---

## Blocking

### B-1. A kept approval stays on the old revision, so the claim can never be submitted

- **Where:** `server/repo/claims.ts:377`
  ```ts
  const approval = b.existing.clearApproval ? CLEAR_APPROVAL : b.status === "approved" ? ", approved_revision = built_from_revision" : "";
  ```
- **Cause:** This fragment goes into an `UPDATE` that also sets `built_from_revision = ?` to the new visit revision. SQLite evaluates every `SET` expression against the old row. That makes `approved_revision` the *previous* `built_from_revision`, not the new one.
- **Rules it breaks:**
  - The comment directly above it (`claims.ts:375-376`) says the approval "moves to that revision (technical F5)".
  - `reviews/technical.md` F5.2 (lines 99-102) says: "Store `built_from_revision` and `approved_revision`; submission refuses when they differ."
- **Effect:** Take an approved claim whose visit is re-imported with an immaterial change, such as a front-desk note. The claim stays `approved` and the officer sees nothing wrong. But the two revisions now differ, so submission (ticket 07) will always refuse it. Nothing in the UI would explain why.
- **Test coverage:** No test covers an immaterial re-import of an approved claim.
- **Fix:**
  - Bind the value: `", approved_revision = ?"` with `visit.revision`. Alternatively, write the same expression as `built_from_revision` so both columns take the bound value.
  - Add a test in `server/services/imports.test.ts` that approves a claim, re-imports it with only `notes` changed, and asserts `approvedRevision === builtFromRevision === 2`.

---

## Standards

### Should fix

- **S-1. The synthetic route does the service's work.**
  - **Where:** `functions/api/imports/synthetic.ts:16-31`. The route generates the clinic, reads and writes settings and the code map, runs `db.batch`, and then calls `importVisits`.
  - **Rules it breaks:** `technical.md:288` ("thin route files: parse params, call one service, return") and `technical.md:443` ("route files call exactly one function").
  - **Fix:** Move the setup into a `loadSyntheticClinic` service in `server/services/`. That service is also the natural place to page the import (see Sp-4).

- **S-2. The import service runs SQL against `imports` even though a repository for it exists.**
  - **Where:** `server/services/imports.ts:89`, `:95` and `:119` write `imports` rows directly, but `server/repo/imports.ts` exists in the same diff.
  - **Rule it breaks:** `technical.md:421` says "Repositories ... return statements for the service to batch".
  - **Fix:** Route these three writes through `server/repo/imports.ts`.

- **S-3. `formatSgd` accepts a plain `number`.**
  - **Where:** `src/domain/money.ts:43` declares `formatSgd(amount: Cents | number)`.
  - **Rule it breaks:** `technical.md:307` defines `formatSgd(c: Cents)`. Widening the parameter lets unbranded numbers, including dollar values, through the one formatter the brand relies on.
  - **Fix:** Restore `Cents`. Callers that hold a number should convert it with the existing `cents()` constructor.

- **S-4. Duplicated code (reuse).**
  - The `RealIdentifierRefusedError` → 422 mapping is copied in `functions/api/imports/index.ts:22-27` and `functions/api/imports/synthetic.ts:26-31`. Move it into the error mapping in `server/http.ts`, where the other domain errors already map to statuses.
  - `MAX_ATTEMPTS = 3` and the same optimistic-retry loop appear in both `server/services/imports.ts:47,149` and `server/services/rebuild.ts:173,196`. Extract one `withRetry` helper.

- **S-5. The code-map write side lands early.**
  - **Where:** `server/repo/code-map.ts:34-47` (`saveStatements`).
  - **Rule it breaks:** `technical.md` §4 gives block 02 only the read side of the code map. Writes belong to block 06.
  - **Fix:** Its only caller is synthetic seeding, so either note it in the ticket as pulled forward or keep it inside the synthetic service from S-1.

### Nit

- **S-6. Files outside block 02's §4 row.**
  - New files: `server/cursor.ts`, `server/repo/imports.ts`, `src/domain/claims/state.ts`.
  - Edits to block 01 files: `src/domain/money.ts`, and `tests/helpers/d1.ts` (adds `runSync` and a synchronous batch). The conductor accepted the d1 change.
  - `ClaimPatch` and `transitionStatement` at `claims.ts:456-510` are listed in the contract, so they are acceptable.
  - None of this is wrong; record it in the ticket so block owners know.
- **S-7. `list` takes a different signature from §3.** `server/repo/claims.ts:254` declares `list(db, filter, opts: {now})`, while §3 specifies `list(db, filter, page: Cursor)`; here the cursor travels inside `filter`. Either align the code with §3 or update the doc.
- **S-8. Feature envy.**
  - `server/repo/claims.ts:283-313`: `list` reads `settingsRepo` and calls `deadlineView`, which is view assembly inside a repository.
  - `server/repo/claims.ts:207`: `history` calls `visits.forPatientYear`.
- **S-9. Long function.** `upsertBuiltStatements` (`server/repo/claims.ts:366-454`) runs to about 90 lines and mixes column selection, approval handling and line rewrite. B-1 lives in it, so splitting it would help.
- **S-10. Hidden side effect.** `importOne` (`server/services/imports.ts:142`) changes `summary.flagged` as a side effect. Return the outcome and let the caller count it.
- **S-11. Small duplication and a data clump.**
  - `new Date(now).toISOString()` is repeated across the services; a single `isoAt(now)` would do.
  - The `lineKey` fields at `server/services/rebuild.ts:48` form a data clump that could reuse `ClaimLineState`.

### Passes

- The UI reaches the design system only through `src/ds.ts`.
- The `file-up` icon is registered at `src/lib/icons.ts:34`.
- `app.css` uses DS tokens only, with no raw hex or px values.
- The copy has no exclamation marks and none of the banned words.
- Rule rates live in `src/domain/rules/data/chas-2025-10-01.json`, each with a source and an "as of" date (the numbers rule).
- Tests stub the network.

---

## Spec

### Should fix

- **Sp-1. The ignored count is never stored, so the saved import counts don't add up.**
  - **Rules it breaks:**
    - AC-1.3 (`functional.md:336-339`) says an older revision "is ignored and reported as 'older than the current revision'".
    - AC-1.4 (`functional.md:340-341`) says "the import summary counts add up to the visits sent".
  - **What the code does:**
    - The `imports` row update at `server/services/imports.ts:119` saves new, changed, unchanged and flagged, but not ignored. The `imports` table (`migrations/0001_init.sql:19-31`) has no column for it.
    - The recent-imports view `COUNTS` (`src/ui/pages/Imports.tsx:30-37`) leaves ignored out.
    - `describeImport` (`src/ui/components/LoadSyntheticClinic.tsx:7-11`) leaves out both ignored and flagged.
    - Only the POST response carries `ignored[{reason:"older_than_current"}]`.
  - **Effect:** Once the page reloads, an import that ignored visits shows counts that no longer add up.
  - **Fix:** Add the column in a new migration (`0001` has already shipped in 01) and show it in both places.

- **Sp-2. The deadline is not re-checked when the queue loads.**
  - **Rule it breaks:** `decisions-g2.md:47-48` says the deadline is "re-checked when the queue loads (a cheap recompute of the deadline finding)".
  - **What the code does:**
    - `server/repo/claims.ts:254-318` recomputes only the display value (`deadlineView`). Status, `blockingCount` and the `past_submission_window` finding stay as they were stored at build time.
    - `RebuildReason "deadline"` (`server/services/rebuild.ts:38`) is declared but has no caller.
  - **Effect:** A claim built before its window closed still lists as `ready`, while `DeadlineText` (`src/ui/components/DeadlineText.tsx:23`) shows "Past the …-day window" next to it.
  - **Fix:** Either recompute the deadline finding inside `list`, or call the `"deadline"` rebuild for claims whose window has passed before the page is read.

- **Sp-3. The D07 and D08 tests lock in wrong amounts, and ticket 03 must not inherit them.**
  - **Where:** `src/domain/claims/build-cases.test.ts:80` asserts D07 at 2000 with status `needs_attention` and `card_expired`. Line `:82` asserts D08 at 3000 while blocked.
  - **Rules they break:**
    - `decisions-g2.md` §4 says a permanently unclaimable claim contributes $0.
    - `uat-script.md:63` and `:65` list D07 and D08 as blocked.
  - **Cause:** `pickCard` returns the expired tier (`src/domain/claims/build.ts:158-164`, `:208`, `:229`, and `splitBill` at `:304-326`).
  - **Fix:** The waterfall is 03's scope, so fixing the amounts can wait. But mark these two cases as provisional or known-wrong now (for example a `// TODO(03)` comment and an `it.todo` with the correct value), so 03 doesn't treat them as the truth.

- **Sp-4. The synthetic route bypasses the 100-visit page cap.**
  - **Where:** the cap is enforced only in `functions/api/imports/index.ts:21`. `functions/api/imports/synthetic.ts:27` imports the whole generated clinic, 180-220 visits, in one invocation.
  - **Rule it breaks:** `technical.md:139-140` says the cap "keeps one invocation well under D1's per-invocation query limit".
  - **Effect:** This is not an acceptance-criterion failure. It is a deploy risk on the demo path.
  - **Fix:** Page the import inside the service from S-1.

### Nit

- **Sp-5.** `src/domain/rules/data/chas-2025-10-01.json:7` cites the general `chas.sg/Using-CHAS/Cards-and-Subsidies/` page. The research note (`docs/research/`, lines 504-506) cites the per-card pages, which carry the amounts. Point each rate at the page that states it.
- **Sp-6 (scope note).** Ticket 02 implements much of 03's CHAS logic. The conductor accepted this in crew-log; I list it so 03's reviewer diffs against it.

### Not counted (ticket 03 owns these)

- `completedOn` is not yet used for the window, card, tier and same-day checks (`build.ts:159`, `:175`, `:206`, `:216`).
- D23 lacks the past-window finding.
- D24 lacks the pre-auth balance warning.
- The design.md "Queue row" bill-split bar (`design.md:23-25`) is not in the queue. It shows the waterfall, so it belongs to 03.

### Delivered as specified

- The rule-set amounts match.
- `rebuild.ts` exists.
- The claims repository interface is in place.
- The identifier test is present: `functions/api/claims/index.test.ts:90-100` asserts the full JSON has no NRIC, NRIC digits, name, phone or address.
- The property test for money is present.
- The T9 guard works.

---

## Security

There are no blocking findings. I did this pass by hand because the `security-review` skill could not resolve `origin/HEAD`.

### Nit

- **Sec-1. A non-demo deployment reveals that the synthetic route exists.**
  - **Where:** `functions/api/imports/synthetic.ts:16-17` checks `DEMO_MODE !== "yes"` only *after* the identity-key resolution in `server/http.ts:122-124`.
  - **Effect:** In a deployment without `IDENTIFIER_KEY`, an authenticated officer gets a 503 `identity_not_configured` instead of a 404.
  - **Fix:** Check `DEMO_MODE` first.
- **Sec-2. A withdrawn claim keeps its approval fields.** Withdrawing an approved claim (`server/services/rebuild.ts:136-137`) audits `withdraw` with `from: approved`, but leaves the approval fields set on the closed claim. This is not exploitable today. It becomes a risk if ticket 04 ever reopens claims; clear them on withdraw.
- **Sec-3. Rebuild history can miss held lines from another year.** History is keyed on `yearOf(clinical.date)`, so a held line whose `completedOn` falls in a different year is missed. Note for 03.

### Passes

- **Import endpoint (`POST /api/imports`):** it requires connector auth with an identity, `readJson` enforces a byte limit, and more than 100 visits returns 413.
- **Refused identifiers:** `RealIdentifierRefusedError` returns 422 with only `importId` and indexes, and never echoes the value; `functions/api/imports/index.test.ts:35-36` asserts that. The guard refuses the whole batch unless `ALLOW_REAL_IDENTIFIERS=yes`, and the `import_refused` audit entry holds indexes only.
- **Error messages:** Zod validation messages carry no values.
- **Identity sealing:** `sealIdentity` binds the additional authenticated data to `{visitKey, revision}`, so a sealed row can't be replayed under another visit or revision.
- **Claims list:** it reads only `patient_mask`.
- **SQL injection:** the `PATCH_COLUMNS` whitelist prevents it, and the cursor shape is validated before use.
- **Secrets and data:** no secrets, no `.dev.vars` content and no real patient data appear in the diff. The recent-imports list holds counts and the actor's email only.
- **No AI on identifiers:** nothing in this diff calls Anthropic.

---

## UI (`web-design-review`)

There are no blocking findings.

### Nit

- **UI-1.** `.claim-row__findings summary` (`src/ui/app.css`, about line 464) has no hover state. It is the only interactive control in the row without one.
- **UI-2.** `src/ui/pages/Queue.tsx:140-141` shows "More claims didn't load. Try again." The retry button stays visible, but its label doesn't say what it retries. "Load more claims" would be clearer.
- **UI-3.** `describeImport` (`src/ui/components/LoadSyntheticClinic.tsx:7-11`) omits flagged and ignored. The fix is the same as Sp-1.

### Passes

- **Loading and status:**
  - Loading copy uses the `…` character.
  - Import results sit in `role="status"` regions and failures in `role="alert"`.
  - Loading buttons set `aria-busy` and `disabled`.
- **Formatting:** dates use `Intl.DateTimeFormat` with `Asia/Singapore` (`Imports.tsx:19-28`), and import figures use `tabular-nums`.
- **Layout:** long lists use `content-visibility` on rows, and flex children set `min-width: 0` and `overflow-wrap`.
- **Accessibility:**
  - The decorative icon is `aria-hidden`.
  - `translate="no"` is set on the patient mask and payer name.
  - Focus on `<summary>` is covered by the global `:focus-visible` (`src/design-system/tokens/base.css:32`).
- **Behaviour and tokens:** navigation uses links, empty states are handled, and only DS tokens are used.
- **Sentence case:** the design system's sentence-case rule overrides the guideline's Title Case.

---

## Questions for the conductor

1. **What should happen to the D07 and D08 test cases (Sp-3)?** I recommend marking them provisional in this round, then correcting the amounts to $0 and blocked in ticket 03, where `pickCard` and the waterfall are owned.
2. **Where should the ignored count be stored (Sp-1)?** It needs a schema change. I recommend a new migration `0002` adding `ignored_count`, made in this round, because AC-1.4 belongs to 02.
