# Quality gate: chas-claimer 0.1.0

*QA lead, 2026-11-14 (SGT). Exit criteria: `reviews/test-strategy.md` §8, criteria 1 to 11.*

```
Decision: GO with waivers
Branch:   crew/chas-claimer @ 392f46f (Node 20.20.2)
```

Six criteria are met outright: 2, 3, 4, 5, 6, 7 and 11. Criterion 9 is met through the waiver it
allows. Criteria 1, 8 and 10 are met in substance but not to the letter: one part of SC7.2 was cut
from scope, defects were filed in the QA reports instead of `issues/`, and the review and security
rules were not run the way criterion 10 says. The five waivers in section 4 cover those gaps.

**The GO holds only while every waiver in section 4 stands.** If the G4 holder declines any one of
them, the decision becomes NO-GO, and section 6 says what turns it back. The G4 holder is the
conductor, under Ting Yu's G0 to G4 delegation of 2026-11-13 (operating card, "Branches"). Every
waiver also goes on Ting Yu's follow-up list.

The tree is clean apart from the uncommitted release files: `CHANGELOG.md`,
`reviews/release.md`, `reviews/qa-04.md`, this file, and edits to `follow-ups.md` and
`crew-log.md`. None of them touches code, so the code at 392f46f is the code this gate checked.

---

## 1. Fresh run (QA lead, at 392f46f)

| Command | Result |
|---|---|
| `npm test -- --reporter=dot` | 102 files, 1492 tests passed, 0 failed, exit 0 (21.55 s) |
| `npx vitest run --reporter=json` (second full run, for the trace) | 1492 total, 1492 passed, 0 failed, 0 pending, 0 todo |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0. 1723 modules, JS 421.48 kB, CSS 32.33 kB |
| `npx vitest run tests/synthetic-data.test.ts`, tracked files as committed | 8 passed |
| The same guard with `GIT_INDEX_FILE` set to a scratch copy of the index, with `CHANGELOG.md`, `reviews/release.md` and `reviews/qa-04.md` added and the edited `follow-ups.md` and `crew-log.md` staged | 8 passed. The real index's checksum was the same before and after, and `git status` was unchanged |
| The same scratch-index guard, with this file added | 8 passed (run after this file was written) |
| The criterion 3 grep, exactly as written in §8 | no output, exit 1 |
| `grep -rnE "\.fails\("` over the same folders, plus `mock/` | no output, exit 1 |
| `npx vitest run tests/e2e` | 7 passed, including the whole flow with no Anthropic key |
| Probe outside the repo: SC-D18 through `buildVisitClaims` at a branch with no GST, fees $31.00 and $31.01, claim dates 31 Aug 2026 and 10 Nov 2026 | $31.00 on either date: ready, no findings. $31.01 on 31 Aug: ready. $31.01 on 10 Nov: needs attention, `benchmark_exceeded` |

The guard skips only `src/design-system/` and `package-lock.json`. It does read `.scratch/` and
`CHANGELOG.md`, so the scratch-index runs did scan the release files.

---

## 2. Exit criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Every case from SC1.1 to SC8.4 traces to a passing test or a QA PASS line; only SC3.7 may be waived | **met with waiver W4** (and W1 for SC3.7) | Section 3 traces every case. SC3.7 is waived (W1). SC7.2 passes for everything except the $830 ward limit, which the conductor ruled out of scope (W4) |
| 2 | Fresh `npm test`, typecheck and build exit 0 on the gated commit | **met** | Section 1: 1492 of 1492 passed, typecheck exit 0, build exit 0 |
| 3 | No skipped or focused tests | **met** | The §8 grep printed nothing and exited 1. No `.fails(` either. The JSON run shows 0 pending and 0 todo |
| 4 | A real fast-check property for each named area, no `numRuns` below 100, a fixed seed | **met** | Money: `money.test.ts` (3 properties). Waterfall: `build.property.test.ts` (2, 300 runs each). Rules: `findings.property.test.ts`, SC2.12 at 300 runs and SC2.13 at 200. NRIC: `nric.test.ts` (5). Lifecycle: `lifecycle.test.ts`, SC4.2. Matching: `matcher.test.ts` (2), SC5.4. AI de-identification: `server/ai/deidentify.test.ts` and the SC6.2 property in `functions/api/ai/justification.test.ts`. CSV round trip: `csv.test.ts` (2). `tests/setup.ts` sets `fc.configureGlobal({ seed: 20_261_113, numRuns: 100 })`. The only `numRuns` under 100 is `numRuns: 1` in four `fc.sample` calls in `server/crypto.test.ts`. Those draw a single fixture value; they aren't properties |
| 5 | `tests/setup.ts` fails any unstubbed `fetch`, and the run passes with it | **met** | `beforeEach` stubs `fetch` to throw "Unexpected network request in a test". The fresh run passed with it in place |
| 6 | The SC7.6 guard is present and passes | **met** | `tests/synthetic-data.test.ts`, "finds no real-looking identifier, phone number, home path or LAN address in any tracked file", passes on 392f46f and with every release file in a scratch index |
| 7 | The whole-flow test (SC8.3) passes with `ANTHROPIC_API_KEY` unset | **met** | `tests/e2e/whole-flow.test.ts`, "the whole flow with no Anthropic key (SC8.3)": both cases pass. `configuredDesk` sets the key only when asked to, and neither helper in `tests/helpers/` sets it |
| 8 | No open critical or major defects; each open minor listed with an owner; defects filed as `issues/NN-defect-<slug>.md` | **met with waiver W5** | 0 critical, 0 major and 5 minor are open (section 5). QA 03 D01, the last critical, is fixed and was re-verified in QA 04, on both legs. QA 02 N2, the last major, was re-verified in QA 03. The filing rule wasn't followed (W5) |
| 9 | SC3.7 run by a person, or waived at G4 and recorded here | **met by waiver W1** | Conductor, crew-log "final review decisions", Q3. Recorded in follow-up 21 and in section 4 |
| 10 | Every code review ends in approve, or approve with only minor findings; a `crew:security-review` pass has no unresolved high finding | **met with waivers W2 and W3** | Ten review files end in changes-requested without a later reviewer approval (W2). The security-review skill never ran (W3). No review records an unresolved high-severity security finding |
| 11 | B1 to B10 each PASS in a QA report dated on or after the last change to `src/` or `functions/` | **met** | `qa-04.md` §4: B1 to B10 pass 10 of 10, run 2026-11-14 at 392f46f. The last change to `src/`, `functions/` or `server/` is 3bf2f4e (2026-11-14 14:42 SGT), which 392f46f contains |

---

## 3. Traceability (criterion 1)

Test names are quoted from the fresh JSON run, where every test passed. "QA 04 Bn" means a PASS
line in `reviews/qa-04.md` §4. "D-cases" means `src/domain/claims/build-cases.test.ts`, the UAT
case table run through the builder.

### SC1, claims built and split

| Case | Evidence |
|---|---|
| SC1.1 | `rules/index.test.ts`, "matches the published *procedure* caps for every tier", once for each of the 18 procedures. D-cases SC-D02-P02 to P07 give one consultation per tier |
| SC1.2 | `rules/index.test.ts`, "gives Green no dental subsidy and Public Assistance the full fee". D-cases, "D24: Public Assistance leaves a balance the patient pays" (the uncovered line) |
| SC1.3 | D-cases, "SC-D01 splits the bill" (with GST) against SC-D02 (no GST), and "SC-D22: gst_not_registered". D-cases, "every split sums to the fee including GST" |
| SC1.4 | `build.property.test.ts`, "the payer waterfall, for any fees, limits and history splits the whole fee…" |
| SC1.5 | The same property: "never below zero, never paying a line twice, never past a cap". Also "claims already sent, after the waterfall is reordered… never claims past the fee" |
| SC1.6 | D-cases, "SC-D04b splits the bill" (CHAS 62000, Flexi 40000, Meridian 28800, patient 0). The fixture follows functional N2: an MG patient aged 62 can't exist, so D04 uses a 70-year-old |
| SC1.7 | D-cases, "D04b with insurance above MediSave: Meridian takes the rest and no MediSave claim is built" |
| SC1.8 | D-cases, "MULTITOSP with three surgical codes is within MediSave's cap; a fourth holds the claim (SC1.8)". The per-system cap is `tosp_too_many_in_system` (afe43d3). "ships exactly the 21 tables 1A to 7C" |
| SC1.9 | `build.test.ts`, "decisions-g2 #8: a claim past the policy's yearly limit is billed in full and warns, not cut". D-cases PARTLY-1 and PARTLY-2. G2 decision #8 changed the cap into a warning. QA 04 B6 shows the benefit code H-CRN in the file export |
| SC1.10 | D-cases, "SC-D20: … needs_attention, [unmapped_treatment]" and "D20 reports the unmapped code on the visit too" |
| SC1.11 | `server/services/imports.test.ts`, "gives every synthetic visit one revision and counts that add up (AC-1.4, SC1.11)" |
| SC1.12 | `imports.test.ts`, "writes nothing when the same content arrives again (AC-1.3, SC1.12)", plus a second SC1.12 case. QA 04, D01 second leg: a re-import flags sent claims as changed |
| SC1.13 | `imports.test.ts`, "leaves every table identical when the same batch is imported twice (SC1.13)" (property, seed 20261113, 100 runs) |
| SC1.14 | `tests/e2e/whole-flow.test.ts`, "imports the synthetic clinic through the connector, with claims for every scheme (SC1.14)", with a key and without |
| SC1.15 | QA 04 B1 (200 visits imported, all new) and B2 |

### SC2, block or warn

| Case | Evidence |
|---|---|
| SC2.1 | D-cases SC-D07 (`card_expired`) and twin SC-D07b (expires on the visit date, ready). `cases.test.ts`, "D07 … D07b's expires on the visit date" |
| SC2.2 | D-cases SC-D02-P07 and SC-D06 (`chas_green_no_dental`), against the other tiers in SC-D02 |
| SC2.3 | D-cases SC-D08 (`past_submission_window`) and twin SC-D08b ("D08b is due today: zero days left"). `claims.test.ts`, "deadlines on approval and submission (AC-3.5)". `deadlines.test.ts`, "in time at 23:59 SGT, past at 00:00 SGT the next day" |
| SC2.4 | D-cases SC-D09b (`same_day_duplicate`) against SC-D09a. `cases.test.ts`, "D09a and D09b: one patient at both branches on the same day". `dates.test.ts` covers the 00:30 SGT day boundary |
| SC2.5 | D-cases, "D04a and D05 hold the started crown; D04b claims it on its own date (AC-2.11)" |
| SC2.6 | D-cases, "SC-D12: MEDISAVE_TOSP is needs_attention with [medisave_no_mcaf]", against SC-D10 (MCAF on file, ready) |
| SC2.7 | D-cases, "SC-D11: … [tosp_msp_ranked]". `rules/index.test.ts`, "ranks SF811T as the research note does" and "ranks SF812T…" |
| SC2.8 | D-cases, "SC-D23: CHAS 0, needs_attention, [no_rule_set]". `rules/index.test.ts`, "has no rule set before 1 Oct 2025" and "covers 1 Oct 2025 onwards" |
| SC2.9 | D-cases, "D19: only the third scaling of the year warns" (SC-D19-3 is ready with the warning, SC-D19-2 has none) |
| SC2.10 | `rules/index.test.ts`, "applies MOH benchmarks only to visits from 1 Sep 2026". D-cases SC-D18 and SC-D18b (`benchmark_exceeded`) and SC-D20 (`benchmark_not_set`, a warning). The suite has no $31.00 against $31.01 twin; the QA lead's probe proved that edge (section 1) |
| SC2.11 | D-cases, "D14 is under 60 for Flexi-MediSave", against SC-D14b (60th birthday, Flexi claimed). "SC-D13: … [dentist_not_medisave_accredited]" |
| SC2.12 | `findings.property.test.ts`, "never add or remove a blocking finding because of this clinic's earlier claims" (300 runs) |
| SC2.13 | `findings.property.test.ts`, "give the same findings in the same order for the same visit, rule set and clock" (200 runs) |
| SC2.14 | D-cases: blocking findings give needs_attention (SC-D07, D20, D23); warnings alone give ready (SC-D08b, SC-D19-3) |
| SC2.15 | `lifecycle.test.ts`, "approve refuses a claim with a blocking finding even if its status still says ready". QA 04, D01 second leg: approve, batch approve, submit and `/api/submissions` each return 409 `not_allowed` |
| SC2.16 | `FindingList.test.tsx`, "lists what blocks the claim before what only needs a look, each in words with its source". The `findings.test.ts` catalogue. QA 04 B2 and B3 |

### SC3, assisted submission

| Case | Evidence |
|---|---|
| SC3.1 | `AssistedSubmit.test.tsx`, "lists the payer's fields in portal order with a copy button each and the identifier masked (AC-4.2)". `functions/api/claims/[id]/packet.test.ts` |
| SC3.2 | `AssistedSubmit.test.tsx`, "copies a field's text and says so", plus the AC-4.2 case |
| SC3.3 | `claims.test.ts`, "reveal (S11, AC-3.6) answers one identity field to an officer, and records which field was revealed but not its value". `MaskedIdentifier.test.tsx`. QA 04 B5 ("Show NRIC (audited)") |
| SC3.4 | `claims.test.ts`, "act: submit … records the portal reference" and "refuses an empty portal reference and records no attempt". `AssistedSubmit.test.tsx`, "says a reference already on another claim to this payer is taken (AC-4.3)" |
| SC3.5 | `AssistedSubmit.test.tsx`, the AC-4.2 and AC-4.3 cases: copy buttons for every field, and only the reference typed. QA 04 B5 |
| SC3.6 | QA 04 B5 (desktop), and B10 (360 px on every route, keyboard over B2 to B5) |
| SC3.7 | **Waived, W1** |

### SC4, approval and audit

| Case | Evidence |
|---|---|
| SC4.1 | `lifecycle.test.ts`, "the transition table (AC-3.1) from *status* reaches exactly the allowed statuses", once for each of the 9 statuses |
| SC4.2 | `lifecycle.test.ts`, "any run of actions (SC4.2) only moves a claim along the table, and never changes its amounts once it has been sent" |
| SC4.3 | `functions/api/claims/[id]/actions.test.ts`, "refuses approval from an officer with 403 forbidden (SC4.3)". `claims.test.ts`, "actMany: batch approval". QA 04 B4 |
| SC4.4 | `claims.test.ts`, "records a reviewer approving their own import as a self-approval". `lifecycle.test.ts`, "labels an approval of your own import as self-approval" |
| SC4.5 | `server/http.test.ts`, "answers a GET without an assertion with 401". `me.test.ts`, "refuses a signed-in email on neither role list", "never trusts the plain email header Access also sends" and "ignores DEV_USER on a deployed hostname". This is stronger than the strategy's header rule: the desk verifies the Access JWT |
| SC4.6 | `whole-flow.test.ts`, "keeping one audit event per thing that happened (SC4.6, SC4.7, SC6.5)". `claims.test.ts`, "the audit trail end to end (AC-3.6)" |
| SC4.7 | The same whole-flow case. `server/repo/audit.test.ts` |
| SC4.8 | `lifecycle.test.ts`, "withdraw needs a reason and clears who approved it" and "reopen sends a rejected claim back to the desk". `claims.test.ts`, "act: reopen rebuilds the visit". The write-off is "accept short payment closes a part-paid claim as paid and records what is written off" |
| SC4.9 | `ClaimHistory.test.ts`, "who did it, in a claim's history". The AC-3.6 trail case. QA 04 B3 and B9 (audit rows) |

### SC5, remittance matching

| Case | Evidence |
|---|---|
| SC5.1 | `matcher.test.ts`, "SC5.1: matches a line to the claim with its portal reference" |
| SC5.2 | `matcher.test.ts`, "SC5.2: with no reference, matches the one claim with the same patient, visit date and amount owed" |
| SC5.3 | `matcher.test.ts`, "SC5.3: guesses nothing for an unknown reference, a different amount or a part payment without a reference" |
| SC5.4 | `matcher.test.ts`, "SC5.4: a line never pays two claims, a claim never takes two lines…" (property) |
| SC5.5 | `statement.test.ts`, "SC5.5: reads each line through the payer's columns, amounts in cents", and two more SC5.5 cases |
| SC5.6 | `functions/api/remittances/index.test.ts`, "imports R1 for an officer, pays what it matches". `…/lines/[n]/match.test.ts`, "AC-5.5: matches line 4 to D05 for an officer, pays D05 and audits the match" |
| SC5.7 | QA 04 B8 (import, the automatic match, a hand match with confirmation, a re-upload refused) |

### SC6, AI

| Case | Evidence |
|---|---|
| SC6.1 | One test file per feature, all passing: `functions/api/ai/code-suggestion.test.ts`, `rejection-explainer.test.ts`, `justification.test.ts`, `source-mapping.test.ts` |
| SC6.2 | `justification.test.ts`, "sends none of the patient's identifiers however the note spells them (SC6.2)" (property). `server/ai/deidentify.test.ts` |
| SC6.3 | `source-mapping.test.ts`, "sends the table and column names and not one row value (SC6.3)" |
| SC6.4 | `ui/ai/index.test.tsx`, "JustificationDraft (SC6.4) hands the draft over only when the person uses it". `code-suggestion.test.ts`, "… and saves nothing" |
| SC6.5 | `whole-flow.test.ts`, "the whole flow with no Anthropic key (SC8.3)" |
| SC6.6 | `ui/ai/index.test.tsx`, "hostile model output (SC6.6) shows markup in the answer as text, never as elements" |
| SC6.7 | `justification.test.ts`, "answers ai_unavailable when the service fails, with the claim unchanged (SC6.7)", and 11 more SC6.7 cases |
| SC6.8 | QA 04 B7: with AI off, Explain shows "AI isn't set up…". The strategy accepts the AI-off path |

### SC7, rule sets and data

| Case | Evidence |
|---|---|
| SC7.1 | `rules/index.test.ts`, "covers 1 Oct 2025 onwards with a 30-day window and dated sources" and "lists each rule set with its scheme, dates and sources". `settings.test.ts`, "refuses a benchmark without an https source" |
| SC7.2 | `rules/index.test.ts`: the 18 × 4 CHAS caps, "ships exactly the 21 tables 1A to 7C", the MSP rankings (SC7.2), and the Flexi rule set. **The $830 ward limit is not shipped (W4)** |
| SC7.3 | `rules/index.test.ts`, "applies MOH benchmarks only to visits from 1 Sep 2026, and only the two it publishes". The `benchmark_not_set` warning on SC-D20 |
| SC7.4 | `rules/index.test.ts`, "has no rule set before 1 Oct 2025" and "covers 1 Oct 2025 onwards". `claim-date.test.ts`, "the CHAS rule set is the one in force on the completion date", plus the property "building it on its own date is the same as building it as a prep visit completed on that date". These are examples, not the planned property; criterion 4 doesn't require one here |
| SC7.5 | `claims.test.ts`, "claimDetail (AC-3.7) shows … the rule set, the waterfall and the source revision". `whole-flow.test.ts`, the AC-3.7 case. QA 04 B9 ("as of 13 Nov 2026") |
| SC7.6 | `tests/synthetic-data.test.ts` (section 1) |
| SC7.7 | `mock/synthetic-clinic/clinic.test.ts`, "only ever emits T9-block identifiers with a valid check letter, whatever the seed (SC7.7)". `nric.test.ts`, "generates synthetic numbers that the validator accepts" |
| SC7.8 | `nric.test.ts`, "rejects every single-character change of a valid number", "normalising twice equals normalising once" and "masks all but the last three digits and the check letter" |
| SC7.9 | `mock/synthetic-clinic/cases.test.ts`, "generateClinic: the cases map (SC7.9)" (28 cases) |
| SC7.10 | `clinic.test.ts`, "gives byte-identical output for the same seed and as-of date (SC7.10)" |

### SC8, build health and the whole flow

| Case | Evidence |
|---|---|
| SC8.1 | Section 1 |
| SC8.2 | `tests/schema.test.ts`, "the D1 schema applies to an empty database and holds every table the desk uses". QA 04 §2 drove the desk on local D1 with the migrations applied |
| SC8.3 | `whole-flow.test.ts`, "the whole flow with an Anthropic key (SC8.3)" and "… with no Anthropic key (SC8.3)": 4 cases pass |
| SC8.4 | QA 04 B1 to B9, all pass |

---

## 4. Waivers, as criterion 9 requires

Each waiver is granted at G4 by the conductor, under Ting Yu's delegation, and each stays on Ting
Yu's follow-up list.

| ID | Criterion | What is waived | Why it is acceptable for v1 | Granted | Follow-up |
|---|---|---|---|---|---|
| W1 | 9, and 1 for SC3.7 | UAT 5.8 / SC3.7: a person, timed, copying a CHAS claim into a stand-in form in under 60 seconds | Only a person can run it. The checklist's mechanics pass in the suite (SC3.1 to SC3.5) and in the browser (QA 04 B5) | Conductor, crew-log "final review decisions", Q3 | 21: run it before the desk replaces the current way of claiming |
| W2 | 10, reviews | These files end in changes-requested with no later reviewer approval: `code-review-02`, `-03`, `-04`, `-05`, `-06`, `-07`, `-08`, `-11`, `-qa02` and `-qa03`. A conductor re-review closed each one. The ticket reviews are also covered by the whole-branch final review, which approved in `code-review-final-fix.md`. No second reviewer read three later rounds: final-fix round 2 (afe43d3 to 8178afd), the QA 02 review fixes (6acb036 to 0c3a3e6) and the QA 03 review fix (030f74c to 3bf2f4e) | Each late round applied the reviewer's own finding and added tests that failed before the fix (crew-log, "QA 02 merge" and "QA 03 merge"). QA 04 re-checked the result independently in the browser and passed. The QA lead read the production diffs of the last two rounds: they change waterfall and display logic, and one type moves file. They don't touch auth, identifiers, AI requests or SQL. In round 2, `server/crypto.ts` and `server/env.ts` change comment text only | Conductor, crew-log "final fix merge", "QA 02 merge", "QA 03 merge"; release-manager entry | New: run one reviewer pass over `0c3a3e6..3bf2f4e` before the next release |
| W3 | 10, security | `crew:security-review` never ran: the repo has no `origin/HEAD` (crew-log, reviewer, ticket 11) | Reviewers did manual security passes. Every per-ticket review, `code-review-final.md`, `code-review-final-fix.md`, `code-review-qa02` and `code-review-qa03` has a Security section. `infra.md` covers auth, Access and secrets. No review records an unresolved high finding. The one blocking security finding (S-B1, a reported NRIC-shaped string in the log) was redacted, and the history plan in `release.md` §5 rebuilds `main`, so the old commits are never pushed | Recorded here for the conductor at G4 | New: run `crew:security-review` once `origin/HEAD` exists after the first push |
| W4 | 1, SC7.2 | The $830 ward limit (research §2.1) isn't in the shipped TOSP configuration | The desk builds dental day-surgery claims and has no ward charges. The rest of SC7.2 passes | Conductor, crew-log "final review fix round" | New: add it if the desk ever claims an inpatient stay |
| W5 | 8, filing | Defects were filed in `reviews/qa-NN.md`, each with a severity heading, and carried in `follow-ups.md`, instead of `issues/NN-defect-<slug>.md` | Every defect can still be traced, with its severity, repro and status (QA 02 and QA 03 re-verification tables, QA 04 §4). The census in section 5 uses those files | Recorded here for the conductor at G4 | none |

The staging-only UAT steps are not waivers. The UAT 5.10 api leg and 7.5 need a payer token and a
test endpoint (follow-up 15). No exit criterion depends on them: the api channel passes at the
stubbed seam (`server/channels/api.test.ts`, and `functions/api/submissions/index.test.ts`, AC-4.6).

---

## 5. Open defects: 0 critical, 0 major, 5 minor

| Defect | Severity | Owner | Blocks? |
|---|---|---|---|
| QA 04 D03: on a claim held by `sent_claims_exceed_fee`, Who pays shows a sent Flexi claim below its claimed amount (follow-up 24) | Minor | Developer, next fix round; the red test is in `qa-04.md` §6 | No |
| Focus falls to the page body after a dialog is cancelled; the DS Dialog doesn't return it (follow-up 23) | Minor (accessibility, with a working alternative) | Ting Yu, upstream in `jurasolutions/design-system` | No |
| The DS Field has no `aria-describedby` for its hint (follow-up 6) | Minor (accessibility) | Ting Yu, upstream | No |
| QA 01 D17 remainder: a hand match doesn't say "by hand" in the trail; reloading the checklist loses a typed reference; the Fee column doesn't say it's before GST (follow-up 16) | Minor | Developer, next fix round | No |
| Visit notes on a visit with no claims have nowhere to show, for example D24's PA balance (follow-up 17) | Minor | Developer, with the visit view | No |

**Why D03 is Minor and not Critical.** Criterion 8 calls "a wrong amount or payer split" critical.
D03 is wrong on screen only, in the Who pays panel. Every amount stored or sent is correct. The held
claim sits at $0, and approve, batch approve, submit and `/api/submissions` all refuse it with 409
(QA 04, D01 second leg). On the same page, the blocking finding states the true totals ($1,020.00
sent against a $708.50 fee), and "Other claims for this visit" shows Flexi at $400.00. The QA
engineer and the conductor both rated it Minor (crew-log, QA 04). If the G4 holder reads it as a
wrong payer split, the decision becomes NO-GO until follow-up 24 is fixed.

---

## 6. To turn a NO-GO into a GO

If any waiver is declined:

- **W1:** a person runs UAT 5.8 with five checklists, median under 60 s, recorded in a `qa-NN.md`.
- **W2:** a reviewer approves `0c3a3e6..3bf2f4e` (and `afe43d3..8178afd`) in a `code-review-*.md`
  with no blocking findings.
- **W3:** `crew:security-review` runs on the branch (once `origin/HEAD` exists) with no unresolved
  high finding.
- **W4:** ship the $830 ward limit with its source and date, plus a test against research §2.1.
- **W5:** file each open defect in section 5 as `issues/NN-defect-<slug>.md` with a `Severity:` line.
- **D03 reclassified as critical or major:** fix follow-up 24, so the red test in `qa-04.md` §6
  passes, then re-run the suite, typecheck, build and browser check B9 at the new commit.

Any code change re-opens criteria 2 and 11: a fresh run, and B1 to B10 at the new commit.

---

## 7. Residual risks

1. **Real payer portals are untested.** The field order, rejection codes and portal behaviour are
   assumptions until the clinic shows the real screens (strategy §7, PRD §3).
2. **The api channel and remittance step 7.5 haven't run against an endpoint** (follow-up 15).
3. **A settings change can withdraw a claim with no way back** (follow-ups 1 and 22). v1 warns on
   the settings page. Build the revive before the clinic changes its waterfall or code map in
   production.
4. **A third party's name in visit notes can reach Anthropic** (follow-up 20, ADR 0004). Decide
   this before real identifiers are switched on.
5. **The late fix rounds rest on tests and QA 04, not on a second reviewer** (W2). They change
   money logic in `src/domain/claims/build.ts`. The waterfall property (300 runs) and the sent-claims
   property cover them.
6. **Some boundaries are proven but not pinned.** The SC2.10 cent edge is proven only by this gate's
   probe, and SC7.4 has examples but not the planned property. Add both to the suite.
7. **Benchmarks are compared on the GST-inclusive fee** (UAT default S4, case D18b). Confirm with
   the clinic how MOH means the benchmark.
8. **Operational limits:** statements are capped at 50 lines (follow-up 8); a hand match can't be
   undone (7); a hold can be stranded by a worker crash (9); Node 20 is past end of life (13).
9. **The tests run on sql.js, not production D1.** QA 04 used local workerd D1, which narrows the
   gap but doesn't close it.
