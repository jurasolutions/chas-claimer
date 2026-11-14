# Infra review: chas-claimer

_Crew infra engineer, 2026-11-14, branch `crew/chas-claimer-infra` from `crew/chas-claimer` at
e53bbe0. Sources: `docs/agents/crew.md`, `README.md`, `package.json`, `public/_headers`,
`migrations/0001_init.sql`, `functions/api/**`, `connector/post.ts`, `server/{env,auth,access-jwt,crypto,http}.ts`,
`reviews/technical.md` §7–§9, `decisions-g2.md` §15, the PRD, and the landing page's README for how
Jura deploys today. Nothing was run against Cloudflare: no account exists yet._

**Verdict.** The desk is deployable once Ting Yu runs `scripts/setup-wizard.sh`. Its auth and
identity checks fail closed, so a half-configured deployment answers 503 and shows nothing. Two
items need a decision before real patient data arrives: `IDENTIFIER_KEY` cannot be rotated (§9),
and the plan tier (§11, Q1).

---

## 1. Touchpoints

Environments: **L** local (`npm run dev:functions`), **CI** GitHub Actions, **Pv** Pages Preview,
**Pr** Pages Production, **C** the clinic's connector machine.

| Touchpoint | Change | Environments | Owner | Status |
|---|---|---|---|---|
| Node toolchain | Added `.nvmrc` = `20`. CI and the Pages build both read it. Node 20 is past end of life (see §11) | L, CI, Pv, Pr | infra | done |
| `npm ci` from the committed lockfile | none | CI, Pv, Pr | developer | in place |
| Build `vite build` into `dist/` | none | CI, Pv, Pr | developer | verified locally |
| CI workflow `.github/workflows/ci.yml` | New: typecheck, test, build on push and PR to `main` and `crew/**`. No secrets, `contents: read`, actions pinned to `@v4`. Created under the conductor's authorisation for this run (the path is normally blocked) | CI | infra | done, lint clean |
| Pages project (Git integration, production branch `main`, build `npm run build`, output `dist`) | create | Pv, Pr | Ting Yu | not created (wizard stage 5) |
| Pages runtime: compatibility date `2026-05-01`, no flags | set in the dashboard (no `wrangler.toml`) | Pv, Pr | Ting Yu | not set (stage 8) |
| Pages Functions routing (`functions/api/**`, generated `_routes.json`) | none | Pv, Pr | developer | in place |
| `public/_headers` (CSP, frame-ancestors, no-referrer, nosniff) | none; HSTS gap reported (I3) | Pv, Pr | developer | in place |
| No `wrangler.toml` | kept that way. With one carrying `pages_build_output_dir`, Pages takes bindings from the file instead of the dashboard (landing page README; card: "never add a `wrangler.toml`") | Pv, Pr | — | in place |
| `wrangler.local.toml` | none; local only, Pages never reads it | L | developer | in place |
| D1 `chas-claimer`, `--location apac` | create | Pr | Ting Yu | not created (stage 3) |
| D1 `chas-claimer-preview`, `--location apac` | create (new in this review: previews must not share Production's data) | Pv | Ting Yu | not created (stage 3) |
| Migration `0001_init.sql` | apply `--remote` to both | Pv, Pr | Ting Yu | pending (stage 4) |
| Remote migration config `.wrangler/d1-remote.toml` | written by the wizard, git-ignored; checked locally that it resolves `migrations/` | L | infra | done |
| `.dev.vars.example` | New, placeholders only. `.gitignore` gains `!.dev.vars.example`: the existing `.dev.vars.*` rule would have ignored it | L | infra | done |
| `.gitignore` for D1 exports | New `backups/` and `*.d1-export.sql` | L | infra | done |
| Environment variables (§3) | set per environment | Pv, Pr | Ting Yu | not set (stages 9–10) |
| Access application (one, three hostnames) | create | Pv, Pr | Ting Yu | not created (stage 6) |
| Access service token + Service Auth policy | create; expires (1 year default) | Pr, C | Ting Yu | not created (stage 7) |
| Custom domain and DNS | undecided (Jura open thread) | Pr | Ting Yu | open (stage 11, optional) |
| Connector environment (`CLAIMS_DESK_URL`, `CONNECTOR_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`) | set on the clinic machine | C | Ting Yu with the clinic | later, after the data-intermediary agreement |
| Anthropic API (optional) | Jura's own key, with a workspace spend limit | Pr | Ting Yu | optional |
| Payer APIs (`PAYER_<ID>_API_TOKEN`) | one per payer moved to the `api` channel | Pr | Ting Yu | later |
| GitHub app access for Pages | scope to `jurasolutions/chas-claimer` only | — | Ting Yu | stage 5 |
| Scheduled jobs, queues, KV, R2, Durable Objects | none used | — | — | n/a |
| Logs | Pages real-time logs only; no persistent store configured | Pv, Pr | Ting Yu | §7 |
| Backups | D1 Time Travel (always on); exports kept out of the repo | Pr | Ting Yu | §8 |
| README "Deploy" | extended in place: CI, Production versus Preview, first deployment, smoke check, migrations, logs, backup, rollback, rotation | — | infra | done |
| `scripts/setup-wizard.sh` | New, 14 stages | — | infra | done, `bash -n` clean |

## 2. Bindings

| Binding | Type | Production | Preview | Local |
|---|---|---|---|---|
| `DB` | D1 | `chas-claimer` | `chas-claimer-preview` | `--d1 DB=…` in `dev:functions`, state in `.wrangler/state` |

There are no other bindings (no KV, R2, AI or service bindings).

## 3. Environment variables

Drift check: `server/env.ts`, the README's Configuration table and the brief's list name the same 14
entries, and the code reads exactly these (grep of `env.<NAME>` across `server/`, `functions/`,
`src/`). **No drift.** The connector's four variables live on the clinic machine and are
deliberately not in `Env`. One wording drift, I2: `CONNECTOR_TOKEN` is checked as at least 32
characters, not 32 bytes of randomness.

| Variable | Kind | Production | Preview | Local | Notes |
|---|---|---|---|---|---|
| `DB` | binding | `chas-claimer` | `chas-claimer-preview` | command line | Settings, Bindings |
| `ACCESS_TEAM_DOMAIN` | text | `<team>.cloudflareaccess.com` | same | unset (loopback uses `DEV_USER`) | without it, or `ACCESS_AUD`, every Access route answers 503 |
| `ACCESS_AUD` | text | the one application's AUD | same | unset | not a secret; one application means one AUD |
| `ROLE_REVIEWERS` | text | emails | same | command line | a role change needs a redeploy |
| `ROLE_OFFICERS` | text | emails | same | command line | |
| `CONNECTOR_TOKEN` | secret | `openssl rand -base64 32` | **unset** | `.dev.vars`, optional | shorter than 32 characters counts as unset (503) |
| `IDENTIFIER_KEY` | secret | 32 random bytes, base64 | **a different key** | published dev key on the command line | exactly 32 bytes; the published dev key is refused off loopback; cannot be rotated yet (§9) |
| `ALLOW_REAL_IDENTIFIERS` | text | unset until the data-intermediary agreement, then `yes` | never | unset | anything but `yes` refuses non-`T9` NRICs |
| `DEMO_MODE` | text | unset | `yes` | command line `yes` | turns on the synthetic import and the payer simulator |
| `AI_DAILY_CALL_CAP` | text | unset (200) | `20` | `.dev.vars`, optional | `0` turns AI off |
| `ANTHROPIC_API_KEY` | secret | Jura's key, optional | unset, or a separate low-limit key | `.dev.vars`, optional | never TaskWise's key (company separation) |
| `ANTHROPIC_BASE_URL` | text | unset | unset | optional | |
| `DEV_USER` | text | **never** | **never** | command line | honoured on localhost, 127.0.0.1 and [::1] only, so it is inert on Pages, but leave it out |
| `PAYER_<ID>_API_TOKEN` | secret | per payer on `api` | **never** | `.dev.vars`, test endpoints only | name derived from the payer ID, never configured |

## 4. Secrets

No secret value appears in this review, the README, the wizard or any commit. The wizard
generates keys straight to the clipboard, clears it afterwards, and reads the service token with
hidden input into a private temporary header file that is deleted at once.

| Secret | Lives in | Created by | How |
|---|---|---|---|
| `IDENTIFIER_KEY` (production) | Pages secret, Production; password manager copy (the only recoverable copy) | Ting Yu | wizard stage 10 |
| `IDENTIFIER_KEY` (preview) | Pages secret, Preview; password manager | Ting Yu | wizard stage 10 |
| `CONNECTOR_TOKEN` | Pages secret, Production; the clinic connector's environment; password manager | Ting Yu | wizard stage 10 |
| Access service token (client ID and secret) | the clinic connector's environment as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`; password manager. Not in Pages | Ting Yu in Zero Trust | wizard stage 7 |
| `ANTHROPIC_API_KEY` | Pages secret, Production | Ting Yu, Jura's Anthropic console | wizard stage 10 (optional) |
| `PAYER_<ID>_API_TOKEN` | Pages secret, Production | Ting Yu, from each payer | later |
| Wrangler sign-in | wrangler's OAuth token on Ting Yu's machine | Ting Yu | wizard stage 2 |
| CI | none | — | the workflow reads no secrets |

## 5. Access set-up

Per `decisions-g2.md` §15 and ADR 0007.

1. **One self-hosted application**, "chas-claimer desk", with three destinations:
   `chas-claimer.pages.dev`, `*.chas-claimer.pages.dev` and the custom domain. Session 8 hours.
2. **Allow policy** "Desk staff": include the reviewer and officer emails. Access decides who
   reaches the desk; `ROLE_*` decides what they can do. Someone allowed by Access but on neither
   list gets 403.
3. **Service token** "chas-claimer-connector", one-year duration, and a **Service Auth** policy for
   it on the same application. The token passes Access for every path, but the desk accepts it
   nowhere: a service-token assertion carries no user email, so every Access route answers 401,
   and `POST /api/imports` ignores the assertion and checks the bearer `CONNECTOR_TOKEN`. Two
   independent secrets are needed to import.
4. **Do not use the Pages project's own Access toggle for previews.** It creates a second
   application with a different AUD, and since the desk checks one `ACCESS_AUD`, previews would
   refuse every sign-in. (They fail closed, so this is an outage, not a leak.)
5. **Order:** create the Pages project first, because Access needs the `pages.dev` hostname to
   exist. The first deployment is harmless: with no `ACCESS_*`, no `IDENTIFIER_KEY` and an empty
   database every API route answers 503, and the static shell holds no data. For the custom domain,
   add it to Access before adding it to Pages.

**The preview-deploy risk.** Every pushed branch becomes a public `*.chas-claimer.pages.dev` desk.
Three controls cover it: the wildcard destination in the one Access application; a separate
preview database and `IDENTIFIER_KEY`, so preview code never reads or writes clinic records; and no
`CONNECTOR_TOKEN` or payer tokens in Preview, so nothing can import into a preview or send from it.
The smoke check probes `access-check.chas-claimer.pages.dev`, a hostname that does not exist, to
prove the wildcard sits in front of every preview.

## 6. Deploy plan

### Pre-deploy

- Create both D1 databases with `--location apac`. **What the hint does:** it asks Cloudflare to
  place the database's primary copy in an Asia-Pacific location, chosen at creation and fixed for
  the database's life. **What it doesn't guarantee:** Singapore specifically (it is a region, not a
  city); where Time Travel's point-in-time data is held (not documented per database); where a
  Function runs (at the edge location nearest the caller, normally Singapore for clinic staff);
  or any legal jurisdiction (D1 jurisdictions are `eu` and `fedramp` only, and setting one
  overrides the hint). Keep D1 read replication off, its default, so no replica is placed elsewhere.
  If the data-intermediary agreement needs residency in writing, ask Cloudflare for it (Q3).
- Apply `0001_init.sql` to both with
  `wrangler d1 migrations apply <name> --remote -c .wrangler/d1-remote.toml`. There is no down
  migration. For a fresh database the rollback is to delete and recreate it.
- Set the bindings, variables and secrets per §2–§4. No feature flags beyond `DEMO_MODE` and
  `ALLOW_REAL_IDENTIFIERS`.

### Deploy

Ting Yu triggers it. Pages builds `main` on each push once connected. The first time: create the
project (stage 5), then the settings (stages 6–11), then **Retry deployment** (stage 12), because
Pages binds variables when a deployment is created. After that, a merge to `main` deploys. The
crew never pushes to `main` except the conductor's delegated first version.

### Smoke check

The exact table is in the README ("Smoke check") and wizard stage 13 runs it. In short:

| Request | Expected |
|---|---|
| anonymous `GET /` on `chas-claimer.pages.dev`, `access-check.chas-claimer.pages.dev`, the custom domain | 302 to `<team>.cloudflareaccess.com` |
| `GET /api/me` with the service token | 401 (503 means the Access variables aren't on this deployment) |
| `POST /api/imports` with the service token and a wrong bearer | 401 (503 means `CONNECTOR_TOKEN` is unset or short) |
| `GET /` with the service token | `Content-Security-Policy` with `frame-ancestors 'none'` |
| signed-in reviewer opens `/api/me` | own email, roles `reviewer`, `officer` |
| synthetic import on a preview | visits appear (503 `identity_not_configured` means no preview key) |

### Watch

- `npx wrangler@4.86.0 pages deployment tail --project-name chas-claimer --status error --format pretty`
  for the first hour after a deployment, and the deployment's Real-time logs in the dashboard.
- Pages analytics for the 5xx rate; Zero Trust Access logs for refusals; D1 metrics for rows
  read and written.
- **Roll back when:** any `{"code":"internal"}` line on a route that worked before the deploy;
  any 503 `auth_not_configured` or `identity_not_configured` on Production; any anonymous request
  that reaches the desk without the Access login (then also pull the hostname from DNS or pause the
  project until Access covers it).

### Rollback

1. Pages, Deployments, the last good Production deployment, **Rollback to this deployment**.
   Instant. Or `git revert` the commit on `main` and push.
2. If the data is damaged, Time Travel restore (§8), after noting the current bookmark.

A rollback does not undo: schema or data changes in D1; claims already sent to a payer or files
uploaded to a portal; Access or service-token changes. After rotating a secret, don't roll back to a
deployment built before the rotation, since it may still carry the old value.

## 7. Observability

- **What the Functions log:** one line, `console.error(JSON.stringify({ code: "internal", claimId }))`
  in `server/http.ts` when a handler throws unexpectedly. `claimId` is a random UUID
  (`crypto.randomUUID()`). Exceptions are caught by `route()`, so no error message or stack, which
  could carry data, reaches the runtime log.
- **What the platform logs:** tail sessions show each request's method, URL, status and Cloudflare
  metadata. No route takes an identifier in its path or query (no `searchParams.get` anywhere in
  `server/` or `functions/`; path params are claim UUIDs, remittance IDs, payer IDs and clinic
  procedure codes). Request bodies are not logged.
- **Third parties:** the Anthropic client has `logLevel: "off"` and `maxRetries: 0`. Access logs hold
  staff emails, not patient data.
- **Connector:** prints counts, row positions and masked identifiers only; its one `console.error`
  prints a `SourceShapeError` (table and column names) or a fixed message.
- **Confirmed: no identifier reaches a log**, from reading every `console.*` call outside tests
  (three in total) and every route's path and query handling.
- **Gap:** nothing is stored after a tail session ends. Acceptable for a first version with one
  clinic. Add a persistent log store only if support needs history.

## 8. Backup and restore (D1 Time Travel)

- Always on. Restore points for any minute in the last 30 days on Workers Paid, 7 on the free plan.
- `wrangler d1 time-travel info chas-claimer` gives the current bookmark. Note it before every
  migration and before any bulk operation.
- `wrangler d1 time-travel restore chas-claimer --timestamp=<RFC3339>` (or `--bookmark=`) replaces
  the whole database in place and prints a bookmark that undoes the restore.
- **It also rewinds the append-only audit trail.** Everything after the restore point, audit
  events included, is gone. Record each restore and its reason outside the desk.
- Offsite copy: `wrangler d1 export chas-claimer --remote --output <file>`. Identities are sealed
  and patients masked, but it is still health data: encrypted store only, never the repo
  (`backups/` and `*.d1-export.sql` are now git-ignored). Export outside clinic hours.
- An export is useless without `IDENTIFIER_KEY`: the password manager copy of the key is part of
  the backup.

## 9. `IDENTIFIER_KEY` rotation

**Not supported today (finding I1).** `server/crypto.ts` derives the HMAC and AES-GCM keys from one
`IDENTIFIER_KEY`. Stored values carry a `v1:` prefix "so the key can rotate later", but
`openIdentity` rejects any other prefix and there is no second key. Changing the variable in place:

- every sealed identity fails to open, so existing claims can't be revealed, exported or sent by API;
- every `patient_hash` changes, so returning patients stop matching earlier visits;
- every `content_hash` changes, so the next connector run sees each visit as changed.

**Operational rule until fixed:** treat the key as permanent. Keep it in the password manager. Rotate
only on suspected compromise, and then only with the code change below.

**Recommended fix (developer, before `ALLOW_REAL_IDENTIFIERS=yes`):**
1. Read `IDENTIFIER_KEY` as the current key and an optional `IDENTIFIER_KEY_PREVIOUS`, each tagged
   with a version (for example `IDENTIFIER_KEY_VERSION=2`), and write values with the current
   version prefix (`v2:`).
2. `openIdentity` picks the key by prefix. Patient lookup computes the hash under both keys while
   the previous key is set.
3. A reviewer-only, batched re-seal and re-hash route on the `settings/rebuild` cursor pattern
   moves rows from `v1:` to `v2:` and reports what remains. When none remain, unset the previous key.
4. Audit the rotation as one event per batch.

## 10. Findings outside my boundary

I did not edit `src/`, `server/` or `functions/`. Each item has a recommended fix.

| ID | Severity | Where | Finding | Recommended fix |
|---|---|---|---|---|
| I1 | Medium now, High once real data lands | `server/crypto.ts` | `IDENTIFIER_KEY` cannot be rotated (§9) | the versioned-key design in §9 |
| I2 | Low | `server/auth.ts` `connectorConfigured` | the "32 bytes" check measures the string's length, so 32 low-entropy characters pass | document "at least 32 characters, from `openssl rand -base64 32`", or require 43 or more |
| I3 | Low | `public/_headers` | no `Strict-Transport-Security`. `pages.dev` is HSTS-preloaded with the whole `.dev` domain; a custom `.sg` domain is not | turn on HSTS for the custom domain's zone (SSL/TLS, Edge Certificates), which covers static files and Functions alike |
| I4 | Low (UX) | the UI's fetch layer | when the Access session expires, `/api` calls are redirected to `cloudflareaccess.com`; `connect-src 'self'` blocks that, and the user sees a network error | treat a failed fetch on a signed-in page as "your session ended, reload to sign in again" |
| I5 | Info | `server/http.ts` | Function responses don't carry the CSP from `_headers` (Pages applies `_headers` to static files only). They are JSON with `nosniff` and `no-store`, so the risk is small | none needed |

## 11. Risks

| Risk | Mitigation |
|---|---|
| CPU limit: 10 ms per request on the free plan; an import page of 100 visits does HMAC, AES-GCM and rule checks for each | Workers Paid (Q1). Otherwise lower the connector's page size |
| Region and latency: D1 primary in APAC, Functions at the nearest edge | clinic staff in Singapore hit a Singapore edge location; keep read replication off |
| Residency: the location hint is not a legal guarantee | Q3; keep real data off until the data-intermediary agreement says what is needed |
| AI cost and rate limits | `AI_DAILY_CALL_CAP` (200, 20 on Preview), a workspace spend limit on Jura's Anthropic key; AI fails closed per call |
| Vendor limits: D1 database size and daily row limits on the free plan; Access is free up to 50 users | one clinic is far inside these; revisit on a second clinic |
| Drift between Production and Preview | the README table and wizard stages 8–10 set both; `ACCESS_*` and role lists must match, the database, key and tokens must not |
| Settings that don't take effect | Pages binds variables at deployment time; every settings change ends with a redeploy (stage 12) |
| Service token expiry stops every import | expiry captured by the wizard; renew a month ahead; rotation is a coordinated change |
| Losing `IDENTIFIER_KEY` | password manager copy is part of the backup (§8) |
| A deployment before Access is in place | everything fails closed (503) and the database is empty; Access goes on a hostname before the hostname goes live |
| Node 20 end of life | wrangler 4.86.0 is the last release that runs on Node 20. Move `.nvmrc`, CI and the wrangler pins to Node 22 LTS together in a follow-up |
| `npm ci` on Linux with a lockfile made on macOS | the suite, typecheck and build pass here in UTC (CI's timezone); the first CI run on GitHub confirms the Linux install |

## 12. Questions for Ting Yu

- **Q1. Plan tier.** Recommended: Workers Paid, for the CPU limit and 30-day Time Travel.
- **Q2. Custom domain.** Recommended: a subdomain of a Jura or clinic domain already on Cloudflare,
  added to Access before Pages. Not blocking: `chas-claimer.pages.dev` works behind Access meanwhile.
- **Q3. Residency in writing.** Recommended: before `ALLOW_REAL_IDENTIFIERS=yes`, confirm with
  Cloudflare what they commit to for D1 and Time Travel storage location, and record it with the
  data-intermediary agreement.
- **Q4. `IDENTIFIER_KEY` rotation (I1).** Recommended: a ticket for the §9 fix before real data.
