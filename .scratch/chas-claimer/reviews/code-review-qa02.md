# Code review: QA 02 fix integration

- **Branch:** `crew/chas-claimer-qa02-int` at `f9669ba`
- **Compared against:** `2eef6fd` (merge-base)
- **Scope:** 38 files, +787 / -34
  - qa02-server: N3, N5, N6, N7
  - qa02-ui: N1, N2, N4, N8, plus the settings note for follow-up 1
  - conductor commit `f9669ba`: the neutral "rest" segment in BillSplit
- **Reviewer:** crew reviewer, 2026-11-14

## Verdict: changes-requested

There is one blocking finding, B1. The N3 fix corrects the Who pays panel after a waterfall reorder, which is a rare case. In doing so it breaks the panel on the most common multi-payer claim page: a submitted CHAS claim whose MediSave and insurer claims are still pending. That page now shows only CHAS and a grey "rest of the bill". The MediSave segment, the insurer segment and the patient's share are gone, with no settings change involved. Everything else is approve-quality.

## Evidence (run by the reviewer in the int-qa02 worktree)

- `npx vitest run`: 102 files, 1460 tests, all pass.
- `npm run typecheck` (`tsc --noEmit`): exit 0.
- `npm run build`: ok.
- **N5, with `migrations/0004` taken out:** the `server/services/claims.test.ts` test "N5: refuses a portal reference that differs from another CHAS claim's only in case or spacing" fails. The test proves the fix.
- **N5, with `server/repo/remittances.ts` restored to base:** the N5 test in `remittances.test.ts` fails. The test proves the fix.
- **B1 reproduction:** I ran throwaway tests in a detached scratch worktree at HEAD and at base, then removed it. The branch was not modified.
  - **D04b**, CHAS submitted (62000), MEDISAVE_FLEXI 40000 and MERIDIAN 28800 still `ready`, settings unchanged. `claimDetail(CHAS).split.segments`:
    - HEAD: `[CHAS 62000, rest 68800]`
    - base: `[CHAS 62000, MEDISAVE_FLEXI 40000, MERIDIAN 28800, patient 0]`
  - **Withdrawn Flexi**, siblings unchanged, settings unchanged:
    - HEAD: `[MEDISAVE_FLEXI 40000, rest 90800]`
    - base: `[CHAS 62000, MEDISAVE_FLEXI 40000, MERIDIAN 28800, patient 0]`
- **Blocked paths:** no change under `src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars` or `dist/`. No `wrangler.toml` was added.
- **Method:** the mattpocock `code-review`, `security-review` and `crew:web-design-review` skills were not invoked. I ran both axes and the security pass by hand over every changed file.

## Standards

### Should fix

- **S1** `src/ui/components/ClaimHistory.tsx:1`: `import type { RebuildReason } from "../../../server/services/rebuild"`.
  - This is the only `src/` → `server/` import in the codebase, so the UI now depends on a Functions service module.
  - It breaks the layering in README.md:20: "`src/api/` | Request and response types shared by the UI and the Functions".
  - Fix: move `RebuildReason` to `src/api/` (or `src/domain/`) and import it from there on both sides.

### Nit

- **S2** `src/ui/pages/ClaimDetail.tsx:413`: a space is missing in `onDone={afterAction}onReload={reload}`. It is valid JSX, but it reads as a typo.
- **S3** `src/domain/claims/build.ts:561-566`: the `frozenSplit` docstring says the other frozen claims keep their amounts "in waterfall order". In fact the amounts are allocated in `onVisit` order and then sorted by today's waterfall rank. Either reword the docstring or allocate in build order.
- **S4** `src/ui/pages/ClaimDetail.tsx` (N8 `closedShort`) computes `cents(claim.claimedCents - claim.paidCents)`. `ClaimActions.tsx` `shortWords` uses `subtract` for the same sum. Both are integer cents, so the only issue is consistency with the money helpers.
- **S5** `migrations/0004`: the 0001 portal-reference indexes are now redundant beside `submissions_portal_reference_key` and `claims_portal_reference_key`. Dropping them is optional.

## Spec

### Blocking

- **B1** `server/services/claims.ts:533-547` (`frozenVisitSplit`), via `src/domain/claims/build.ts:567` (`frozenSplit`): unsent siblings that nothing changed are folded into "rest of the bill".
  - **The rule:** `frozenWith` keeps only siblings that are *sent* and built from the same revision. Every other open sibling sets `othersOpen`, and then the remainder becomes a single "rest" segment.
  - **Where it fires:** the claim header is frozen for any status past `ready`, and so is the claim it is called for. So the rule applies to every submitted CHAS claim whose later payers are still draft, ready or approved. Those siblings were built from the same revision under the same settings, and their stored amounts are still correct.
  - **What it breaks:**
    - `docs/design.md:17-22`: the claim-detail bill split shows "CHAS, then MediSave, then the insurer, then what the patient pays", with "every segment labelled underneath with payer and amount".
    - AC-3.7: the claim page shows "the visit's bill across its payers".
    - On base, this page met both rules (reproduced above).
  - **Scope of the original defect:** QA 02 N3 (`reviews/qa-02.md:199`) only reported the case where the waterfall changed after the claim froze ("uses today's settings"). Its expected result is that the header and the split agree, which base already met whenever settings had not changed.
  - **Suggested fix:**
    - Treat an unsent sibling as "unchanged" when today's `splitAcross(builtFrom, settings, [claim, ...same-revision open siblings])` gives the frozen claim's own segment equal to `claim.claimedCents`. In that case keep the full payer-by-payer split with the patient last.
    - Fall back to `frozenSplit` with "rest" only when the frozen claim's share no longer matches. That is the N3 case.
    - Add a test: submitted CHAS on D04b with Flexi and Meridian `ready` shows four segments, CHAS, MediSave, Meridian and patient.
  - **Open question:** if showing "rest" for pending siblings is a deliberate reading of D12, it needs Ting Yu's sign-off. It changes the claim page that UAT walks most often.

### Should fix

- **SP1** `server/services/claims.test.ts:691`: the test "a frozen claim whose siblings are all frozen with it shows each at its claimed amount and the patient last" withdraws every claim. So `frozenWith` is empty and the path where several frozen claims sit together is never run. Add a case with two sent siblings from the same revision and nothing else open.

### Nit

- **SP2** `docs/design.md:43`: the bill-split colour row lists `--green-700`, `--green-500`, `--green-300` and `--neutral-200` hatched. It does not list the `--neutral-300` rest fill added in `f9669ba`. The token itself is a design-system token, so this only affects the doc.
- **SP3** The BillSplit `f9669ba` summary sentence, "CHAS pays $462.50, and the rest of the bill is $487.50 of $950.00", reads awkwardly. Consider "CHAS pays $462.50 of $950.00. The other $487.50 is still to be worked out."
- **SP4** N7 (`src/domain/claims/insurance.ts:27-35`): one claim-level pre-auth reference clears `pre_auth_missing` for every benefit on the claim. That matches the single reference on the packet (`src/domain/packet.ts:171`), so no change is needed now. Note it if insurers start issuing a pre-auth per benefit.
- **SP5** N5: reference keys diverge for non-ASCII text.
  - `src/domain/matcher.ts` `referenceKey` uses JS `toUpperCase` (Unicode). The trigger and index use SQLite `upper` (ASCII only).
  - Edges are trimmed in JS on both inputs (`lifecycle.ts:100`, `statement.ts:72`), so trim behaves the same. The difference only appears for non-ASCII references.
  - Portal references are ASCII in practice. Leave it, or restrict the key to ASCII on the JS side as well.
- **SP6** N5: case-variant duplicates that are already stored would block resubmission of either claim once 0004 is applied. Nothing is deployed, so there is no data to clean up, but README's migration note could say so.
- **SP7** N1: Remittances refocuses only when the announcement changes. An identical repeat result does not move focus. This is acceptable.
- **SP8** N2: a very long design-system `description` in the dialog header sits outside `.desk-dialog__body`, so it does not scroll. No current dialog has one.

### Checked and fine

- **N1:**
  - `src/ui/focus.ts` `useFocusOnSettle` does not focus on first load.
  - Each target has `tabIndex=-1` and `settled-focus`.
  - `app.css:406-412` hides the ring for programmatic focus and shows `--border-focus` on `:focus-visible`.
  - The App.tsx search-change effect focuses main only when focus is on the body.
- **N2:** `src/dialog.tsx` wraps children in `.desk-dialog__body`. `app.css` sets max-height `100dvh` minus 2×`--space-4`, and the body scrolls. It works for every dialog and is tested in `BatchApprove.test.tsx`.
- **N4:** the `ClaimHistory` withdrawn wording is correct.
- **N5:**
  - 0004 is forward-only.
  - It recreates the trigger on `upper(trim(...))` and keeps the same-claim exemption, the payer scope and `portal_reference_taken`.
  - The remittance match is case-insensitive.
  - README documents the change.
- **N6:** `findingsInForce` (`src/domain/claims/state.ts:79`) is applied in both `toState` and the list. The overview, AI justification, exports and packets do not read the deadline finding.
- **N7:** rebuild passes the stored annotations (`server/services/rebuild.ts:118-119`). Blank references are trimmed and dropped (`cleanAnnotations`).
- **N8:** the close-short copy names the shortfall in plain words with no exclamation marks, which follows the decision in crew-log.
- **Settings note (follow-up 1):** the copy matches. It uses sentence case and the existing `settings__note` class.

## Security

No findings.

- **Identifiers:** no path to Anthropic changed, so no NRIC/FIN, name, phone number or address reaches the AI.
- **SQL:** stays parameterised. The new `json_each` and `upper(trim(?))` lookups bind their values.
- **Secrets and data:** no secrets or connection strings. Every new test record is synthetic and uses the reserved test prefix. Tests make no network calls.
- **Auth:** no route or role checks changed.
- **Blocked paths:** none touched.
