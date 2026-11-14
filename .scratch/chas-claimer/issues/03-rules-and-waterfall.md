# 03: All three schemes, the payer waterfall and the full finding catalogue

**What to build:** every visit becomes the right claims for CHAS, Flexi-MediSave, surgical (TOSP) MediSave and insurance, split by the payer waterfall, with every certain breach a blocking finding and every uncertain one a warning, and the officer can read why in plain words. Includes: MediSave TOSP rule set (dental subset, table limits, MSP), Flexi-MediSave rule set (start 2026-07-01 unconfirmed, $400/yr, 60+, crowns and root canals), account holder and MCAF validity, insurance amounts (remainder, co-pay, policy limit warning, pre-auth, policy active), held multi-visit lines and completion dates, blocked-upper-payer behaviour, benchmarks (GST-inclusive, blank = no check, from 1 Sep 2026), same-day duplicate, card validity, tier tie-break, PA, GST consistency, rule set by date, `upstream_rejected` and `waiting_on_upper_payer`.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Functional AC-2.1 to AC-2.13, and every row of functional S1's table.
- [ ] Property: for any visit, the bill split's segments sum exactly to the visit total, no segment is negative, and no payer exceeds its cap (fast-check).
- [ ] Every finding message tells the officer what to do (design principle 2) and names the rule set it came from.
- [ ] Re-running the import of the synthetic clinic produces the expected claims for every D-case (one table-driven test keyed by the generator's `cases` map).

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Stay inside `src/domain/rules/**` and `src/domain/claims/**`. The builder's inputs and `server/services/*` are fixed by 02.
- The Flexi-MediSave rule set's `note` reads "Start date unconfirmed" and the TOSP set's `note` carries its edition, through `listRuleSets()`; 06 only displays them.
- Builder-level tests cover the settings effects 06 cannot see in wave 1: a dentist without MediSave accreditation gives a blocking finding on MediSave claims (AC-8.2), and a benchmark override from settings is applied with its source (AC-8.1).

**Conductor addendum (after 02, 2026-11-14).**
- Ticket 02 shipped the CHAS rule set and the CHAS part of the finding catalogue. Extend them; don't rewrite them.
- When a visit changes, ticket 02 rebuilds only that visit's claims. Frequency counts (annual and 3-yearly limits, the Flexi-MediSave yearly amount, insurance annual benefit) depend on the patient's other visits. So when a visit's revision changes, also rebuild the patient's later unsubmitted claims within the counting period, and test it. Submitted claims stay fixed (technical F5).
- Sec-3 from code-review-02: rebuild history is keyed by `yearOf(clinical.date)`, so a held line whose `completedOn` falls in another year is missed. Key the history on the claim date (completion date for held lines). Test across a year boundary.
- D07 and D08 currently assert only CHAS $0. Once the waterfall lands, assert their lower payers and the patient's share.
