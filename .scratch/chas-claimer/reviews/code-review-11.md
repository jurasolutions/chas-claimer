# Code review 11: hardening (key rotation, I2, I4, simulator nav, `/api/me`)

- **Branch:** `crew/chas-claimer-11-hardening` at `d89535d`
- **Compared against:** merge-base with `crew/chas-claimer` (`8e6bec9`), `git diff crew/chas-claimer...crew/chas-claimer-11-hardening`. That is 34 files, +1110/−85, and 9 commits plus a merge.
- **Spec:** `.scratch/chas-claimer/issues/11-hardening.md`, `reviews/infra.md` §9 and §10 (I1, I2, I4), ADR 0006 and `reviews/technical.md` §7
- **Reviewed:** 2026-11-14, crew reviewer

## Verdict: changes-requested

There is one blocking finding (B1). The reseal route reports `remaining: 0` while remittance rows still depend on the previous key. README step 6 then has the operator unset that key. After that, the desk loses patient matches on some remittance lines and no longer detects a payer remittance file imported a second time. The ticket's first line promises the opposite: "rotate the identifier key without losing a single sealed identity or patient match".

Everything else is should-fix or nit. The crypto itself is sound.

## Evidence (run in a detached review worktree at `d89535d`)

| Command | Result |
|---|---|
| `npx vitest run --reporter=dot` | 95 files, 1246 tests passed. The `{"code":"internal"}` stderr lines are expected test logs |
| `npx tsc --noEmit -p .` | exit 0 |
| `npm run build` | built, 1720 modules. The only warning is zod's Rollup comment |
| Blocked paths (`src/design-system/`, `dist/`, `.env`, `.dev.vars`, `jurasolutions/design-system/`, `jurasolutions/inputs/`) | none touched |

---

## Standards

The Standards reviewer found no hard breaches of a documented standard. The UI copy, design-system use, icon registration, synthetic test data, the no-network rule and the absence of secrets all check out. The findings below are judgement calls, based on conventions visible in neighbouring code.

### Should fix

- **S-1. Raw SQL in the service, not a repo module.** `server/services/reseal.ts:63-77, 93-99, 112-122`.
  - **Rule:** the neighbouring convention. `services/rebuild.ts`, `services/imports.ts` and `services/remittances.ts` reach D1 only through `server/repo/*`.
  - **Fix:** move "page of stale revisions", "count remaining" and "guarded re-key update" into a `server/repo/visit-revisions.ts`, or into `repo/visits.ts`. That would also be where B1's new counts live.
- **S-2. Adopting a patient's hashes is done three ways.** This is a reuse finding: new code duplicates an existing helper.
  - `patients.adopt` is used in `server/services/imports.ts:156`.
  - `adoptStatements` is used in `server/services/remittances.ts:102`, with its own `Map` dedupe.
  - `adoptStatements` is used again in `server/services/reseal.ts:101-104`, with its own `Set` dedupe.
  - **Fix:** give `server/repo/patients.ts` one helper that dedupes and returns statements for many patients, and call it from all three places.

### Nit

- **N-1. Primitive obsession on the hash pair.** `patientHashes` and `contentHashes` return `string[]` with an unwritten "current first" rule. Callers cast `hashes[0] as string` at `server/services/imports.ts:143,146`, `server/services/remittances.ts:92` and `server/services/reseal.ts:90`, and destructure `[current, ...older]` elsewhere. A `{ current, older }` type would drop the casts.
- **N-2. The `v<n>:` format is spelled out in four places.** `server/crypto.ts` (`PREFIX`), the `STALE` SQL at `server/services/reseal.ts:55`, `Number(prefix.slice(1, -1))` at `server/services/reseal.ts:119`, and the GLOB in `migrations/0002_key_rotation.sql:20`. `KeyVersion` could carry its numeric `version`.
- **N-3. Two stacked doc comments on `byHash`.** At `server/repo/remittances.ts:134-135`, the old line ("The file this payer already sent…") was left above the new one.
- **N-4. `SessionEnded` repeats `PageBoundary`'s broken-page markup.** At `src/ui/App.tsx:299-311`, it repeats the header, sentence, actions row and the same reload button. A shared component would serve both.
- **N-5. `GLOSSARY.md` has no entries for the new terms.** "Reseal", "key version" and "previous key" are new user-facing terms in the README and the audit trail. See the CLAUDE.md "Domain docs" section.
- **N-6. The round trip has no property test.** `joinVisit` is tested against the synthetic clinic and two hand-built shapes (`src/domain/source-visit.test.ts`). A fast-check round trip over `arbSyntheticNric`-based visits would better guard the one function that, if wrong, turns revisions into permanent `failed` rows. The file already uses fast-check.

---

## Spec

Each finding below quotes the ticket line it measures against (`.scratch/chas-claimer/issues/11-hardening.md`).

### Blocking

- **B1. `remaining` reaches 0 while remittance data still depends on the previous key. The README then says to unset it.**
  - **Spec lines:**
    - Line 3: "a reviewer can rotate the identifier key without losing a single sealed identity or patient match".
    - Lines 18-19: the route "moves rows to the current version, reports what remains".
    - infra §9 step 3: "When none remain, unset the previous key."
  - **Where:**
    - `server/services/reseal.ts:55,63`: `STALE` and `remaining()` look only at `visit_revisions`.
    - `server/services/remittances.ts:91-106` and `server/repo/remittances.ts:136-143`: `remittances.file_hash` is a keyed content hash. It is written once, at insert. The CSV is not stored, so no reseal can recompute it.
    - `server/services/reseal.ts:101-104`: a remittance line's `patient_hash` moves only when the same patient has a visit revision being resealed.
    - `README.md:565-569,574-579`: step 5 says "Check `remaining` is 0" and step 6 says "Unset `IDENTIFIER_KEY_PREVIOUS`".
  - **Concrete failure:**
    - Import payer file F under key v1, rotate to v2, reseal until `remaining` is 0, and unset the previous key.
    - Now import F again. `byHash` computes only the v2 hash, finds nothing, and inserts F a second time (`UNIQUE (payer_id, file_hash)` does not fire).
    - Reference matching pays any open claim (`src/domain/matcher.ts:48`, OPEN = submitted, accepted), and `remittance_lines_claim_once` is per file. So a part-paid claim gets the same payment recorded twice.
    - Separately, remittance lines for a patient with no visit on the desk keep their v1 `patient_hash`. They then match nobody, which is the "patient match" the ticket says is not lost.
  - **What is wrong in the README:** its caveat at `README.md:578-579` names the wrong thing. It says "A clinic file pushed again … recognised as already seen only while `IDENTIFIER_KEY_PREVIOUS` is set". Clinic visits are in fact recognised after a full reseal, because reseal re-keys `visit_revisions.content_hash` and `visits.content_hash`. The README says nothing about payer remittance files.
  - **Fix:**
    1. Make the route report what it cannot move. Add `remittanceFiles` and `remittanceLines` counts to `ResealProgress`: rows whose `file_hash` or `patient_hash` prefix is not the current one.
    2. Rewrite README steps 5-6 and the caveats to say what unsetting the previous key costs for those rows.
    3. Add a guard against importing the same payer file again across a rotation. For example, refuse it or ask for confirmation when a file with the same payer, file name and line count already exists under a retired key prefix. The guard needs your decision (Q1).
  - Alternatively, you may decide to narrow the ticket's promise for remittances. That is also your call (Q1).

### Should fix

- **S-3. A forgotten `IDENTIFIER_KEY_PREVIOUS` silently splits every patient.** `server/crypto.ts:76` (`identifierKeys`) and `server/services/imports.ts:141-156`.
  - **Spec line 17:** "patient lookup matches under both keys while the previous key is set". Nothing protects the case where it isn't.
  - **Concrete failure:** suppose the operator sets the new `IDENTIFIER_KEY` and `IDENTIFIER_KEY_VERSION` but not the previous key. Then:
    - every re-pushed visit gets a new revision, because its old content hash no longer matches;
    - every returning patient gets a new `patient_hash`;
    - sealed identities under v1 fail to open.
    - Nothing refuses or warns.
  - **Fix:** have imports (and remittance imports) refuse with 503 `identity_not_configured` while stored rows carry a version prefix that is neither current nor previous. Alternatively, have `GET /api/me` or the reseal route's no-previous path flag it. A cheap check: `SELECT 1 FROM visit_revisions WHERE identity_sealed NOT LIKE ?current% AND identity_sealed NOT LIKE ?previous% LIMIT 1`.
- **S-4. The session-ended screen triggers on any network failure and destroys the page.** `src/ui/api.ts:52` and `src/ui/App.tsx:167`.
  - **Spec line 22:** "a failed fetch on a signed-in page (Access redirect blocked by CSP) shows 'Your session ended…'".
  - The code treats every `fetch` `TypeError` while `navigator.onLine !== false` as an ended session. That includes a Wi-Fi blip, a DNS failure, an edge reset or the desk being down.
  - It then replaces `<PageBoundary>` permanently, which unmounts any half-filled form, for example a claim edit or a remittance match. Reproduce in `src/ui/api.test.ts` by stubbing `fetch` to reject with `TypeError("Failed to fetch")` and `navigator.onLine = true`: the listener fires.
  - **Fix:** on a `TypeError`, probe once with `fetch("/api/me", { redirect: "manual" })`.
    - If the response `type === "opaqueredirect"`, Access is redirecting, so the session ended.
    - If the probe also throws, show a connection message instead.
  - Consider showing the notice as a banner or dialog above the page rather than replacing it, so unsaved input survives until the user chooses to reload.
- **S-5. Stale 32-character guidance remains for `CONNECTOR_TOKEN`.**
  - **Spec line 21:** "`CONNECTOR_TOKEN` must be at least 43 characters … the README says so".
  - The README is right (`README.md:67,471`). Two operator-facing copies still say 32:
    - `.dev.vars.example:13,15` ("At least 32 characters", `replace-with-at-least-32-random-characters`).
    - `scripts/setup-wizard.sh:576`, whose 503 hint says "shorter than 32 characters". That is now wrong for tokens of 32 to 42 characters.
  - The wizard's generator (`new_secret`, 32 bytes base64, so 44 characters) already passes.

### Nit

- **N-7. The audit detail overstates the count.** `detail.resealed` counts attempted writes, not rows changed (`server/services/reseal.ts:119`). Under two concurrent reseal runs, both audit events claim the same rows. The response's `moved` uses `meta.changes` correctly, and the audit could too, by writing the audit after the batch or recording `moved`.
- **N-8. `failed` does not name the failing rows.** It is a bare count (`server/services/reseal.ts:106-108`). README step 5 says "find out why", but nothing names the visit keys. Returning the failing `visit_key`/`revision` pairs is safe, because they carry no identifier, and would give the operator a starting point.
- **N-9. Scope: the synthetic import is now also on at loopback.** `functions/api/imports/synthetic.ts:18` now uses `simulatorOn`, which goes beyond "the simulator routes and `/api/me`". This is harmless and documented in the README. Noted only.

---

## Security

The `security-review` skill could not run in this checkout: it needs `origin/HEAD`, which is not set. I did the pass by hand on the same diff, concentrating on key handling, input handling, the new SQL and the money paths. I found no blocking security findings. B1 (a payment recorded twice) and S-3 (silent identity split) are the integrity risks, and are listed under Spec.

What holds:

- **Key derivation.** HKDF-SHA256 per version, with separate `match/v<n>` and `identity/v<n>` info (`server/crypto.ts`). Version 1 derives exactly as before, so today's `v1:` rows open with `IDENTIFIER_KEY_VERSION` unset.
- **Sealing.** Every seal, including a reseal, uses a fresh random 12-byte IV and keeps `visitKey:revision` as additional data.
- **Opening.** `openIdentity` picks the key by prefix. An unknown version throws, and an edited prefix fails GCM authentication, so there is no downgrade.
- **Fails closed** on:
  - a malformed key or version;
  - a previous key at version 1, malformed, or equal to current;
  - the development-key fingerprint on either key outside loopback (`server/crypto.ts:86-88`).
- **Route.** `functions/api/settings/reseal.ts` is `auth: "access"`, `roles: ["reviewer"]` and `identity: true`, and takes a 64 KB body and a strict zod cursor. The officer gets 403, which is tested.
- **SQL.** All the new SQL binds its values. The table names in `adoptStatements` come from a fixed list.
- **No leakage.** The reseal loop swallows errors into a count. Audit detail carries only counts and the version. No key, plaintext or identifier reaches logs, errors, the audit trail or the response.
- **Connector token.** At least 43 UTF-8 characters (`server/auth.ts:84-86`). The comparison stays constant-time, as before.

Nits:

- **N-10. Loose and permissive trigger.** `migrations/0002_key_rotation.sql:20,22`: `GLOB 'v[1-9]*:'` accepts prefixes such as `v1x:`. The trigger also allows a downgrade (v2 to v1) and any `content_hash` whose prefix matches. A trigger cannot check cryptography, and the service is the real guard. Tightening it to `v[1-9]:`, `v[1-9][0-9]:` or `v[1-9][0-9][0-9]:`, and requiring the new version to be greater than the old, would make the database refuse a mistaken hand edit.
- **N-11. Non-constant-time key comparison.** `server/crypto.ts:86` compares the previous and current keys with `toHex(...) === toHex(...)`. This is a configuration check run once per request on server-held values, with no attacker-controlled input, so timing does not matter here. Noted only.

---

## UI (`crew:web-design-review` on `src/ui/App.tsx`, `src/ui/api.ts`, changed hunks)

The design system wins where the guidelines differ. The guidelines ask for Title Case on headings and buttons; the design system's sentence case overrides that (note, not finding). Sentence case, second person and no exclamation marks all hold.

- `src/ui/App.tsx:167`: the guideline is "Warn before navigation with unsaved changes". Replacing the page discards unsaved input with no warning. See S-4.
- `src/ui/App.tsx:299-301`: `role="alert"` announces the message. Focus, however, stays on whatever element was unmounted, which leaves it on `<body>`. Move focus to `#main` (it already has `tabIndex={-1}`) or to the reload button when `ended` flips. Nit.
- `src/ui/App.tsx:306`: the `refresh-cw` icon is decorative and gets `aria-hidden="true"` from the design system's `Icon`. It is registered in `src/lib/icons.ts:50,106`. Pass.
- `src/ui/App.tsx:198`: the simulator list is left out when off, not hidden with CSS, so there is no stray focus target. Pass.

---

## Questions for Ting Yu

- **Q1. B1: how should a payer remittance file imported again across a rotation be handled?** Once the old key is unset, the desk cannot recognise that file by its content.
  - **Recommended:**
    - The reseal route reports the remittance rows it cannot move.
    - The remittance import refuses, with a clear message, any file whose payer, file name and line count match a file stored under a retired key version, unless a reviewer confirms.
    - The README describes this.
- **Q2. Migration `0002`.** Nothing has been deployed, and `0001_init.sql` was edited in place as recently as today. The README's "Migrations only go forward" rule (`README.md:481`) has been followed, which is correct once a database exists.
  - **Recommended:** keep `0002` as written. Folding it into `0001` would save one README step, but would break the documented rule for no real gain.
- **Q3. D1 limits per request.** A full reseal batch can run about 50 × (2 updates + 3 adopt statements) + 1 audit, which is roughly 250 statements, plus two counts.
  - I believe Workers Paid allows about 1,000 queries per invocation and Workers Free about 50. That is from memory and not checked against Cloudflare's docs.
  - **Recommended:** confirm the account is on Workers Paid before the first rotation. If it is on Free, drop `RESEAL_BATCH` to 8.
