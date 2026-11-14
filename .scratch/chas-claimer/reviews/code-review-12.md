# Code review 12: QA fixes (12a claim detail and builder, 12b queue, dialogs and overview)

- **Branch:** `crew/chas-claimer-12-int` at `da718ff`. This is the integration of `crew/chas-claimer-12b-qa`, then `crew/chas-claimer-12a-qa`.
- **Compared against:** `d9ae698`, the `crew/chas-claimer` tip and merge-base. `git diff d9ae698...HEAD` covers 41 files, +1401/−94, and 21 commits including merges.
- **Spec:** `.scratch/chas-claimer/issues/12a-qa-claim-detail-and-builder.md`, `issues/12b-qa-*.md`, `reviews/qa-01.md` (D01–D20) and `reviews/uat-script.md`
- **Reviewed:** 2026-11-14, crew reviewer. I read every changed file.

## Verdict: approve with fixes

There are no blocking findings, so this is an approve. Two spec items should be fixed before UAT is run against this build:

- SP-1: the queue shows no branch, so UAT 3.3 fails as written.
- SP-2: a frozen claim can show "About this visit" notes from a later revision, which breaks D12.

All five former `it.fails` are now plain passing tests, and none of their assertions were removed:

- checkout re-open
- D05 crown held
- AC-8.3 overview
- dialog focus
- queue filter control

## Evidence

| Command | Result |
|---|---|
| `npx vitest run` on the 13 touched test files | 13 files, 239 tests passed |
| Full suite (conductor's run on this tip) | 98 files, 1328 tests passed |
| `npm run typecheck` | clean |
| `npm run build` | built. `dist/` is untracked and not committed |
| `git status` | only `?? node_modules` |
| Blocked paths (`src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars`, `dist/`) and `wrangler.toml` | none touched |
| `it.fails` left in `src/ functions/ server/ connector/` | none |

---

## Standards

### Blocking

None.

### Should fix

- **ST-1. The scheme display names are now defined three times.** This is a reuse finding.
  - `src/ui/components/QueueFilters.tsx:12-17` `SCHEME_WORDS` is a verbatim copy of `src/ui/pages/Settings.tsx:210`.
  - `src/domain/claims/findings.ts:28` `SCHEME_NAMES` is a third variant.
  - **Rule:** the reuse rule. New code should not duplicate an existing helper.
  - **Fix:** export one map, for example from `src/domain` next to the scheme type, and import it in all three places.

### Nit

- **ST-2.** `src/ui/pages/Overview.tsx:13` `STATUS_WORDS` duplicates the StatusBadge words. This diff already exports them as `statusWords` (`src/ui/components/StatusBadge.tsx:16`). This is the reuse rule again.
- **ST-3.** `src/domain/lifecycle.ts:230` writes `status === "submitted" || status === "accepted"` inline, although `SENT_STATUSES` already exists in the same module.
- **ST-4.** `src/dialog.tsx:10` imports the DS `Dialog` directly instead of through `src/ds.ts`. The operating card says DS components are imported only through `src/ds.ts`. This is acceptable because `dialog.tsx` is the wrapper that `ds.ts:89-90` re-exports. Keep the upstream DS issue open so the wrapper can be deleted.
- **ST-5.** `src/dialog.tsx` ~31-34 assigns `opener.current` and `wasOpen.current` during render. It is harmless under StrictMode today, but the React rule is to assign refs in an effect. The first-focus selector skips `aria-label="Close"`, which ties it to the DS label text. Both go when the upstream fix lands.
- **ST-6.** The local `FieldNote` in `src/ui/pages/AssistedSubmit.tsx:321` re-implements the DS Field hint and error. It is correctly wired with `aria-describedby`. Raise it under the same upstream note.
- **ST-7. Judgement only.**
  - `claimDetail` in `server/services/claims.ts` keeps growing (the frozen split, `lastBuilt`, `pricedBy`, remark filtering).
  - The `settled` rule lives in `ClaimDetail.tsx`, not in `src/domain`.
  - `connector/problems.ts` mirrors the schema's FIELDS and LISTS by hand.
  - Consider a deepening pass later. None of this blocks.

---

## Spec

### Blocking

None.

### Should fix

- **SP-1. D03 / UAT 3.3: the queue shows no branch.**
  - **What the spec says:** `reviews/uat-script.md:115` expects "Open the queue; filter `ready` | D01 shows CHAS $50.50, branch East". `reviews/qa-01.md` D03 (~line 210) expects branch "East". Ticket 12a (`issues/12a-qa-claim-detail-and-builder.md:21-22`) says "branches show their names from settings, not codes".
  - **What the code does:** claim detail now has `branchName` (`server/services/claims.ts:593`, `src/ui/pages/ClaimDetail.tsx:188-199`). But `ClaimRow` (`src/api/claims.ts:31`) carries only `branchId`, and the rows in `src/ui/pages/Queue.tsx` (~213-239) render no branch at all. The branch filter does use names (`src/ui/components/QueueFilters.tsx:55-60`).
  - **Result:** the QA wording "the queue or D04b's detail" is met through the detail page, but UAT 3.3 fails as written. The 12a developer raised this as an open question, and it is not in `follow-ups.md`.
  - **Fix, one of:**
    - add `branchName` to the list API and to the queue row meta;
    - or amend UAT 3.3 to check the branch on the detail page and log a follow-up.
- **SP-2. D12: a frozen claim can show notes from a later revision.**
  - **What the spec says:** D12 requires that "a withdrawn or submitted claim's frozen figures and the visit's current figures are never mixed on one screen".
  - **What the code does:** the figures and lines freeze correctly (`server/services/claims.ts:551-581`). But `visit.notes` and `visit.findings` (`claims.ts:605-608`) come from `remarks()` (`server/repo/visits.ts:137`), and `remarksStatement` writes those only for the visit's current revision (`visits.ts:148`).
  - **Result:** a sent claim built from revision N shows revision N+1's "About this visit" notes beside its "As built on" figures.
  - **Fix, one of:**
    - hide the visit remarks when the claim is frozen and `builtFrom !== current`;
    - label them as the visit's current state;
    - store them per revision.
  - **Missing test:** a frozen claim whose visit has been re-imported.

### Nit

- **SP-3. Small scope additions beyond the tickets.** All are defensible and consistent with D07 and D17:
  - new empty-state copy, "The checks found nothing on this claim." (`src/ui/components/FindingList.tsx:40`);
  - the heading "What the checks found";
  - the exported `statusWords`;
  - 58 lines in `src/ui/app.css`.
- **SP-4.** "Loading approved claims…" (`src/ui/pages/AssistedSubmit.tsx:544`) has no `aria-busy`, although the queue's "Loading claims…" does. The ticket names only the queue, so this is consistency, not a breach.

### Checked and refuted

- **"`frozenOn` counts `approval_cleared`, which sets no figures."** This is wrong. `server/services/rebuild.ts:166` writes `approval_cleared` *instead of* `rebuilt` when a rebuild also clears approval, so that audit entry marks a build. `BUILD_ACTIONS` (`claims.ts:613`) is correct.

### Verified as specified

- **D01:** filters in the URL.
- **D02:** migration `0003_visit_notes.sql`. The rebuild stores notes, including the withdrawn-visit note, and they are rendered through `describeVisitNote`. Tests apply every file in `migrations/` (`tests/helpers/d1.ts:14`). The import batch runs revision writes before the statements (`server/services/imports.ts:176`), so the `current_revision` guard holds.
- **D04, D08, D10, D20.** The D10 sweep found no form-submitting Button without a type. The untyped ones are all Dialog footer Cancels outside the form.
- **D05/D07:** a blocked claim says it can't be submitted, and settled findings carry no severity.
- **D06:** the dialog wrapper, with the upstream follow-up noted.
- **D09:** the hold extension has no version bump and no audit entry, and it is guarded by id, version and holder (`server/repo/claims.ts` ~567).
- **D11:** approval is cleared only on claims that changed (`functions/api/settings.test.ts` ~150).
- **D13:** insurer claims have no rule-set card, `pricedBy` lists each scheme's rule set and source, and branch names appear on the detail page.
- **D17:**
  - no payment action on a paid claim;
  - Reopen asks to confirm;
  - the submit list refreshes after a file is confirmed;
  - the server already refused a second export or confirm (`server/services/submissions.ts:168-169`), and this is now pinned by `functions/api/submissions/index.test.ts:165-193`.
- **D18:** limited to 0 to 5 days in both `server/repo/claims.ts:280` and `server/repo/overview.ts`.
- **D19:** `connector/problems.ts` builds its messages from field paths only.

---

## Security

The `security-review` skill failed with `fatal: ambiguous argument 'origin/HEAD...'`, because this worktree has no `origin/HEAD`. I did the same pass by hand on `d9ae698...HEAD`.

### Blocking

None.

### Should fix

None.

### Nit

None.

### Checked

- **Identifiers (public repo, no AI on identifiers):**
  - The new `notes_json` and `findings_json` columns hold codes and params only (`VisitNote`, `src/domain/types.ts:172`), never an NRIC, name, phone number or address.
  - `connector/problems.ts` returns fixed strings plus a Zod path and never echoes values.
  - `'T9XXXXXXX'` appears only as a deliberately malformed value in a "never echo" test.
  - No new data goes to Anthropic.
- **Auth:** no route or role changes. `GET /api/settings` already allows officer and reviewer (`functions/api/settings.ts:18`), so the new queue filter names load for officers without widening access.
- **Hold extension:** `hold()` (`server/services/claims.ts` ~394-404) reaches the extend path only after the person, status and holder checks. The SQL is guarded by id, version and `checkout_by`.
- **Submissions:** confirmed files can't be re-exported or re-confirmed (409).
- **Secrets and config:** no secrets, no `.env` or `.dev.vars` changes, and no `wrangler.toml`.
- **Test data and network:** tests use synthetic data and touch no network.

---

## UI

I checked `src/ui/components/QueueFilters.tsx`, `FindingList.tsx`, `StatusBadge.tsx`, `src/ui/pages/Queue.tsx`, `ClaimDetail.tsx`, `AssistedSubmit.tsx`, `Overview.tsx`, `src/dialog.tsx` and `src/ui/app.css` against the vendored Web Interface Guidelines.

### Blocking

None.

### Should fix

None.

### Nit

- **UI-1.** If settings fail to load, `QueueFilters` silently falls back to raw branch ids. A muted "Branch names couldn't load" note would explain the codes.
- **UI-2.** The native Select in dark mode and modal overscroll are DS-level issues. 12b already noted them for upstream.
- **UI-3.** See SP-4: `aria-busy` is missing on "Loading approved claims…".

### Checked

- **Filters:** `QueueFilters` is a labelled `role="group"`, uses Field labels, and its state is reflected in the URL.
- **Loading and dialogs:** loading regions carry `aria-busy`. On open, the dialog focuses its first real control and returns focus to the opener on close. Escape still works through the DS listener.
- **CSS:** the new CSS uses DS tokens only, with `min-width: 0`, `overflow-wrap: anywhere` and `text-wrap: balance`.
- **Copy:** sentence case, second person, no buzzwords, no exclamation marks, no emoji.
