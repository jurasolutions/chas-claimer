# Code review: QA 03 fixes (D01, D02)

- **Branch:** `crew/chas-claimer-qa03` at `ca3647d`, against merge-base `ce75b80`
- **Commits:** `1d737b6` takes every sent claim off the visit before the unsent ones (D01). `ca3647d` puts focus on each action's result once it settles (D02).
- **Diff:** 20 files, +548 / -59, in `docs/adr`, `server/services` (tests only), `src/domain` and `src/ui`.
- **Spec:** `reviews/qa-03.md` §6 (D01, D02), the conductor's QA 03 triage in `crew-log.md`, `docs/adr/0009-claim-identity-and-the-waterfall.md`, and `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`.
- **Date:** 2026-11-14

## Verdict: changes-requested

One finding is blocking (Spec B1). The over-claim QA found is fixed and proven: Meridian stays at $288, Flexi at $400, and every claim fits within the fee. But the safeguard the conductor's triage asked for, and that ADR 0009 now describes, doesn't work. The desk records a "blocking" finding that blocks nothing, and on a real visit nobody sees it. Everything else is a should fix or a nit.

## Evidence (run by the reviewer in the worktree)

| Command | Result |
|---|---|
| `npx vitest run --reporter=dot` | 102 files, 1489 tests passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 (1723 modules, built in 1.42s) |
| `npx vitest run src/domain/nric.test.ts` (SC7.6) | 10 passed. The diff adds no NRIC-shaped strings |
| Blocked paths | No changes under `src/design-system/` or `dist/`, and no `.env`, `.dev.vars` or wrangler.toml changes |
| Probe (scratch test, deleted afterwards; tree left clean) | See Spec B1 |

**Probe.** Import SC-D04b and submit all three claims: CHAS 62000, MEDISAVE_FLEXI 40000 and MERIDIAN 28800, at revision 1. Then reimport with every treatment fee halved, which gives revision 2 with a fee of 70800. Results:

- The import reports `flagged: 3`.
- The visit remarks hold `sent_claims_exceed_fee`, blocking, with `{sentCents: 130800, feeCents: 70800}`.
- `claimDetail` for each of the three claims returns `visit.findings: []`.
- None of the three claims has the code among its own findings.

The desk has stored a blocking finding that no page shows.

---

## Standards

No hard violations.

- `src/design-system/` is untouched.
- The diff has no secrets, identifiers or real data.
- New copy is sentence case and second person, with no buzzwords or exclamation marks.
- ADR 0009 was updated with the decision.
- GLOSSARY.md lists no finding codes for any other code either, so leaving the two new codes out is consistent.

**Should fix**

- **S1. ADR 0003 now under-lists the blocking findings.** `docs/adr/0003-local-limits-warn-never-block.md:3,5` names every blocking finding, and its amendment added `insurance_deadline_passed`. The new blocking `sent_claims_exceed_fee` (`src/domain/claims/findings.ts:237-238`) fits that ADR's rule, "certain from the desk's own records", but it isn't listed. Rule: `docs/agents/domain.md` says to flag ADR conflicts and keep the ADRs true. Fix: add a one-line amendment to 0003.
- **S2. `fixedDiffers` is computed in production but nothing reads it.**
  - It is computed at `src/domain/claims/build.ts:290-297`, typed at `:123`, and returned at `:185`, `:255` and `:360`.
  - The only readers are `src/domain/claims/build.test.ts:217-218`. Nothing in `server/` or `src/ui/` reads it.
  - The diff keeps paying for an extra in-order allocation pass to produce it.
  - Possible Speculative Generality (baseline smell, judgement call). This is the code half of Spec B1: wire it there or delete it.

**Nits (baseline smells, judgement calls)**

- **N1. Possible Duplicated Code.** The trio `useState(0)`, `setX(n => n + 1)` and `useFocusOnSettle(x)` appears four times:
  - `src/ui/components/ClaimAnnotations.tsx:60-61,94`
  - `src/ui/pages/Remittances.tsx:584-585,620`
  - `src/ui/pages/Settings.tsx:1140-1141,1191`
  - `src/ui/pages/Simulator.tsx:46-47,73`

  The wrapper `<div ref tabIndex={-1} className="settled-focus">` also appears three times: `ClaimActions.tsx:247`, `Remittances.tsx:658` and `Simulator.tsx:85`. A small `useSettleCounter()` and a generic `SettledFocus` wrapper (generalising `SettledFailureAlert`) would collect both.
- **N2. Some sites don't follow the hook's own contract.** `src/ui/focus.ts:10-11` says "Pass a counter … or `true`". Several call sites pass objects instead and rely on getting a new object each time:
  - `Queue.tsx:54`
  - `Remittances.tsx:429`
  - `Settings.tsx:509`
  - `ClaimActions.tsx:243`
  - `Simulator.tsx:45`, which builds `{ id }` only to get a fresh identity

  Update the doc comment or standardise on counters.
- **N3. Possible Mysterious Name.** In `src/ui/pages/Simulator.tsx:146`, the name and type `decided: object | null` hide that the value is only a focus token.
- **N4. Awkward reuse.** `src/ui/components/ClaimAnnotations.tsx:120` calls `set("justification")({ target: { value: text } })`, building a fake event just to reuse `set`, which now also clears `saved`.
- **N5. Primitive Obsession.** `src/domain/claims/build.ts:326` compares with a raw `0`; the rest of the file uses `cents(0)`.
- **N6. Possible Duplicated Code.** `fixedOf(plan)` (`build.ts:286`) does a linear `find` three times per plan across three loops. A map built once would do. Negligible at this size.
- **N7. Voice.** `src/domain/claims/findings.ts:234` is the first catalogue message to show "waterfall" to the officer. It is a glossary term, but check it against the plain-spoken rule (DS README §3, via the operating card's Voice section).

## Spec

**Blocking**

- **B1. The "blocking" safeguard has no effect, and `fixedDiffers` never surfaces.**
  - *Conductor triage, QA 03 (crew-log):* "Fix at the cause (fixed amounts come off the fee before any unsent plan, **fixedDiffers surfaces as a blocking finding**)".
  - *ADR 0009 (this diff), `docs/adr/0009-claim-identity-and-the-waterfall.md:3`:* "sent claims that add up to more than the visit's fee **raise a blocking `sent_claims_exceed_fee` on the visit**".

  Trace:
  - **Produced.** `src/domain/claims/build.ts:235` adds the finding to `visitFindings`, only when the sent claims add up to more than the fee (`:360`).
  - **Stored.** `server/services/rebuild.ts:184-190` stores it as a visit remark. It never reaches a claim.
  - **No effect on status.** A claim's status comes only from its own findings (`statusAfterBuild`, `build.ts:253`), so no claim moves to needs_attention.
  - **No effect on the queue.** `blockingCount` (`server/repo/claims.ts:326`) counts per-claim findings only, so the queue's count and "to fix" label never see it.
  - **No effect on the claim page.** `src/ui/pages/ClaimDetail.tsx:403` builds `blocked` from `claim.findings` only. Visit findings render under "About this visit", which is documented as "They don't stop this claim, so they carry no severity" (`ClaimDetail.tsx:60-64`).
  - **Usually not shown at all.** A sent claim built from an earlier revision gets `laterRemarks(...)`, which returns `findings: []` (`server/services/claims.ts:631-632, 650-651`). The realistic way to get over the fee is a clinical revision that lowers the fee, which leaves the sent claims on the earlier revision. When every claim on the visit is sent, as in the probe, no page shows the finding.
  - **`fixedDiffers` is a different condition and is still never read** (Standards S2). A single sent claim that the current rules would price differently raises nothing beyond the existing changed-after-submission flag.

  **Why this blocks.** An unmet line from the triage decision, on a money path, plus an ADR written in this diff that states behaviour the code doesn't have. The case it guards is real: the clinic has already claimed more than the visit's fee at the portals and needs to amend there.

  **Fix (developer's choice of one):**
  1. Attach `sent_claims_exceed_fee` to each sent claim of the visit, so it shows on the claim page and counts in `blockingCount` whatever revision the claim was built from. Wire or delete `fixedDiffers` in the same change.
  2. Have the conductor revise the triage decision, and reword ADR 0009 to say what the code does: a visit remark, with the sent claims flagged changed after submission.

  Option 1 is recommended. Either way, add a service-level test that reproduces the probe and asserts that the officer can see the finding.

**Should fix**

- (none beyond B1)

**Nits**

- **SN1. A flagged unsent claim is kept even at $0.** `src/domain/claims/build.ts:329-330`: `flagged` bypasses the drop rule, so a $0 claim with only the `lower_payer_sent_first` warning is kept and comes out `ready`. That is defensible as "the desk flags the conflict" (qa-03.md D01 Expected), but not asked for. Consider whether a ready $0 claim should be sendable.
- **SN2. A corner case gets no warning.** In `build.ts:325-327`, when `claimed < inTurn` but no lower-ranked payer has `taken > 0`, `below` is empty and no warning is added.
- **SN3. The property test covers less than the triage asked.** The triage asked for "a property test over every waterfall order and sent subset". In `src/domain/claims/build.property.test.ts`, the new property (300 runs) has three gaps:
  - The sent amounts always come from a default-order build, never from a different order.
  - Unsent claims aren't checked against their scheme caps.
  - `over` inflates only the first sent claim.

**Met**

- **D01.** "Meridian stays at $288, or the desk flags the conflict. Who pays shows Flexi at $400." Met.
  - `build.test.ts` (D01) and `server/services/rebuild.test.ts` (D04b) assert [62000, 40000, 28800] and the split `CHAS, MERIDIAN, MEDISAVE_FLEXI, patient`.
  - `takeFixed` takes each sent amount in full, so the claims never total more than the fee while the sent total fits within it.
  - The SP1 expectation change in `server/services/claims.test.ts` (to chas 62000, meridian 28800, flexi 40000, patient 0) is correct: the old test encoded the bug.
  - Approval clearing still follows `materiallyDiffers` (`rebuild.ts:77-84, 157`), as the conductor accepted.
  - No migration is needed, because `findings.code` has no CHECK constraint.
- **D02.** All seven sites (a to g) focus their settled result, and each has a test that asserts `document.activeElement`. The existing "leaves focus alone when the claim first loads" test still passes. I checked for focus stealing on reload or remount and found none:
  - Simulator `reload()` doesn't remount the items.
  - ClaimActions clears `failure` when a dialog opens and closes.
  - Settings `saving` is stable state.

## Security

No findings.

- The diff touches no auth, sessions, roles, SQL, request parsing, secrets or network calls. The server changes are tests only.
- The two new finding codes carry only `scheme`, `sentCents` and `feeCents`, with no NRIC/FIN, name, phone or address, so nothing new can reach Anthropic carrying an identifier.
- Test data is the synthetic fixtures (`SC-D04b`), and the diff adds no NRIC-shaped strings.
- The one `Link href` in the diff (`Remittances.tsx:670`) is existing code that moved under a new wrapper and still uses `encodeURIComponent`. The diff adds no `dangerouslySetInnerHTML`, storage access or `eval`.
- The `security-review` skill couldn't run here because it needs an `origin/HEAD` ref, so I ran its checklist by hand on the diff.

## UI (Vercel Web Interface Guidelines, changed files)

Files checked: `src/ui/components/ClaimActions.tsx`, `src/ui/components/ClaimAnnotations.tsx`, `src/ui/pages/Queue.tsx`, `src/ui/pages/Remittances.tsx`, `src/ui/pages/Settings.tsx`, `src/ui/pages/Simulator.tsx`.

- **Focus states:** pass. `.settled-focus` (`src/ui/app.css:406-412`) removes the outline only on `:focus` and draws a `:focus-visible` ring in `var(--border-focus)`, so there is a focus replacement.
- **Accessibility:** pass. Results keep `role="status"` or `role="alert"`, and focus targets are `tabIndex={-1}` non-interactive containers.
  - Nit: in `Remittances.tsx:658` and `Simulator.tsx:85`, focus lands on a generic wrapper `div`, not on the alert itself. Screen readers still read the alert's content, so this is acceptable.
- **Forms:** follow-up, out of scope. The Settings "Save settings" refusal paths (stale, forbidden, connection; `RefusalAlert` around `Settings.tsx:693`) don't take focus once the disabled button drops it. QA D02f covered only the saved and stopped outcomes.
- **Content and copy:** pass. The new "Saved. The checks ran again on what you entered." (`ClaimAnnotations.tsx:153-155`) is active and plain. The guideline's "Title Case for buttons" conflicts with the design system's sentence case; the DS wins (note, not a finding).
- **Typography, animation, images, performance, navigation, touch, layout, theming, i18n, hydration:** nothing in scope changed.
- Known and out of scope: the DS Dialog doesn't return focus on cancel. That is the developer's follow-up, filed against items 14 and 18.
