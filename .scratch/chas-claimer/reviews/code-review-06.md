# Code review 06: settings, code map, Today screen

- **Branch:** `crew/chas-claimer-06-settings` (HEAD 618f047)
- **Point of comparison:** merge-base `01d0b7d` (`git diff 01d0b7d...crew/chas-claimer-06-settings`), 14 commits c30dff4..618f047, 22 files
- **Spec:** `.scratch/chas-claimer/issues/06-settings-code-map-overview.md`, PRD `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`, `decisions-g2.md`, `reviews/technical.md`, `reviews/functional.md`
- **Reviewer date:** 2026-11-14

## Verdict: changes-requested

One blocking finding: a clinic code that has been mapped can't be corrected, removed or given a second target from the UI (Spec 1). Everything else is should-fix or nit, and none of those alone would hold this ticket back.

## Evidence (run in the worktree)

- `npm install`: 0 vulnerabilities
- `npx vitest run`: 51 files, 497 tests passed. Stderr has act() warnings for `Overview` in `src/ui/App.test.tsx`. These are noise, not failures.
- `npm run typecheck`: clean
- `npm run build`: ok (JS 316.95 kB, CSS 19.90 kB)
- Blocked paths: the diff touches nothing under `src/design-system/`, `dist/`, `.env` or `.dev.vars`. No finding.
- Path-param probe: Wrangler 4.86.0 Pages routing hands `[clinicCode]` over still percent-encoded. A probe returned `{"clinicCode":"XR%2FOPG%201"}`. See Spec 4.

---

## Standards

Sources: `docs/agents/crew.md`, `reviews/technical.md` §3–§4, `CLAUDE.md`, plus the Fowler smell baseline. Hard violations break a documented rule. Smells are judgement calls.

### Should fix

1. **Ownership: block 01's file edited.** `server/auth.ts:~32` adds `roleLists()`. Rule: technical.md §4, "a block edits only its own files plus the shared files its row names". Either add it to block 06's row in technical §4 or move the helper into a block-06 module.
2. **Ownership: shared stylesheet not in the row.** `src/ui/app.css` (+355 lines) is not in block 06's row (technical.md §4). Record it as a shared file in §4. The new unlisted files are defensible, but the tech lead should confirm and list them: `server/services/settings.ts`, `server/services/code-map.ts`, `server/repo/affected-visits.ts`, `src/api/overview.ts` and `functions/api/settings/rebuild.ts`.
3. **Layering: audit insert written in a service.** `server/services/settings.ts:107-115` has a raw `INSERT INTO audit_events ... WHERE id = 1 AND version = ? AND changes() = 1`. Rule: technical.md §3, which says `server/repo/audit.ts` owns audit inserts. The `changes()` guard is the right idea. Extend `auditStatement` with an optional guard (or add a `guardedAuditStatement` in `repo/audit.ts`) so the service doesn't write audit SQL.

### Nit

4. **Token not used.** `src/ui/app.css:563` sets `min-height: 44px`. Use `var(--tap-min)` (DS `spacing.css:37`), as `app.css:164` already does. Rule: crew.md, "never ad-hoc styles". The focus outline at `app.css:666-667` (`2px solid var(--border-focus)`) matches DS `base.css:33` exactly, so it is not a finding.

### Smells (judgement calls)

5. **Large Module.** `src/ui/pages/Settings.tsx` is 982 lines with about 20 components. Move the code map (`689-934`) and the rebuild loop (`446-489`) into their own modules.
6. **Duplicated Code.** Each of these repeats something that exists elsewhere:
   - `Settings.tsx:206` `SCHEME_WORDS` duplicates `src/domain/claims/findings.ts:27` `SCHEME_NAMES`, and the two disagree ("Surgical MediSave (TOSP)" vs "MediSave"). Pick one source.
   - `src/ui/pages/Overview.tsx:13` `STATUS_WORDS` duplicates `src/ui/components/StatusBadge.tsx:5-13`.
   - `Settings.tsx:138-165`: `TextField` and `SelectField` are near-identical.
   - The "is this a CHAS procedure in any rule set" check appears in both `server/services/code-map.ts:45-49` and `server/services/settings.ts:~84`.
   - The `?`-placeholder builder appears in `server/repo/affected-visits.ts:11` and `server/repo/overview.ts:17`. It already exists in `repo/claims.ts` and `repo/visits.ts`.
   - `functions/api/settings/rebuild.ts:25-26` repeats `64 * 1024`. Use one constant.
7. **Result type not used.** `parseKey` (`server/services/code-map.ts:29`) returns `CodeMapKey | ValidationIssue`, so callers need a `"target" in k` guard (`functions/api/code-map/[clinicCode]/[target]/[payerId].ts:22`). `src/domain/result.ts` exists for this.
8. **Divergent Change / misplacement.**
   - `approvedByChannel` lives in `server/repo/overview.ts` but serves settings.
   - `server/services/code-map.ts:13` imports `rebuildBatch` from `services/settings`. It belongs in `services/rebuild`.
9. **Primitive Obsession.** The no-payer case is `""` in one place and `"-"` in another, and needs a cast (`server/services/code-map.ts:58`).
10. **Mysterious Name.** `marks`, `rest`, `c` and `s` in `server/repo/affected-visits.ts`.

Copy and numbers are clean:
- Sentence case throughout.
- Rule sets show their source and as-of date.
- Overrides require a source and an as-of date.
- No KPI tiles.
- Money goes through `MoneyCell`.

---

## Spec

### Blocking

1. **The code map can't be maintained in the UI.**
   - Spec line: ticket line 3, "keeps the code map (clinic code → CHAS procedure, TOSP code, each payer's benefit code, or "not claimable")".
   - `server/repo/code-map.ts:49` (`NOT EXISTS (SELECT 1 FROM code_map m WHERE m.clinic_code = ...)`) drops a code from the unmapped list as soon as any target is mapped.
   - `MappedList` (`src/ui/pages/Settings.tsx:701-727`) only displays entries. It has no edit and no remove.
   - Consequences:
     - (a) A wrong CHAS procedure mapping can't be fixed, so every claim built from that code keeps going out wrong.
     - (b) A code that needs a CHAS procedure and an insurer benefit code can only ever get its first target.
     - (c) "Not claimable" can't be reversed.
   - The domain agrees with the list: `src/domain/claims/build.ts:145-147` (`hasAnyMapping`) treats any mapping as mapped. So the gap is purely the missing UI for existing entries.
   - Delete is unreachable from the browser anyway (Spec 5), so the server's DELETE route doesn't rescue this.
   - Fix:
     - Give each mapped row "Change" and "Remove" actions.
     - Let a row add a missing TOSP or benefit target.
     - Add tests for correcting and removing an entry.

### Should fix

2. **A benchmark override can't be removed.** `Settings.tsx:417-445` offers only "Add an override". An accidental add leaves a blank override that fails validation (`Settings.tsx:98-100`: min, max and source errors), so the whole form can't be saved until the page is reloaded and the draft is lost. Spec: ticket, settings "edit benchmark overrides". Add "Remove".
3. **No viewport evidence for Today.** Ticket line 15 asks for the Today screen at 360px and 1280px. The CSS has a `64rem` breakpoint (`app.css:526-535`) and the layout looks right, but there is no screenshot or test at either width. QA can close this. Attach the evidence to the ticket.
4. **Clinic codes are never percent-decoded.**
   - Spec: technical §6, `PUT/DELETE /api/code-map/:clinicCode/:target/:payerId`, which is keyed on the clinic's own code.
   - `src/api/settings.ts` `codeMapPath` encodes the code.
   - Wrangler's Pages router (path-to-regexp 6.3.0 `match()` with no `decode`) passes it on still encoded.
   - `parseKey` (`server/services/code-map.ts:29-31`) never decodes it.
   - Result: a code such as `XR/OPG 1` is saved as `XR%2FOPG%201` and silently never matches its visits. The 64-character check also runs on the encoded length.
   - Synthetic codes are alphanumeric, so no test catches this.
   - Fix:
     - Use `decodeURIComponent` in `parseKey`, inside a try that returns a validation issue on a malformed sequence.
     - Add a route test with a space and a slash.
5. **`api.delete` is refused by the server.**
   - `src/ui/api.ts` `request()` sets `Content-Type` only when there is a body.
   - `server/http.ts` `browserRefusal` returns 403 `json_required` for any mutation without a JSON content type.
   - So `DELETE /api/code-map/...` can't succeed from the UI.
   - This is pre-existing and outside the diff, but this ticket is the first to need it.
   - Fix: either always send `Content-Type: application/json` on DELETE, or exempt a bodyless DELETE in `browserRefusal` while keeping the origin check. Add a test through `request()`.
6. **Doc comment overclaims.** `src/api/settings.ts:3-4` says every write "carries the version it was made against and answers 409 `stale`". Code-map PUT and DELETE carry no version and never answer 409 (`server/services/code-map.ts:54-89`). Technical §6 doesn't require a version there, so correct the comment, or add versioning (see Security 2).

### Scope creep (accept; record it)

7. **Rebuild route not in the route table.** `POST /api/settings/rebuild` (`functions/api/settings/rebuild.ts`) isn't in technical §6's route table. It is needed for the 100-per-request rebuild cap and "Carry on rebuilding". Add it to §6.

### Implemented, but the spec needs to catch up (questions for the PRD owner)

8. **AC-8.1 is tested on SCALING, not consultation.** `functions/api/settings.test.ts` uses `SCALING_OVERRIDE` because decisions-g2 §9 ships the published consultation range and `benchmarkIssues` correctly refuses an override of it. The code is right, so reword functional AC-8.1 for UAT.
9. **Today window.** 5 days (`DEADLINE_WARNING_DAYS`) matches decisions-g2 §5 and functional AC-8.3. Technical §6 still says 7. Correct technical §6.

### Passed

- Saves are versioned and audited, and a stale save answers 409 with the current version.
- Roles are read-only from `roleLists(env)` (AC-8.5 tested).
- Rule sets are read-only, with source, as-of date and notes (`Settings.test.tsx:57-80, 246-261`).
- S15 wording is exact: "N approved claims will still use the {channel} channel" (`Settings.tsx:331`).
- Every payer field is present.
- Rebuild is capped at 100 per request, scoped to what changed, reports what remains, and offers "Carry on rebuilding".
- Code-map saves audit their origin, plus `ai_suggestion_accepted`.
- The suggestion stub appears on unmapped rows.
- `MappingProposal` is rendered and downloads as `clinic-database-mapping.json`.
- AC-8.3: the Today links honour the queue's `due`, `payer` and comma-separated `status` filters (checked in `src/api/claims.ts:76-105`).
- AC-8.4: officers get 403 and a disabled fieldset.
- AC-8.2 is tested on dentist scope.

---

## Security

The `security-review` skill couldn't run (`git diff origin/HEAD...` has no such revision in the worktree), so I did this pass by hand on the same diff.

### Should fix

1. **Settings save judges against a possibly stale `before`.**
   - Where: `server/services/settings.ts:101-117`.
   - `before` is read before the version check. `benchmarkIssues`, `changedSections` and `rebuildScope` are all computed against `before`.
   - `before` can be newer than `expectedVersion`. When that happens, the save is refused as stale by the batch, so nothing is written.
   - `before` can also be read after a concurrent save lands. When that happens:
     - an override that was judged against the wrong baseline can pass;
     - the rebuild can be scoped to the wrong dentists or branches;
     - the audit's `sections` can misreport.
   - The window is small with one or two reviewers, but these are claim-shaping rules.
   - Fix:
     - Return `stale` at once when `before.version !== expectedVersion`.
     - Keep the batch's version guard for the remaining race.

### Nit

2. **The code map is last-write-wins.**
   - Where: `server/services/code-map.ts:54-89`.
   - Code-map PUT and DELETE take no version. Two reviewers mapping the same code at once silently overwrite each other.
   - The audit does record `previous`, so this is recoverable.
   - Delete is audited as `code_map_saved` with `deleted: true` (line 82). A distinct `code_map_deleted` action would read more plainly in the audit trail.
3. **The rebuild cursor is client-supplied.** `functions/api/settings/rebuild.ts:14-22` accepts any scope, so a reviewer can trigger a full rebuild. This is acceptable: the route is reviewer-only, zod-bounded (500 ids, 64-char codes, 64 KiB body) and capped at 100 visits per request.

### Checked and clean

- **Authorisation.** Every new route goes through `route()` with `auth: "access"`.
  - Reads (GET settings, code map, overview) allow officer and reviewer.
  - Writes (PUT settings, PUT/DELETE code map, POST rebuild) are reviewer-only.
- **CSRF.** Mutations without a JSON content type get 403 `json_required`, and foreign origins get 403 `foreign_origin` (`server/http.ts`).
- **SQL.** All queries are parameterised. `json_each` and `json_extract` paths are constants.
- **Secrets and patient data.** No secrets, credentials or patient data in the diff. The fixtures are synthetic.
- **Links.**
  - Rule-set source links come from the shipped JSON and use `target=_blank rel=noreferrer`.
  - `payer.apiUrl` and the override `sourceUrl` are user input, but neither is ever rendered as a link, so there is no `javascript:` vector.
- **No AI on identifiers.** The code-suggestion stub sends only clinic codes and descriptions, with no NRIC, name or phone. It is a stub, and no network call is made.

---

## UI

Checked with `crew:web-design-review` (Vercel Web Interface Guidelines, vendored copy) on the changed lines of `src/ui/pages/Overview.tsx`, `src/ui/pages/Settings.tsx` and `src/ui/app.css`. The DS wins where they conflict.

### Note

- The guidelines prefer Title Case for headings and buttons. The DS (`README.md` §3) requires sentence case, so this is not a finding.

### Nits

- **Overview.tsx**
  - The "Counting today's claims…" paragraph has no `role="status"` or `aria-live`, so screen readers aren't told when loading finishes.
- **Settings.tsx**
  - Line 645: no unsaved-changes guard (`beforeunload` or route-leave) on a long form with a draft.
  - Lines 305-310: in the waterfall, moving an item to the last place disables the button that has focus, so focus drops to `body`. Move focus to the other button, or keep it on the moved item.
  - Lines 186-198: the People lists have no empty state when the environment role lists are empty.
  - Lines 516-519: "Load the latest settings" discards the draft without confirming. The 409 message explains why, so this is acceptable as it stands.
  - `UnmappedRow`: on success `busy` stays true, and the row relies on the refetch to disappear. If the refetch fails, the row stays disabled.
  - Server issues on paths whose field is hidden (for example `apiUrl` when the channel isn't `api`) count towards the error summary with no visible field to fix.
- **app.css**
  - Line 563: the 44px literal (see Standards 4).

### Passes

- **Overview.tsx**
  - Links are real `<Link>` elements.
  - It uses a semantic list with headings.
  - The loading text ends in "…".
  - The error is an alert with a retry.
  - Figures use `tabular-nums`, and payer names carry `translate="no"`.
  - It has an empty state.
- **Settings.tsx**
  - Every field is labelled, with `aria-invalid` and `aria-describedby` on errors.
  - Focus moves to the first error (`604-607`).
  - The save status is `role="status"`, and errors are `role="alert"`.
  - The waterfall move buttons have visually hidden names.
  - Codes have `spellCheck={false}` and `autoComplete="off"`.
  - Fields use `type="url"` and `inputMode` where they should.
  - The fieldset is disabled for officers.
- **app.css**
  - It has `min-width: 0`, `overflow-wrap`, `tabular-nums` and `touch-action`.
  - The checkbox focus ring uses `:focus-visible`.

---

## Rulings on the developer's open items

- **(a) Synthetic benchmark overrides** (`mock/synthetic-clinic/config.ts:95-96`, commit 3f830ea, outside this diff).
  - The overrides: CONSULTATION 2100–3100 and CROWN_PERMANENT 75000–140000, with a MOH URL and `asOf` 2025-09-01.
  - They are dead config:
    - `src/domain/rules/data/chas-2025-10-01.json` already publishes both benchmarks from 2026-09-01.
    - `chasRuleSetFor` ignores overrides before that date, and the published values win after it.
  - They contradict ADR 0008. The new `benchmarkIssues` would refuse them if they were entered fresh, and the `asOf` back-dates an MOH figure.
  - Their only dependant is the tautological assertion in `mock/synthetic-clinic/generate.test.ts:52-56`.
  - **Should fix as a follow-up:** remove both overrides and that assertion.
- **(b) `parseKey` decoding:** confirmed real. Should fix (Spec 4).
- **(c) `api.delete` content type:** confirmed real. Should fix (Spec 5). It is also why Spec 1 can't be solved with the server's DELETE alone.
- **(d) Today window:** 5 days is right. Technical §6's 7 days is drift (Spec 9).

---

## Summary per axis

- **Standards:** 10 findings (3 should fix, 1 nit, 6 smells). The worst is the audit SQL written in `services/settings.ts` (technical §3).
- **Spec:** 9 findings (1 blocking, 5 should fix, 1 scope note, 2 PRD questions). The worst is that the code map can't be corrected, removed or given a second target in the UI (ticket line 3).
- **Security:** 3 findings (1 should fix, 2 nits). The worst is the settings save judging against a possibly stale `before`.
- **UI:** 7 nits and 1 DS note. Nothing blocking.
