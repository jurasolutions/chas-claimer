# Functional review: chas-claimer

*Reviewer: functional lead · 2026-11-13 · against `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`
(cited as `PRD Lnn`), `GLOSSARY.md`, ADR 0001–0005, `docs/research/sg-dental-claims.md` (cited as `research §n`)
and `.scratch/chas-claimer/interview.md` (cited as `Qnn`).*

Ting Yu delegated every gate, so where a finding turns on a client fact this review gives a
**recommended default** the build can proceed on. Each default is an assumption to confirm with
the clinic, in the same way as the interview's answers. The PRD is not edited; findings point at
the line to change when Ting Yu reviews.

Scenario IDs (`D01`, `D04b` …) refer to the synthetic clinic data set defined in
`reviews/uat-script.md` §2. The generator must produce every one of them.

---

## 1. The process as it actually runs

A CHAS dental visit at a Singapore clinic, end to end, and where the PRD covers each step:

| # | Real step | Who | PRD coverage |
|---|---|---|---|
| 1 | Patient registers, shows NRIC and CHAS / PG / MG card; front desk checks tier and balance in MHCP or the CMS | Front desk | Outside the desk (clinic database holds tier and card expiry). OK |
| 2 | Insurance member: card checked, pre-authorisation or LOG requested for big-ticket items **before** treatment | Front desk / TPA | Pre-auth is only a reference on the claim (L72-74, glossary). No check that it exists when required. **Gap → S1** |
| 3 | MediSave: patient (or the **account holder**, e.g. spouse) signs MCAF(S) | Front desk | MCAF as a yes/no only; no account holder, no MCAF scope or validity. **Gap → S2** |
| 4 | Treatment. Crowns, dentures and root canals span several visits; claimable only when complete | Dentist | Blocking finding on "unfinished multi-visit procedure" (L43-44), but no completion date, no rule for which visit's date the claim takes. **Gap → B1** |
| 5 | Itemised bill at the counter: subsidy and MediSave **already deducted**, patient pays the balance | Front desk | Not modelled; the desk recomputes the split. A mismatch with what was billed goes unnoticed. **Gap → S16** |
| 6 | Claims officer keys each claim into MHCP / NPHC / TPA portal within 30 days | Claims officer | Assisted checklist (L77-79). 30-day check exists, but when it is evaluated is not stated. **Gap → B6** |
| 7 | Portal refuses on submit (balance used up, card invalid) and issues no reference | Claims officer | Lifecycle requires a portal reference for `submitted` (L75-76); no path for "portal refused". **Gap → B2** |
| 8 | Payer accepts, part-accepts, adjusts or rejects | Payer | Claim-level `accepted` / `rejected` only; no accepted amount. **Gap → B2** |
| 9 | Clinic corrects and resubmits, or writes off | Claims officer | `rejected → needs attention / ready / written off` (Q20). Resubmission history and re-import of a rejected claim not stated. **Gap → B2, B3** |
| 10 | Payment arrives (CHAS within about a month of approval), often short or before the clinic recorded the outcome | Finance | Remittance matching (L50-51, L82). Partial, early, duplicate and over-payments not stated. **Gap → B2, S12** |
| 11 | Clinic corrects a visit after the claim went (fee, tooth, code) | Front desk | "Changed after submission" flag (L70-71), but no resolution path. **Gap → S7** |
| 12 | MOH audit: show who claimed what, at which branch, on what documentation | Reviewer / owner | Audit trail (L48-49, L90). Branch per claim (Q1). Cross-branch multi-visit not covered. **Gap → B1, S5** |

Handoffs nobody owns today in the PRD: who re-checks a claim that was approved but has sat past
day 30 (B6); who resolves a "changed after submission" flag (S7); who closes a short payment (B2).

---

## 2. Findings

### Blocking

**B1. Multi-visit procedures have no claim date, window or card-validity rule.** PRD L27-28,
L43-44, L72-74; ADR 0003; research §1 summary 3.
A crown is prepared at one visit and fitted at another. The PRD makes "unfinished multi-visit
procedure" a blocking finding on the claim, which also blocks the consultation and X-ray done at
the prep visit. Those lines then miss the 30-day window while the crown is being made (D04a,
D05). It also never says which date the crown is claimed on, which date the 30-day window and
card validity run from, or which branch claims it when prep and fit are at different branches.
**Recommended default:**
- A treatment carries `completion: complete | in progress` and `completed_on`.
- An in-progress multi-visit line is **held** off the claim with a visit-level note "Held until
  the crown is complete". It does not block the other lines on that visit.
- The held procedure is claimed on the claim for the **completion visit**, dated `completed_on`.
  The 30-day window, card validity, tier and the same-day rule all use that date. The claim
  belongs to the completion visit's branch, and if the procedure started at another branch the
  claim gets a warning (D25).
- If the clinic database records completion by updating the prep visit rather than adding a fit
  visit, the re-import of the prep visit releases the held line onto a new claim dated
  `completed_on`.
- A source visit that marks a multi-visit procedure `complete` with no in-progress history is
  accepted (single-visit root canal, D03).

**B2. The lifecycle has no amounts, so partial outcomes and payments cannot be recorded.** PRD
L50-51, L75-76, L82; Q20, Q26; research §6.8.
Insurers routinely pay their own schedule, not the claimed amount; CHAS payments can arrive
short; remittances often arrive before anyone records the outcome; and MHCP can refuse a claim
outright with no reference. None of these has a path. **Recommended default:**
- `accepted` records an **accepted amount** (defaults to the claimed amount; may be lower, never
  higher). Recording a lower amount needs a reason.
- `paid` is reached when payments matched to the claim sum to the accepted amount. Until then the
  claim stays `accepted` and shows "Paid $X of $Y".
- A short payment is closed by an explicit, audited **accept short payment** action with a
  reason, which moves the claim to `paid` and records the difference as written off.
- A remittance line matched to a `submitted` claim records an implicit acceptance at the paid
  amount (audited as "accepted by remittance") and then applies the rule above.
- Overpayment (payments exceed the accepted amount) leaves the claim `paid` with a flag
  "Overpaid by $X" for a person.
- From the assisted checklist the officer can record **portal refused** with the portal's
  message, moving `approved → rejected` with no portal reference.
- Every resubmission keeps the previous portal references in the claim's history; the claim shows
  the latest.
- A `rejected` claim moved back to `needs attention` or `ready` counts as unsubmitted for
  re-imports (B3).

**B3. A re-import can change an approved claim without voiding the approval.** PRD L70-71; Q19.
"Re-imports update unsubmitted claims" includes `approved` claims. The reviewer would then have
approved figures that no longer exist. The same applies when a code-map entry, rule set,
benchmark, branch or dentist setting changes. **Recommended default:** any change to an
unsubmitted claim's lines, amounts or findings moves an `approved` claim back to `ready` (or
`needs attention` if a blocking finding appears), with an audit event "Approval cleared: source
visit revision 2". Submitted, accepted, paid and written-off claims are never recomputed; they keep
the rule-set version they were built with.

**B4. The `S0000` synthetic-identifier block can contain real people's NRICs.** PRD L107;
GLOSSARY "Synthetic identifier"; Q9; repo `CLAUDE.md` "No real patient data, ever".
The S0000 block holds the very first NRICs ever issued, and at least one number in it is widely
reported to belong to a real, well-known person. A public repo pairing such numbers with made-up
dental and payment records breaks the interview's own test ("an NRIC prefix that cannot belong to
a real person"). **Recommended default:** generate synthetic identifiers from a block that
cannot have been issued yet, such as the `T9` block (the digits after `T` encode a birth year in
the 2090s), with a valid check letter. Never derive age from the identifier; date of birth is its
own field. Verify the choice of block against ICA's numbering before adopting it, and add a test
that rejects any synthetic identifier outside the chosen block. The glossary entry changes with
it.

**B5. The payer waterfall does not say what happens when a payer above is blocked.** PRD L40-41,
L127; Q13.
Each payer claims "what the payer above it left". If the CHAS claim is blocked, the MediSave and
insurance amounts below it are unknown. Two different cases need two answers:
- **Permanently not claimable** (CHAS Green, card expired on the visit date, past the 30-day
  window, no rule set for the date): the upper payer contributes $0 and the lower claims are built
  and can go. A Green 63-year-old's root canal must still reach Flexi-MediSave (D06).
- **Fixable** (unmapped code, missing justification, GST inconsistency): the lower claims are built
  but get the blocking finding "Waiting on the CHAS claim; amounts may change", until the upper
  claim is ready.
- A blocking finding on one payer's claim never blocks another payer's claim for any other reason.
- When an upper claim is rebuilt after a lower claim was submitted (a rejected CHAS claim corrected
  to a different amount), the lower claim is flagged **changed after submission** (UAT §6.3).

**B6. The 30-day window has no clock, boundary or re-check.** PRD L26, L43; research §1.4.
"Past 30 days" depends on today. A claim built as `ready` on day 25 and approved on day 31 would
go out late. **Recommended default:**
- Dates are calendar dates in SGT, never UTC. A claim is in time while
  `today (SGT) ≤ claim date + 30 days`. Day 30 is the last day (D08b passes, D08 blocks).
- The window is re-checked when the queue loads, on approval and on recording a submission.
  Crossing it moves the claim to `needs attention`.
- A warning "Last N days to submit" appears from day 25.
- The window applies to CHAS only; MediSave and insurance deadlines are per-payer settings,
  blank (no check) until the clinic supplies them (research §2.4, §3.4).
- For the synthetic clinic and UAT, the generator takes a `--today` anchor and lays every visit
  out relative to it, so the boundary cases stay true on the day the UAT is run.

### Should fix

**S1. The list of certain blockers is incomplete.** PRD L42-45; ADR 0003.
These are as certain from the record and settings as the ones listed, and each needs a stated
outcome. Recommended classification:

| Condition | Outcome |
|---|---|
| Branch not CHAS-registered (CHAS claim) / not MediSave-registered (MediSave claim) | Blocking |
| Dentist not MediSave-accredited (any MediSave claim) | Blocking (D13) |
| TOSP code not in the rule set | Blocking |
| More than 3 TOSP procedures in one episode, or more than 2 anatomical systems | Blocking |
| Treatment code not in the code map | Blocking until mapped; an explicit "not claimable" mapping is fine (D20) |
| No rule set covers the claim date | Blocking (D23) |
| Insurer requires pre-authorisation for this benefit and none recorded | Blocking (D16) |
| Policy not active on the claim date | Blocking (D17) |
| Fee above the configured benchmark, claim date on or after 1 Sep 2026, no justification | Blocking (D18) |
| GST amount present at a branch that isn't GST-registered | Blocking (D22) |
| Flexi-MediSave: patient under 60 on the claim date, or treatment not a crown or root canal | No Flexi-MediSave claim is built; visit note says why (D14, D15) |
| Local annual / 3-yearly count over limit, Flexi-MediSave yearly amount, insurance annual benefit | Warning (ADR 0003) (D19) |
| Insurer is not on panel (member reimbursement) | No insurance claim built |

**S2. MediSave is paid from an account holder, not always the patient.** PRD L72-74; research
§2.1, §2.3.
Flexi-MediSave can come from a spouse aged 60+; TOSP MediSave can come from family members. The
MCAF is the account holder's, and MCAF(S) can cover one visit, a period, or stand until revoked.
**Recommended default:** a MediSave claim carries an account holder (default: the patient) with
relationship and age, and an MCAF with type (`single visit`, `period`, `standing`), valid-from,
valid-to and revoked-on. "No MCAF" means no MCAF valid on the claim date for that account holder.
Spouse-account support can be a seeded case flagged optional (D26) if the build runs short.

**S3. The Flexi-MediSave dental start date is not known.** PRD L17-18, L55-56; research §2.1
("mid-2026").
A rule set needs an effective date, and the numbers rule says unknowns ship blank, but a blank
start date means Flexi-MediSave never applies. **Recommended default:** ship the Flexi-MediSave
dental rule set with effective date 1 Jul 2026, its source note reading "mid-2026 per CPF Budget
2025; exact date to confirm", and show "Start date unconfirmed" beside it in settings. Confirm with
the clinic (PRD L182-183, open question 3).

**S4. Benchmark basis and blanks.** PRD L30-31, L104-106; Q16.
Two things are unstated: whether the fee compared is GST-inclusive, and what a blank benchmark
does. **Recommended default:** compare the GST-inclusive fee (the conservative choice: it asks for
more justifications, never fewer); a blank benchmark runs no check and the claim line shows
"Benchmark not set". D18b sits on this boundary ($29.00 + GST = $31.61 against a $31.00 top). Add
to the client questions.

**S5. Tie-breaks the builder needs.**
- **Same-day duplicate** (PRD L43): the second claim, ordered by visit start time then visit ID,
  is blocked, across branches too (D09). Its finding tells the officer to combine the visits in the
  clinic system.
- **More than one tier held** (for example Merdeka Generation and CHAS Blue): use the valid tier
  with the highest subsidy on the claim date, with a note (D21).
- **Card expiry boundary:** a card is valid on its expiry date (D07b).
- **Age 60 boundary:** a patient is 60 on their 60th birthday (D14b).

**S6. Concurrent and repeated submission.** PRD L77-79, L148-151.
Two officers can open the same approved claim's checklist and both key it into MHCP. **Recommended
default:** opening the checklist marks the claim "Being submitted by <email>" for 30 minutes; a
second officer sees that and must confirm to take over. Recording a portal reference on a claim
that already has one for the current attempt is refused. A portal reference already used by
another claim of the same payer is refused. The `api` channel sends an idempotency key per
attempt; a timeout leaves the claim `approved` with a failed attempt in the audit trail, never
`submitted`.

**S7. "Changed after submission" has no way out.** PRD L70-71; glossary.
**Recommended default:** the officer either **acknowledges** the change (no payer action needed;
note required, audited, flag cleared) or records that the claim was amended or cancelled in the
portal (outside the desk). Add an explicit out-of-scope line: "amending or cancelling a submitted
claim in the payer's portal is done by a person; the desk records it". A visit deleted or voided
in the clinic database (if the source mapping exposes it) withdraws its unsubmitted claims and
flags submitted ones.

**S8. Withdrawal rules.** PRD L75-76; Q20.
Allow `withdrawn` from `needs attention`, `ready` and `approved`, with a reason. A re-import never
resurrects a withdrawn claim; it shows a note on the visit instead (UAT §5.15). Permanently
unclaimable claims (Green, expired, past window) offer "Withdraw" as their one-click fix.

**S9. De-identification of free text is untested.** PRD L52-54, L112; ADR 0004.
The justification draft reads the dentist's notes, and the rejection explainer reads text pasted
from a portal. Both can carry a name, NRIC, phone or member number. **Recommended default:** a
scrubber removes the visit's own known identifiers (name, NRIC/FIN, phone, address, member ID,
policy number) and anything matching NRIC/FIN, phone or email patterns before any call, and a
test asserts the outgoing request body contains none of a seeded set (the notes on D18 and D18b
include the patient's synthetic name, identifier and phone on purpose).

**S10. Insurance specifics.** PRD L72-74, L85-87; Q27; research §3.
Each payer setting needs: panel yes/no; pre-auth required per benefit code; submission deadline
(blank = no check); template fields. Annual benefit limits come from the policy and produce a
warning when the local count would exceed them.

**S11. Where roles live is contradictory.** PRD L87 ("roles" in settings) vs L161
(`ROLE_REVIEWERS`, `ROLE_OFFICERS` env vars).
**Recommended default:** environment variables are the source of truth; the settings screen shows
them read-only. A signed-in email in neither list gets "You don't have access to the claims
desk" on every page and a 403 from every API route. Reviewers can do everything officers can.
Officers cannot approve. Both roles may reveal an identifier, and every reveal is audited.

**S12. Remittance edge cases.** PRD L50-51, L82; Q26.
**Recommended default:** importing the same file twice adds no lines (hash of file plus line);
a line matching two or more claims is left for a person; a line matched to a `withdrawn` or
`written off` claim is left for a person with a note; a negative line (recovery or clawback) is
left for a person. Add an explicit out-of-scope line: "clawbacks and payer recoveries are matched
by hand".

**S13. Rule and setting changes against existing claims.** PRD L55-56; ADR 0002.
Covered by B3: unsubmitted claims recompute; submitted ones keep their rule-set version, shown on
claim detail as "Built with CHAS dental schedule effective 1 Oct 2025".

**S14. Success criterion 3 cannot fail as written.** PRD L46-47 ("in under a minute of copying").
Rewritten as AC-4.2 below: a measurable field count, order and timing on a stated sample.

**S15. Changing a payer's channel with claims in flight.** PRD L79.
**Recommended default:** a claim uses the channel set when it was approved; changing the channel
affects claims approved afterwards. Settings shows "N approved claims will still use the assisted
channel".

**S16. The desk never compares with what the clinic billed.** Process step 5.
The patient has already been charged the balance. If the desk computes a different subsidy, either
the clinic under-claims or the bill was wrong. **Recommended default:** if the source mapping
supplies billed amounts per payer, any difference is a warning "Billed CHAS subsidy $20.00, rules
give $20.50". If it doesn't, nothing is shown. Add a client question: does the CMS store the
per-payer split on the bill?

**S17. Warnings at approval.** PRD L48-49.
The reviewer must see every warning on the claims being approved, and batch approval lists them.
Approving a claim with warnings records "Approved with 1 warning" in the audit trail.

### Notes

**N1. Glossary gaps and overloaded terms** (domain-modeling pass). Proposed entries for whoever
next edits `GLOSSARY.md`; none were written by this review:
- **Approval**: a reviewer's sign-off that a claim may be submitted. *Avoid*: "approved" for
  anything a payer does. The research note uses "approved" for the payer's decision (§6.8) and
  the CHAS FAQ talks of "claim approval date"; in the desk that is **accepted**.
- **Accepted amount**: what the payer agreed to pay on a claim; at most the amount claimed.
- **Completion date**: the date a multi-visit procedure was finished; the date its claim takes.
- **Held line**: a treatment kept off a claim until it is complete. *Avoid*: pending, parked.
- **Card validity**: the dates between which a CHAS tier applies to the patient. *Avoid*:
  card status.
- **MediSave account holder**: whose MediSave pays; the patient or a family member, each with
  their own MCAF.
- **Withdraw (a claim)**: the clinic decides not to submit a claim. Distinct from a MediSave
  **withdrawal limit**, which the glossary should name as such under TOSP code.
- **Patient balance**: what is left after the payer waterfall; the patient pays it.
- **Claim status**: the nine statuses and who may move between them (AC-3.1).

**N2. The interview's example patient doesn't exist.** Q13 has "a Merdeka Generation patient aged
62". MG cardholders were born 1950–1959 and are 67 or older in 2026. The synthetic clinic should
not repeat it; D04 uses a 70-year-old.

**N3. The TOSP rule set is the 1 Jan 2024 edition.** MOH FCM No. 1/2026 updates it and has not
been read (research §2.1). Ship it with that note visible in settings.

**N4. Fictional payers.** The synthetic clinic should use made-up insurer and TPA names
("Meridian Dental Plan", "Harbour TPA") and made-up benefit codes, not Singlife's real ones, so the
public repo never implies a panel relationship or publishes an insurer's schedule as ours.

**N5. CHAS-plus-TOSP on one treatment.** Whether a surgical wisdom-tooth removal also attracts the
CHAS posterior-extraction subsidy is a code-map decision. Default: map surgical removals to TOSP
only (D10); add to the client questions.

**N6. PA patient balance.** A PA patient should pay nothing for CHAS-covered procedures. A PA
visit with a patient balance gets a warning "Check this fee isn't for a CHAS-covered procedure"
(D24).

**N7. Explicit out-of-scope lines to add** at G2 if not fixed: portal amendments and cancellations
(S7), clawbacks (S12), deposits taken at a prep visit, MediShield Life, patient billing and
itemised bills (already L99).

---

## 3. Edge coverage

| Edge | Covered by |
|---|---|
| Empty: no visits imported, empty CSV, remittance with no lines, queue with nothing in a status | AC-1.6, AC-5.7, AC-8.3 |
| Maximum: 200-visit import in one request; batch approval of 50 claims; 4 TOSP procedures | AC-1.4, AC-3.4, S1 |
| Concurrent: two officers on one checklist; connector run overlapping a synthetic load; same remittance twice | S6, AC-1.5, AC-5.6 |
| Out of order: remittance before outcome; re-import of an older revision; fit visit imported before prep | B2, AC-1.3, B1 |
| Permission denied: officer approving; email not on either list; connector with wrong token | AC-3.3, S11, AC-7.3 |
| Data from before the change: visit before 1 Oct 2025; visit before 1 Sep 2026 above benchmark; Flexi-MediSave before its start date | AC-2.10, AC-2.8, S3 |
| Date boundaries: day 30, card expiry day, 60th birthday, calendar-year rollover for frequency counts | B6, S5, AC-2.9 |
| Out of scope by PRD: bots, extension, SmartCMS, Healthier SG, CDMP, real endpoints, multi-clinic, patient-facing, notifications (L94-99) | Ruled out |

---

## 4. Testable acceptance criteria by build block

Amounts are SGD. GST is 9% at branch East (GST-registered); branch West is not GST-registered.
Unless stated, "today" is the generator's anchor date T and claim dates are T−N in SGT.

### Block 1. Walking skeleton: schema, synthetic clinic, import, CHAS claims, queue screen

- **AC-1.1** Given the generator run twice with `--seed 1 --today 2026-11-13`, when the two SQLite
  files are compared, then they are byte-identical, hold 2 branches, 3 dentists, 55–65 patients,
  180–220 visits, and contain every scenario D01–D27 in `uat-script.md` §2 with exactly those
  fees, dates, tiers and flags.
- **AC-1.2** Given the generated file, when every identifier is checked, then each is in the
  chosen synthetic block with a valid check letter (B4), and no name, phone or address matches a
  denylist of real-looking patterns (a test, not a manual look).
- **AC-1.3** Given D01 imported once, when the same content is imported again, then no new
  revision, claim or audit event is created and the import reports "0 new, 0 changed, 1
  unchanged". Given revision 2 then an older revision 1 payload arrives, then it is ignored and
  reported as "older than the current revision".
- **AC-1.4** Given an import of all synthetic visits in one request, when it finishes, then every
  visit has exactly one revision and the import summary counts add up to the visits sent.
- **AC-1.5** Given two imports of the same visits started at the same time, when both finish, then
  each visit still has one revision and one set of claims (no duplicates).
- **AC-1.6** Given an empty database, when the queue opens, then it shows an empty state with
  "Load the synthetic clinic" and no error.
- **AC-1.7** Given D01 imported (Blue, East, T−3, consultation $28.00 + $2.52 GST, scaling $60.00
  + $5.40 GST), when the queue opens, then one CHAS claim shows status `ready`, amount $50.50,
  the identifier masked in the `S••••567D` style (first letter, bullets, last four characters) and
  the branch East.
- **AC-1.8** Given the queue at 360px wide, when a claim row is read, then status, patient (masked),
  claim date, payer and amount are visible without horizontal scrolling.

### Block 2. Rule sets, claim building, payer waterfall, findings

- **AC-2.1 Tiers.** Given D02 (consultation $28.00 at West, T−2), when claims are built, then CHAS
  amounts are PG $28.00, MG $25.50, Blue $20.50, Orange $13.50, PA $28.00, and the Green patient's
  claim has the blocking finding "CHAS Green has no dental subsidy".
- **AC-2.2 GST.** Given D01, then each line's fee considered is fee + GST ($30.52, $65.40) and the
  subsidy is the lesser of that and the tier maximum, in cents.
- **AC-2.3 Waterfall.** Given D04b (MG, crown $1,200.00 + $108.00, Meridian policy limit $1,000.00,
  MCAF valid), then CHAS $620.00, Flexi-MediSave $400.00 with the warning "Check the patient's
  yearly Flexi-MediSave balance in the portal", Meridian $288.00, patient balance $0.00. Given the
  waterfall order changed to CHAS → insurance → MediSave, then Meridian $688.00 (within its
  $1,000.00 limit), and no MediSave claim is built because nothing is left.
- **AC-2.4 Blocked payer above.** Given D06 (Green, 63, root canal pre-molar $763.00), then the
  CHAS claim is blocked (Green) and the Flexi-MediSave claim is `ready` at $400.00 (B5). Given D20
  before its code is mapped, then the CHAS claim is blocked and any lower claim carries "Waiting on
  the CHAS claim".
- **AC-2.5 Certain blockers.** Given each of D07 (card expired), D08 (T−31), D09b (same day, second
  visit), D11 (SF811T), D12 (no MCAF), D13 (dentist not accredited), D16 (pre-auth missing), D17
  (policy ended), D20 (unmapped), D22 (GST at non-GST branch), D23 (no rule set), then the named
  claim is `needs attention` with exactly that blocking finding, and every other claim on the
  same visit is unaffected.
- **AC-2.6 Boundaries pass.** Given D07b (card expires on the visit date), D08b (T−30), D14b (60th
  birthday on the visit date), then none of them has a blocking finding; D08b carries "Last day to
  submit".
- **AC-2.7 TOSP.** Given D10 (SF813T, table 2C, fee $1,635.00), then the MediSave claim is $1,120.00
  and the patient balance $515.00, with the rule set's source shown on the line.
- **AC-2.8 Benchmark.** Given D18 (consultation $35.00 + $3.15, claim date on or after 1 Sep 2026,
  benchmark top $31.00), then blocking "Fee is above the MOH benchmark ($21.00–$31.00). Add a
  clinical justification." When a justification of at least 20 characters is saved, then the
  claim becomes `ready`. Given the same fee with claim date 31 Aug 2026, then no finding.
- **AC-2.9 Frequency warning.** Given D19 (third scaling this calendar year, earlier two not
  withdrawn), then the third claim is `ready` with the warning "May exceed 2 scalings per calendar
  year. Check the balance in the portal." Given the earlier two fall in the previous calendar year,
  then no warning.
- **AC-2.10 Rule set by date.** Given D23 (claim date 15 Sep 2025), then blocking "No CHAS rule set
  covers 15 Sep 2025". Given any built line, then claim detail shows the rule set name, source URL
  and effective date.
- **AC-2.11 Multi-visit.** Given D04a/D05 (crown in progress), then the crown is a held line, the
  consultation and X-ray are claimed on the prep visit's date, and D04b claims the crown on its
  completion date (B1).
- **AC-2.12 Flexi-MediSave eligibility.** Given D14 (59), D15 (scaling, 70), then no
  Flexi-MediSave claim is built and the visit says why. Given D14b, then Flexi-MediSave $282.50.
- **AC-2.13 Property.** For any generated fee and tier, the sum of all payer amounts plus the
  patient balance equals the visit's fee including GST, to the cent, and no amount is negative.

### Block 3. Lifecycle, approval, audit trail, claim detail

- **AC-3.1 Transitions.** Given the allowed set below, when any other transition is attempted
  through the API, then it returns 409 and no state or audit change occurs:
  `needs attention ⇄ ready` (by findings), `needs attention | ready | approved → withdrawn`,
  `ready → approved` (reviewer), `approved → ready` (re-import, B3), `approved → submitted`,
  `approved → rejected` (portal refused), `submitted → accepted | rejected`, `submitted → paid`
  (remittance, B2), `accepted → paid`, `rejected → needs attention | ready | written off`.
- **AC-3.2 Approval.** Given D01 `ready` and a reviewer signed in, when they approve, then status is
  `approved` and the audit trail shows actor email, time (SGT) and "approved". Given the reviewer
  also imported it, then the event reads "approved (self-approval)".
- **AC-3.3 Permission.** Given an officer signed in, when they call approve, then 403, and the
  Approve button is not shown to them.
- **AC-3.4 Batch.** Given 50 `ready` claims selected, when a reviewer approves the batch, then all
  50 are `approved` and there are 50 audit events; given 1 of them gained a blocking finding since
  selection, then 49 are approved and the screen names the one that wasn't.
- **AC-3.5 Re-check.** Given D08b `approved` and the clock moves to T+1, when the queue loads, then
  it is `needs attention` with "Past the 30-day window" (B6).
- **AC-3.6 Audit completeness.** Given D01 taken through import, approve, reveal, submit, accept,
  pay, then the claim detail's trail lists those six events in order with actor and time, and the
  `audit_events` table rejects UPDATE and DELETE.
- **AC-3.7 Claim detail.** Given D04b, then claim detail shows each line's clinic code, scheme code,
  fee considered, amount claimed, rule set, findings, the waterfall across payers, and the source
  visit revision.

### Block 4. Submission channels, assisted checklist, file export, API channel, payer simulator

- **AC-4.1 Packet minimality.** Given D04b's Meridian claim and a template listing member ID, plan,
  benefit code, tooth, date, amount, then the packet holds exactly those fields and no clinical
  notes, diagnosis or other payers' amounts.
- **AC-4.2 Assisted checklist** (replaces PRD L46-47). Given D01 `approved` with CHAS on the assisted
  channel, when the officer opens the checklist, then fields appear in the configured portal order,
  each with a copy button, the identifier masked until "Show" is pressed (one audit event per
  reveal), and at most 12 fields. In UAT, a tester copying five claims into a stand-in form takes
  a median under 60 seconds per claim, timed.
- **AC-4.3 Record reference.** Given the checklist, when the officer saves portal reference
  `MHCP-0001`, then the claim is `submitted` with that reference. Saving an empty reference is
  refused. Saving `MHCP-0001` on another CHAS claim is refused.
- **AC-4.4 Portal refused.** Given the checklist, when the officer records "Portal refused" with
  the message "Annual balance used", then the claim is `rejected` with no reference (B2).
- **AC-4.5 File channel.** Given three approved Harbour claims, when the officer exports, then one
  CSV in the configured column order has three rows, amounts with two decimals, and all three
  claims become `submitted` only after the officer confirms the file was sent.
- **AC-4.6 API channel.** Given Meridian on `api` pointed at the simulator endpoint and
  `PAYER_MERIDIAN_API_TOKEN` set, when D04b is sent, then the request carries the bearer token and
  an idempotency key, and the claim is `submitted` with the simulator's reference. Given the
  endpoint times out, then the claim stays `approved` and the trail shows a failed attempt.
  Given the token is unset, then sending is refused with "This payer's API token is not set".
- **AC-4.7 Simulator.** Given a claim submitted to the simulator, when a person accepts it at
  $550.00, rejects it with a reason, or pays it, then the claim reflects that outcome with the
  simulator as actor in the trail.
- **AC-4.8 Concurrency.** Given officer A has D01's checklist open, when officer B opens it, then B
  sees "Being submitted by A" (S6).

### Block 5. Remittance import and matching

- **AC-5.1 Reference match.** Given remittance R1 line 1 (reference of D01, $50.50), then it
  matches D01 and D01 becomes `paid`.
- **AC-5.2 Second-tier match.** Given R1 line 3 (no reference; P04's identifier, date T−2,
  $20.50), then it matches P04's D02 claim by patient hash, date and amount.
- **AC-5.3 Partial.** Given R1 line 2 ($550.00 against D03's CHAS claim accepted at $594.50), then
  D03 stays `accepted` showing "Paid $550.00 of $594.50"; after "Accept short payment" with a
  reason, it is `paid` with $44.50 written off (B2).
- **AC-5.4 Before outcome.** Given R2 line 1 (Meridian, D04b's reference, $288.00) while D04b is
  `submitted`, then D04b is `paid` and the trail shows "accepted by remittance".
- **AC-5.5 Unmatched and ambiguous.** Given R1 line 4 (unknown reference, $99.99), then it is listed
  under "Match by hand" and no claim changes. A person can match it to a claim, audited.
- **AC-5.6 Idempotent.** Given R1 imported twice, then the second import adds 0 lines. Given R1
  line 5 duplicates line 1, then the duplicate is listed under "Match by hand" with "D01 is already
  paid".
- **AC-5.7 Empty.** Given a CSV with headers only, then "No payment lines in this file" and nothing
  else changes.

### Block 6. AI features

- **AC-6.1 Off.** Given `ANTHROPIC_API_KEY` unset, when any AI action is used, then it shows "AI
  isn't set up" and every other screen works.
- **AC-6.2 No identifiers.** Given D18b's dentist note containing the patient's synthetic name,
  identifier and phone, when "Draft justification" runs with `fetch` stubbed, then the captured
  request body contains none of them (S9).
- **AC-6.3 Code map suggestion.** Given D20's unmapped "Laser gum contouring", when suggested, then
  a proposal appears that changes nothing until a person accepts it; accepting adds the code-map
  entry with "accepted from AI suggestion" in the trail.
- **AC-6.4 Rejection explainer.** Given D27's rejected CHAS claim with reason "Tooth 14 is a
  pre-molar, not a molar", then the explanation and proposed fix are shown as a suggestion; the
  claim's status does not change.
- **AC-6.5 Mapping proposal.** Given only the synthetic database's table and column names, when a
  mapping is proposed, then the request contains no row values and the proposal is saved only on
  acceptance.

### Block 7. Connector CLI and source mapping

- **AC-7.1** Given the shipped synthetic mapping and the SQLite file, when `connector --dry-run`
  runs, then it prints the visit count and the first visit's fields with identifiers masked, and
  sends nothing.
- **AC-7.2** Given the same, when it runs for real against `npm run dev:functions`, then the desk
  holds the same visits as a direct synthetic load (same content hashes).
- **AC-7.3** Given a wrong `CONNECTOR_TOKEN`, then the desk returns 401, the connector exits non-zero
  with "The desk refused the token", and nothing is imported.
- **AC-7.4** Given a CSV export with one row missing its visit date, then that row is reported by
  line number and skipped, and the others import.
- **AC-7.5** Given the desk unreachable, then the connector exits non-zero with no partial import
  recorded as complete; a rerun imports everything once.

### Block 8. Settings, code map screens, overview

- **AC-8.1** Given a reviewer sets a benchmark that ships blank (for example scaling) to a range with
  a source URL, then unsubmitted claims recompute (B3) and the trail records who changed it.
  Saving a benchmark without a source URL is refused. *(Reworded at build, 2026-11-14: the
  consultation range ships published per decisions-g2 §9, so it is the wrong example for "from
  blank".)*
- **AC-8.2** Given a dentist's MediSave accreditation switched off, then their unsubmitted MediSave
  claims become `needs attention`.
- **AC-8.3** Given the overview, then it shows counts by status, claims with 5 days or fewer left in
  the CHAS window, amounts submitted and not yet paid by payer, and unmatched remittance lines;
  with an empty database it shows zeros, not errors.
- **AC-8.4** Given an officer, then settings are read-only for them (default: reviewers edit
  settings).
- **AC-8.5** Given roles from environment variables, then the settings screen lists them read-only
  (S11).
