# Code review 08: remittance import and matching

- **Branch:** `crew/chas-claimer-08-remittances` at 7dab97d
- **Compared with:** merge-base 77a9109 on `crew/chas-claimer` (`git diff crew/chas-claimer...crew/chas-claimer-08-remittances`, 22 files, +2943 / -24)
- **Reviewer run:** 2026-11-14

## Verdict: changes-requested

One finding is blocking. A single statement line can record its payment twice, on two claims, through the hand-match path, and the import path has the same gap between two batches. I reproduced it against the branch. Everything else is *should fix* or *nit*.

The blocked paths are clean. `src/design-system/`, `dist/`, `.env`, `.dev.vars` and `jurasolutions/inputs/` are all untouched.

## Evidence (run by the reviewer in a detached worktree at 7dab97d)

- `npx vitest run --reporter=dot` passed: 76 files, 1009/1009 tests. The only stderr is the expected 500 log from the reveal test.
- `npx tsc --noEmit -p .` exited 0.
- `npm run build` built: JS 370.75 kB, CSS 27.08 kB.
- I wrote a throwaway reproduction test, `server/services/review-race.test.ts`, which is not on the branch and was deleted with the worktree. It produced these results:
  - **Race A:** two concurrent `matchByHand` calls for R1 line 4 ($99.99), one to D05 and one to another submitted CHAS claim. Both returned `ok`, and both claims show `paidCents 9999`, so the total recorded is $199.98 for a $99.99 line. The line points at only one of the two claims, and the audit says "remittance_line_matched" for both.
  - **Race B:** request A's payment on D05 lands, then request B hand-matches line 5 to D05 at the new version, then A marks line 4. A's line update throws `UNIQUE constraint failed: remittance_lines.remittance_id, remittance_lines.claim_id`, which reaches the user as a 500. By then D05 has recorded both payments (paidCents 15049), and line 4 still waits for a person as `no_claim`, so it can be paid a third time.
  - **Query count:** importing R1 (5 lines, 3 matched) prepared 57 D1 statements.

## Standards

### Blocking

None on this axis. The money race is filed under Security, where it bites hardest.

### Should fix

1. **The import's statement count breaks the per-invocation budget.** `src/api/remittances.ts:16` (`MAX_REMITTANCE_LINES = 500`) and `server/services/remittances.ts:114-120`.
   - Rule: `technical.md:139-140` says imports must stay "well under D1's per-invocation query limit and the Workers CPU limit", and the risk register at `technical.md:688` says the same for large imports.
   - Measured: R1 prepares 57 statements for 3 matched lines, about 15 per matched line (`claims.detail`, then `act` with its detail, deadline, importer, settings and batch, then the match batch).
   - At that rate a clinic statement with about 65 matching lines reaches 1,000 statements, against a cap of 500 lines.
   - Caveat: I counted prepared statements and could not measure D1's own query count locally. The order of magnitude still holds.
   - Fix: lower `MAX_REMITTANCE_LINES` to a size that fits, or record payments in pages across invocations. Either way, add a test that pins the statement count per matched line.
2. **The match counter relies on `changes()` across a batch.** `server/repo/remittances.ts:217` runs `UPDATE remittances SET matched = matched + 1 WHERE id = ? AND changes() = 1`.
   - Rule: technical.md F7 (`technical.md:135-136`) says "The nonce avoids relying on `changes()` across batch statements."
   - Fix: count the matched lines instead, with `matched = (SELECT count(*) FROM remittance_lines WHERE remittance_id = ? AND claim_id IS NOT NULL)`.
3. **Reuse: the real-NRIC refusal is duplicated.** `server/services/remittances.ts:74-85` copies the guard in `server/services/imports.ts:54, 93-105`. The two even refuse differently: one throws `RealIdentifierRefusedError`, the other returns an err Result. Extract one helper for both paths.
4. **Reuse: the payment step is duplicated.**
   - `matchByHand` (`server/services/remittances.ts:194-217`) and `recordPayment` (`:261-293`) each build the same `record_payment` action (`${remittanceId}:${lineNo}`, `paidOn ?? sgtDay(now)`) and then run `matchStatements`.
   - The fix for the blocking finding has to change both places in the same way, so make it one function first.
   - The `kind: "manual"` variant of `Paying` (`:255`) is never passed to `recordPayment` (Speculative Generality). It becomes live once the two paths share one function.

### Nit

5. Synthetic NRICs with wrong check letters. `src/ui/pages/Remittances.test.tsx:40, :139` use `T9000001A`, and `src/domain/statement.test.ts:55, :69` use `T9000001Z`. Both are in the reserved T9 block, so there is no real-data risk, but the valid form is `T9000001I` (GLOSSARY.md, synthetic identifiers).
6. Terminology. The code says "remittance" (GLOSSARY.md:189), while the page says "Payment statement" (`src/ui/pages/Remittances.tsx:151, :389`). Add the UI wording to the glossary as an alias, or align the two.
7. `server/repo/remittances.ts:164-210` (`FACTS`, `claimFacts`, `openClaims`, `claimPayer`) queries the `claims` table, and `payer_id?` at `:190` is never selected. This is possible Feature Envy, and the queries belong in `server/repo/claims.ts`. The ticket contract does not forbid that file.
8. `server/services/remittances.ts:118` does `lines.find(...)!` inside the match loop, which is O(n²) and asserts non-null. `:279` casts `paidOn` with `as ReturnType<typeof sgtDay>`, when the line type could carry `IsoDate`.
9. `server/services/remittances.ts:34` imports `Deps` from the imports service. Use a shared deps type.

## Spec

### Blocking

None on this axis alone. The ticket property "a line never matches two claims" is broken by Security B1.

### Should fix

1. **The hand-match undo was not built.**
   - `uat-script.md` §7, step 7.4 reads: "Match R1 line 4 by hand to any submitted claim, then undo | Both actions in the trail".
   - There is no undo route, service or UI. Only `functions/api/remittances/[id]/lines/[n]/match.ts` exists. AC-5.5 asks only that "A person can match it to a claim, audited", so the ACs are met and the UAT step will fail.
   - This needs a decision (see Questions).
   - It also bears on the UI: a hand match records money with one click, with no confirmation and no undo (UI 1).
2. **test-strategy contradicts the spec.** test-strategy SC5.3 says partial payments "stay unmatched", while AC-5.3 (functional.md) and decisions-g2 §2 match a partial payment by reference. The code follows AC-5.3 and decisions-g2, which is correct. test-strategy needs a one-line fix by its owner, not a code change.

### Nit

3. **A reference line never falls back to patient, date and amount** (`src/domain/matcher.ts:71`).
   - The ticket says "by portal reference, then by patient, date and amount" (`issues/08-remittances.md:3`), which can be read either way. S12's "nothing is guessed" supports the code.
   - I recommend keeping it, and recording the rule in the ticket or GLOSSARY.
4. **The service returns a Result where `technical.md:454` shows a bare `Promise<RemittanceSummary>`.** Returning a Result matches the repo's pattern (`act` and settings). Amend technical.md.
5. **Unrequested but sound additions:** the real-NRIC refusal on remittance imports, the advisory "fits" note on waiting lines, the new parser `src/domain/statement.ts`, and the `RemittanceColumnsSchema` export. None is harmful.

### Confirmed

- **AC-5.1 to AC-5.7:** each has a service-level test (`server/services/remittances.test.ts`). AC-5.5, 5.6 and 5.7 also have function-level tests (`match.test.ts`, `index.test.ts`).
- **S12:** covered in `src/domain/matcher.test.ts` (closed, negative, taken, ambiguous), plus a test for a duplicate file sent concurrently. The one-line-one-claim properties are tested at `matcher.test.ts:103, :118`.
- **Contract:**
  - `server/services/claims.ts` and `ClaimDetail.tsx` are untouched.
  - The mapping is saved through the settings service, so it is versioned and audited.
  - Payments go only through `act(record_payment)` with the system actor `remittance`.
- **Who maps columns.** Reviewers, not officers, edit the mapping. That follows AC-8.4 ("default: reviewers edit settings"), and decisions-g2 accepted functional.md, so this is the right reading.
- **Negative and zero lines are refused by hand match** (`server/services/remittances.ts:188`). That is consistent with decisions-g2 §14, which puts clawbacks and recoveries out of scope and leaves them to a person, and with functional.md:236. It is not a finding.
- **Coverage gaps (should fix, small):**
  - No integration test for AC-5.2 (patient, date and amount through HTTP), or for S12's withdrawn claim and ambiguous match.
  - No test for concurrent hand matches. Add one with the B1 fix.

## Security

### Blocking

**B1. One statement line can pay twice (money, and data integrity).**

- **Where:**
  - `server/services/remittances.ts:194-217` (`matchByHand`: `act` at 194-205, then a separate `db.batch` at 207-217)
  - `server/services/remittances.ts:261-293` (`recordPayment`: `act` at 273-284, then `db.batch(matchStatements)` at 291)
  - `server/repo/remittances.ts:213-218` (the conditional line UPDATE, whose zero-row result is never checked)
- **Rules broken:**
  - technical.md F7: "services compose one `db.batch()` per command, which D1 runs atomically".
  - The ticket's property: "a line never matches two claims and a claim is never matched by two lines of one file".
- **What happens:**
  - The checks at `:187` (line still unmatched) and `:192` (claim not already paid by this file) are reads taken before the write.
  - The payment is committed by `act` in one batch, and the line is claimed in a second batch afterwards.
  - **Race A (two people, one line, two claims):** both payments commit, the second line UPDATE silently changes 0 rows, and both requests audit a match. Reproduced: $199.98 recorded for a $99.99 line.
  - **Race B (two lines, one claim):** the second line UPDATE hits the `remittance_lines_claim_once` index and throws a 500 after the payment has committed. The line stays waiting with the money already on the claim. Reproduced.
  - **Crash:** a Worker that dies between the two batches leaves the same state. A re-import adds nothing (`:87-89`), so the line never recovers by itself.
  - The import path (`recordPayment`) has the same gap. A person can hand-match a line from the statement page while the import that wrote it is still recording payments.
- **Fix, two options:**
  - **Fully atomic.** Let `act` take extra statements that run in its batch, guarded by its nonce. Then the line UPDATE and its audit commit with the payment or not at all. This touches `server/services/claims.ts`, which the ticket contract forbids, so the conductor has to decide (see Questions).
  - **Within the ticket's files.** Reserve the line first:
    1. Run the conditional `UPDATE remittance_lines SET claim_id = ?, match_kind = ? ... WHERE claim_id IS NULL` on its own. Require `meta.changes === 1`, and map the UNIQUE violation to `not_allowed` "another line of this file already paid the claim".
    2. Only then call `act`.
    3. On any refusal from `act`, release the reservation with a conditional UPDATE back to NULL.
  - With the fallback, a crash leaves a reserved line with no payment instead of a double payment. That is the safer failure, and `remittanceDetail` can flag it, because the claim's trail has no payment carrying that `remittanceLineId`.
  - Whichever option is chosen, apply it to both paths and add the concurrent tests from the evidence above.

### Checked, no finding

- **Auth and roles.** All four routes use `route({ auth: "access", roles: ["officer", "reviewer"] })`. Only a reviewer can save a column mapping (`server/services/remittances.ts:60`); an officer gets 403.
- **Origin.** The Origin check comes from the spine (`server/http.ts:88`).
- **Body caps.** Bodies are capped (512 KB upload, 1 KB match), and the line number is validated as `/^[1-9]\d{0,5}$/` before use.
- **Identifiers.**
  - NRICs are parsed and checked, then replaced by `patientHash` before any write (`server/services/remittances.ts:91-93`).
  - A real NRIC is refused unless `ALLOW_REAL_IDENTIFIERS` is set.
  - Problems name headers and line numbers, never cell values (`src/domain/statement.ts:27-30`).
  - Responses carry `patientMask` only.
- **No AI call** is anywhere on the path.
- **SQL.** Every query is parametrised. Lists go through `json_each(?)`.
- **Money.** Amounts are integer cents. The lifecycle handles partial, short and over payments as decisions-g2 §2 says.

### Nit

- `fileName` is stored and shown as given (`server/repo/remittances.ts:117`). A payer's file named after a patient would keep that name. Consider showing the payer and the date instead, or dropping the name once the file hash is stored.

## UI (crew:web-design-review on `src/ui/pages/Remittances.tsx` and the changed lines of `src/ui/app.css`)

The page is built from the design-system components via `src/ds.ts` and uses tokens throughout. The only raw value is a 480px breakpoint. Labels, `role="alert"` and `role="status"`, `<time dateTime>`, `scope="col"`, `tabular-nums`, `translate="no"` on references and the "…" loading copy are all in place. The copy is sentence case, with no exclamation marks and no buzzwords.

1. **Should fix.** `src/ui/pages/Remittances.tsx:282-294`. A hand match records a payment with one click, with no confirmation and no undo. Guideline: "Destructive actions need confirmation modal or undo window". This ties to Spec 1.
2. **Nit.** `src/ui/pages/Remittances.tsx:291`. The match button is only disabled while busy. Guideline: show progress during the request (for example "Matching…").
3. **Nit.** `src/ui/pages/Remittances.tsx:569`. The file picker is a raw `<input type="file">`. That is acceptable if the design system has no file control; note it if it does.

## Questions for the conductor

1. **How to make B1 atomic.** Allow a small change to `act` (an extra-statements option guarded by its nonce), or keep `claims.ts` frozen and use reserve-then-pay? *Recommended: reserve-then-pay now, inside the ticket's files. Open a follow-up for the `act` option if a second caller needs it.*
2. **UAT 7.4 undo.** Build the undo, or defer it? *Recommended: defer to a follow-up ticket (an undo that reverses the payment through a lifecycle action and releases the line), and amend UAT 7.4 for this release.*
