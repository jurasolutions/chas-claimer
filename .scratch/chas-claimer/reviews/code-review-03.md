# Code review 03: all three schemes, the payer waterfall and the finding catalogue

- **Branch:** `crew/chas-claimer-03-rules-and-waterfall` at f079e06
- **Compared against:** merge-base 01d0b7d (`git diff 01d0b7d...HEAD`, 20 files, +1610 / -154)
- **Reviewed:** 2026-11-14 by the reviewer persona. Every changed file was read.
- **Specs used:** `issues/03-rules-and-waterfall.md` (contract and conductor addendum), `decisions-g2.md` (wins on conflicts), `reviews/functional.md`, `docs/adr/0002`, `0003` and `0008`

## Verdict: changes-requested

One blocking finding: the completion date is ignored for every rule except frequency. It bills the wrong payer on a re-imported prep visit, and I reproduced it below. The verdict rests on that finding alone. Spec finding 2 (the insurance limit) needs a decision from Ting Yu, but it does not drive the verdict.

### Evidence I ran

| Command | Result |
|---|---|
| `npm install` | 0 vulnerabilities |
| `npm test` (run twice) | 47 files, 566 tests passed both times. Only act() warnings, in App.test.tsx stderr |
| `npm run typecheck` | clean |
| `npm run build` | built in 814ms; `git status` clean afterwards |
| `npx tsx held.ts` (reproduction script, scratchpad) | see Spec finding 1 |
| Scan of added lines for NRIC/FIN, names, phones and secrets | none found; synthetic NRICs stay in the reserved test block |

Blocked paths: none touched (`src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars`, `dist/`). The diff has no UI files, so no web-design review was run.

Scope: the work stays inside `src/domain/rules/**` and `src/domain/claims/**`. The changes to `server/repo/claims.ts`, `server/services/rebuild.ts` and `server/services/imports.ts` fall under the conductor addendum (the later-visit rebuild and Sec-3), so they are in scope.

---

## Spec

### Blocking

**1. The completion date is ignored for the window, card, rule set, MCAF, policy and deadline.** `src/domain/claims/build.ts:229, 372, 388, 419, 427`; `src/domain/claims/medisave.ts:15-21, 55, 101`; `src/domain/claims/insurance.ts:40, 44`.
- **What the specs say.**
  - decisions-g2 §3: the completed procedure is claimed "dated `completedOn`; window, card validity, tier and same-day rule use that date".
  - functional B1: "the re-import of the prep visit releases the held line onto a new claim dated `completed_on`".
  - functional S2: "no MCAF valid on the **claim date**".
- **What the code does.** Only frequency and the yearly caps use `claimDateOf`. Card validity (`pickCard`), the CHAS, TOSP and Flexi rule-set lookups, the 30-day deadline, the same-day check, PA, MCAF validity, `policyActive` and the insurer deadline all read `visit.date`.
- **How I reproduced it.** I took D04b (MG crown $1,200 + $108 GST) and moved it onto a prep visit dated 2026-09-20, updated to `complete` with `completedOn` 2026-11-10. The CHAS claim comes out at $0 with status `needs_attention` and finding `past_submission_window` (deadline 2026-10-20), although the claim date is 2026-11-10. MERIDIAN is billed $908.00 instead of $288.00, so the insurer is overbilled by $620.
  - The baseline D04b, a separate fit visit, gives CHAS $620.00 ready, Flexi $400.00, MERIDIAN $288.00, patient $0.
- **Missing test.** No test has a `completedOn` that differs from `visit.date`. AC-2.11 covers only the separate-fit-visit shape.
- **Fix.** Take one claim date per plan (`claimDateOf` over the plan's lines) and pass it to every date-keyed check. Add a builder test for the updated-prep-visit shape, across the window boundary and across a card expiry.

### Should fix

**2. The insurance annual limit caps the amount; decision #8 says to warn.** `src/domain/claims/insurance.ts:62`, `build.ts:279, 318-329`, asserted by `build.test.ts:111-126`.
- **What decision #8 says:** "what's left after the payers above, less a co-pay percentage … a warning (not a block) when this clinic's claims on the policy this year would exceed its annual limit." The ticket also says "policy limit **warning**".
- **What the code does:** it sets `capCents = max(0, limit − used)`, cuts the insurer's amount and moves the rest to the patient.
- **Why it matters:** ADR 0003 says a local count "may be wrong in both directions". Cutting the amount on that count can make the patient pay at the counter for something the insurer would have covered.
- **Question:** this is a product call (see Questions). Either bill the full remainder and keep the warning, or amend decision #8 to say the cap applies.

**3. The insurance limit is counted per payer, not per policy.** `src/domain/claims/insurance.ts:60`.
- The code filters on `c.payerId === payer.id`. Decision #8 says "claims on the policy". A patient with two policies at the same insurer shares one count.

**4. The later-visit rebuild misses visits when a visit's date moves later.** `server/services/rebuild.ts:214-229`, called from `server/services/imports.ts:184`.
- The rebuild starts from the new `clinical.date`. Suppose a re-import moves a visit from March to June. The visits between March and June were built while the March claim counted as earlier. They are never rebuilt, so they keep stale frequency warnings and stale yearly caps.
- The addendum requires: "when a visit's revision changes, also rebuild the patient's later unsubmitted claims within the counting period". Start from `min(old date, new date)`.

**5. Finding messages do not all name their rule set.** `src/domain/claims/build.ts:235`.
- The ticket requires: "Every finding message … names the rule set it came from".
- `ruleRef` is filled in only for claim findings on CHAS, TOSP and Flexi. Visit-level findings and notes carry no reference:
  - `unmapped_treatment`
  - `pa_patient_balance`
  - the Flexi notes
- No message text names the rule set either.
- Insurance has no rule set, so naming the payer's settings there is fine.

**6. A visit whose treatments are all unmapped gets no CHAS claim, so lower payers do not wait.** `src/domain/claims/build.ts:404`.
- `planChas` returns `null` when nothing is claimable. That leaves no upper claim to hold an insurance claim on `waiting_on_upper_payer`.
- functional.md:116 lists an unmapped code as **fixable**, and says the lower claims are built as waiting.
- AC-2.4 and D20 cover only the mixed case. This is from reading the code; I did not reproduce it.

**7. Flexi gives no note when it is skipped.** `src/domain/claims/medisave.ts` (`planFlexi`).
- A visit dated before the rule set's 2026-07-01 start returns `null` with no note.
- The D15 "not covered" note fires only when `visit.medisave` is present.
- Coverage depends on the CHAS code map, so a crown with no CHAS mapping never reaches Flexi.
- The officer cannot see why Flexi is absent.

### Nit

**8. Claims that can never be paid still count against frequency.** `src/domain/claims/plan.ts:42, 70`.
- `NOT_COUNTED` excludes only `withdrawn`, `written_off` and `rejected`. A CHAS claim that is past its window or has an expired card can never be paid, yet it still counts.
- Later visits therefore get a spurious `frequency_over_limit` warning until the officer withdraws that claim. It is a warning only, per ADR 0003.

**9. The Flexi limit warning shows on every Flexi claim.** `src/domain/claims/medisave.ts:135`.
- `flexi_yearly_amount_exceeded` is pushed unconditionally. AC-2.3 asks for this warning, so the behaviour matches the spec, but the code name says "exceeded" when nothing has been exceeded. Rename it, for example to `flexi_check_yearly_balance`.

**10. The MCAF type is ignored.** `src/domain/claims/medisave.ts:15-21`.
- A `single_visit` MCAF with `validTo: null` passes for every later visit (functional S2). Note that the account holder is modelled correctly: the MCAF sits under the visit's `medisave.accountHolder`. Only the type is ignored.

**11. A pre-auth's `approvedOn` is not checked against the claim date.** `src/domain/claims/insurance.ts:33`.

**12. `insurance_deadline_passed` blocks, but decision #5 does not say it should.** `src/domain/claims/insurance.ts:45`.
- Blocking is defensible: the deadline is a clinic setting and the date is certain. Record the choice in ADR 0003's list of certain blockers.

### Checked and fine

- Tier order: PA comes first, with a note when the patient has several tiers.
- The card is valid on its expiry date (D07b).
- The deadline warning starts at 5 days left.
- `billed_amount_differs` fires only when the source supplies a billed amount.
- Blocked and rejected upper payers: lower claims wait while the upper claim needs a fix, and get a warning when the payer has rejected it.
- MSP-ranked TOSP codes are never payable, consistent with ADR 0003.
- Benchmark overrides carry their source (`build.ts:477`).
- The property test checks that the split sums to the total, has no negatives and respects caps (`build.property.test.ts:58-84`).
- D07 and D08 assert their full split `{ CHAS: 0, patient: 5000 }`. These fixtures have no lower payer, and D06 covers the "lower payers go" case.
- Sec-3: history is keyed on the claim date, and `rebuild.test.ts` covers the year boundary in both directions, the later-visit rebuild, sent claims left fixed and limits out of reach.

---

## Standards

### Should fix

**S1. Fallback figures are hard-coded in the finding catalogue.** `src/domain/claims/findings.ts:76` (`?? 30`), `:139` (`3`), `:144` (`2`), `:154` (`?? 40000`), `:253` (`?? 60`, "under 60"), `:254` ("crowns and root canal treatment").
- These fallbacks are new in this branch. They break the numbers rule in CLAUDE.md ("Subsidy rates and caps in the scheme rules are configuration with a source and an 'as of' date, not hard-coded truth") and ADR 0002/0008.
- Every current call site passes the parameter, so the risk is latent. However, `deadlineView` at `build.ts:143-151` produces `{ code: "past_submission_window" }` with no params. Any path that turns that into a finding would show a hard-coded 30.
- Fix: make the params required in the finding's type, and drop the fallbacks.

**S2. The rule helpers are duplicated.** `src/domain/rules/medisave.ts` repeats `IsoDateString`, `CentsValue`, `SourceSchema`, `load()` and `covers()` from `src/domain/rules/chas.ts`. Move them into a shared module under `src/domain/rules/`.

**S3. The code-map lookup is written four times.**
- The four copies are at `build.ts:395`, `plan.ts:75` (`chasCodeOf`), `claims/medisave.ts:40` and `insurance.ts:30`.
- `chasCodeOf` already exists in `plan.ts`. Add a matching `benefitCodeOf(payerId)` there and use both everywhere.

**S4. The used-this-year sum is duplicated.** `claims/medisave.ts:130-133` and `insurance.ts:59-62`. Make it a single `usedThisYear(input, predicate, year)` in `plan.ts`.

### Nit

- `nameOf` is defined twice (`build.ts:259` and `:355`).
- The card-validity test `expiry >= visit.date` is written twice (`build.ts:229` and `:372`).
- `claims/medisave.ts:73` writes out a minimum by hand where `money.min` exists.
- `claims/medisave.ts:36-37` retypes `Treatment` where it could import it from `plan.ts`.
- `PlanLine.t` is a cryptic name; `treatment` would be clearer.
- `TospProcedure.table: string | null` takes any string; a union of the table codes would be safer.
- `build.ts:53` imports `CHAS_RULE_SETS` from `../rules/chas` directly, bypassing the `rules` index.
- `crossPayerChecks` (`build.ts:350`) mutates the claims passed in.
- The Flexi rule set ships `effectiveFrom: 2026-07-01` with the note "Start date unconfirmed". ADR 0008 prefers null for unconfirmed figures, but decisions-g2 §6 names this exact date, and decisions win. This is not a finding; it is noted so a later re-check of the date is not missed.

---

## Security

No findings.

- The SQL in the changed `server/repo/claims.ts` and `server/services/rebuild.ts` code is parameterised with `.bind`.
- The later-visit rebuild reads only by patient hash.
- Finding params and audit details carry payer names, dates and amounts. They carry no NRIC/FIN, name, phone or address.
- Error messages carry only `visitKey`.
- The diff adds no new network or Anthropic calls.
- No secrets and no `.env` or `.dev.vars` content.
- The test data is synthetic and uses the reserved NRIC test block.
- The rule-set JSON carries a source and an "as of" date (2026-11-13). I checked the TOSP table limits and the null and MSP codes against research §2.1, and they match.
- The `security-review` skill failed before it started (`fatal: ambiguous argument 'origin/HEAD...'`), so I ran this pass by hand over the same diff.

---

## Questions

1. **The insurance annual limit (Spec 2).** Should an insurer's claim be cut at the policy's remaining limit, or billed in full with a warning?
   - Recommended: bill in full with the warning, as decision #8 and ADR 0003 say. The local count cannot see other clinics' claims.
   - If Ting Yu wants the cap, amend decision #8 instead.
2. **The developer's question (a):** PARTLY-1 sits outside the CHAS window, so the seeded partly-used-limit case is untested.
   - Recommended: no seed change needed. The builder test at `build.test.ts:119-126` already covers it: an earlier same-payer, same-year claim reduces the remaining limit. If decision #8 changes the behaviour, update that test.
3. **The developer's question (b):** should the settings, code-map and deadline rebuilds process a patient's visits in order?
   - Recommended: yes, oldest first, by the same `orderKey(visitDate, startTime, visitKey)` that `earlierCounted` uses. Do not order by claim date alone, or the rebuild would disagree with the builder about what counts as earlier.
   - This belongs to ticket 06's loop. `recheckDeadlines` rebuilds one visit at a time, so it is unaffected.
