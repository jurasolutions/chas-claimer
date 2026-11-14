# Release: chas-claimer 0.1.0

_Crew release manager, 2026-11-14. Branch `crew/chas-claimer` at `392f46f`, base `main` at `bcbd9f6`.
Written before QA 04 and the quality gate: sections marked **pending** are filled in after both._

## 1. Release notes (for Ting Yu)

The claims desk is ready as a first version, on synthetic data only.

It takes claim-ready visits from the clinic's records through a small connector, works out what
CHAS, MediSave (Flexi and TOSP) and each insurer should pay in waterfall order, and lets a
reviewer approve each claim before it is sent. Claims go out through the payer's portal with a
checklist, as a CSV file, or to an API. A built-in payer simulator lets the team rehearse the
whole cycle. Payment statements can be imported and matched to claims. Every change is recorded
in the claim's history.

AI is optional and off until you add a key. Nothing it receives carries a patient's NRIC, name,
phone number or address. Real NRICs are refused until you switch them on, which waits for the
data-intermediary agreement.

Nothing is deployed yet. `scripts/setup-wizard.sh` walks you through Cloudflare in order. The
things only you can do are in section 6. The changes are in `CHANGELOG.md`, with the known limits
an operator needs.

## 2. Release checklist (`crew:release-checklist`)

### Readiness

| Item | | Note |
|---|---|---|
| `reviews/quality-gate.md` says GO at the branch's current SHA | ❌ pending | Not written yet. It follows QA 04. **Blocks release** until it says GO at the release commit |
| Every `reviews/code-review-*.md` approves, `final` included | ❌ waiver | `code-review-final-fix.md` approves the final review's blockers. Each changes-requested ticket review was followed by a fix round and a conductor re-review. Two late rounds had no second reviewer: `code-review-qa02.md` B1 and `code-review-qa03.md` B1 were fixed and accepted by the conductor against the reviewer's own probes (crew-log, "QA 02 merge", "QA 03 merge"). QA 04 is the independent check. Waiver for Ting Yu |
| Branch up to date with its base; suite green after | ✅ | `main` (`bcbd9f6`) is an ancestor of `392f46f`, 395 commits ahead. Suite green at `392f46f` (section 8) |
| No commit touches a blocked path | ✅ | `git diff main...crew/chas-claimer` is empty for `src/design-system/`, `dist/`, `.env`, `.dev.vars`. `.github/workflows/ci.yml` is new, created with the conductor's authorisation (crew-log, infra entry) |
| No secrets, `.env` files or credentials in the diff | ✅ | Keyword grep reviewed: hits are documentation, placeholders and variable names. No key shapes (`sk-ant-`, `ghp_`, `AKIA`, private keys). No `.env`, `.dev.vars` or `wrangler.toml` tracked. The `dev:functions` script's `IDENTIFIER_KEY` is a published development constant, ranked not-a-secret in `code-review-final.md` N-1 |

### Package

| Item | | Note |
|---|---|---|
| Version bumped per convention | ✅ | `package.json` and `package-lock.json` already record `0.1.0` (the card's first version). No install needed |
| `CHANGELOG.md` entry | ✅ | `0.1.0 — 2026-11-14`: what was added and the known limits, in plain sentences |
| Release notes for users | ✅ | Section 1. The repo publishes none separately |
| PR body in `reviews/pr-body.md` | n/a | No pull request on this ship path: `main` is rebuilt as one root commit and pushed to an empty remote (section 5). The root commit message in section 5 carries the description |

### Runtime

| Item | | Note |
|---|---|---|
| Migrations forward-tested; down path or reason | ✅ | 0001–0004 apply to local D1 on every `npm run dev:functions` set-up and in the tests. D1 has no down migration: each one is additive or only widens a trigger, so the deployment before it still runs. The undo is a Time Travel restore (section 4) |
| New configuration documented per environment | ✅ | README "Configuration" and "Production and Preview" tables, `.dev.vars.example`, wizard stages "Plain-text variables" and "Secrets" |
| Feature flags and defaults | ✅ | `DEMO_MODE` unset (simulator and synthetic import off; on at localhost). `ALLOW_REAL_IDENTIFIERS` unset (real NRICs refused). AI off without `ANTHROPIC_API_KEY`; `AI_DAILY_CALL_CAP` default 200, `0` turns AI off |
| What to watch, for how long | ✅ | Section 3, "Watch" |

### Rollback

| Item | | Note |
|---|---|---|
| Revert range or PR | ✅ | Feature range `bcbd9f6..<release commit>` on `crew/chas-claimer`. After the rebuild, `main` is one root commit, so the code rollback is Pages "Rollback to this deployment" (section 4) |
| Side effects a revert does not undo | ✅ | Section 4 |

### Options for G4

✅ Laid out in section 5. The conductor has already chosen.

**Open items:** the quality gate (blocks release) and the code-review waiver (for Ting Yu).
QA 04 (`reviews/qa-04.md`) is still running.

## 3. Deploy order

Ting Yu runs this, in this order, with `bash scripts/setup-wizard.sh`. README "Deploy" is the
reference behind each step.

1. **Sign wrangler in** to the Cloudflare account (Workers Paid recommended, infra Q1).
2. **Create the two D1 databases in Asia-Pacific:**
   `npx wrangler@4.86.0 d1 create chas-claimer-preview --location apac` and
   `npx wrangler@4.86.0 d1 create chas-claimer --location apac`. The location is a hint for the
   primary copy, fixed at creation. It is not a Singapore guarantee. Leave read replication off.
3. **Note each database's Time Travel bookmark** (`d1 time-travel info <name>`), then **apply
   migrations 0001–0004 to `chas-claimer-preview` first, then `chas-claimer`**, with
   `wrangler d1 migrations apply <name> --remote -c .wrangler/d1-remote.toml` (the wizard writes
   that git-ignored config).
4. **Create the Pages project** from the dashboard: production branch `main`, build
   `npm run build`, output `dist`. The first deployment answers 503 everywhere until settings exist.
5. **Create one Access application** covering the custom domain, `chas-claimer.pages.dev` and
   `*.chas-claimer.pages.dev`, with an Allow policy for reviewers and officers. Do not use the
   Pages project's own Access toggle.
6. **Create the connector's service token** and a Service Auth policy for it.
7. **Runtime and bindings:** compatibility date `2026-05-01`, no flags; `DB` bound to
   `chas-claimer` on Production and `chas-claimer-preview` on Preview.
8. **Variables and secrets** per environment, from README "Configuration", the "Production and
   Preview" table and `.dev.vars.example`. Production: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`,
   `ROLE_REVIEWERS`, `ROLE_OFFICERS`, `CONNECTOR_TOKEN`, `IDENTIFIER_KEY`; optionally
   `ANTHROPIC_API_KEY`. Preview: its own `IDENTIFIER_KEY`, `DEMO_MODE=yes`,
   `AI_DAILY_CALL_CAP=20`, no `CONNECTOR_TOKEN`, no payer tokens. Save each secret in the
   password manager before pasting it. **`DEMO_MODE` stays unset on Production**, and
   **`ALLOW_REAL_IDENTIFIERS` stays unset** until section 6 says otherwise.
9. **Custom domain and HSTS**, once the domain is chosen: add it to the Access application first,
   then to Pages. Turn on HSTS for the domain's zone (SSL/TLS, Edge Certificates); `pages.dev` is
   already preloaded, a custom domain is not (infra I3).
10. **Redeploy** (Retry deployment on the latest Production build), since Pages binds variables when
    a deployment is created.
11. **Smoke check** (README table, wizard stage "Smoke check"): anonymous requests get a 302 to
    Access on every hostname; `/api/me` with the service token gets 401; a wrong bearer on
    `/api/imports` gets 401; the CSP header is there; a reviewer sees both roles.
12. **Payer channels.** As a reviewer, in Settings, move every real payer off the default
    `simulator` channel to `assisted`, `file` or `api`, with its field template; set `portalUrl`
    through the settings API where a link helps (README "Portal links"). For each `api` payer, set
    `PAYER_<ID>_API_TOKEN` on Production only, pointing at a test endpoint until the payer
    confirms, then redeploy.
13. **Connector at the clinic** with `CLAIMS_DESK_URL`, `CONNECTOR_TOKEN` and the service token's
    `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in its environment. With real identifiers
    still refused, only synthetic data imports.

### Watch

- For the first hour after each deployment:
  `npx wrangler@4.86.0 pages deployment tail --project-name chas-claimer --status error`.
- Through the first week of use: Pages 5xx rate, Zero Trust Access logs for refusals, D1 rows read
  and written, and the `ai_usage` table if AI is on.
- Roll back on any `{"code":"internal"}` line on a route that worked before, any 503
  `auth_not_configured` or `identity_not_configured` on Production, or any anonymous request that
  reaches the desk without the Access login (then also pause the project or pull the hostname).

## 4. Rollback plan

- **Code:** Pages, Deployments, the last good Production deployment, **Rollback to this
  deployment**. It takes effect at once. For this first release there is no earlier good
  deployment: roll back by pausing the project or removing its custom domain. For later releases,
  reverting the release commit on `main` and pushing also works.
- **Schema and data:** note the Time Travel bookmark before each migration
  (`npx wrangler@4.86.0 d1 time-travel info chas-claimer`). Migrations 0001–0004 are additive or
  only widen a trigger, so older code keeps running against the newer schema and a code rollback
  needs no database change. Restore (`d1 time-travel restore chas-claimer --bookmark=<bookmark>` or
  `--timestamp=...`) only when the data itself is damaged: it replaces the whole database,
  including the audit trail, and prints a bookmark that undoes the restore.
- **Turn AI off:** set `AI_DAILY_CALL_CAP=0` and redeploy. The key stays, and every AI button says
  the limit is reached (`server/ai/run.ts`, `takeCall` returns false at 0). Or remove
  `ANTHROPIC_API_KEY` and redeploy: the buttons say AI isn't set up. Both are supported. A value
  that isn't a whole number falls back to 200, so set exactly `0`.
- **Stop real identifiers:** unset `ALLOW_REAL_IDENTIFIERS` (anything but `yes` counts as off) and
  redeploy. Imports and statements carrying an NRIC outside the `T9` block are refused again with
  422 `real_identifier_refused`. Data already imported stays sealed on the desk.
- **Stop the simulator:** unset `DEMO_MODE` and redeploy; its routes answer 404.
- **What a rollback does not undo:** claims already sent to a payer, CSV files already downloaded or
  uploaded to a portal, prompts already sent to Anthropic (de-identified), audit events, Access
  and service-token changes. After a secret rotation, don't roll back to a deployment built before
  it. After an `IDENTIFIER_KEY` rotation, don't roll back to a build without key rotation (0.1.0 and
  later all have it).

## 5. G4 merge plan (decided by the conductor)

The options from `finishing-a-development-branch` were: merge locally, push and open a pull
request, keep the branch, or discard on request. The conductor chose a variant of "merge locally,
then push", recorded here as decided (crew-log, "final review decisions"; Ting Yu's delegation on
the operating card).

**Why main is rebuilt.** `main` holds three local, unpushed planning commits on top of the first.
One of them, `3885cec`, carries an identifier since redacted on the feature branch, and every
commit carries a LAN-host default author address. A merge would publish both, and nothing has been
pushed, so no shared history is rewritten.

**Steps for the conductor**, after the release commit (this file, `CHANGELOG.md`, QA 04 and the
quality gate) lands on `crew/chas-claimer`:

1. Keep the old `main`: `git branch -m main archive/main-planning`. It and every `crew/*` branch
   stay local and are never pushed.
2. Make one root commit holding the release tree, with the identity set per command, never in git
   config:

   ```sh
   REL=$(git rev-parse crew/chas-claimer)
   JURA='321973523+jurasolutions@users.noreply.github.com'
   NEW=$(GIT_AUTHOR_NAME='Jura release' GIT_AUTHOR_EMAIL="$JURA" \
         GIT_COMMITTER_NAME='Jura release' GIT_COMMITTER_EMAIL="$JURA" \
         git commit-tree "$REL^{tree}" -F <message file>)
   git branch main "$NEW"
   ```

   The identity is the one the Jura landing-page repo already releases under.
3. No tag. The operating card says "No release tags", so the version lives in `package.json` and
   `CHANGELOG.md` only.
4. Push only `main`, with no force (the remote is empty): `git push origin refs/heads/main`. Never
   `--all`, `--mirror` or `--tags`, which would publish `crew/*` or `archive/main-planning`.

**Root commit message (draft):**

```
Release the claims desk, version 0.1.0

The first version of the claims desk for a Singapore dental clinic. It imports
claim-ready visits through the clinic connector, builds CHAS, MediSave (Flexi and
TOSP) and insurance claims through the payer waterfall, and sends them through
assisted, file and API channels or the payer simulator, with remittance
matching, an audit trail, key rotation and optional AI behind a
de-identification gate. Synthetic data only until real identifiers are
switched on.

See CHANGELOG.md for the changes and known limits.
```

(The commit-message attribution lines from the session are added by the conductor.)

**Verification after the push:**

- `git ls-remote origin` lists only `refs/heads/main` (and `HEAD`), and `main` is `$NEW`.
- `git log --format='%an <%ae> | %cn <%ce>' origin/main` shows only the Jura release identity.
- In a fresh clone, on Node 20 from `.nvmrc`: `npm ci && npm run typecheck && npm test && npm run build`,
  all green. `npm test` includes the SC7.6 guard over every tracked file at the release tree.
- CI on GitHub goes green for the push to `main`.

**Conductor decision:** no tag, per the operating card ("No release tags"). A tag is an outward-facing
step the card rules out, and nothing in this release needs one.

## 6. What Ting Yu must still do

**Cloudflare and secrets**

- Run `bash scripts/setup-wizard.sh`: account and plan (Workers Paid), wrangler sign-in, the two
  D1 databases, migrations, Pages project, Access application and service token, variables and
  secrets, custom domain and HSTS, redeploy, smoke check (section 3).
- Generate every secret with `openssl rand -base64 32` and keep it in the password manager before
  pasting it. Separate `IDENTIFIER_KEY` values for Production and Preview.
- Choose the custom domain (infra Q2). Renew the service token a month before it expires.

**The clinic** (PRD §6, through Ting Yu)

- Answer questions 1–10: the CMS and database, who logs into MHCP and NPHC, MediSave
  accreditation and portals, MCAF capture, the insurer and TPA panel and their submission methods,
  redacted notice samples, the 16 benchmark ranges not yet transcribed, branches and GST, monthly
  volumes, and the data-intermediary agreement.
- Run the timed CHAS checklist with a person (follow-up 21) before the desk replaces the current
  way of claiming.

**Before any automated or third-party submission**

- Get MOH/AIC to confirm whether Jura may submit as a Corppass third-party entity, or through a
  browser extension in the clinic user's own tab (PRD §6 Q2, ADR 0001). Until then, CHAS and
  MediSave go through the assisted checklist.
- From 13 Nov 2026, MHCP accepts connections from Singapore IP addresses only. Officers using the
  assisted checklist must be on a Singapore connection, and any future automated route must leave
  from a Singapore address.

**Before `ALLOW_REAL_IDENTIFIERS=yes`**

- Sign the data-intermediary agreement with the clinic.
- Get Cloudflare's residency commitment for D1 and Time Travel storage in writing, and file it with
  the agreement (infra Q3).
- Decide follow-up 20: a name list from the CMS, or free-text notes kept out of AI calls.
- Then set it on Production only and redeploy.

**Code and upstream**

- Approve the design system fixes at source in `jurasolutions/design-system` (follow-ups 6, 14, 18,
  23: Field hint and `aria-describedby`, Dialog focus and focus return, Button default `type`), then
  `npm run sync:ds`.
- Move `.nvmrc`, CI and the wrangler pin to Node 22 together, after running the suite on 22
  (follow-up 13).
- Build follow-up 22 (revive a claim withdrawn by a settings change) before changing the waterfall
  or the code map on the live desk.
- Set up a staging payer for the API channel and UAT 5.10 and 7.5 (follow-up 15).
- When the first version is accepted, move the PRD to `prd/done/` with the ship date.

## 7. After QA 04 and the quality gate (pending)

- Record QA 04's result and the gate's verdict and SHA in section 2, Readiness.
- If either changes code, re-run section 8 at the new SHA, and add any new known limit to
  `CHANGELOG.md`.

## 8. Evidence at `392f46f` (Node 20.20.2)

- `npx vitest run` → 102 files, 1492 tests passed.
- `npm run typecheck` → exit 0.
- `npm run build` → built, `dist/assets/index-*.js` 421 kB.
- `npx vitest run tests/synthetic-data.test.ts` → passed, with `CHANGELOG.md` and this file added
  to a scratch copy of the index (the guard reads `git ls-files`, so it skips files not yet
  tracked). It runs again over both once they are committed.
