# UAT script: Claims desk (chas-claimer)

*For a business user at the clinic (claims officer and reviewer) to accept the first version.
Runs entirely on the synthetic clinic and the payer simulator. No real patient data. Written by
the functional lead, 2026-11-13. Expected results follow `reviews/functional.md`; a step marked
**[default B1]** etc. depends on a recommended default there, and changes if Ting Yu overturns it.*

How to use this script: work through the sections in order. Each step has an action and an
expected result. Tick **Pass** only when everything in the expected column is true. Note anything
else under the step, even if it passes.

---

## 1. Set-up

| # | Action | Expected |
|---|---|---|
| 1.1 | Generate the synthetic clinic with `--seed 1 --today <today's date>` (T = today, SGT) | A SQLite file; the generator prints 2 branches, 3 dentists, about 60 patients, about 200 visits |
| 1.2 | Start the desk locally (`npm run db:migrate:local`, then `npm run dev:functions`) with `ROLE_OFFICERS=officer@example.test`, `ROLE_REVIEWERS=reviewer@example.test`, `ANTHROPIC_API_KEY` unset | Desk opens at http://localhost:8788 |
| 1.3 | Sign in as `officer@example.test` (`DEV_USER`) | Overview shows zeros and an empty-state prompt to load data. No errors |
| 1.4 | Open Settings and check the seeded configuration against §2.1 | Matches §2.1. Benchmarks other than consultation and crown are blank. Roles shown read-only |

Three people (or one person switching `DEV_USER`): **O** = officer@example.test, **R** =
reviewer@example.test, **X** = outsider@example.test (on neither list).

---

## 2. Test data

### 2.1 Clinic configuration

- **Branch East:** GST-registered (9%), CHAS-registered, MediSave-registered.
- **Branch West:** not GST-registered, CHAS-registered, MediSave-registered.
- **Dentists:** Dr A (East, MediSave-accredited), Dr B (West, accredited), Dr C (West, **not**
  accredited).
- **Payers and channels:** CHAS → `assisted`; MediSave → `simulator`; Meridian Dental Plan
  (fictional) → `api`, pointed at the simulator endpoint, covers crowns and root canals, no
  pre-authorisation; Harbour TPA (fictional) → `file`, covers fillings, extractions and crowns,
  **pre-authorisation required for crowns**.
- **Waterfall:** CHAS → MediSave → insurance.
- **Benchmarks:** consultation $21.00–$31.00 and permanent crown $750.00–$1,400.00 (MOH, 1 Sep 2025);
  the rest blank.
- **Code map** (clinic code → scheme code): CON consultation; SCL scaling; XR X-ray; FIL-S filling,
  simple; EXT-P extraction, posterior; RCT-A / RCT-P / RCT-M root canal anterior / pre-molar /
  molar (Meridian RC1); CRN permanent crown (Meridian CR1, Harbour H-CRN); SURG-WT → TOSP SF813T
  only; SURG-WTS → TOSP SF811T; PRS → TOSP SF708T; IMP → TOSP SB816M; WHT whitening → not
  claimable; **NEW-99 "Laser gum contouring" deliberately unmapped**.

### 2.2 Scenarios the synthetic clinic must contain

Fees at East show fee + 9% GST. "T−n" is n days before T. Amounts are what the desk should
compute. Patient IDs are labels; every identifier is synthetic.

| ID | Patient | Visit | Treatments | Expected claims |
|---|---|---|---|---|
| D01 | P01 Blue, 45 | East, Dr A, T−3 | CON $28.00 + $2.52; SCL $60.00 + $5.40 | CHAS $50.50 `ready`; patient $45.42 |
| D02 | P02 PG 85; P03 MG 70; P04 Blue 40; P05 Orange 35; P06 PA 50; P07 Green 45 | West, Dr B, T−2 each | CON $28.00 | CHAS PG $28.00, MG $25.50, Blue $20.50, Orange $13.50, PA $28.00; Green blocked "no dental subsidy" |
| D03 | P02 PG 85, MCAF standing | East, Dr A, T−5 | RCT-M complete, $900.00 + $81.00 | CHAS $594.50; Flexi-MediSave $386.50 with yearly-balance warning; patient $0.00 |
| D04a | P08 MG 70, Meridian policy (limit $1,000.00), MCAF standing | East, Dr A, T−18 | CON $28.00 + $2.52; XR $30.00 + $2.70; CRN **in progress** | CHAS $41.50 (CON $25.50 + XR $16.00); crown held **[default B1]**; patient $21.72 |
| D04b | P08 | East, Dr A, T−4 | CRN **complete**, $1,200.00 + $108.00 | CHAS $620.00; Flexi-MediSave $400.00 (warning); Meridian $288.00; patient $0.00 |
| D05 | P09 Orange 45 | West, Dr B, T−10 | CON $28.00; CRN in progress | CHAS $13.50 `ready`; crown held, no blocking finding **[default B1]** |
| D06 | P10 Green 63, MCAF standing | East, Dr A, T−6 | RCT-P complete, $700.00 + $63.00 | CHAS blocked (Green); Flexi-MediSave $400.00 `ready` **[default B5]**; patient $363.00 |
| D07 | P11 Orange 50, card expired T−40 | West, Dr B, T−6 | SCL $50.00 | CHAS blocked "card expired on the visit date" |
| D07b | P12 Orange 50, card expires T−6 | West, Dr B, T−6 | SCL $50.00 | CHAS $20.00 `ready` |
| D08 | P13 Blue 40 | West, Dr B, T−31 | SCL $50.00 | CHAS blocked "past the 30-day window" |
| D08b | P14 Blue 40 | West, Dr B, T−30 | SCL $50.00 | CHAS $30.00 `ready`, warning "last day to submit" |
| D09a | P15 Blue 30 | East, Dr A, T−7, 09:30 | CON $28.00 + $2.52 | CHAS $20.50 `ready` |
| D09b | P15 | West, Dr B, T−7, 16:00 | XR $30.00 | CHAS $11.00 blocked "second CHAS claim on the same day" |
| D10 | P16 Blue 30, MCAF single visit | East, Dr A, T−8 | SURG-WT (SF813T, table 2C), $1,500.00 + $135.00 | No CHAS claim; MediSave $1,120.00; patient $515.00 |
| D11 | P17 Blue 30, MCAF | East, Dr A, T−8 | SURG-WTS (SF811T, MSP), $400.00 + $36.00 | MediSave blocked "MSP-ranked, not claimable" |
| D12 | P18 Orange 55, **no MCAF** | East, Dr A, T−9 | PRS (SF708T, 2C), $900.00 + $81.00 | MediSave $981.00 blocked "no MCAF" |
| D13 | P19 Blue 50, MCAF | West, **Dr C**, T−9 | IMP (SB816M, 2C), $3,000.00 | MediSave $1,120.00 blocked "dentist not MediSave-accredited" |
| D14 | P20 Blue, 60th birthday at T+20 | West, Dr B, T−4 | RCT-A $500.00 | CHAS $326.00; no Flexi-MediSave (under 60); patient $174.00 |
| D14b | P21 Orange, 60th birthday on T−4, MCAF | West, Dr B, T−4 | RCT-A $500.00 | CHAS $217.50; Flexi-MediSave $282.50 |
| D15 | P22 Blue 70, MCAF | West, Dr B, T−4 | SCL $50.00 | CHAS $30.00; no Flexi-MediSave (not a crown or root canal) |
| D16 | P23 Blue 40, Harbour policy, **no pre-auth** | East, Dr A, T−5 (prep at T−19) | CRN complete, $1,000.00 + $90.00 | CHAS $615.00 `ready`; Harbour $475.00 blocked "pre-authorisation required" |
| D17 | P24 Blue 40, Harbour policy **ended T−60** | West, Dr B, T−5 | FIL-S $80.00 | CHAS $30.00; Harbour blocked "policy not active on the visit date" |
| D18 | P25 Blue 40; dentist note includes the patient's synthetic name and phone | East, Dr A, T−3 | CON $35.00 + $3.15 | CHAS $20.50 blocked "fee above the MOH benchmark, add a justification" |
| D18b | P26 Blue 40; dentist note includes the patient's synthetic name, identifier and phone | East, Dr A, T−3 | CON $29.00 + $2.61 | Above benchmark on the GST-inclusive fee ($31.61) **[default S4]** |
| D19 | P27 Blue 40 | West, T−28, T−14, T−2 | SCL $50.00 each | Third claim $30.00 `ready` with "may exceed 2 scalings per calendar year" (all three in the same calendar year as T) |
| D20 | P28 Blue 40 | East, Dr A, T−2 | CON $28.00 + $2.52; NEW-99 $200.00 + $18.00 | CHAS blocked "treatment code NEW-99 isn't in the code map" |
| D21 | P29 holds MG and Blue, 70 | West, T−2 | CON $28.00 | CHAS $25.50 (MG), note "two tiers held" |
| D22 | P30 Blue 40 | West, T−2 | CON $28.00 **with $2.52 GST** | CHAS blocked "GST charged at a branch that isn't GST-registered" |
| D23 | P31 Blue 40 | East, 15 Sep 2025 | CON $28.00 + $2.52 | CHAS blocked "no CHAS rule set covers 15 Sep 2025" (and past window) |
| D24 | P06 PA 50 | West, T−1 | WHT $150.00 | No CHAS line; warning "PA patient has a balance of $150.00" |
| D25 | P32 Blue 40 | Prep West T−20; fit East T−6 | CRN complete $1,000.00 + $90.00 | CHAS $615.00 at East, warning "started at West" |
| D26 *(optional, S2)* | P33 Blue 65, pays from spouse (66) account, spouse's MCAF | West, T−3 | RCT-A $500.00 | CHAS $326.00; Flexi-MediSave $174.00 from the spouse's account |
| D27 | P35 Blue 40, Meridian policy (limit $1,000.00) | East, Dr A, T−6 | RCT-M on tooth 14, $800.00 + $72.00 | CHAS $584.50; Meridian $287.50; patient $0.00 (used for rejection and resubmission) |

### 2.3 Remittance files (CSV, generated alongside the clinic)

**R1, CHAS statement** (columns: reference, identifier, visit date, amount):

| Line | Content | Purpose |
|---|---|---|
| 1 | D01's portal reference, $50.50 | Match by reference |
| 2 | D03's CHAS portal reference, $550.00 | Partial payment |
| 3 | No reference; P04's identifier, T−2, $20.50 | Match by patient, date, amount |
| 4 | Reference `UNKNOWN-1`, $99.99 | Unmatched |
| 5 | D01's portal reference again, $50.50 | Duplicate payment |

The generator writes R1 with placeholder references; the tester fills in the references recorded
in §5 before importing (or the generator writes the `MHCP-000n` values used below).

**R2, Meridian statement:** line 1 is D04b's Meridian reference, $288.00.

---

## 3. Import and the queue

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 3.1 | O | Load the synthetic clinic from the Imports screen | Summary shows visits new / changed / unchanged; counts add up | ☐ |
| 3.2 | O | Load it again | 0 new, 0 changed; no new audit events | ☐ |
| 3.3 | O | Open the queue; filter `ready` | D01 shows CHAS $50.50, branch East, identifier masked (first letter, bullets, last four) | ☐ |
| 3.4 | O | Check each D02 claim | PG $28.00, MG $25.50, Blue $20.50, Orange $13.50, PA $28.00, Green blocked | ☐ |
| 3.5 | O | Narrow the browser to 360px; read a queue row | Status, masked patient, date, payer, amount visible without sideways scrolling | ☐ |
| 3.6 | X | Open the desk as the outsider | "You don't have access to the claims desk"; no data visible | ☐ |

## 4. Rules and the payer waterfall

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 4.1 | O | Open D04b's claim detail | Waterfall: CHAS $620.00 → Flexi-MediSave $400.00 → Meridian $288.00 → patient $0.00; each line names its rule set and source | ☐ |
| 4.2 | O | Open D04a | CHAS $41.50 for consultation and X-ray; crown shown as held until complete | ☐ |
| 4.3 | O | Open D05 | CHAS $13.50 `ready`; crown held; no blocking finding | ☐ |
| 4.4 | O | Open D06 | CHAS blocked (Green); Flexi-MediSave $400.00 `ready` | ☐ |
| 4.5 | O | Check D07, D08, D09b, D11, D12, D13, D16, D17, D20, D22, D23 | Each blocked with the finding in §2.2; other claims on the same visit unaffected (D16 CHAS `ready`, D17 CHAS `ready`) | ☐ |
| 4.6 | O | Check D07b, D08b, D14b | No blocking finding; D08b says "last day to submit" | ☐ |
| 4.7 | O | Check D10 | MediSave $1,120.00; patient $515.00 | ☐ |
| 4.8 | O | Check D14 and D15 | No Flexi-MediSave claim; the visit says why | ☐ |
| 4.9 | O | Check D19's third scaling | `ready` with the "may exceed" warning, not blocked | ☐ |
| 4.10 | O | Check D21, D24, D25 | MG used with a note; PA balance warning; cross-branch warning | ☐ |
| 4.11 | O | On D18, type a justification and save | Claim becomes `ready`; the trail records who wrote it | ☐ |
| 4.12 | O | Withdraw D07 with reason "Card expired" | `withdrawn`; reason in the trail | ☐ |

## 5. Approval, submission and re-imports

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 5.1 | O | Try to approve D01 | No Approve button; the API refuses if called | ☐ |
| 5.2 | R | Approve as one batch: D01, P04's D02 claim, D03 (both payers), D04a, D04b (all three payers), D08b, D14b (both payers), D27 (both payers) | All `approved`; before confirming, the batch screen lists the Flexi-MediSave warnings on D03 and D04b and the "last day" warning on D08b | ☐ |
| 5.3 | O | Open D01's assisted checklist | Fields in portal order, each with a copy button; identifier masked until Show; at most 12 fields | ☐ |
| 5.4 | O | Press Show on the identifier, then check the trail | One "identifier revealed" event with O's email and time | ☐ |
| 5.5 | O (second browser) | Open D01's checklist while the first is open | "Being submitted by officer@example.test" | ☐ |
| 5.6 | O | Record portal reference `MHCP-0001` on D01 | `submitted` with that reference | ☐ |
| 5.7 | O | Record `MHCP-0001` on D08b | Refused: reference already used | ☐ |
| 5.8 | O | Time five CHAS checklists (D01 again as a rehearsal, plus D03, D04a, D04b, D27) keyed into a stand-in form | Median under 60 seconds per claim | ☐ |
| 5.9 | O | Record `MHCP-0002`, `MHCP-0003`, `MHCP-0004`, `MHCP-0005`, `MHCP-0007` on the CHAS claims of D03, D04a, D04b, D27 and P04's D02 claim | All `submitted` | ☐ |
| 5.10 | O | Send the MediSave claims of D03, D04b and D14b (simulator) and the Meridian claims of D04b and D27 (api) | All `submitted` with simulator references; the api request carried a bearer token  (staging only: needs a payer token and a test endpoint; QA 01 D14) | ☐ |
| 5.11 | O | Record "Portal refused" on D08b with "Annual balance used" | `rejected`, no reference | ☐ |
| 5.12 | O | Edit D01's scaling fee in the synthetic database to $55.00 + $4.95; re-import | D01 still `submitted` at $50.50; flagged "changed after submission" | ☐ |
| 5.13 | O | Acknowledge D01's change with a note | Flag cleared; note in the trail | ☐ |
| 5.14 | R, O | R approves D15; O edits D15's fee to $15.00 and re-imports | D15 back to `ready` at $15.00; trail shows "approval cleared" | ☐ |
| 5.15 | O | Re-import D07 (withdrawn) with a changed fee | Stays `withdrawn`; the visit shows a note | ☐ |
| 5.16 | O, R | O adds pre-authorisation `PA-0016` to D16 in the synthetic database and re-imports; R approves D16's Harbour claim; O exports the Harbour file | D16 Harbour `ready` after the re-import, then `approved`; one CSV in the configured column order with D16's row; `submitted` only after O confirms the file was sent | ☐ |

## 6. Outcomes, rejection and resubmission

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 6.1 | O | In the simulator, reject D14b's Flexi-MediSave claim: "Yearly balance used up" | `rejected` with that reason | ☐ |
| 6.2 | O | Write off D14b's Flexi-MediSave claim with a reason | `written off`; reason in the trail | ☐ |
| 6.3 | O | Record a rejection on D27's CHAS claim: "Tooth 14 is a pre-molar, not a molar". Change the treatment to RCT-P in the synthetic database; re-import | CHAS claim rebuilt at $462.50 and `ready` again; D27's submitted Meridian claim flagged "changed after submission" (its share would now be $409.50) **[default B5]** | ☐ |
| 6.4 | R, O | R approves D27's CHAS claim; O records `MHCP-0006` | `submitted`; history shows both `MHCP-0005` and `MHCP-0006` | ☐ |
| 6.5 | O | In the simulator, accept D03's MediSave claim and pay it in full | `paid` | ☐ |
| 6.6 | O | Record D03's CHAS claim as accepted at $594.50 | `accepted` | ☐ |

## 7. Remittances

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 7.1 | O | Import R1 | Line 1 → D01 `paid`; line 2 → D03 CHAS "Paid $550.00 of $594.50"; line 3 → P04's D02 claim `paid` (implicitly accepted); lines 4 and 5 under "Match by hand", line 5 saying D01 is already paid | ☐ |
| 7.2 | O | Import R1 again | 0 new lines | ☐ |
| 7.3 | O | On D03 CHAS, choose "Accept short payment" with a reason | `paid`; $44.50 written off; reason in the trail | ☐ |
| 7.4 | O | Match R1 line 4 by hand to any submitted claim (undo is deferred to a follow-up; the desk asks for confirmation first) | The confirmation names the claim and amount; the match is in the trail | ☐ |
| 7.5 | O | Import R2 (D04b Meridian still `submitted`) | D04b Meridian `paid`; trail shows "accepted by remittance"  (staging only: needs a payer token and a test endpoint; QA 01 D14) | ☐ |
| 7.6 | O | Import a CSV with headers only | "No payment lines in this file" | ☐ |

## 8. AI features

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 8.1 | O | With `ANTHROPIC_API_KEY` unset, press "Suggest code" on D20 | "AI isn't set up"; everything else works | ☐ |
| 8.2 | — | Restart with a key (or the local stand-in at `ANTHROPIC_BASE_URL`) | Desk starts | ☐ |
| 8.3 | O | On D20, "Suggest code" for NEW-99 | A suggestion; nothing changes until accepted. Choose "not claimable" instead; D20 becomes CHAS $20.50 `ready` | ☐ |
| 8.4 | O | On D18b, "Draft justification" | A draft appears for the dentist to edit; the stand-in's request log contains no name, identifier or phone from D18b's note | ☐ |
| 8.5 | O | On D27's rejection, "Explain" | An explanation and proposed fix; status unchanged | ☐ |
| 8.6 | O | In Settings, "Propose mapping" from the synthetic database | A proposal built from table and column names; the request log has no row values | ☐ |

## 9. Connector

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 9.1 | O | Run the connector with `--dry-run` against the SQLite file and the shipped mapping | Prints the visit count and one visit with identifiers masked; sends nothing | ☐ |
| 9.2 | O | Run it for real into a fresh desk | Same visits and claims as the direct load | ☐ |
| 9.3 | O | Run it with a wrong token | Exits with "The desk refused the token"; nothing imported | ☐ |
| 9.4 | O | Run it from the CSV export with one row missing its visit date | That row reported by line number and skipped; the rest imported | ☐ |

## 10. Settings, overview and audit

| # | Who | Action | Expected | Pass |
|---|---|---|---|---|
| 10.1 | O | Try to edit a benchmark | Read-only for officers | ☐ |
| 10.2 | R | Set the scaling benchmark without a source URL | Refused | ☐ |
| 10.3 | R | Switch off Dr A's MediSave accreditation | Dr A's unsubmitted MediSave claims (D06, D10) become `needs attention`; switch it back and they return | ☐ |
| 10.4 | R | Open the overview | Counts by status; claims with 5 days or fewer left in the CHAS window (D19's T−28 scaling, 2 days left); amounts submitted and unpaid by payer; unmatched remittance lines | ☐ |
| 10.5 | R | Open D01's claim detail trail | Import, approval, reveal, submission, changed-after-submission acknowledgement, payment, each with actor and SGT time, in order | ☐ |
| 10.6 | R | Check that every screen uses Jura's design system, sentence case, no exclamation marks | Pass by inspection | ☐ |

---

## 11. Sign-off

Accepted when every step passes, or each failure is recorded below with an agreed fix or an
explicit out-of-scope line in the PRD.

| Step | Failure | Agreed outcome |
|---|---|---|
| | | |

Tested by: ______________ (claims officer) Date: ________
Accepted by: ______________ (reviewer) Date: ________
