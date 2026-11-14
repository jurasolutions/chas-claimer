# 12a: QA fixes, claim detail and the builder

**What to build:** fix the QA 01 defects in the claim builder, rebuild and the claim detail page, so an officer
sees why a visit has the claims it has and the figures agree. Defect numbers refer to
`.scratch/chas-claimer/reviews/qa-01.md` §6.

**Blocked by:** 11 is in flight on `server/crypto.ts`, `server/auth.ts`, `src/ui/api.ts`, `App.tsx` and the
settings page; stay off those. 12b runs in parallel on the queue, overview, settings, submit page and dialogs.

**Status:** ready-for-agent

- [ ] D02 (major): visit notes reach the claim detail. Rebuild stores the builder's visit notes (held crown,
      no Flexi-MediSave and why, PA balance warning, withdrawn-visit note on re-import) and claim detail shows
      them through `describeVisitNote`. The QA `it.fails` test turns into a passing `it`. UAT 4.2, 4.3, 4.8,
      4.10 and 5.15.
- [ ] D11: a rebuild clears approval only on claims whose lines, amounts or blocking findings changed
      (decisions-g2 §13). Unchanged approved claims keep their approval; test with the QA repro (Dr A's
      MediSave off then on).
- [ ] D12: a withdrawn or submitted claim's frozen figures and the visit's current figures are never mixed on one
      screen; frozen figures are labelled "as built on <date>".
- [ ] D13: insurer claims show no rule-set message; D03: each scheme payer line names its rule set and source,
      and branches show their names from settings, not codes.
- [ ] D07: findings on a withdrawn claim no longer say "Blocks submission". D05: blocked claims show the
      computed amount consistently, with the status saying it can't be submitted.
- [ ] D17: a paid claim offers neither "Record a payment" nor "What to fix"; Reopen asks for confirmation.
