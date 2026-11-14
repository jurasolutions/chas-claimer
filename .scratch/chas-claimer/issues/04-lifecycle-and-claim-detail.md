# 04: Lifecycle, approval, audit trail and claim detail

**What to build:** an officer opens a claim and sees its lines, the bill split, findings, sibling claims, submissions and full history, and moves it through the lifecycle; a reviewer approves one claim or a batch; every change, reveal and approval is in the audit trail. Lifecycle per decisions-g2 §2 (accepted amounts, payments, short payment, portal refused, overpaid, acknowledge change, withdraw, write off, reopen with rebuild), 409 on stale versions, 30-day re-check on queue load, approve and submit, annotations (justification, pre-auth, MCAF references) that rebuild the claim, the audited reveal route.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Functional AC-3.1 to AC-3.7, S6 (checkout), S7, S8, S17.
- [ ] Property: no sequence of actions reaches a state outside the allowed transitions; paid cents never exceed accepted cents without the overpaid flag.
- [ ] Two concurrent approvals of the same claim: one succeeds, one gets 409, one audit event.
- [ ] Revealing an identifier writes the audit event before the value is returned.
- [ ] Claim detail at 360px puts findings first; at 1280px two columns.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- `act` lands the complete action set from decisions-g2 §2, including `record_payment{cents, paidOn, remittanceLineId?}` and the system actors `simulator` and `remittance`, so 07 and 08 only call it and never edit `server/services/claims.ts`.
- Approval stamps the payer's current channel on the claim (S15). The `submit` action refuses a portal reference already used by another claim of the same payer, and writes the `submissions` row for the attempt.
- Checkout (S6) is a service here: `checkout(claimId, actor)` and `takeOver(claimId, actor)` on the 30-minute `checkout_by`/`checkout_until` columns. Ticket 07's checklist calls them and owns AC-4.8's screen.
- After reject, reopen and annotation changes, call `rebuildVisits` (02) for the visit, so unsubmitted siblings get `upstream_rejected` or lose it.
- Claim detail renders `<RejectionExplainer>` on rejected claims and `<JustificationDraft>` in the annotations form, shows "Paid $X of $Y" with the "Accept short payment" action, and the queue and claim detail carry the "Submit" entry points that link to the AssistedSubmit route. Tickets 07, 08 and 09 then never edit `ClaimDetail.tsx` or `Queue.tsx`.
- This ticket edits 02's `Queue.tsx` and `functions/api/claims/index.ts` (batch approve, 30-day re-check). No other wave-1 ticket touches them.
- AC-3.7 is tested with a seeded two-payer claim fixture written through `upsertBuiltStatements`, not with D04b, because insurance claims arrive with 03 in the same wave. Ticket 10 checks D04b itself.

**Conductor addendum (after 01b, 2026-11-13).** `POST /api/claims/:id/reveal` answers `{ "value": string }`; the UI shell's `MaskedIdentifier` already expects that shape. Officers and reviewers may both reveal (S11); every reveal is audited before the value is returned.

**Conductor addendum (after 02, 2026-11-14).**
- A queue GET re-checks CHAS deadlines. Only claims whose deadline state has moved get rebuilt, with reason `deadline`, audited to the viewer, at most 50 per load (`server/services/deadlines.ts`). This is accepted for v1. Ticket 04 adds the remaining re-checks from decisions-g2 §5: on approve, and on recording a submission. Use the same service.
- Sec-2 from code-review-02: withdrawing an approved claim leaves its approval fields set. Clear them on withdraw, and test it, before `reopen` exists.
