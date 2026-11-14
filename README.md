# chas-claimer

A claims desk for a Singapore dental clinic. It pulls claim-ready visits out of the clinic's own
records, checks them against each scheme's rules, and submits them to CHAS, MediSave and dental
insurers through one adapter per payer channel. Built by Jura Solutions.

The desk is a React app on Cloudflare Pages, with Pages Functions for the API and D1 for storage.
A small connector runs at the clinic and pushes visits to the desk.

**This repo is public.** It holds no real patient data. Every record in `mock/` and the tests is
synthetic, and every synthetic NRIC sits in the reserved `T9` block (T9000000 to T9999999, with a
valid check letter). See `GLOSSARY.md`.

## Layout

| Path | Holds |
|---|---|
| `src/` | The desk UI (React) and the pure domain code it shares with the server |
| `src/domain/` | Money in cents, SGT dates, NRIC checks and masking, closed unions, source visits, settings, CSV |
| `src/api/` | Request and response types shared by the UI and the Functions |
| `src/design-system/` | Read-only copy of the Jura design system. Change it at source, then `npm run sync:ds` |
| `server/` | Code the Functions call: environment, `route()`, Access JWT checks, identifier keys, repositories |
| `functions/api/` | One Pages Function per route |
| `migrations/` | D1 schema |
| `connector/` | The clinic-side connector |
| `mock/` | The synthetic clinic |
| `public/` | Static files copied into `dist/`, including `_headers` |
| `tests/` | Shared test set-up and helpers, plus cross-cutting tests |
| `docs/adr/` | Architecture decisions |

## Commands

| Command | Does |
|---|---|
| `npm install` | Installs dependencies from the committed lockfile |
| `npm run dev` | The UI alone on http://localhost:5173. API calls fail here: Vite does not run Functions |
| `npm run db:migrate:local` | Applies `migrations/` to a local D1 in `.wrangler/state`. Run it once before `dev:functions` |
| `npm run dev:functions` | Builds, then serves the UI, the Functions and the local D1 on http://localhost:8788 |
| `npm test` | Runs the whole suite. Tests never touch the network |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm run build` | Builds the UI into `dist/` |
| `npm run connector` | Runs the clinic connector |
| `npm run mock:clinic` | Generates the synthetic clinic |
| `npm run sync:ds` | Copies the design system in from `jurasolutions/design-system/` |

`npm run dev:functions` passes public, development-only values on the command line: a `DEV_USER`,
the two role lists, `DEMO_MODE=yes` and a fixed `IDENTIFIER_KEY`. That key is published in
`package.json`, so it protects nothing. Never use it outside your own machine: the desk refuses it
on any hostname but localhost, 127.0.0.1 or [::1], and answers 503 `identity_not_configured`
instead.

Property tests run from a fixed seed. Set `FC_SEED` to try another one.

## Configuration

Secrets live in Cloudflare Pages environment variables, or in `.dev.vars` on your own machine
(copy `.dev.vars.example`, which holds placeholders only). Never put them in a file in the repo. There is no `wrangler.toml`: `wrangler.local.toml` is for
local development only, and Pages does not read it.

| Variable | Required | What it does |
|---|---|---|
| `DB` | yes | The D1 binding. Set it in Pages under Settings, Bindings |
| `ACCESS_TEAM_DOMAIN` | yes | Your Access team domain, `<team>.cloudflareaccess.com`. Without it, or without `ACCESS_AUD`, every signed-in route answers 503 `auth_not_configured` |
| `ACCESS_AUD` | yes | The Application Audience (AUD) tag of the Access application |
| `ROLE_REVIEWERS` | yes | Comma-separated emails. Reviewers also hold the officer role |
| `ROLE_OFFICERS` | yes | Comma-separated emails. Someone on neither list is refused with 403 |
| `CONNECTOR_TOKEN` | yes | At least 43 characters: 32 random bytes in base64, as the command below makes. Accepted only on `POST /api/imports`. Unset or shorter, the import route answers 503 `auth_not_configured` |
| `IDENTIFIER_KEY` | yes | 32 random bytes, base64. The current key: it keys the patient hashes and seals each visit's identity. Without it, every route that touches identity answers 503 `identity_not_configured` |
| `IDENTIFIER_KEY_VERSION` | no | The current key's version, a whole number from 1 to 999. Default 1. Every stored hash and seal carries it as a `v<n>:` prefix. Raise it by one at each rotation. Anything else, and identity routes answer 503 |
| `IDENTIFIER_KEY_PREVIOUS` | during a rotation | The key one version back. Set it only while a rotation is under way (see [Rotating secrets](#rotating-secrets)). It must differ from `IDENTIFIER_KEY`, and it is refused at version 1 |
| `ALLOW_REAL_IDENTIFIERS` | no | `yes` lets an NRIC outside the synthetic `T9` block through the import guard. Anything else, and such an import is refused with 422 `real_identifier_refused`. Leave it unset until the data-intermediary agreement is signed |
| `ANTHROPIC_API_KEY` | no | Turns on AI suggestions. Nothing sent carries an NRIC, a name, a phone number or an address |
| `ANTHROPIC_BASE_URL` | no | Overrides the Anthropic API address |
| `AI_DAILY_CALL_CAP` | no | The most AI calls the desk makes in a day. Default 200. `0` turns AI suggestions off: each one answers that the limit is reached |
| `DEMO_MODE` | no | `yes` turns on the synthetic clinic import and the payer simulator (both are always on at `localhost`). Leave it unset on the clinic's live desk |
| `DEV_USER` | no | Local development only. An email to act as, honoured only when the request's host is `localhost`, `127.0.0.1` or `[::1]`. Set in the Pages dashboard, it does nothing |
| `PAYER_<ID>_API_TOKEN` | per payer | The API token for a payer on the `api` channel. The name is derived from the payer ID, never configured, so settings cannot point a payer at another secret |

To make a 32-byte key for `CONNECTOR_TOKEN` or `IDENTIFIER_KEY`:

```sh
openssl rand -base64 32
```

Production and Preview each get their own D1 database, both created in the Asia-Pacific region.
See [Deploy](#deploy).

## Cloudflare Access set-up

The desk trusts only a verified Access token. Ting Yu sets this up once, in the Cloudflare
dashboard (see ADR 0007).

1. **One Access application covers every address the desk answers on:** the custom domain,
   `*.pages.dev` and preview deployments. A preview left outside the application is open to anyone.
2. Add a policy that allows the reviewers and officers by email.
3. Copy the team domain into `ACCESS_TEAM_DOMAIN` and the application's AUD tag into `ACCESS_AUD`.
4. **The connector passes Access with a service token.** Create an Access service token, add a
   Service Auth policy for it, and give the connector its `CF-Access-Client-Id` and
   `CF-Access-Client-Secret`. The connector also sends `CONNECTOR_TOKEN` as a bearer token. Prefer
   this to a bypass policy on `/api/imports`: it keeps two independent secrets between the
   internet and the import route.
5. **Rotating either secret is a coordinated change:** update the Pages variable and the clinic's
   connector environment together, then redeploy.

The desk reads the user's email from the verified `Cf-Access-Jwt-Assertion` token only. It never
trusts the plain `Cf-Access-Authenticated-User-Email` header.

## Security headers

`public/_headers` sets a Content Security Policy with `frame-ancestors 'none'`, `no-referrer` and
`nosniff` for every page. Every API answer carries `Cache-Control: no-store`.

The policy loosens two things on purpose, because the read-only design system needs them: styles
allow `'unsafe-inline'` (the design system renders `<style>` elements for its keyframes) and Google
Fonts (its `tokens/fonts.css` imports them). Scripts stay `'self'`.

## The synthetic clinic

`mock/synthetic-clinic/` builds a made-up dental clinic for tests, demos and the UAT run. Every
row in it is synthetic. Identifiers come from the reserved T9 test block with a valid check
letter (see `GLOSSARY.md`), phone numbers use `+65 0000`, and the only insurers are two
fictional payers, Meridian Dental Plan and Harbour TPA. A deny-list test fails the build if a
real insurer or TPA name appears.

`generateClinic({ seed, asOf })` is a pure function: no database, network or clock. The same
seed and date always give the same clinic, byte for byte. It returns:

- `records`: the clinic's own rows (patients, CHAS cards, policies, appointments, treatment
  lines, MediSave details, pre-authorisations)
- `visits`: those rows as source visits, about 60 patients and 200 visits
- `cases`: each UAT case (D01 to D27, with their lettered variants) mapped to its visit keys,
  such as `SC-D01`
- `settings` and `codeMap`: the clinic's desk settings and code map from UAT §2.1
- `remittances`: the R1 CHAS and R2 Meridian statements from UAT §2.3, as CSV text

Expected claim amounts belong to the rule-engine tests, not to the generator.

### Procedure keys

The code map (`mock/synthetic-clinic/config.ts`) turns each clinic code into the key a rule set
reads. The CHAS rule set and the fee benchmarks use the CHAS keys below, so a rule written for
`CONSULTATION` matches the clinic's `CON` line. The two benchmark overrides in the settings are
keyed `CONSULTATION` and `CROWN_PERMANENT`. Harbour TPA needs a pre-authorisation for `H-CRN`;
Meridian needs none. `NEW-99` is left out on purpose: it is D20's unmapped code. A test keeps
this table and the code map in step.

| Clinic code | Target | Key |
|---|---|---|
| `CON` | chas | `CONSULTATION` |
| `SCL` | chas | `SCALING` |
| `XR` | chas | `XRAY` |
| `FIL-S` | chas | `FILLING_SIMPLE` |
| `EXT-P` | chas | `EXTRACTION_POSTERIOR` |
| `RCT-A` | chas | `RCT_ANTERIOR` |
| `RCT-P` | chas | `RCT_PREMOLAR` |
| `RCT-M` | chas | `RCT_MOLAR` |
| `CRN` | chas | `CROWN_PERMANENT` |
| `WHT` | chas | not claimable |
| `SURG-WT` | tosp | `SF813T` |
| `SURG-WTS` | tosp | `SF811T` |
| `PRS` | tosp | `SF708T` |
| `IMP` | tosp | `SB816M` |
| `RCT-A` | benefit (MERIDIAN) | `RC1` |
| `RCT-P` | benefit (MERIDIAN) | `RC1` |
| `RCT-M` | benefit (MERIDIAN) | `RC1` |
| `CRN` | benefit (MERIDIAN) | `CR1` |
| `CRN` | benefit (HARBOUR) | `H-CRN` |
| `FIL-S` | benefit (HARBOUR) | `H-FIL` |
| `EXT-P` | benefit (HARBOUR) | `H-EXT` |

### Writing the clinic's database

```sh
npm run mock:clinic -- --seed 7 --as-of 2026-11-13 --out ../clinic.sqlite
```

This writes three files next to `--out`, which should be outside the repo, and prints counts and
file paths only, never a row:

- `clinic.sqlite`: the clinic's database in its own schema (`mock/synthetic-clinic/schema.sql`),
  which the connector reads
- `clinic.r1-chas.csv`: the R1 CHAS statement
- `clinic.r2-meridian.csv`: the R2 Meridian statement

Swap in the run's own references before importing either statement (UAT 7.1 and 7.5). R1 carries
`MHCP-0001` and `MHCP-0002`, the references UAT 5.6 and 5.9 record by hand for D01 and D03; if you
recorded others, put those in the `reference` column instead. R2's `Claim Ref` is the placeholder
`MDP-0001`: replace it with the reference the simulator gave D04b's Meridian claim at UAT 5.10, or
R2 lands under "Match by hand" instead of marking that claim `paid`.

The schema has these tables: `branches`, `doctors`, `patients`, `chas_cards`, `insurance_policies`,
`appointments`, `treatment_lines`, `medisave_details` and `preauthorisations`. Money is in cents,
dates are `YYYY-MM-DD` text, and the CHAS tier, treatment status, MCAF type and holder
relationship use the desk's own spellings.

For the re-import steps (UAT 5.12, 5.14, 5.15, 5.16 and 6.3), the tester edits this file with any
SQLite tool and re-imports. Fees are in cents. For example, UAT 5.12 sets D01's scaling to $55.00
plus $4.95 GST:

```sql
UPDATE treatment_lines SET fee_cents = 5500, gst_cents = 495
WHERE appt_no = 'SC-D01' AND item_code = 'SCL';
```

UAT 5.16 adds a pre-authorisation, approved on the day the crown was prepared, and UAT 6.3 changes
a treatment code. A pre-authorisation lands on the patient's policy with the same insurer; one for
an insurer the patient has no policy with is refused when the file is read:

```sql
INSERT INTO preauthorisations (appt_no, insurer_code, benefit_code, preauth_ref, approved_on)
VALUES ('SC-D16', 'HARBOUR', 'H-CRN', 'PA-0016',
        (SELECT appt_date FROM appointments WHERE appt_no = 'SC-D16-PREP'));
UPDATE treatment_lines SET item_code = 'RCT-P' WHERE appt_no = 'SC-D27' AND line_no = 1;
```

## Running the connector at the clinic

The connector runs on a machine at the clinic. It reads visits from the clinic's records through a
source mapping and sends them to the desk's `POST /api/imports`. It only reads the clinic's
records and never changes them.

**The source** is either a SQLite file or a folder of CSV files. A CSV folder holds one
`<table>.csv` per table, with the column names on the first line. A skipped row is reported by
where it sits: `appointments row 37` for SQLite, `appointments.csv line 5` for CSV.

**The mapping** is a JSON file that names the clinic's tables and columns for each field the desk
needs. `connector/mappings/synthetic-clinic.json` maps the synthetic clinic. Start from a copy of
it when writing a mapping for a real clinic's schema.

**The environment** holds the desk's address and tokens. They are never read from a file in this
repo or from the command line:

| Variable | Required | Notes |
|---|---|---|
| `CLAIMS_DESK_URL` | yes | The desk's address, such as `https://claims.example.test`. It must use `https`; plain `http` is allowed only for this machine (`localhost`, `127.0.0.1` or `[::1]`) |
| `CONNECTOR_TOKEN` | yes | The same value as the desk's `CONNECTOR_TOKEN`, sent as a bearer token |
| `CF_ACCESS_CLIENT_ID` | yes, unless the desk is on this machine | The Access service token's client ID (see [Cloudflare Access set-up](#cloudflare-access-set-up), step 4). The connector will not push to a desk on another machine without it |
| `CF_ACCESS_CLIENT_SECRET` | yes, unless the desk is on this machine | Its client secret. For a desk on this machine both Access variables are optional, but set both or neither |

The commands:

```sh
# Lists the source's tables and column names, never a value. Use it when writing a mapping.
npm run connector -- describe --source <clinic.sqlite | csv folder>

# Reads every visit through the mapping. Prints the count, any skipped rows and the first visit with
# its identifiers masked. Sends nothing.
npm run connector -- dry-run --mapping <mapping.json> --source <clinic.sqlite | csv folder>

# Reads the visits and sends them to the desk.
npm run connector -- push --mapping <mapping.json> --source <clinic.sqlite | csv folder>
```

`--since YYYY-MM-DD` limits `dry-run` and `push` to visits on or after that date.

Run `dry-run` before the first `push` with a new mapping.

**How `push` sends visits:**

- Visits are sorted with a patient's earlier visits first, then sent in pages of at most 100.
  Each page is its own import on the desk.
- A 5xx answer or a dropped connection is retried 3 times, after waits of 1, 2 and 4 seconds.
- A refusal is never retried. That covers a wrong token (401), an Access refusal and a page the
  desk rejects.

The output shows counts, row positions and masked identifiers only. A full NRIC, name or phone
number never appears in it.

| Exit code | Meaning |
|---|---|
| 0 | Done. Rows the mapping could not read were skipped and listed; fix them at the source and run again |
| 1 | The source could not be read, or the desk refused or could not be reached. The output names the page; the pages before it are imported and complete |
| 2 | A bad argument, an invalid mapping (each problem is named by path) or a missing environment variable. Nothing was read or sent |

**Running again is always safe.** The desk leaves an unchanged visit alone, so a run that stopped
partway can simply be repeated. The repeat imports the remaining pages and changes nothing in the
pages already imported. A wrong `CONNECTOR_TOKEN` stops the run with "The desk refused the token",
and nothing is imported.

## Payer channels and API tokens

Each payer in settings has one channel. A claim keeps the channel it had when it was approved, so
changing a payer's channel affects only claims approved after the change. Approved claims are sent
from **Send claims** (`/submit`), grouped by payer.

| Channel | What happens when you send |
|---|---|
| `assisted` | Nothing leaves the desk. You open each claim's checklist, copy its fields into the payer's portal in order, and record the reference the portal gives you. Only one officer holds a checklist at a time. Anyone else can take it over after confirming |
| `file` | The desk gives you one CSV for the payer: the template's fields as columns, one row per claim. A cell that starts like a spreadsheet formula is neutralised. The file is not stored. The claims stay approved until you upload the file to the portal and confirm the upload on the desk |
| `api` | The desk posts each claim to the payer's API, one at a time, and records the reference that comes back |
| `simulator` | The desk's own stand-in for a payer, for demos and training. The claim lands in the **Payer simulator** inbox, where a person accepts it, rejects it or pays it. Nothing reaches a real payer, and the packet stays masked |

Each claim that is sent, exported or confirmed gets its own audit event.

The simulator records payments with no money behind them, so it is off on a deployed desk. It runs
only when `DEMO_MODE=yes`, or when you open the desk as `localhost` on your own machine. While it is
off, the **Payer simulator** page has nothing to show (its routes answer 404), and a claim approved
for a `simulator` payer is refused with "The payer simulator is off on this deployment." On a
deployed desk, give every payer a real channel before claims are approved.

### Portal links

A claim's checklist can link straight to the payer's portal. Each payer in settings has an optional
`portalUrl`, blank by default. When it is set, the checklist shows **Open portal**, which opens the
portal in a new tab. When it is blank, there is no link.

The Settings screen has no field for it yet. To set it, a reviewer reads the document with
`GET /api/settings`, sets `portalUrl` on the payer, and saves the whole document with
`PUT /api/settings` (`{ "settings": …, "expectedVersion": … }`). Set it back to `null` to remove the
link. It follows the API address rules below: `https` only, with a host name, and no IP address,
`localhost`, user name or password. Changing it does not rebuild any claims.

### API tokens

A payer on the `api` channel needs a token. Set it as `PAYER_<ID>_API_TOKEN`, where `<ID>` is the
payer's ID from settings. For example, the token for `MERIDIAN` is `PAYER_MERIDIAN_API_TOKEN`. Put it
in the Cloudflare Pages environment variables, or in `.dev.vars` on your own machine. It is never
stored in settings. The desk never writes it to D1, the audit trail, a response or a log. If the
token is missing, the desk refuses to send to that payer and says the token is not set.

### What the api channel sends

- The payer's API address in settings must be `https`, with a host name. An IP address, `localhost`
  or a user name and password in the URL are refused.
- The request is a `POST` with a JSON body:
  `{ "claimId": "…", "payerId": "…", "fields": { "<template field>": "text or null" } }`.
- The token goes in `Authorization: Bearer <token>`. If the payer's settings name another header in
  `apiAuthHeader`, the bare token goes in that header instead.
- `Idempotency-Key` is 64 hex characters. It is fixed for a claim at a given visit revision until the
  payer has the claim, so a send repeated after a timeout reaches the payer as one claim. A claim the
  payer rejected, reopened and sent again gets a new key.
- A 2xx answer must be JSON `{ "reference": "…" }` with 1 to 80 characters.
- Redirects are not followed. A send stops after 15 seconds. An answer over 64 KB is refused.
- A claim that could not be sent stays approved, and the desk shows why: `timeout`, `network`,
  `redirect`, `http_<status>` or `bad_response`. Sending it again is safe.

## AI suggestions

AI is optional. Without `ANTHROPIC_API_KEY` every screen works as before, and pressing an AI
button says "AI isn't set up". With a key, four buttons ask for a suggestion and show it beside
the work, marked as AI's:

| Button | Where | Who | What comes back |
|---|---|---|---|
| Suggest code | Settings, unmapped clinic codes | officers and reviewers ask; a reviewer accepts | A CHAS procedure, or "not claimable under CHAS", with a reason |
| Explain the rejection | A rejected claim | officers and reviewers | What the rejection means and what might fix it |
| Draft a justification | A claim's annotations | officers and reviewers | A draft for the dentist to edit |
| Propose a mapping | Settings, source mapping | reviewers | Which tables and columns hold what the desk reads |

Nothing is saved until someone accepts it. An accepted code suggestion goes through the code-map
route with origin `ai_accepted`; a draft goes into the form, to edit before saving; an accepted
mapping goes into the form, to save with the settings. Dismissing one changes nothing.

### What is sent, and what never is

| Sent | Never sent |
|---|---|
| A claim's scheme, payer, treatment lines (codes, tooth, quantity, fees) and rejection reason | An NRIC or FIN |
| Clinic codes and their descriptions, as the clinic's records hold them | A patient's name, phone number or address |
| The dentist's notes, with the visit's own identity scrubbed out | A row from the clinic's database |
| Table and column names from the connector's `describe` output | The connector's token |

Every prompt goes through the de-identification gate in `server/ai/deidentify.ts` first. It
removes the visit's own identity and anything shaped like an NRIC, FIN, phone number, email or
postal code. If an identifier still remains, the request is refused with 422
`ai_identifiers_remain` and nothing goes to Anthropic. Reading the notes or the identity for a prompt is recorded in the claim's
history, the same as a reveal.

For a mapping proposal, run the connector at the clinic and paste what it prints:

```sh
npm run connector -- describe --source <clinic file>
```

Only the names reach the desk. The desk checks the proposal against them before showing it.

### Settings

| Variable | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Turns AI on |
| `ANTHROPIC_BASE_URL` | Points the desk at a stand-in for the Anthropic API, for testing |
| `AI_DAILY_CALL_CAP` | The most AI calls in a Singapore day, across everyone. Default 200. `0` turns AI off without removing the key. A value that isn't a whole number falls back to 200 |

Each day's calls and their cost are counted in the `ai_usage` table. When the cap is reached,
the buttons say so until the next day, and the rest of the desk carries on.

### When AI can't help

Each failure gets a plain message, and the claim, code map and settings stay as they were:

| Code | Status | When |
|---|---|---|
| `ai_not_configured` | 503 | No key |
| `ai_cap_reached` | 429 | Today's cap is used up, or the cap is `0` |
| `ai_busy` | 503 | Anthropic is rate-limiting |
| `ai_unavailable` | 502 | Anthropic could not be reached or failed |
| `ai_unusable` | 502 | The answer was cut short or didn't fit what was asked |
| `ai_identifiers_remain` | 422 | The prompt still held an identifier, so it wasn't sent |

## Deploy

Cloudflare Pages is not yet connected to this repo. `scripts/setup-wizard.sh` walks Ting Yu through
the first deployment in order, one step per screen. It prints instructions, runs only read-only
checks or commands you confirm, and never shows a secret. This section is the reference behind it.

```sh
bash scripts/setup-wizard.sh
```

### Continuous integration

`.github/workflows/ci.yml` runs the typecheck, the tests and the build on every push and pull
request to `main` and `crew/**`. It uses no secrets and deploys nothing. Node comes from `.nvmrc`
(Node 20, which wrangler 4.86.0 needs), and the Pages build reads the same file.

### Production and Preview

Pages gives every deployment from `main` the Production settings, and every other branch the
Preview settings. They are kept apart so code on a branch can never reach the clinic's records.

| | Production | Preview |
|---|---|---|
| Built from | `main` | every other pushed branch |
| Answers on | the custom domain and `chas-claimer.pages.dev` | `<branch>.chas-claimer.pages.dev` and `<hash>.chas-claimer.pages.dev` |
| D1 binding `DB` | `chas-claimer` | `chas-claimer-preview` |
| `IDENTIFIER_KEY` | its own key | a different key |
| `CONNECTOR_TOKEN` | set | unset, so no connector can import into a preview |
| `DEMO_MODE` | unset | `yes` |
| `AI_DAILY_CALL_CAP` | 200 (the default) | 20 |
| `PAYER_<ID>_API_TOKEN` | per payer | never |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, role lists | set | the same values |

**A preview is a full copy of the desk on a public address.** It must sit behind Access like
Production. The one Access application covers `*.chas-claimer.pages.dev` for that reason. Do not
use the Access toggle in the Pages project's own settings: it creates a second application with a
second AUD tag, and the desk would refuse every sign-in on previews.

### First deployment

1. **Create the databases** in Asia-Pacific:
   `npx wrangler@4.86.0 d1 create chas-claimer --location apac`, and the same for
   `chas-claimer-preview`. The location is a hint for where the primary copy lives, fixed at
   creation. It is not a promise of Singapore, and D1 offers no Singapore jurisdiction.
2. **Apply the schema** to both with `wrangler d1 migrations apply <name> --remote`. Wrangler needs
   a config naming the database, and this repo has no `wrangler.toml` on purpose (Pages would take
   its bindings from it), so the wizard writes one to `.wrangler/d1-remote.toml`, which git ignores.
3. **Create the Pages project** from the Cloudflare dashboard, connected to this repo: production
   branch `main`, build command `npm run build`, output directory `dist`. The first deployment is
   harmless: with no settings yet, every API route answers 503.
4. **Create one Access application** covering the custom domain, `chas-claimer.pages.dev` and
   `*.chas-claimer.pages.dev`, with an Allow policy for the reviewers and officers (see
   [Cloudflare Access set-up](#cloudflare-access-set-up)).
5. **Create the connector's service token** and a Service Auth policy for it on that application.
6. **Set the runtime and bindings:** compatibility date `2026-05-01` with no flags, and the D1
   binding `DB` per environment as in the table above.
7. **Set the variables and secrets** per environment, from [Configuration](#configuration) and the
   table above. Keep a copy of each secret in the password manager before pasting it: Pages never
   shows a secret again.
8. **Add the custom domain**, once it is decided: to the Access application first, then to Pages.
9. **Redeploy** (Retry deployment on the latest Production build). Pages binds variables when a
   deployment is created, so settings added later are invisible to deployments already running.
10. **Run the smoke check** below.

### Smoke check

| Check | Expect | Otherwise |
|---|---|---|
| `curl -sI https://<host>/` with no credentials, for each hostname and for `access-check.chas-claimer.pages.dev` | a 302 to `<team>.cloudflareaccess.com` | Stop. That hostname is outside the Access application |
| `GET /api/me` with the service token headers | 401 | 503: the Access variables are not on this deployment, so redeploy. A login page: the Service Auth policy is missing |
| `POST /api/imports` with the service token, `Content-Type: application/json` and a wrong bearer token | 401 | 503: `CONNECTOR_TOKEN` is unset or shorter than 43 characters |
| `GET /` with the service token | a `Content-Security-Policy` header with `frame-ancestors 'none'` | `_headers` did not deploy |
| Sign in as a reviewer and open `/api/me` | your email, roles `reviewer` and `officer` | your email is not in `ROLE_REVIEWERS`, or the deployment predates it |
| On a preview, run the synthetic clinic import | visits appear on the desk | 503 `identity_not_configured`: the preview `IDENTIFIER_KEY` is missing |

On Production, the connector's first `push` is the identity check: a missing `IDENTIFIER_KEY`
refuses the import with 503 and imports nothing.

### Migrations

Migrations only go forward. To change the schema, add a new file in `migrations/` and keep it
additive (new tables or nullable columns) so the deployment before it still runs. Apply it to
`chas-claimer-preview` first, then to `chas-claimer`, before merging the code that needs it.
Note the Time Travel bookmark first (below), since D1 has no down migration.

`0002_key_rotation.sql` replaces a trigger instead of adding to the schema. It only widens what the
trigger allows, to the one re-key the reseal route makes, so the deployment before it still runs.
It also adds an index on `remittance_lines.patient_hash`.

`0003_visit_notes.sql` adds two columns to `visits` with defaults, so it is additive. The claim
page's notes about the visit stay empty until a visit is next rebuilt after it is applied.

`0004_reference_case.sql` replaces the portal-reference trigger so that references compare on
`upper(trim(...))`: `mhcp-0001` can no longer name a second claim at a payer that holds
`MHCP-0001`. The deployment before it already answers that refusal as `reference_taken`, so it
still runs. The trigger checks new submissions only, so references already stored are left as
they are. It also adds two expression indexes on that key.

### Logs and what they hold

The Functions write one log line of their own: `{"code":"internal","claimId":"<uuid>"}` when a
route fails unexpectedly. No route takes an identifier in its path or query, so request URLs in
the logs carry only claim IDs, payer IDs and procedure codes. The Anthropic client's logging is off.

- **Live logs:** `npx wrangler@4.86.0 pages deployment tail --project-name chas-claimer --status error`,
  or Real-time logs on a deployment in the dashboard. Nothing is stored after the session ends.
- **Sign-ins:** Zero Trust, Logs, Access shows who was allowed or refused, by staff email.
- **Database:** the D1 metrics page shows queries, rows read and written, and storage.

After a deployment, roll back if `internal` lines appear on routes that worked before, if any
route answers 503 `auth_not_configured` or `identity_not_configured`, or if an anonymous request
reaches the desk without the Access login.

### Backup and restore

D1 Time Travel keeps a restore point for every minute: 30 days on the Workers Paid plan, 7 on the
free plan. It is always on.

```sh
npx wrangler@4.86.0 d1 time-travel info chas-claimer          # the current bookmark; note it before a migration
npx wrangler@4.86.0 d1 time-travel restore chas-claimer --timestamp=2026-11-20T01:00:00Z
```

A restore replaces the whole database in place, and everything written after that moment is gone,
including audit events. It prints a bookmark that undoes the restore. Use it only when the data
itself is damaged, and record why outside the desk, since the desk's own audit trail goes back too.

For a copy outside Cloudflare, `wrangler d1 export chas-claimer --remote --output <file>` writes a
SQL dump. Identities in it are sealed and patients masked, but it is still the clinic's health
data: keep it in an encrypted store, never in this repo (`backups/` and `*.d1-export.sql` are
git-ignored). Run exports outside clinic hours, since a large export can hold up requests.

### Rolling back

Open the Pages project's Deployments, pick the last good Production deployment and choose Rollback
to this deployment. It takes effect at once. Or revert the commit on `main` and push.

A rollback changes the code only. It does not undo:

- the database's schema or data (restore with Time Travel if needed);
- claims already sent to a payer, or files already uploaded to a portal;
- changes to the Access application or the service token.

After rotating a secret, do not roll back to a deployment built before the rotation: it may still
carry the old value.

### Rotating secrets

- **`CONNECTOR_TOKEN` and the service token:** a coordinated change. Update the Pages secret and the
  clinic connector's environment together, then redeploy. The service token expires (one year by
  default): renew it a month ahead.
- **`PAYER_<ID>_API_TOKEN`, `ANTHROPIC_API_KEY`:** replace the Pages secret, redeploy, then revoke the
  old one at its source.
- **`IDENTIFIER_KEY`:** rotate it in place, never by simply replacing it. A new key alone makes every
  stored patient hash and sealed identity unreadable: existing claims can no longer be revealed,
  exported or sent, and returning patients stop matching. Keep the password manager copy of every
  key until its rotation is finished, because losing a key before then loses what it sealed.

#### Rotating `IDENTIFIER_KEY`

Do Preview first, then Production. Finish one rotation before you start the next: the desk reads
only the current key and the one before it.

1. **Apply migration `0002_key_rotation.sql`** to the database if it is not there yet (see
   [Migrations](#migrations)). It lets a stored visit revision be re-keyed, and nothing else, and
   records which key version each statement and statement line was taken in under.
2. **Check the plan is Workers Paid.** The reseal's batch size assumes it (step 5).
3. **Note the Time Travel bookmark** (see [Backup and restore](#backup-and-restore)).
4. **Set three variables together** in Pages, then redeploy: `IDENTIFIER_KEY` to a new key from
   `openssl rand -base64 32`, `IDENTIFIER_KEY_VERSION` to the old version plus one (2 if it was
   never set), and `IDENTIFIER_KEY_PREVIOUS` to the key it replaces (the previous key). From here,
   new values are written under the new key, and values under the previous key still open and
   still match.
5. **Move the stored rows** as a reviewer: Settings, "Identifier key", "Move stored identities".
   The page keeps going until nothing is left, and "Carry on moving" picks up if it stops. Behind
   it, `POST /api/settings/reseal` takes `{"after": ""}` and then the `next` each answer returns,
   until `next` is null. Each request moves up to 150 visit revisions, which needs the Workers Paid
   plan (on the free plan a request's 10 ms of CPU is not enough for a batch that size). Each
   answer gives `moved`, `failed`, the `failures` by visit key and revision, and what is left. Each
   request is recorded in the audit trail as `identity_resealed`, with counts only.
   `GET /api/settings/reseal` reports where the rotation stands without moving anything.
6. **Check `remaining` is 0** on the same Settings section ("Every stored identity is under the
   current key."). If it is not, the revisions listed under "Revisions left as they were" are ones
   neither key opens, or whose content no longer matches its hash. Stop and find out why before
   going on: those rows are lost once the previous key is gone. If the page says "The previous key isn't
   set.", `IDENTIFIER_KEY_PREVIOUS` is missing while rows still need it: set it again first.
7. **Read "Some payment records can't move."** if Settings shows it. It counts the payment
   statements and statement lines the reseal could not move (see below). Decide you can live with
   that before you unset the previous key: once it is unset, they no longer match by hash.
8. **Unset `IDENTIFIER_KEY_PREVIOUS`** and redeploy. Keep `IDENTIFIER_KEY_VERSION` at its new value.
   Keep the previous key in the password manager until you are sure no backup you might restore still
   needs it.

What to know before you start:

- The reseal moves a patient's hash on visits, claims and remittance lines when it reseals one of
  that patient's visits. Two kinds of payment statement (remittance) row can't move, because
  nothing on the desk still holds the identifier they were hashed from: every imported statement's
  file hash, and the patient hash of a line whose patient has no visit on the desk. Once the previous
  key is unset, those lines no longer match a patient by hash. Matching by reference or by hand
  still works for them.
- Because an old statement's file hash can't move, the desk can't recognise the same file imported
  again under the new key. Instead it refuses, with 409 `possible_duplicate`, a statement with the
  same payer, file name and number of lines as one imported under an earlier key (a statement from
  before key versions were recorded counts as earlier). The page links to the earlier statement to
  compare. A reviewer can import it anyway (`confirmPossibleDuplicate` on `POST /api/remittances`);
  officers can't. Both the refusal and the confirmed import are recorded in the audit trail. A copy
  under a different file name is not caught, so compare a re-sent statement with the ones
  already on the desk before you import it.
- A clinic file pushed again across a rotation is recognised as already seen only while
  `IDENTIFIER_KEY_PREVIOUS` is set.
- Do not roll back to a deployment built before key rotation existed while rows are under
  version 2 or later: it reads one key only.
- A Time Travel restore to a moment before the rotation brings back rows under the previous key. Set
  `IDENTIFIER_KEY_PREVIOUS` again and rerun the reseal.
