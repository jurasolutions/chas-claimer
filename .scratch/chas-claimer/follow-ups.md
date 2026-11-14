# Follow-ups after the first version

Items accepted for v1 with a known limit. Each names where it came from.

1. **A rebuild withdraws an unsent claim that is no longer built** (ticket 03, round 2). If a code-map change
   later makes the visit claimable for that payer again, the withdrawn claim is not revived, because a
   re-import never resurrects a withdrawn claim (functional S8). The officer sees the visit note and can
   reopen by hand once reopening a withdrawn claim exists. Follow-up: tell an automatic withdrawal from an
   officer's withdrawal, and let a rebuild revive only the automatic kind.
2. **One claim per visit and payer for mixed prep visits** (ticket 03, round 2). A visit that holds an
   unfinished crown and also completes another procedure for the same payer carries one claim; the crown is
   claimed later on its completion visit. This follows ADR 0009 and needs no change unless a payer wants
   prep and fit claimed together.
3. **The queue GET writes** (ticket 02). Loading the queue rebuilds up to 50 claims whose deadline state
   moved, audited with reason `deadline`. A scheduled job would be cleaner once Pages cron is set up.
4. **Claim history doesn't show why an identifier was revealed** (ticket 09 review). `ClaimHistory.tsx` lists
   reveals without their purpose (for example "AI justification").
5. **`shippedMapping()` fails under jsdom** (ticket 09 review). Tests only; the helper reads a file the browser
   test environment can't reach.
6. **The design system's Field has no `aria-describedby` and takes a text-only hint** (ticket 09 review). Needs a
   change in `jurasolutions/design-system` itself, then `npm run sync:ds`. For Ting Yu: approve that change at source.
7. **Undo a hand match** (ticket 08 review; UAT 7.4 amended). A wrong hand match records a payment, and the
   lifecycle has no "reverse payment" action yet. The desk asks for confirmation before a hand match; undo needs a
   reversing lifecycle action and its audit event.
8. **Statements over 50 lines are refused** (ticket 08 review). A paid line costs about 13 D1 statements, so the desk
   caps a file at 50 lines and asks the officer to split it. A real CHAS remittance can be longer. Follow-up: the
   page uploads a large file in pages of 50 lines under one file hash, so the officer never splits by hand.
9. **A line can stay held if the worker dies between the hold and the payment** (ticket 08 review). A thrown error
   releases the hold; only a hard crash or timeout leaves it. Follow-up: a hold older than a few minutes with no
   payment is released on the next import or page load, audited.
10. **Settings has no field for a payer's portal address** (ticket 07). `portalUrl` is in the settings document and
    the README says how to set it; the settings screen doesn't show it yet.
11. **A stored settings document with more than 12 template fields fails to read** (ticket 07). The cap applies on
    save, so this only happens if the document is edited outside the desk. Follow-up: trim with a warning on read.
12. **Every synthetic payer defaults to the simulator channel** (ticket 07). On a deployed desk with the simulator
    off, submission is refused until a reviewer sets each real payer's channel. This fails closed on purpose.
13. **Node 20 is past end of life** (infra review). wrangler 4.86.0 is the last release that runs on it. Move
    `.nvmrc`, CI and the wrangler pin to Node 22 together, and run the suite on 22 first.
14. **The design system's Dialog doesn't manage focus** (QA 01 D06). The app wraps it in `src/ds.ts`; the fix belongs
    upstream in `jurasolutions/design-system`, then `npm run sync:ds` and drop the wrapper. For Ting Yu.
15. **UAT 5.10's api leg and 7.5 need staging** (QA 01 D14): a payer token and a test endpoint.
16. **QA 01 D17 notes not taken into 12a/12b:** a hand match doesn't say "by hand" in the trail; reloading the checklist
    loses a typed reference; the Fee column doesn't say it's before GST.
17. **Notes on a visit with no claims have nowhere to show** (QA 01 D24, ticket 12a). Add a visit view, reached from the
    claim page and the import report.
18. **Design system Button has no default `type`** (QA 01 D10). Inside a form it submits. The app sets `type="button"`
    where it matters; the default belongs at source. Same upstream note as 14 and the Field hint (`AssistedSubmit`'s
    local `FieldNote`); `src/dialog.tsx` goes when the Dialog fix lands.
19. **Small reuse and depth items from code-review-12** (ST-5, ST-7): refs assigned during render in `src/dialog.tsx`;
    `claimDetail` keeps growing; the "settled" rule lives in the UI, not `src/domain`; `connector/problems.ts` mirrors
    the schema by hand. A deepening pass, not a defect.
20. **A third party's name in the visit notes reaches Anthropic** (ADR 0004 known limit). The scrubber removes the
    patient's identifiers and dates of birth, not every name a clinician types. Before real identifiers are allowed,
    decide whether to add a name list from the CMS or keep free-text notes out of the AI call.
21. **UAT 5.8 / SC3.7, the timed CHAS checklist, was waived at G4** (test strategy exit criterion 9). It has to be a
    person keying five checklists into a stand-in form, median under 60 seconds each. Ting Yu or the clinic runs it
    before the desk replaces the current way of claiming.
22. **Revive a claim withdrawn by a settings change** (follow-up 1, seen live in QA 02). v1 warns on the settings page; the desk
    still has no way to bring the claim back. Build this before the clinic changes its waterfall or code map in production.
23. **Focus after a dialog is cancelled** falls to the page body: the design system's Dialog doesn't return it. Same upstream
    note as 14 and 18. Busy buttons could use `aria-disabled` so focus isn't dropped while an action runs.
24. **Who pays on a claim held by `sent_claims_exceed_fee` understates a sent claim** (QA 04 D03, Minor). The claim is
    already blocked and its finding explains why, but the bar fits the sent claims into the fee and shows a sent Flexi
    claim below what it claimed. Show sent claims at their claimed amounts there, with the held claim at nothing. The red
    test is written out in `reviews/qa-04.md` section 6.
25. **A second reviewer pass over the last three fix rounds** (quality gate W2): `0c3a3e6..3bf2f4e` was checked by tests, the
    conductor and QA 04, not by a fresh reviewer. Review it at the start of the next release. Run `crew:security-review`
    there too once the repo has a remote HEAD (W3).
