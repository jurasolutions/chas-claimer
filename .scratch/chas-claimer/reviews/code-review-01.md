# Code review: ticket 01 (backend foundation)

- Branch: `crew/chas-claimer-01-foundation` (HEAD aa80259), 16 commits, 48 files, +4268 / -9
- Compared against: merge-base with `crew/chas-claimer` (fea9c9b), `git diff crew/chas-claimer...crew/chas-claimer-01-foundation`
- Spec: `.scratch/chas-claimer/issues/01-foundation.md`, `decisions-g2.md` (wins on conflict), `reviews/technical.md`
- Reviewer: crew reviewer, 2026-11-13

## Verdict: approve

There are no blocking findings. The verdict rests on that alone. Three should-fix items are best done before ticket 02 writes the first sealed row, because each one costs more once data exists (S-1, Sec-1, Sec-2).

## Evidence (run by the reviewer in the worktree)

| Check | Result |
|---|---|
| `npx vitest run` | 15 files, 126 tests passed |
| `npm run typecheck` | clean |
| `npm run build` | exit 0 |
| Blocked paths (`src/design-system/`, `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars`, `dist/`) | none touched; no `wrangler.toml` added |
| NRIC-shaped literals | only `T9000000J` / `t9000000j` (valid T9) and `T9000000A` (invalid, negative test) |
| Network in tests | `tests/setup.ts:15-23` makes `fetch` throw in every test; `tests/helpers/network.ts` answers only the URLs a test names |
| Logging | the only `console.` call is `server/http.ts:102`, which logs `{code, claimId}` and nothing else |
| Commit messages | all plain sentence-case imperatives (operating card) |
| UI diff | none (no `src/ui` or `.tsx` changes), so `web-design-review` was not run |

## Standards

From the Standards sub-agent. I re-ranked one item against the spec, and noted where.

### Blocking

None.

### Should fix

- **S-1 `src/domain/types.ts:156` and `migrations/0001_init.sql:135-143`**: `Finding.lineNo` exists, but `findings` has no `line_no` column. A finding about a line cannot round-trip through the database, unless it is smuggled through `params_json`, and `types.ts:151` says params carry message values only. The breach is "`types.ts` declares every type the UI shell's props need", which only holds if the type can be stored. technical §5 lists the `findings` columns without one, so either add `line_no INTEGER` to the migration (cheap now, before 02/03 write findings) or drop `lineNo` from the type and record the choice.

### Nit

- **N-1 `package.json:15`** (`dev:functions`) hard-codes `--binding IDENTIFIER_KEY=Y2hh...` (32 bytes, "chas-claimer-dev-key-not-secret!"). The Standards sub-agent ranked this a hard breach of CLAUDE.md "Secrets stay out". **I re-ranked it.** technical.md F12 (l.210-212) explicitly asks for "`IDENTIFIER_KEY` set to a fixed published dev key", crew may not touch `.dev.vars`, and README.md:44-46 says the key "protects nothing. Never use it outside your own machine." It is a published constant, not a secret. The real risk is a production deploy that reuses it, and that is covered under Security, Sec-2.
- **N-2 `migrations/0001_init.sql:8-11`**: `audit_events.action` and `findings.code` have no CHECK, against technical §5 "status and kind columns carry CHECK IN (...)". The reason is documented (open-ended lists; SQLite cannot alter a CHECK without a table rebuild, and the audit log must never be rebuilt). It is acceptable, but the conductor should record it in technical §5 so later tickets do not "fix" it.
- **N-3 `src/domain/types.ts`**: the `ClaimAction` names drift from technical §3 and GLOSSARY. Here it is `record_payment{cents}`; there it is `pay{amount, paidOn}`. `submit` has no `channel`, and the new `portal_refused`, `accept_short_payment` and `acknowledge_change` follow decisions-g2 §2. Code follows decisions-g2, which wins. GLOSSARY and technical §3 are conductor-owned and should be brought into line.
- **N-4**: files outside the technical §4 ownership row for 01 are `server/bytes.ts`, `src/domain/validation.ts`, `tests/helpers/{access,arbitraries,seed}.ts` and `tests/setup.ts`. These are supporting files only. The conductor should add them to §4 so parallel tickets know who owns them.
- **N-5 (possible Duplicated Code)**: money and date zod schemas are declared twice, as `CentsSchema`/`DateSchema` in `source-visit.ts` and `NonNegCents`/`IsoDateSchema` in `settings.ts`. Also, `CLAIM_ACTION_KINDS ... satisfies readonly ClaimActionKind[]` does not catch a missing member.
- **N-6 (possible Primitive Obsession)**: `PayerId` and instants (`AuditDraft.at`, `updatedAt`) are plain strings, while `Cents`, `IsoDate` and `Nric` are branded.
- **N-7 `src/domain/settings.ts:150-246`**: `DEFAULT_SETTINGS` gives the made-up insurers figures (copay 10 %, limits 100 000 and 150 000 cents) and calls itself "the starting point for a real one". These are not published figures, so the numbers rule is not breached. But a real clinic could inherit invented limits, so caption them as illustrative, or null them outside demo mode, before the settings screen ships.

## Spec

From the Spec sub-agent, with my verification noted. All eight acceptance criteria have a matching test, and every contract item checked out. That covers:

- the nine statuses and twelve actions
- `Actor` with connector, simulator and remittance
- `accepted_cents`, `overpaid`, `checkout_by`, `checkout_until` and `channel` on `claims` (`0001_init.sql:93-110`)
- `UNIQUE (payer_id, file_hash)` (l.210) and the partial unique index (l.227-228)
- the `connector` and `mock:clinic` tsx scripts
- the full README env table and the four empty sections (README.md:112-127)

### Blocking

None.

### Should fix

- **Sp-1 `server/http.ts:154`, `route()` options**: AC4 says "identity routes fail closed without `IDENTIFIER_KEY`". `requireIdentifierKeys` exists and is tested (`server/http.test.ts:152-175`), but `route()` has no identity option, so each later route must remember to call it. That passes for 01, which has no identity route. Making it a `route({ identity: true })` option would put the fail-closed guarantee in the spine, which is where ticket 01 is meant to land it, rather than in eight later handlers.

### Nit

- **Sp-2**: "The import guard refuses anything else until `ALLOW_REAL_IDENTIFIERS=yes`" (decisions-g2 §1). Ticket 01 supplies `isSynthetic` (`src/domain/nric.ts:41`), the 422 code (`src/api/common.ts:44`), the env field (`server/env.ts:21`) and the README row. No code reads the variable yet. That fits, because the import ticket owns the guard, but ticket 02's review must check it.
- **Sp-3 `public/_headers:8`**: the CSP adds `https://fonts.googleapis.com` to `style-src`, `https://fonts.gstatic.com` to `font-src`, and `'unsafe-inline'` styles. technical F11 says "CSP default-src 'self'". The design system justifies it, but every page load now reaches a third party. That is a decision for Ting Yu (see Questions).
- **Sp-4 `server/auth.ts:46`**: `DEV_USER` is also honoured on `[::1]`. technical l.34 says "`localhost` or `127.0.0.1`". This is loopback and safe, so it only needs updating in the spec line.
- **Sp-5 `src/domain/settings.ts:86-89`**: `apiAuthHeader` is not in the contract's payer fields. It is harmless: a header name only, regex-bounded, and the token still comes from `payerTokenName(id)`.
- **Sp-6 `functions/api/me.ts:6`**: this line answers `json({error:"forbidden"},403)` instead of `problem()`, but it cannot be reached because `route()` already refuses a person with no roles (`server/http.ts:81`). Use `problem()` or delete the branch.
- **Sp-7 `server/repo/settings.ts:22,29`**: `InvalidSettingsError` on read surfaces through `route()` as a generic 500 `internal`. That meets "refused on read", but the settings route ticket should map it to an explicit code.
- **Sp-8**: the extra `audit_events_no_replace` trigger (`0001_init.sql:191-196`) was not asked for, and it is welcome: it closes the `INSERT OR REPLACE` hole.

## Security

The `security-review` skill could not load here because its preamble runs `git diff origin/HEAD...` and this repo has no `origin/HEAD`. I did the pass by hand on the same diff, covering every focus area in the brief.

### Blocking

None.

### Should fix

- **Sec-1 `server/crypto.ts:49-56, 59-69`**: the AES-GCM seal has no additional authenticated data. A sealed identity is not bound to its `visit_key` or `revision`, so anyone with write access to D1 can move one patient's `identity_sealed` onto another visit row. It still opens cleanly, and the desk would then attribute a claim to the wrong patient. The random 12-byte IV per seal is correct. Pass `additionalData: utf8(\`${visitKey}:${revision}\`)` on both seal and open. Do it now: once ticket 02 writes `v1:` rows, adding AAD needs a `v2:` format and a re-seal.
- **Sec-2 `server/crypto.ts:24-26` with `package.json:15`**: the published dev key is exactly 32 bytes, so `identifierKeys` accepts it anywhere. A Pages deploy that copies the dev bindings would seal real NRICs under a key printed in a public repo. Refuse that exact key (compare its derived fingerprint) unless the request host is local, the same way `DEV_USER` is fenced (`server/auth.ts:46`). Return `identity_not_configured`. This keeps F12's published dev key and stops it from protecting real data.

### Nit

- **Sec-3 `src/domain/nric.test.ts:46-47`**: these lines build valid non-T9 numbers at run time (`"T8999999"+check`, `"S9000000"+check`). No literal is committed, so the GLOSSARY rule holds to the letter. But the test still produces a real-shaped number that could belong to someone. Add a comment that these exist only to prove `isSynthetic` is false, or derive the non-T9 case from a property over the arbitrary instead of fixed digits.
- **Sec-4 `server/crypto.ts:68`**: `openIdentity` casts the decrypted JSON to `VisitIdentity` without parsing it. The schema already exists in `source-visit.ts`, so validate with it.
- **Sec-5 `server/access-jwt.ts`**: concurrent JWKS refreshes are not deduplicated. A cold start under load can fetch the certs several times. Share one in-flight promise.

### Checked and clean

- **Access JWT** (`server/access-jwt.ts`): checks `alg === "RS256"` and a string `kid`, verifies RSASSA-PKCS1-v1_5/SHA-256 via Web Crypto, checks `aud` (string or array), requires `iss === https://<team>`, `exp > now` with no leeway, `nbf` with 60 s leeway, and a non-empty email. The JWKS fetch uses `redirect: "error"`. Missing config gives 503 `auth_not_configured`.
- **Connector token** (`server/auth.ts`): HMAC under a random per-call key, then `subtle.verify`, so the comparison is constant time. It needs `Bearer` and at least 32 bytes; shorter counts as unset (503), per technical §7.
- **HKDF/HMAC**: fixed salt with distinct `info` (`match/v1`, `identity/v1`). Hashes are domain-separated (`patient`, `content`) and version-prefixed. The key must be exactly 32 base64 bytes, otherwise null and fail closed.
- **`DEV_USER`**: honoured only for loopback hostnames. With nothing configured, the answer is `auth_not_configured`.
- **Request spine** (`server/http.ts`):
  - A non-JSON mutation gets 403 `json_required`.
  - Access routes refuse a foreign or missing Origin (403 `foreign_origin`).
  - A declared Content-Length over the limit gets 413, and the body stream is capped.
  - Every response is `no-store` plus nosniff, error paths included.
  - The 500 path logs no identifiers.
- **Error bodies**: `src/api/common.ts` carries codes only. `InvalidSettingsError` and validation issues carry paths, not values.
- **D1** (`migrations/0001_init.sql`):
  - The audit log refuses UPDATE, DELETE and id reuse.
  - `visit_revisions` is immutable.
  - The audit insert is guarded by version and nonce (`server/repo/audit.ts`), so a stale write changes 0 rows and adds no audit row (tested).
  - No identifier is stored in the clear; there is only `patient_hash`, `patient_mask` and `identity_sealed`.
- **Headers** (`public/_headers`):
  - CSP includes `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` and `form-action 'self'`.
  - The file also sets X-Frame-Options DENY, Referrer-Policy no-referrer, nosniff and Permissions-Policy.
  - Google Fonts deviates from F11 (see Sp-3).
- **CSV** (`src/domain/csv.ts:18,32-35`): text cells starting with `= + - @ \t \r` get a `'` prefix and quotes. Amounts never take the text path. There is a row cap on parse.
- **Secrets**:
  - No `.dev.vars`, `.env` or `wrangler.toml` was committed.
  - The test keys in `tests/helpers/env.ts` are labelled test-only constants.
  - `PAYER_<ID>_API_TOKEN` is derived from the payer ID, so settings cannot point at another secret.

## Questions for the conductor / Ting Yu

1. Do you accept Google Fonts and `'unsafe-inline'` styles in the CSP (Sp-3)? The alternative is self-hosting the fonts.
2. Should `findings` get a `line_no` column, or should `Finding.lineNo` be dropped (S-1)?
3. The doc updates are conductor-owned: technical §3/§4/§5 and GLOSSARY (N-2, N-3, N-4, Sp-4).

## Summary

- **Standards:** 8 findings (0 blocking, 1 should fix, 7 nits). Worst: S-1, `Finding.lineNo` has no `findings` column.
- **Spec:** 8 findings (0 blocking, 1 should fix, 7 nits). Worst: Sp-1, fail-closed identity is a helper, not a `route()` option (AC4).
- **Security:** 5 findings (0 blocking, 2 should fix, 3 nits). Worst: Sec-1, the AES-GCM identity seal has no AAD, so sealed blobs can be swapped between rows.
