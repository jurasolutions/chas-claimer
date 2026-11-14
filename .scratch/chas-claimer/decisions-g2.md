# G2 decisions: how the three spec reviews are reconciled

*Conductor, 2026-11-13. Gate G2 delegated by Ting Yu. The PRD plus these decisions are the
signed-off spec. Where the three reviews disagree, this file wins; otherwise each review stands.*

Read in this order: PRD → this file → `reviews/technical.md` (layout, interfaces, schema, routes)
→ `reviews/functional.md` (rules and acceptance criteria) → `reviews/test-strategy.md`.

## Accepted wholesale

- **Technical review F1–F14** and ADRs 0006–0009 (filed in `docs/adr/`).
- **Functional review B1–B6, S1–S17, N1–N7**, with their recommended defaults.
- **Test strategy** exit criteria and levels.

## Reconciled points

1. **Synthetic identifiers: the `T9` block** (T9000000–T9999999 with a valid check letter;
   birth years 2090–2099, so none can have been issued). Date of birth is its own field, never
   derived from the identifier. `isSynthetic(n)` is `/^T9\d{6}[A-Z]$/` with a valid check
   letter. The import guard refuses anything else until `ALLOW_REAL_IDENTIFIERS=yes`.
2. **Lifecycle (merges technical §3 and functional B2, S6, S7, S8).** Statuses:
   `needs_attention`, `ready`, `approved`, `submitted`, `accepted`, `rejected`, `paid`,
   `withdrawn`, `written_off`. Actions: `approve`, `unapprove`, `submit{portalReference?}`,
   `portal_refused{message}` (approved → rejected, no reference), `accept{acceptedCents?, reason?}`
   (defaults to claimed; lower needs a reason; never higher), `reject{reason}`,
   `record_payment{cents, paidOn, remittanceLineId?}` (stays `accepted` until payments reach the
   accepted amount, then `paid`; a payment on a `submitted` claim is an implicit acceptance at
   the paid amount, audited "accepted by remittance"), `accept_short_payment{reason}` (accepted →
   paid, difference written off), `reopen` (rejected → rebuild → needs_attention | ready),
   `withdraw{reason}` (from needs_attention, ready, approved), `write_off{reason}` (from
   rejected), `acknowledge_change{note}` (clears changed-after-submission). Overpayment leaves
   `paid` with an "overpaid" flag. Every resubmission is a new row in `submissions`.
   Add `accepted_cents` and `overpaid` handling to the claims table and `checkout_by`,
   `checkout_until` (S6, 30 minutes) — block 01 owns the schema, so these go into
   `0001_init.sql` from the start.
3. **Multi-visit procedures (functional B1).** A treatment carries `completion`
   (`complete` | `in_progress`) and `completedOn`. In-progress multi-visit lines (crown,
   denture, root canal) are **held** off the claim with a visit note; they never block the
   visit's other lines. The completed procedure is claimed on the completion visit's claim,
   dated `completedOn`; window, card validity, tier and same-day rule use that date.
4. **Waterfall when a payer above is blocked (functional B5).** Permanently unclaimable upper
   claim (Green, expired card, past window, no rule set) contributes $0 and lower claims go.
   Fixable upper claim: lower claims get the blocking finding `waiting_on_upper_payer`. This is
   in addition to technical F5 (submitted upper claims are fixed inputs; an upper rejection gives
   siblings the warning `upstream_rejected`).
5. **The 30-day window (functional B6, technical F10).** SGT calendar dates; in time while
   `today ≤ claimDate + 30`; warning "Last N days to submit" from day 25; re-checked when the
   queue loads (a cheap recompute of the deadline finding), on approve, and on recording a
   submission. CHAS only; MediSave and insurance deadlines are per-payer settings, blank by
   default.
6. **Two MediSave payers (technical F6).** `MEDISAVE_FLEXI` and `MEDISAVE_TOSP`. Flexi-MediSave
   dental rule set ships with effective date 2026-07-01 marked "start date unconfirmed"
   (functional S3). MediSave account holder and MCAF type/validity per functional S2; spouse
   accounts are a seeded optional case.
7. **Multi-TOSP amount:** cap at the highest table limit among the codes, block more than 3
   procedures, warn on more than one code (technical F6).
8. **Insurance amount:** what's left after the payers above, less a co-pay percentage if the
   policy has one; a warning (not a block) when this clinic's claims on the policy this year
   would exceed its annual limit. Payer settings carry panel yes/no, pre-auth-required benefit
   codes, deadline days (blank = no check) and template fields (functional S10).
9. **Benchmarks** compare the GST-inclusive fee; a blank benchmark runs no check and shows
   "Benchmark not set" (functional S4). Ship the consultation ($21–$31) and permanent crown
   ($750–$1,400) ranges with their source; the other 16 are `null`.
10. **Roles (functional S11).** Environment variables are the source of truth; settings shows them
    read-only. Officers cannot approve; both roles may reveal (audited).
11. **Fictional payers (functional N4).** The synthetic clinic uses made-up insurer and TPA names
    ("Meridian Dental Plan", "Harbour TPA") and made-up benefit codes. Real insurer code sets
    never ship.
12. **Demo anchor.** The generator takes `asOf` (technical F13; functional's `--today`): one
    concept, named `asOf` in code and `--as-of` on the CLI.
13. **Approval cleared on change (functional B3 = technical F5.2).** Any change to an unsubmitted
    claim's lines, amounts or blocking findings clears approval, audited.
14. **Out of scope, added to the PRD at G2:** amending or cancelling a submitted claim in a
    payer's portal (a person does it; the desk records it), clawbacks and payer recoveries
    (matched by hand), deposits at a prep visit, MediShield Life.
15. **Connector auth (technical Q1):** one Access application covers the custom domain,
    `pages.dev` and previews; the connector sends an Access service token plus the bearer
    `CONNECTOR_TOKEN`. Documented in the README; Ting Yu sets it up.
