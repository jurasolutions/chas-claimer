# Code review 09: AI suggestions

- **Branch:** `crew/chas-claimer-09-ai` (HEAD dd42f8f)
- **Point of comparison:** merge-base `d32de7f` (`git diff crew/chas-claimer...crew/chas-claimer-09-ai`), 10 commits 0c3405a..dd42f8f
- **Spec:** `.scratch/chas-claimer/issues/09-ai.md`, `reviews/functional.md` AC-6.1 to AC-6.5 and S9, `reviews/technical.md` F8 and §6 routes, ADR 0004, ADR 0006 amendment
- **Reviewer date:** 2026-11-14
- **Method:** I did the Standards, Spec and Security axes and the UI pass inline, not through the code-review, security-review and web-design-review skills (budget). I read every changed file in a detached review worktree.

## Verdict: approve with fixes

There are no blocking findings. The de-identification gate fails closed. Every AI route checks the key, the role and the daily cap before it calls the model. Opening the notes or the identity is audited before the model is called, and a failed audit write means no call is made. Every AC has a test, including a fast-check property and the D18/D18b assertions on the captured request body. Two should-fix items can land in 09 (Security 1, Spec 1). The rest can be deferred.

## Evidence (run in the worktree)

- `npx vitest run`: 76 files, 1023 tests passed. Stderr has act() warnings in `src/ui/App.test.tsx` and `{"code":"internal"}` lines from the audit-failure tests. Both are expected.
- `npx tsc --noEmit -p .`: exit 0
- `npm run build`: built in 1.41s (JS 364.98 kB, CSS 25.48 kB). The only warnings are Rollup notes about zod comments.
- **Blocked paths:** the diff touches only `README.md`, `functions/api/ai/**`, `server/ai/**`, `src/api/ai.ts`, `src/api/common.ts`, `src/ui/ai/**` and `tests/helpers/ai.ts`. Nothing is under `src/design-system/`, `dist/`, `.env`, `.dev.vars` or `jurasolutions/inputs/`. No finding.
- **Gate probe:** I bundled `server/ai/deidentify.ts` with esbuild and ran it on a synthetic T9 identity with ISO date of birth 1960-03-04. `"Patient born 04/03/1960"` and `"Born 4 March 1960"` came back `ok` and unchanged. `"Call a real-format mobile number"` was redacted. See Security 1.
- **Wiring checked:** `src/ui/pages/Settings.tsx:1115` submits `origin: "ai_accepted"` and `:1149` puts it in the `PUT /api/code-map` body. `JustificationDraft` is rendered at `src/ui/components/ClaimAnnotations.tsx:115` and fills the form only, with no save. `RejectionExplainer` is at `ClaimDetail.tsx:91`. `MappingProposal` is at `Settings.tsx:596` and is shown to reviewers only.
- **Ported settings:** `effort: "low"` in `server/ai/run.ts:60` matches the landing-page usage, for example `landing-page/server/tax-estimator.js:148`. The model is `claude-haiku-5-5`, `maxRetries` is 0 and `logLevel` is `"off"`.

---

## Standards

Sources: `docs/agents/crew.md`, `reviews/technical.md` §4, `CLAUDE.md`.

### Nit

1. **New helper not in the ownership row.** `tests/helpers/ai.ts` is new and is not in block 09's row (`technical.md:541`). Additions to `src/api/common.ts` are allowed as shared (`technical.md:545-550`) and were reported. The conductor should record `tests/helpers/ai.ts` in §4 at merge.
2. **Dead branch.** `src/ui/ai/index.tsx:250` runs `Promise.reject(new Error("unreachable"))` to reach the "not set up" message. Set the off state directly, the way `useAsk` (L58-80) does.
3. **Commit title overstates.** a561e79 is titled "Add the AI suggestion slots to the desk's screens", but it only touches `src/ui/ai/*`. The pages already rendered the slots. This needs no action. It is noted for the changelog.

## Spec

### Should fix

1. **The configuration table omits `0`.** `README.md:72` says only "Default 200". The AI section at `README.md:331` says correctly that `0` turns AI off and that an invalid value falls back to 200. Implementation: `server/ai/run.ts` `dailyCap`. The ticket limits 09 to the "AI suggestions" section, so the conductor should make this one-line docs edit at merge (follow-up c).
2. **The history drops the reveal purpose.** `src/ui/components/ClaimHistory.tsx:134-137` renders every `revealed` event as "Revealed the notes" or "Revealed the patient's details". The ADR 0006 amendment makes the AI path a fourth opener. The audit row stores `purpose: ai_justification` or `ai_rejection_explainer` (`server/ai/tasks/justification.ts:66-73`, `rejection-explainer.ts:68-75`), but a reader of the history can't tell an AI-prompted reveal from a person's reveal. Nothing is lost, because the stored row is complete. This is display only. The file belongs to another block, so defer it to a follow-up ticket (follow-up a).

### Nit

3. **Explainer 409 copy is generic.** `src/ui/ai/index.tsx:44`: when a claim stops being rejected between render and press, `not_allowed` falls through to "That didn't go through. Try again." Trying again can't succeed. Something like "This claim isn't rejected any more" would be accurate.

AC coverage confirmed:
- AC-6.1: off state in `src/ui/ai/index.test.tsx` and 503 `ai_not_configured` in each route test.
- AC-6.2: `functions/api/ai/justification.test.ts:42-92`, D18, D18b and a property over seeded identities.
- AC-6.3: code-suggestion accept via `ai_accepted`, and nothing is saved before accept.
- AC-6.4: `rejection-explainer.test.ts:58-84`, D27, status unchanged.
- AC-6.5: `source-mapping.test.ts`, names only, nothing saved.
- F8 fast-check: `server/ai/deidentify.test.ts:70`.

## Security

Clean:
- Every route needs `auth: "access"`, with roles set per §6. Source mapping is reviewer-only.
- zod schemas are `.strict()` with size limits: 1 KB for the claim routes and 256 KB for mapping.
- The cap counts the call before it is made, with an atomic `ON CONFLICT ... WHERE calls < cap` (`server/ai/run.ts:37-46`). It can't be bypassed by concurrent calls.
- Error bodies carry only a code. The API key is never logged.
- Model output is rendered as text and never as HTML.
- The `DeidentifiedText` brand is cast only in `server/ai/deidentify.ts:83`.

### Should fix

1. **A date of birth in a non-ISO format passes the gate.** `server/ai/deidentify.ts:43` redacts `identity.dateOfBirth` only in its stored ISO form, so a dentist's note with "born 04/03/1960" or "4 March 1960" is sent as written (reproduced above). S9 doesn't list date of birth, so this isn't blocking. But the developer chose to treat it as an identifier, and combined with the clinic and visit date it narrows a patient down. Add DD/MM/YYYY, D/M/YYYY and "D Month YYYY" renderings of the visit's own DOB to `identityPatterns()`, and add the DOB to the property test's seeded set. This is small and belongs in 09.

### Nit

2. **Other people's names pass through.** A note like "Seen with wife Test Person Two" goes out unchanged (reproduced). The visit's own identity is removed and pattern identifiers are caught, but third-party names can't be. This is ADR 0004's accepted limit, and README:322 states the scope correctly ("the visit's own identity scrubbed out"). No change is needed. Record it as a known limit in the ADR if it isn't there already.
3. **The code suggestion trusts the client's description.** `server/ai/tasks/code-suggestion.ts:49` sends the description from the request body after the pattern scrub only, so names typed into it are not caught. This matches the §6 contract `{clinicCode, description}`, and only officers and reviewers can call it. A later hardening would be for the server to look up the description from the desk's own clinic codes.

## UI (`src/ui/ai/`)

- Status lines are `aria-live="polite"` (`index.tsx:91`, `:307`). Every suggestion is labelled as AI's. Nothing is applied without a button press.
- **Defer (follow-up d):** the DS `Field` doesn't wire `aria-describedby` to its hint or error. The fix belongs in `jurasolutions/design-system/` followed by `npm run sync:ds`. `src/design-system/` is a blocked path, so this needs Ting Yu to change the DS at source.

## Developer follow-ups

| # | Item | Call |
|---|---|---|
| a | `ClaimHistory.tsx:134` omits the reveal purpose | Defer to a follow-up ticket. The file isn't 09's (Spec 2) |
| b | `shippedMapping()` fails under jsdom | Defer. It's test-environment only and no user path is affected |
| c | README row omits cap `0` | The conductor fixes it at merge. It's one line outside 09's README section (Spec 1) |
| d | DS `Field` lacks `aria-describedby` | Defer. It needs a DS source change by Ting Yu (blocked path) |
