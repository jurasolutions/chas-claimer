# Code review: ticket 01b (UI shell)

- Branch: `crew/chas-claimer-01b-ui-shell` (HEAD 851af37), 11 commits, 34 files
- Compared against: aa80259 (ticket 01 head, the brief's fixed point), `git diff aa80259...crew/chas-claimer-01b-ui-shell`. The 01-fix commits on `crew/chas-claimer` are not part of this review.
- Spec: `.scratch/chas-claimer/issues/01b-ui-shell.md`, `decisions-g2.md` (wins on conflict), `reviews/technical.md` §3–§4, `docs/design.md`
- Reviewer: crew reviewer, 2026-11-13

## Verdict: approve

There are no blocking findings, and the verdict rests on that alone. Three should-fix items are worth doing before ticket 02 builds on the shell:

- R-1: a malformed URL blanks the whole desk.
- Sp-1: the reveal-refused copy contradicts G2 #10.
- Sp-2: DeadlineText re-implements a rule the server owns.

R-1 matters most because App.tsx says later tickets "never change this file or the router".

## Evidence (run by the reviewer in the worktree)

| Check | Result |
|---|---|
| `npm test` (vitest) | 24 files, 201 tests passed |
| `npm run typecheck` | clean |
| `npm run build` | exit 0 (1596 modules; JS 179.04 kB, CSS 11.91 kB) |
| Blocked paths (`src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars`, `dist/`) | none touched |
| Contract: no server, migration, `package.json` or README change; no new domain types | holds (`lucide` was already a dependency at aa80259) |
| Design-system boundary | DS components are imported only in `src/ds.ts`; `lucide` only in `src/lib/icons.ts`. `src/main.tsx:3` imports `styles.css` directly, but that line predates this diff |
| Tokens | every `var(--…)` in `src/ui/app.css` resolves to a DS token |
| NRIC-shaped literals | only `T9000000J` and the mask `T****000J` (T9 test prefix) |
| Network in tests | `tests/setup.ts` makes `fetch` throw; the tests stub exact URLs; `ai/index.test.tsx:20` asserts that the AI slots never fetch |
| Risky sinks | no `dangerouslySetInnerHTML`, `console.*`, `localStorage` or `sessionStorage` anywhere in `src/ui`, `src/lib`, `src/ds.ts` or `src/main.tsx` |

## Acceptance boxes

| # | Box | Result |
|---|---|---|
| 1 | Tests, typecheck and build pass | pass (above) |
| 2 | Every route's placeholder renders; rail at 1280px, top bar at 360px | pass (`App.test.tsx:44-93`, every route plus not-found) |
| 3 | BillSplit renders in waterfall order with a sentence, patient last | pass, see the note under Spec nits |
| 4 | MoneyCell and DeadlineText format only the values they are given | partial: MoneyCell passes; DeadlineText fails (Sp-2) |
| 5 | MaskedIdentifier stays masked until Show, then calls reveal once | pass (`MaskedIdentifier.test.tsx:10-48`); double-click is untested (Sp-n2) |
| 6 | `GET /api/me` 403 gives "You don't have access to the claims desk" on every route | pass (`App.test.tsx:114`, every route) |
| 7 | AI slot stubs render nothing and match the final props | pass (props match technical §3 exactly) |

## Robustness (found by the reviewer, reproduced)

### Should fix

**R-1. A malformed escape in a path parameter throws during render and blanks the desk.** `src/ui/router.ts:62` calls `decodeURIComponent(value)` with no guard. `matchPath` runs inside `resolve()` during `Frame`'s render (`src/ui/App.tsx:69`), and nothing in `src/` is an error boundary. So `/claims/%E0` or `/claims/%` unmounts the root and leaves a white page, when it should show "We can't find that page". Reproduced:

```
/claims/%E0 -> /claims/%E0 -> THROWS URIError URI malformed
/claims/%   -> /claims/%   -> THROWS URIError URI malformed
```

Breaks: docs/design.md Principles ("say plainly what to do") and the not-found page this ticket adds (`App.tsx:246`). Fix: catch the `URIError` in `matchPath` and return `null`, which falls through to NotFound. Add a router test for it.

## Standards

From the Standards sub-agent, lightly cleaned. I removed one item (the `main.tsx` styles import, which predates this diff). I verified each remaining item against the code.

### Blocking

None.

### Should fix

**St-1. `src/ui/app.css:2-3` says "Tokens only: no raw colours, sizes or fonts here", but the file has raw sizes.**

- `:63` `15rem`
- `:258` `height: 6px`, which is design.md's value but has no token
- `:273-274` hatch `3px`/`4px`
- `:278` `opacity: 0.35`
- `:318` `border-left: 3px`
- `z-index: 10` at `:40` and `5` at `:114`

Rule: the file's own header and docs/design.md Tokens. Fix: either tokenise these values, or reword the header to list the allowed exceptions so ticket 02 doesn't copy the contradiction.

### Nits

- **St-n1.** `app.css:360-368` adds a universal reduced-motion override with `!important`. It duplicates `src/design-system/tokens/motion.css:23-28`, which already sets every `--dur-*` to 1ms. Every transition in this diff uses those tokens. (Reuse: the DS already does this.)
- **St-n2.** `app.css:97` and `:127` use `--font-display` for the rail name and the top-bar section. docs/design.md:50 keeps Outfit for page titles and the claim header amount.
- **St-n3.** `src/ui/components/StatusBadge.tsx:6-13` uses tone `brand` for approved and `neutral` for ready, withdrawn and written off. docs/design.md:44 lists only warning, danger, success and info. Either record the extra tones in design.md or map them to the listed tones.
- **St-n4.** `app.css:184` and `:252` use the palette token `--neutral-100` where a semantic surface token would fit the rest of the file.
- **St-n5** (possible Speculative Generality).
  - `src/ds.ts` re-exports Dialog, Toast, Tooltip, Accordion, Tabs, Select, Alert, Tag, Field and Input, none of which 01b uses.
  - `src/lib/icons.ts` registers icons nothing uses yet. Its comment says "only the icons the desk uses".
  - This is acceptable as a shared import point for 02 to 08, but the icons comment should match what the file does.
- **St-n6** (possible Duplicated Code). `BillSplit.tsx:47` and `:54` repeat `size === "row" && highlightClaimId !== undefined`. `api.ts:47` calls `codeOf` again after `:37` already did.
- **St-n7** (possible Primitive Obsession). `BillSplit.tsx:24` `payer.startsWith("MEDISAVE")` stands in for a payer kind.
- **St-n8** (possible Repeated Switches). The nested ternaries at `DeadlineText.tsx:20-29` and `App.tsx:259-280` would read better as lookup tables.

## Spec

From the Spec sub-agent, lightly cleaned. I re-ranked two items after checking the spec lines myself, and noted where.

### Blocking

None.

### Should fix

**Sp-1. `src/ui/components/MaskedIdentifier.tsx:22` shows "Only an officer can reveal this." on a 403.**

- This contradicts decisions-g2 #10 ("both roles may reveal (audited)") and the conductor's answer that "O" means officer or reviewer.
- On this route, a 403 means the email is on neither list, so the message should not name a role. Suggested wording: "You don't have access to reveal this."
- `MaskedIdentifier.test.tsx:57` asserts the wrong sentence, so the test needs the same change.

**Sp-2. `src/ui/components/DeadlineText.tsx:6,18-19,30` computes the days left from the browser clock and applies its own warning threshold (`SOON_DAYS = 5`).**

- Box 4 says DeadlineText "only format[s] values they are given".
- decisions-g2 #5 makes the deadline warning a server-side finding: from day 25, re-checked on queue load, approve and submission. It also says MediSave and insurer windows are per-payer settings, so one fixed number is wrong for them.
- The 5 matches CHAS's day 25 today, but the UI would drift if the setting changed. A skewed device clock could also show a different state from the server's finding.
- Fix: take `today` and the tone (or the deadline finding) from the server. If the browser default stays, record it as a decision in crew-log.
- Spec agent correction: its report cited design.md for "due in 7 days". design.md:65 and :70 say "due in 5 days" and "due in 4 days", and the words at `:21-29` match design.md:91.

### Nits

- **Sp-n1** (the spec agent ranked this should-fix; I re-ranked it). The waterfall order relies on the server. `BillSplit.tsx:41` only moves the patient last and keeps the server's order for the rest. That is correct: technical.md:327 makes the waterfall order a `DeskSettings` value, and :335 sends `split` "patient last", so a hard-coded CHAS, MediSave, insurer sort in the UI would be wrong. Two small fixes:
  - The comment at `:20` ("CHAS, then MediSave, then any insurer, then the patient") sits on `fillOf`, which only picks colours, and reads as if the component sorts. Reword it.
  - `BillSplit.test.tsx:16` already passes the patient first, which proves the patient-last move. Optionally add a test showing that the non-patient order is kept as sent.
- **Sp-n2.** Box 5 says "calls the reveal route once", but no test double-clicks. `MaskedIdentifier.tsx:56` disables Show while loading, which guards against it.
- **Sp-n3** (scope, accept). `src/ui/api.ts:54-55` adds `put` and `delete`, but technical §3 lists only `get` and `post`. This was recorded as a developer decision.
- **Sp-n4** (scope, accept). `App.tsx:266-280` adds a 401 page and an "other errors" page with retry, but only the 403 page is specified. These are sensible and were recorded.
- **Sp-n5** (scope, flag to 02 and 03). `src/ui/me.ts`, `src/ui/format.ts` and `src/ui/components/PageHeader.tsx` are outside 01b's owned files in technical §4. Later tickets should know they exist.
- **Sp-n6** (scope, accept). `src/ui/pages/Overview.tsx:15` puts an "Import visits" button on a placeholder. `src/ui/router.ts` is 66 lines against the ~40 in technical §3, and it adds query-string support for Today's links. The "no dependency" requirement holds.

## Security

The `security-review` skill failed to load ("fatal: ambiguous argument 'origin/HEAD...': unknown revision", because the repo has no `origin/HEAD`), so I did this pass by hand on the same diff. I focused on identifier handling, auth, input handling and secrets.

### Blocking

None.

### Should fix

None.

### Nits

- **Sec-n1.** `src/ui/api.ts:15,37` keeps the whole error body on `ApiError.body`. Nothing logs it today. If a later ticket logs or reports `ApiError`, it should log `status` and `code` only, because a problem body from a claim route could carry patient fields (CLAUDE.md "No AI on identifiers"; the public-repo rule).

### Checked and clean

- **Reveal:** the value is held only in component state (`MaskedIdentifier.tsx:39`). Hide drops it (`:52`) and nothing caches it. The live region announces "Shown and recorded…", not the value (`:61`). The value renders with `translate="no"` (`:48`), which keeps it away from browser translation services. The POST goes to an `encodeURIComponent`'d claim id (`:38`).
- **Requests:** all are same-origin with `credentials: "same-origin"` (`api.ts:26`). Every body carries `Content-Type: application/json` (`:29`), which the server needs to pass its `json_required` CSRF check. Unknown error codes collapse to `internal` (`:43`).
- **Navigation:** `navigate` only pushes hrefs from the desk's own links, and `followLink` leaves modified clicks and `target` links to the browser (`router.ts:39-40`). There is no open redirect.
- **Sinks and secrets:** no HTML injection sinks. No secrets, keys or connection strings.
- **AI slots:** they render `null` and send nothing (`ai/index.test.tsx:20`).
- **Access gating:** the desk renders nothing but CannotOpen until `/api/me` succeeds (`App.tsx:113-120`). Real authorisation stays on the server.

## UI

`crew:web-design-review` (Vercel Web Interface Guidelines, vendored copy) ran on `src/ui/App.tsx`, `src/ui/app.css`, the seven components, the eight pages and `src/ui/ai/index.tsx`. The design system wins where the two disagree.

### Notes (the guideline conflicts with the design system, so these are not findings)

- The guideline asks for Title Case headings and buttons. The DS and CLAUDE.md require sentence case, and the code follows sentence case.

### Findings

```text
## src/ui/App.tsx

src/ui/App.tsx:69 - render throws on a malformed path escape; there is no error boundary (R-1)
src/ui/App.tsx:201 - staff email in the rail: add translate="no" (an identifier)
src/ui/App.tsx:241 - menu does not close on an outside click or on focus leaving it; Escape and following a link do close it (ok)

## src/ui/app.css

src/ui/app.css:71-73 - outline: none on main: acceptable, because main is only focused programmatically (tabIndex -1) and is not interactive; the global :focus-visible ring (DS base.css:32) covers every control
src/ui/app.css:360-368 - reduced-motion override duplicates the DS tokens (St-n1)

## src/ui/components/DeadlineText.tsx

src/ui/components/DeadlineText.tsx:33 - the absolute date is only in title= (hover only); touch and screen-reader users never get it. Consider visually hidden text or an aria-describedby

## src/ui/components/BillSplit.tsx

src/ui/components/BillSplit.tsx:45,61 - in the detail size, a screen reader hears the split twice (the img sentence and then the legend). Consider aria-hidden on the legend, or dropping role=img when the legend is shown

## src/ui/components/MaskedIdentifier.tsx

src/ui/components/MaskedIdentifier.tsx:56 - disabling the focused Show button while loading can drop keyboard focus in some browsers; prefer aria-disabled plus an ignored click

## src/ui/components/{FindingList,MoneyCell,PageHeader,StatusBadge}.tsx

✓ pass (icons are aria-hidden in the DS Icon, severity is in words, tabular-nums on money, a single h1)

## src/ui/pages/*.tsx, src/ui/ai/index.tsx

✓ pass (Overview's Button href is a real anchor with followLink)
```

All UI findings are nits except R-1, which is ranked above.

## Summary

- **Robustness:** 1 finding, should fix: R-1, a malformed URL blanks the desk.
- **Standards:** 1 should fix and 8 nits. The worst is St-1, the app.css "tokens only" header that contradicts the code.
- **Spec:** 2 should fix and 6 nits. The worst is Sp-2, DeadlineText owning a server rule against box 4.
- **Security:** 0 blocking, 0 should fix, 1 nit.
- **UI:** nits only.
- **Blocking:** none. **Verdict: approve.**
