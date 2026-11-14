# Code review 04: lifecycle, approval, audit trail, reveal, claim detail

- **Branch:** `crew/chas-claimer-04-lifecycle` (HEAD adae54d, crew/chas-claimer merged in at 871e24f)
- **Point of comparison:** `git diff crew/chas-claimer...crew/chas-claimer-04-lifecycle` (merge-base), 31 commits 31d6972..adae54d, 36 files, +5089/−18
- **Spec:** `.scratch/chas-claimer/issues/04-lifecycle-and-claim-detail.md` (with the Conductor addenda), PRD `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`, `decisions-g2.md`, `reviews/functional.md`, `reviews/technical.md`, `GLOSSARY.md`
- **Reviewer date:** 2026-11-14

## Verdict: changes-requested

There is one blocking finding. The ticket requires a "Submit" entry point in the queue that links to the AssistedSubmit route, and `Queue.tsx` doesn't have one (Spec 1). That matters because tickets 07, 08 and 09 are not allowed to edit `Queue.tsx`, so this ticket is the only place it can be added. Everything else is should-fix or nit. The lifecycle, the concurrency guards, the audited reveal and the deadline re-checks are solid and well tested.

## Evidence (run in the worktree)

- `npm install`: 0 vulnerabilities
- `npx vitest run` (run twice): 64 files, 704 tests passed, exit 0. Stderr has React warnings from the `App.tsx` Frame, plus one expected log from the reveal fail-closed test: `{"code":"internal","claimId":"<uuid>"}`. That log carries no identifier.
- `npm run typecheck`: exit 0
- `npm run build`: exit 0 (JS 355.10 kB, CSS 24.76 kB)
- Blocked paths: the diff touches nothing under `src/design-system/`, `dist/`, `.env` or `.dev.vars`. No finding.
- Tests confirming the spec: concurrent approvals let one land, answer the other stale and audit one approval (`server/services/claims.test.ts:83`). A failed reveal audit returns nothing (`claims.test.ts:493`). The ordered trail runs import, approval, reveal, submission, acceptance, payment (`claims.test.ts:628`). The trail is append-only (`claims.test.ts:652`). There is a property test over action sequences (`src/domain/lifecycle.test.ts:348`).

---

## Standards

Sources: `CLAUDE.md`, `docs/agents/crew.md`, `GLOSSARY.md`, `docs/adr/`, `reviews/technical.md` §4 (file ownership), plus the Fowler smell baseline. Hard violations break a documented rule. Smells are judgement calls.

### Should fix

1. **Portal refusal copy contradicts the glossary.** `src/ui/components/ClaimActions.tsx:72` says "The claim goes back to ready so you can fix it and send it again." Two rules disagree with it. `GLOSSARY.md:145-146` says a portal refusal "counts as rejected", and `src/domain/lifecycle.ts:110-116` moves the claim to `rejected`, which needs a reopen. An officer who reads the dialog will look for the claim under Ready and won't find it. Suggested copy: "The claim is marked rejected. Reopen it to fix it and send it again."
2. **Limits drift from the shared source.** `src/api/claim-limits.ts` exists so that the client and the server agree on limits.
   - `server/services/claims.ts:197` `MAX_BATCH = 50` duplicates `MAX_BATCH_ITEMS` (`claim-limits.ts:11`).
   - `ANNOTATION_LIMITS` (`claims.ts:133`) hard-codes 2000/80/80 instead of using `MAX_ACTION_TEXT` and `MAX_PORTAL_REFERENCE`. Meanwhile the UI uses the constants (`ClaimAnnotations.tsx:108,119,129`).
   - The zod schema for annotations (`src/api/claim-actions.ts:94`) has no `.max()`. The service enforces the limit, but the contract doesn't say so.
3. **Reuse: `splitVisit` copies `build.ts`'s private `splitBill`.** `server/services/claims.ts:512` mirrors `src/domain/claims/build.ts:324`, and its own comment at `claims.ts:510` says so. Export one bill-split function from the domain and call it from both places, so the split the claim page shows can't drift from the one the build uses.
4. **File ownership (technical.md §4).** Block 04's row owns `lifecycle.ts`, `server/services/claims.ts`, `functions/api/claims/**`, `src/api/claim-detail.ts` and `ClaimDetail.tsx`, and may edit `Queue.tsx` and `functions/api/claims/index.ts`. The diff also edits files owned by other blocks: `server/services/rebuild.ts`, `server/services/deadlines.ts`, `server/repo/claims.ts`, `server/services/imports.test.ts` and `tests/helpers/arbitraries.ts`. It also adds files no row lists: `server/repo/submissions.ts` (block 07 builds next to it), `server/claim-http.ts`, `src/api/{claim-actions,claim-limits,common}.ts`, `src/ui/format.ts`, five components and 270 lines of `app.css`. Each edit is defensible. The tech lead should record them in §4 so that block 07 knows `server/repo/submissions.ts` already exists.

### Nit

- `src/ui/components/ClaimActions.tsx:18` and `ClaimHistory.tsx:83` label unapprove as "Withdraw approval" and "Approval withdrawn". **Withdraw** is a glossary term with a different meaning (`GLOSSARY.md:161`: the clinic decides not to submit). "Clear approval" would match the Approval entry.
- `server/services/claims.ts:275` has the typo "rebuilt:a claim".
- `plural` is defined three more times (`ClaimActions.tsx:34`, `ClaimHistory.tsx:23`, `BatchApprove.tsx:12`) on top of the existing one in `Overview.tsx`. Move it to `src/ui/format.ts`.
- `WITHDRAWN_CLEARS` (`server/services/rebuild.ts:50-58`) overlaps `UNAPPROVED` in `lifecycle.ts` and `CLEAR_APPROVAL` in `server/repo/claims.ts:396`.
- `server/claim-http.ts:19` echoes `portalReference` in the `reference_taken` body. That contradicts the file's own header comment ("never the request's own text"). It's harmless, since a portal reference isn't an identifier, but the comment and the code should agree.

### Smells (judgement calls)

- **Duplicated Code.** The stale/not-found tail after a guarded write repeats at `claims.ts:122-125`, `188-191`, `344-347` and `395-398`. The submission-draft literal appears at both `claims.ts:329-340` and `422-433`. `channel ?? "assisted"` appears at `claims.ts:316,416`. `status.replace(/_/g, " ")` appears in five places across `claims.ts` and `lifecycle.ts`. `reasonOf` (`BatchApprove.tsx:27-40`) overlaps `failureOf` (`ClaimActions.tsx:161-179`).
- **Repeated Switches / Shotgun Surgery.** The action kind is switched on in `applyAction`, `opensFrom`, ClaimActions `read`, `historyWords` and the LABEL/FORMS maps. The status guards have already diverged: `record_payment` uses inline statuses (`lifecycle.ts:141`), while `opensFrom` uses `SENT_STATUSES` (`lifecycle.ts:226`).
- **Mysterious Name.** `BatchOutcome` is defined twice with different shapes (`BatchApprove.tsx:18`, `claims.ts:205`). `same` is exported from `deadlines.ts`.
- **Feature Envy.** `ClaimAnnotations` imports `failureOf` from `ClaimActions`, and `ClaimSubmissions` imports `CHANNEL` and `who` from `ClaimHistory`. These are shared helpers living in sibling components.

---

## Spec

### Blocking

1. **The queue has no "Submit" entry point.** Ticket 04, line 23: "the queue and claim detail carry the 'Submit' entry points that link to the AssistedSubmit route. Tickets 07, 08 and 09 then never edit `ClaimDetail.tsx` or `Queue.tsx`." Claim detail carries one (`ClaimActions.tsx:37`, which links to `/submit?claim=<id>`). `src/ui/pages/Queue.tsx` has no submit link at all (`grep -i submit` finds nothing; the row links only to `/claims/<id>`, at L206). The desk-wide nav link (`src/ui/App.tsx:57`) is older than this ticket and isn't in `Queue.tsx`. Claim detail deep-links per claim, which shows that per-claim entry is the design, so block 07 would need a queue entry it isn't allowed to add. Fix: give approved rows (or the approved filter) a `Submit` link to `/submit?claim=<id>`, the same target ClaimActions uses, and add a Queue test for it.

### Should fix

2. **Submission doesn't refuse when the approved and built revisions differ.** Technical F5.2: "Store `built_from_revision` and `approved_revision`; submission refuses when they differ." `src/domain/lifecycle.ts:98-108` instead computes `submittedRevision = claim.approvedRevision ?? claim.builtFromRevision` (L103) and never compares the two. Today the writers maintain the invariant themselves. A non-material rebuild moves `approved_revision` to the new revision (`server/repo/claims.ts:412-417`), and a material change clears the approval (`CLEAR_APPROVAL`, `claims.ts:396`). So I could not build a failing case through the public paths. The guard the spec names is still missing, and no test covers it. Add `if (claim.approvedRevision !== claim.builtFromRevision) return notAllowed(...)` and a unit test for it.
3. **The duplicate portal reference check is not atomic.** Functional S6 says "A portal reference already used by another claim of the same payer is refused" (AC-4.3). `submissionAttempt` (`server/services/claims.ts:418`) calls `portalReferenceTaken` (`server/repo/submissions.ts:95-104`) as a read outside the write batch. The insert is guarded only by the claim's own nonce, and `submissions.portal_reference` has no index, unique or otherwise (`migrations/0001_init.sql:157`). So two claims to the same payer submitted at the same moment with the same reference both land. This is unlikely, because a person types each reference. Close it either with a guarded `INSERT ... SELECT ... WHERE NOT EXISTS` in `submissionStatement`, or with a unique index on a payer-scoped key, and add a test that interleaves two submits.
4. **The server's reason for refusing an input doesn't reach the person.** `failureOf` (`ClaimActions.tsx:175-176`) maps every `invalid` to "Check what you entered and try again." So the server's specific problem (for example, "Say why the payer accepted less than was claimed.") is dropped, and `reference_taken` has no case of its own. The ticket asks that refused actions say why (AC-3.x error copy, `decisions-g2` §2). Show the server's `problem` next to the field it names.
5. **S8: no one-click "Withdraw" from an unclaimable finding.** Functional S8 says "Permanently unclaimable claims (Green, expired, past window) offer 'Withdraw' as their one-click fix." Withdraw exists only as a general action in the claim's action panel (`ClaimActions.tsx:53`). The findings list on `ClaimDetail.tsx` offers no fix that opens it. S8 also requires a reason, so "one click" can reasonably mean opening the Withdraw dialog from the finding.

### Nit

- S7: functional S7 also offers "records that the claim was amended or cancelled in the portal". `decisions-g2` §2 folded S7 into `acknowledge_change{note}`, and the dialog copy (`ClaimActions.tsx:83`, "Say what you did about it.") covers that, so there is no finding. The hint could name amend and cancel explicitly.

### Scope creep (accept; record it)

- `recordFailedSubmission` (`server/services/claims.ts:300`) has no route or UI caller in this ticket. It cites AC-4.6, which is block 07's. Keep it, and tell block 07 that it exists.
- Unapprove is reviewer-only (`lifecycle.ts:264`). The spec names only approve as reviewer-only. That's a tighter rule than asked for, and it's low risk. Record it in decisions-g2 §10.

### Passed

The checks below all passed:

- AC-3.1–3.7: the full action set from decisions-g2 §2, including `record_payment` and system actors.
- A stale version answers 409 (`functions/api/claims/[id]/actions.test.ts:54`). Concurrent approvals give one 409 and one audit event.
- Officers can't approve, and the Approve button is hidden for them.
- Approval stamps the channel.
- Withdrawal clears the approval (Sec-2), including withdrawals made by a rebuild. A material change clears the approval (§13).
- The 30-day re-check runs on approve and on recording a submission, through `server/services/deadlines.ts` (`withTodaysDeadline`, `claims.ts:255-272`; tests at `claims.test.ts:262,288`).
- S6 checkout lasts 30 minutes, and take-over is supported (`claims.test.ts:436`).
- Batch approval takes up to 50 claims and names each one that failed (AC-3.4).
- S17 approve-with-warnings asks for confirmation, and the history reads "Approved with N warnings".
- After a reject, portal refusal, reopen or annotation save, the visit is rebuilt.
- Claim detail renders `RejectionExplainer`, `JustificationDraft`, "Paid $X of $Y" and "Accept short payment".
- Reveal answers `{value}` and is audited first.
- The annotations route is PUT.
- At 360px the findings come first. Two columns start at 1024px, so 1280px gets two columns.

---

## Security

The security-review skill could not run here: there is no `origin/HEAD` in the worktree. I applied its checklist by hand to the same diff (saved at `<scratchpad>/d04.diff` in the session scratchpad).

### Should fix

- The duplicate-reference race (Spec 3) is also an integrity issue: two claims end up recorded against one payer reference, which breaks remittance matching in block 08.

### Checked and clean

- **Auth.** Every new route goes through `route()` in `server/http.ts`. That gives role checks, JSON-only bodies with a size cap and a same-origin check on mutations, `no-store`, and logs that carry only the code and the claim id. Batch approval is reviewer-only. Reveal declares `identity: true`, refuses system actors (`claims.ts:466`), and writes the audit event with the field name and never the value before it returns anything (`claims.ts:477-478`, ADR 0006). A failed audit returns nothing.
- **SQL.** All values are bound. The only interpolation is the constant subquery `NEXT_ATTEMPT` (`server/repo/submissions.ts:~51`), which contains no input.
- **Input handling.** Zod validates action bodies: `paidOn` must be an ISO date, text is capped at 2000, references at 80, and a batch takes 1–50 claims. The service validates annotations.
- **Identifiers and secrets.** The diff contains no `console.*` and no `dangerouslySetInnerHTML`, `eval` or `innerHTML`. The only NRIC-shaped string is synthetic `T9000000J`. There are no secrets or keys. The external links are `https://www.chas.sg/...` source links, opened with `rel="noreferrer"`. Tests make no network calls. Submission packets are stored masked.
- **Money.** Amounts are integer cents, and short payment needs a reason. An overpayment is flagged and keeps the claim paid.

---

## UI

I reviewed `ClaimDetail.tsx`, `ClaimActions.tsx`, `ClaimAnnotations.tsx`, `ClaimHistory.tsx`, `ClaimSubmissions.tsx`, `BatchApprove.tsx`, `Queue.tsx` and `app.css` against the Vercel Web Interface Guidelines (vendored copy).

### Note

- The guidelines ask for Title Case on headings and buttons. The Jura design system mandates sentence case, and the design system wins. No finding.

### Nits

- `src/ui/components/ClaimActions.tsx:242,256,261` and `ClaimAnnotations.tsx:105,115,125` - inputs have no `name`. The date and textarea fields have no `autoComplete="off"`.
- `src/ui/components/ClaimAnnotations.tsx` - there is no guard on unsaved changes when someone navigates away from an edited annotations form.
- Combined with Spec 4: `ClaimActions.tsx:175` shows a generic error instead of the field-level problem, which breaks the guideline "error messages include fix/next step".

### Passes

- Every field has a label tied by `htmlFor`, and `aria-invalid` is set when a field is invalid.
- Loading states end with `…`.
- `role="status"` and `role="alert"` are used for async results and failures, and busy buttons set `aria-busy`.
- There is no `div` with `onClick`, no `autoFocus` and no `<img>`.
- New focus styles use `:focus-visible` (`app.css`, `.claim-row__select:focus-visible + span`). `prefers-reduced-motion` is honoured, and no transition uses `all`.
- Number columns use `tabular-nums`, and long text uses `overflow-wrap: anywhere`. The two-column grid children have `min-width: 0`.
- Dates are formatted with `Intl.DateTimeFormat` (`src/ui/format.ts`).
- The external source link has `rel="noreferrer"` and `translate="no"`.
- The copy is sentence case and second person, with no buzzwords, exclamation marks or emoji.

---

## Summary per axis

- **Standards:** 4 should fix, 5 nits, plus smells. The worst is the portal refusal copy contradicting the glossary (`ClaimActions.tsx:72`).
- **Spec:** 1 blocking, 4 should fix, 1 nit. The worst is the missing queue "Submit" entry point (`Queue.tsx`).
- **Security:** no blocking findings. 1 should fix (the duplicate-reference race).
- **UI:** 3 nits, no blocking findings.
