# Code review 07: submission channels, assisted checklist, payer simulator

- **Branch:** `crew/chas-claimer-07-channels` (HEAD 2369e8e, a merge of `crew/chas-claimer`)
- **Point of comparison:** merge-base `3c30f77` (`git diff crew/chas-claimer...crew/chas-claimer-07-channels`). Commits: 620f474 packet, 415864e checklist hold, 6dcbf2f channels, 05095e6 simulator decisions, bfe7b54 checklist and send page, 1b5cd86 simulator page, bc837ba README. 27 files, +3554 / -13.
- **Spec:** `.scratch/chas-claimer/issues/07-channels-and-simulator.md`, `decisions-g2.md`, `reviews/technical.md` (§3, §4, §5, §6, S6, S15, F3, F9), `reviews/functional.md` (AC-4.1 to AC-4.8), `reviews/uat-script.md` §5, `reviews/test-strategy.md`, `docs/design.md`
- **Reviewer date:** 2026-11-14

## Verdict: changes-requested

There is one blocking finding (Spec 1 / Security 1): a claim can reach the payer and leave no record on the desk. `clear()` never re-checks the CHAS 30-day window before an api send. When `act` then refuses to record the payer's answer (because the window has passed, or the version is stale, the reference is taken, or the claim was checked out meanwhile), `sendGroup` writes no attempt and no audit event. Everything else is should fix or nit. None of those would hold this ticket back on its own.

## Evidence (run in a detached review worktree at 2369e8e)

- `npx vitest run`: 76 files, 962/962 passed
- `npx tsc --noEmit -p .`: exit 0
- `npm run build`: ok (JS 380.33 kB, CSS 27.12 kB)
- Blocked paths: the diff touches nothing under `src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `dist/`, `.env` or `.dev.vars`. No finding.
- Contract: `server/services/claims.ts`, `ClaimDetail.tsx` and `Queue.tsx` are not edited (ticket 07 "do not edit").
- **Repro of the blocking finding** (a scratch test in the review worktree, since deleted). D01 builds a CHAS claim: visit 2026-11-10, deadline 2026-12-10, approved 2026-11-13. The clock is set to deadline + 2 days, then `POST /api/submissions` is called.
  - Simulator channel: the result is `not_allowed`, but a `sim_inbox` row is left "received". The claim moves to `needs_attention` with 0 submission attempts, and the claim's audit is only `["built","approve","approval_cleared"]`. There is no send event.
  - api channel: the payer's endpoint is hit once, with the full-identity packet, yet there are 0 attempts and no audit event.
- URL guard probe (node): `https://2130706433/`, `0x7f000001`, `127.1` and `017700000001` all normalise to `127.0.0.1`, so `apiUrlProblem` (`src/domain/settings.ts:25-39`) catches them.

---

## Standards

Sources: `CLAUDE.md`, `docs/agents/crew.md`, `reviews/technical.md` §3 (layering) and §4 (ownership), `GLOSSARY.md`, `docs/adr/`, plus the Fowler smell baseline. A hard violation breaks a documented rule. Smells are judgement calls.

### Should fix

1. **Ownership: new route in block 04's folder.** `functions/api/claims/[id]/checkout.ts` and its test are new. Rule: technical.md §4, row 07 (line 539) grants only `functions/api/claims/[id]/packet.ts` under that folder. Ticket 04 (line 21) says 07 "owns AC-4.8's screen", so 07 needs a route there. Record it in row 07 (conductor or tech lead).
2. **Layering: a route calling two services.** `functions/api/claims/[id]/checkout.ts:21-23` calls `checkout`/`takeOver` and then `packetView`. Rule: technical.md §3 line 443, "route files call exactly one function". Wrap both in one service function in `server/services/submissions.ts`, for example `holdForChecklist(deps, id, actor, takeOver)`.
3. **Layering: SQL in a service, duplicating a query.** `server/services/submissions.ts:334-340` (`builtClinical`) runs `SELECT clinical_json FROM visit_revisions WHERE visit_key = ? AND revision = ?`. The same query is at `server/services/claims.ts:506`. Rule: technical.md §3 puts SQL in `server/repo/`. Move it into `server/repo/visits.ts` and call it from both places (the `claims.ts` side can follow later, since this ticket must not edit it).
4. **Ownership: files edited add-only outside row 07.** `src/domain/types.ts` (one `"exported"` union line), `src/ui/app.css` (+141) and `README.md` (its own section). All are add-only and reasonable. List them as shared files for 07 in technical §4, as code-review-06 asked for its own unlisted files.
5. **Reuse: `toHex` duplicated.** `server/repo/simulator.ts:~47` (`newReference`) writes its own hex encoding with `b.toString(16).padStart(2, "0")`. `toHex` in `server/bytes.ts:41` already does this.
6. **Reuse: the SHA-256 hex digest exists twice.** One is `sha256Hex` in `submissions.ts:329`; the other is built inline in `server/channels/api.ts:52`. Put one `sha256Hex` in `server/bytes.ts` and call it from both.
7. **One type, two names.** `SendError` (`server/channels/index.ts:33`) is restated as the first five members of `SendFailure` (`src/api/submissions.ts:73`). Define `SendError` once (in `src/api`) and import it on the server side. The channel's `reference` is also renamed to `portalReference` at `submissions.ts:197-198`, so one name should win.

### Nit

8. **Unneeded cast.** `server/channels/api.ts:26` has `env as unknown as Record<string, string | undefined>`. `Env` already has a `PAYER_${string}_API_TOKEN` index signature, so the cast hides type errors for no gain.
9. **Stream reader copied.** `readCapped` in `server/channels/api.ts:103-129` closely matches `readCapped` in `server/http.ts:151`. One reads a `Response` and the other a `Request`, so a shared `ReadableStream` helper would serve both.

### Smells (judgement calls)

10. **Primitive Obsession.** `server/repo/simulator.ts` types `packetMasked` as `unknown`, which forces `as ClaimPacket` and `packet.fields ?? []` at `submissions.ts:306,319`. Type it as `ClaimPacket` in the repo. Its `SELECT *` should also name its columns.
11. **Repeated Switches.** In `src/domain/packet.ts` the template-key aliases (`visit_date`/`service_date`/`date`, `claim_ref`/`claim_id`, `nric`/`patient_nric`) recur in `LABELS`, `IDENTITY_KEYS`, `clinicalValue` and `identityValue`. One table keyed by template key would replace all four.
12. **Duplicated Code.** `submissions.ts:81` and `:319` build the same field view (`{ key, label, text: cellText(f.value), masked, revealField }`). Extract one function. In the UI, `sendFailureWords` and `problemWords` in `AssistedSubmit.tsx` map error codes to words in the same shape.

---

## Spec

### Blocking

1. **A send can leave the desk with no attempt and no audit event.** Spec lines broken:
   - decisions-g2 §5: the CHAS window is "re-checked on approve, and on recording a submission".
   - technical F9 and test-strategy: one audit event per claim per export or send.
   - The README's own claim (`README.md:294`): "Each claim that is sent, exported or confirmed gets its own audit event."

   How it happens:
   - `clear()` (`server/services/submissions.ts:135-165`) repeats `act`'s checks before sending but skips the deadline gate (`withTodaysDeadline`, `server/services/claims.ts:267`).
   - `sendGroup` (`submissions.ts:192-203`) sends first and records afterwards. When `act` refuses (L197-198), it only pushes an error result. Nothing is written: no `recordFailedSubmission`, no audit event.
   - Past the window, a full-identity packet reaches the api payer unaudited, and the desk shows the claim as never sent while the payer holds it.
   - Any `act` failure after a successful send has the same effect (stale version, `reference_taken`, a checkout race). The UI already describes this case (`AssistedSubmit.tsx:605`, "The payer answered, but the claim changed on the desk meanwhile…"), as does the type comment at `src/api/submissions.ts:70-71`, but the server keeps no trace of it.
   - On the simulator channel, `receive` has already written the `sim_inbox` row, so it is left "received" against a claim now in `needs_attention`.

   Fix:
   - (a) Run the deadline gate in `clear` before any channel is called.
   - (b) When `act` refuses after the payer has answered, always write the attempt and an audit event that carries the payer's reference. A `recordFailedSubmission`-style "sent, not recorded" entry would do.
   - (c) For the simulator, receive only after `clear` passes.
   - Add a test for the past-window send and for a stale-version send after the payer has answered.

### Should fix

2. **"Open portal" link missing.** Ticket 07 line 3: "a checklist in the portal's order with copy buttons, an 'Open portal' link". `AssistedSubmit.tsx` has no such link, and `PayerSchema` (`src/domain/settings.ts`) has no portal address. The developer left it out on purpose. The conductor should decide between two options: add an optional https `portalUrl` to the payer settings and show the link only when it is set (my recommendation), or amend the ticket.
3. **Idempotency key does not change after a definitive outcome.**
   - technical S6: "The `api` channel sends an idempotency key per attempt".
   - `server/channels/api.ts:52` hashes `${claimId}:${revision}`, with `revision = claim.builtFromRevision` (`submissions.ts:163`). Reopen (`src/domain/lifecycle.ts` `reopen`, ~L180-194) clears approval and the reference but leaves `builtFromRevision` alone.
   - So reject, then reopen, then re-approve without a re-import sends the same key. A payer that honours idempotency would return its earlier rejection instead of taking the resubmission.
   - A key fixed per attempt would lose the retry-after-timeout safety the developer wanted. Make it stable across failed retries but new after each definitive outcome (for example, add the count of the claim's earlier submitted or rejected cycles), and add a test. Amend S6's wording to match.
4. **AC-4.2 "at most 12 fields" is not enforced.** functional.md AC-4.2 (L431). `src/domain/settings.ts:83` allows `templateFields` up to `.max(100)`, and the checklist does not cap the count. The defaults have 9 to 12 fields, so seeded data meets it. Cap it in the settings schema (block 06's file, so the conductor routes it) or reword AC-4.2 as guidance.
5. **Token absence not tested where the test strategy asks.** test-strategy: the payer token is "never in D1, audit or a response". The tests assert it is absent from the audit trail only. Add assertions over the D1 rows the send writes and over the response body.
6. **The simulator does not record who clicked.** The route (`functions/api/simulator/inbox/[id].ts:15`) ignores `actor`, so a decision's audit shows only `system:simulator`. Keep the simulator as the actor (AC-4.7) and put the person in the event detail, so the trail can tell who played the payer.

### Implemented, but the spec needs to catch up (conductor)

7. **AC-4.5 chosen over F9.** Functional AC-4.5 and UAT 5.16 keep exported claims `approved` until the officer confirms the upload, while technical F9 says "Exporting marks the batch's claims `submitted`". The developer followed the acceptance bar, which is right. Amend F9 or record an ADR.
8. **The channel contract differs from technical §5.** `server/channels/index.ts:43-61` has no `prepare` step and uses `channelFor(kind)` where §5 has `channelFor(payer)` (S15 makes the stamped channel the correct key). The checklist result carries claim IDs, not packets. Behaviour is equivalent, and the header comment explains why. Amend §5.
9. **`POST /api/submissions/confirm` and the checkout route are not in technical §6.** AC-4.5 and AC-4.8 need both. Add them to §6. The roles `["officer", "reviewer"]` match §6 and the role legend.

### Passed

- **S15:** the channel comes from the claim stamped at approval, not from the payer's current setting.
- **AC-4.1:** the packet carries only the template's fields, in template order (`src/domain/packet.ts`).
- **AC-4.3, AC-4.4:** recording a reference submits the claim; an empty reference is refused; "Portal refused" leads to rejected with a reason.
- **AC-4.6 / F3:** https only, no IP literal or localhost, the token named from the payer ID, `redirect: "manual"`, a 15 s timeout, a 64 KB answer cap, and one claim at a time.
- **AC-4.7:** the banner reads "Payer simulator. Nothing here reaches a real payer." (`src/ui/App.tsx:65`, tested), with no real payer's name or look. Packets stay masked.
- **AC-4.8:** a "Being submitted by" notice, with take-over confirmed in a dialog and audited.
- **The file channel:** text that starts like a formula is neutralised; amounts are two decimals from cents; there is one `exported` audit event per claim.

---

## Security

The bundled `security-review` skill could not run here: it diffs against `origin/HEAD`, and this repo has no remote. I applied its checklist by hand to the same diff, concentrating on auth, input handling, secrets, outbound requests, personal data and money.

### Blocking

1. **An identity disclosure goes unaudited** (same root cause as Spec 1). On the api channel the payer receives the patient's full identifiers, yet no audit event or attempt records it when `act` then refuses. CLAUDE.md treats identifiers as the most guarded data, and every reveal or export of identity is audited elsewhere in the desk. This send path is the one exception. Reproduced (see Evidence).

### Should fix

2. **The simulator can record payments on real claims.** The simulator is a channel a payer can be set to in settings. Once it is, any officer or reviewer can "pay" a claim (`simulatorDecide`, `submissions.ts:256-287`). That writes a `record_payment` through `act` with no money behind it. Nothing restricts the simulator channel to non-production environments, and no spec line says whether it should. Recommend either gating the simulator channel behind an environment flag (`SIMULATOR_ENABLED`, off in production) or recording a decision that admins may switch it on deliberately. This is a question for the conductor or the user.

### Nit

3. **The auth header name can override fixed headers.** `apiAuthHeader` (`settings.ts:86-89`, `^[A-Za-z][A-Za-z0-9-]{0,63}$`) accepts names such as `Content-Type` or `Idempotency-Key`. Because the token header is spread last (`api.ts:63`), the token would replace them. Only an admin can set it. Refuse those names in the schema.
4. **The URL guard checks names, not resolved addresses.** `apiUrlProblem` stops IP literals in every encoding tried, but not a DNS name that resolves to a private address (for example a wildcard DNS service). On Workers the risk is low, since fetch cannot reach the host network. Note it in the F3 comment.
5. **The CSV is held in a `data:` URL.** `AssistedSubmit.tsx:716` puts full identifiers into an `href` attribute that stays in the DOM until the page changes. A Blob with `URL.createObjectURL`, revoked after the click, keeps them out of the DOM.

### Checked and clean

- Every new route requires Access auth with `["officer", "reviewer"]`, and `POST /api/submissions` alone opens identity keys (`identity: true`).
- Bodies are strict zod objects with byte caps (1 KB or 16 KB). Batch items are capped and must be distinct, and amounts are positive integers.
- **Secrets:**
  - The token is read from `env` only at send time and goes only into the request header.
  - It is never logged and never stored, and it never appears in an answer or an error. The error words are fixed codes.
  - The packet route and the simulator inbox are masked, and identifiers are revealed only through the audited reveal route.
  - Rejection reasons are never echoed in errors.
- No SQL is built from input. Every query binds its parameters.
- No real patient data in tests or fixtures; NRICs use the synthetic T9 prefix.

---

## UI

Files: `src/ui/pages/AssistedSubmit.tsx`, `src/ui/pages/Simulator.tsx`, `src/ui/app.css` (crew `web-design-review`, Vercel Web Interface Guidelines).

### Note

- The guidelines ask for Title Case on headings and buttons. The design system sets sentence case, and the design system wins, so this is not a finding.

### Nits

1. `src/ui/pages/Simulator.tsx:194-205`: the Accept, Reject and Pay buttons repeat once per inbox item with no per-item accessible name, so a screen reader hears "Accept, Accept, Accept". Add the SIM reference as visually hidden text, as the Copy button does (`AssistedSubmit.tsx:356`).
2. `src/ui/pages/AssistedSubmit.tsx`: a typed portal reference is lost without warning on navigation. Add an unsaved-changes guard, or keep the draft per claim.
3. `src/ui/pages/AssistedSubmit.tsx:721`: `versions.get(id) ?? 0` sends version 0 when the version is unknown, which is always refused as stale. Leave the claim out and say so instead.

### Passes

- **Form fields:** labels are tied with `htmlFor`; the reference field has `autoComplete="off"` and `spellCheck={false}`, and its placeholder ends in "…".
- **Live regions and focus:** the copy confirmation and the selection count are announced with `aria-live`. Focus moves to the results heading after a send, with a `:focus-visible` outline.
- **Text:** literals carry `translate="no"`; loading text uses "…"; amounts use `tabular-nums`; headings use `text-wrap: balance`; `touch-action: manipulation` is set on `summary`.
- **Layout:** the bill split sits at the top of the checklist (`AssistedSubmit.tsx:126-130`), and the one primary action is "Record portal reference" (L291).
- **Identity:** masked identity uses `MaskedIdentifier` and the audited reveal route.
- **Confirmation:** take-over and reject are confirmed in a `Dialog` (L162-179).
- **Design system:** both pages take it only through `src/ds.ts`, and money goes through `formatSgd`, `parseDollars` and `MoneyCell`, so the UI computes no amount itself.

---

## Rulings on the developer's open items

- **ClaimHistory shows `system:simulator` as "The desk".** Show it as "Payer simulator". This is a small change in block 04's or 09's file, so the conductor routes it. AC-4.7 is already met in the data.
- **AC-4.5 over F9:** accepted, see Spec 7.
- **"Open portal" left out:** not accepted as is, see Spec 2.
- **Idempotency key fixed per visit revision:** partly accepted. Stability across retries is right, but the key must change after a definitive outcome (Spec 3).
- **`exported` added without a migration:** accepted. No migration constrains the `action` column.

### Other nits (no rule broken)

- `simulatorDecide` (`submissions.ts:272-284`) moves the claim with `act` before the inbox compare-and-set. If the CAS loses, the claim has moved and the inbox row still says "received". Do the inbox CAS first, or check it in the same batch.
- The assisted checklist opens for a past-window claim without saying so. Once Spec 1(a) is in, `clear` will refuse it. Until then the checklist should show the deadline.

## Summary per axis

- **Standards:** 12 findings (7 should fix, 2 nits, 3 smells). The worst is the new checkout route outside row 07, which also calls two services (Standards 1 and 2).
- **Spec:** 9 findings (1 blocking, 5 should fix, 3 spec catch-ups). The worst is the unaudited send past the deadline or after an `act` refusal (Spec 1).
- **Security:** 5 findings (1 blocking, 1 should fix, 3 nits). The worst is the full-identity api send with no audit event (Security 1).
- **UI:** 3 nits.
