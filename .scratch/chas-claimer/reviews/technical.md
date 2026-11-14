# Technical review: chas-claimer

*Tech lead, 2026-11-13. Reviews `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md` against
`interview.md`, `GLOSSARY.md`, `docs/adr/0001`–`0005`, `docs/research/sg-dental-claims.md`,
`docs/design.md` (untracked) and the scaffold at `5f79ef1`/`32e32f0`. Vocabulary: module, interface,
seam, adapter, depth (mattpocock `codebase-design`); domain terms from `GLOSSARY.md`.*

The approach is sound: a pure domain core, Functions that own storage and channels, a connector at
the clinic, assisted submission for the government schemes. Nothing below changes that shape. The
findings are about what the PRD leaves implicit and what a parallel build needs pinned down before
four people start typing.

---

## 1. Ranked findings

Each finding has a proposed fix. **B** = blocks the build until fixed in block 1 or the spec.
**H** = fix inside the owning block. **M/L** = should, can follow.

### F1 (B) The Access email header can be forged

The PRD reads `Cf-Access-Authenticated-User-Email` for the actor. That header is only trustworthy
on a hostname Access sits in front of. A Pages project also answers on `<project>.pages.dev` and on
every preview URL `<hash>.<project>.pages.dev`; unless Ting Yu puts those behind Access too, anyone
can send the header themselves and act as a reviewer.

**Fix.**
- Never trust the email header. Verify the `Cf-Access-Jwt-Assertion` JWT (RS256) against the team's
  keys at `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`, check `aud` equals `ACCESS_AUD`, `exp`
  and `iss`, and take the email from the verified claims. Cache the key set in module scope for
  10 minutes. No new dependency: Web Crypto `importKey("jwk")` + `verify("RSASSA-PKCS1-v1_5")`.
- Fail closed: with `ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` unset, every authenticated route answers
  503 `auth_not_configured`.
- `DEV_USER` is honoured only on loopback: the request hostname is `localhost`, `127.0.0.1` or
  `[::1]` (`isLoopback` in `server/auth.ts`). A stray `DEV_USER` in the Pages dashboard then does
  nothing.
- Add `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to PRD §5.4.
- Human step (wizard/README): one Access application covering the custom domain, `*.pages.dev`
  and previews. See question Q1.

### F2 (B) No key for the "keyed hash", and raw identifiers sit in a plain JSON column

PRD §5.2 says claims hold "a masked form and a keyed hash", but §5.4 lists no key. NRICs are a
tiny space (seven digits per prefix), so an unkeyed SHA-256 is reversed by enumeration in seconds.
And "identifiers stay inside the source visit snapshot" puts every NRIC, name, phone, date of birth
and member ID in plaintext in D1, in its Time Travel history, and in any export.

**Fix (ADR 0006 draft below).**
- One secret, `IDENTIFIER_KEY` (32 random bytes, base64). HKDF it into two keys:
  `match/v1` (HMAC-SHA256) for `patient_hash` and `content_hash`, and `identity/v1` (AES-GCM) for
  the identity part of each revision. Stored values carry the version prefix (`v1:`) so the key
  can rotate later.
- Split every source visit **at the import seam** into an `identity` part (NRIC/FIN, name, phone,
  date of birth, address if present, policy member IDs, MCAF holder) and a `clinical` part
  (de-identified: branch, dentist, date, age at visit, tier, card expiry, treatments, policy plan
  and limit). The claim builder, findings, AI and every list endpoint see only `clinical`. Only
  three places open `identity`: the reveal route, the packet builder for a channel send, and the
  file export. Each one writes an audit event.
- Imports compute `age_at_visit` from date of birth (Flexi-MediSave needs 60 and over), so the
  date of birth never has to leave `identity`.
- **Synthetic-only guard.** Until `ALLOW_REAL_IDENTIFIERS=yes` is set, the import refuses any NRIC
  outside the synthetic `T9` block (conductor, 2026-11-13: the QA lead moved synthetic identifiers from `S0000` to `T9`, birth years 2090 to 2099) (422 `real_identifier_refused`, with no echo of the value). That turns
  the PRD's "processing agreement is a prerequisite" into a switch only Ting Yu can flip.
- Imports and every identity-touching route fail closed (503) without `IDENTIFIER_KEY`.
- Local dev and tests use a fixed, public, dev-only key (see F12). It is safe because the guard
  keeps real identifiers out wherever that key is used.

### F3 (B) The `api` channel can be pointed at our own secrets

"Credentials for `api` come from environment variables named in settings". If settings can name the
variable, a settings editor can set the URL to any host and the variable to `ANTHROPIC_API_KEY` or
`IDENTIFIER_KEY`, and the desk will send it there.

**Fix.** The variable name is derived, never configured: `PAYER_${payerId}_API_TOKEN`, where
`payerId` matches `^[A-Z0-9_]{2,32}$`. The URL must be `https:`, with a hostname that is not an IP
literal and not `localhost`. Timeout 15 s, no redirects followed (`redirect: "manual"`), and the
response body is read with a size cap. Each send writes an audit event per claim (it is a
disclosure of identifiers).

### F4 (B) Parallel worktrees need a shared foundation, and the configs exclude two folders

Eight blocks touching one schema, one types file, one router and one icon registry will conflict on
every merge unless block 1 lands those as complete, stable seams. Section 3 lists exactly what. Two
config gaps belong in it too:
- `vitest.config.ts` includes only `src/`, `server/`, `functions/`, `tests/`, so tests under
  `connector/` and `mock/` (where `CLAUDE.md` puts synthetic data) would silently never run. Add
  both to `test.include` and to `tsconfig.json` `include`.
- `docs/design.md` assumes `src/ds.ts` and `src/lib/icons.ts`; neither exists yet.

### F5 (H) The payer waterfall and the lifecycle interact in ways the PRD doesn't state

A visit's claims depend on each other: MediSave claims from what CHAS left. The PRD says re-imports
"update unsubmitted claims and flag submitted ones". Three cases follow that the spec should say:

1. **Submitted upstream claims are fixed inputs.** If CHAS was submitted at $462.50 and a re-import
   changes the fee, the CHAS claim is flagged *changed after submission* and the MediSave claim is
   rebuilt from the $462.50 actually claimed, not a recomputed CHAS amount. The builder takes
   `fixed: { payerId, claimedCents }[]`.
2. **Approval is bound to content.** `approved` is unsubmitted, so a re-import may change it. A
   rebuilt claim whose lines or amounts differ returns to `ready` or `needs attention`, with an
   audit event "approval cleared by re-import". Store `built_from_revision` and
   `approved_revision`; submission refuses when they differ.
3. **An upstream rejection moves the split.** When CHAS is rejected, the patient balance and any
   downstream claims are wrong. v1: every sibling claim of the visit gets a warning finding
   `upstream_rejected` ("CHAS rejected this visit's claim. The MediSave and insurance amounts were
   based on it."). Unsubmitted siblings are rebuilt when the rejected claim is reopened.

### F6 (H) MediSave is two payers, and two amount rules are undefined

- **Flexi-MediSave and surgical (TOSP) MediSave** probably go through different portals (research
  §2.2), have different rules and caps, and can both apply to one visit. Model them as two payers,
  `MEDISAVE_FLEXI` and `MEDISAVE_TOSP`, each with its own channel and template. That keeps
  "one claim per visit per payer" true and lets the waterfall order them.
- **Several TOSP codes in one operation.** The research gives the per-table limit but not how CPF
  combines limits for multiple procedures. v1: cap at the highest table limit among the codes
  (conservative, never over-claims), block more than 3 procedures, and warn when there is more than
  one code. Record this as an assumption in the rule set's notes.
- **Insurance amount.** The PRD names "per-policy insurance limits" but no rule. v1: the insurer is
  asked for what is left after the payers above, capped at the policy's annual limit minus this
  clinic's claims on that policy this year (a warning, per ADR 0003, not a block), less a co-pay
  percentage if the policy record carries one. Confirm with the functional reviewer.

### F7 (H) D1 has no interactive transactions

Approve, submit and import are read-then-write. Two officers approving the same claim, or two
connector runs overlapping, will double-write.

**Fix.**
- Repositories return `D1PreparedStatement[]`; services compose one `db.batch()` per command, which
  D1 runs atomically.
- Optimistic concurrency: `claims.version`. A transition is
  `UPDATE claims SET ..., version = version + 1, last_action = ?nonce WHERE id = ? AND version = ?`,
  and its audit event is `INSERT INTO audit_events ... SELECT ... FROM claims WHERE id = ? AND
  last_action = ?nonce`. A stale write changes nothing and inserts nothing; the service sees
  `meta.changes === 0` and answers 409 `stale`. (The nonce avoids relying on `changes()` across
  batch statements.)
- `UNIQUE (visit_key, payer_id)` on claims and `UNIQUE (visit_key, revision)` on revisions, with
  `INSERT ... ON CONFLICT DO NOTHING` where a race is harmless.
- The connector posts in pages of at most 100 visits; `/api/imports` refuses more (413). This also
  keeps one invocation well under D1's per-invocation query limit and the Workers CPU limit.

### F8 (H) The AI de-identification gate needs to be a module, not a convention

ADR 0004 says nothing identifying reaches the model. Treatment descriptions and dentists' notes are
clinic free text and will sometimes contain a name ("crown for Mdm Tan") or a phone number, and a
payer's rejection text may quote an NRIC.

**Fix.** `server/ai/deidentify.ts` is the only way to build a prompt: every task's input type is
`DeidentifiedText`, a brand only `deidentify()` can produce. It (1) redacts exact matches of the
visit's own identity values (name tokens, NRIC, phone, member IDs, case- and space-insensitive),
(2) redacts NRIC/FIN (`[STFGM]\d{7}[A-Z]`), Singapore phone (`[689]\d{7}`, `+65`), email and
postal-code patterns, and (3) fails closed if anything still matches after redaction. Property-test
it with fast-check. The source mapping assistant gets column names only, uploaded by a person in
Settings from the connector's `describe` output, so the connector token never reaches an AI route.

Do **not** port `repos/landing-page/server/ai-run.js`: it is built around anonymous visitors' tries
and refunds. Port `server/anthropic.js` (client with `maxRetries: 0`, `logLevel: "off"`,
`classifyApiError`, `responseText`, prices) to TypeScript, and add a small per-day call cap
(`AI_DAILY_CALL_CAP`, default 200) in an `ai_usage` table.

### F9 (M) Channel contract: keep it to two methods, and treat exports as disclosures

PRD §5.3 gives each channel `prepare`, `send` and `recordOutcome`. Outcomes arrive the same way
whatever the channel (a person, the simulator, a remittance), so they belong to the lifecycle, not
the channel. The channel interface becomes `prepare` + `send`, which is what makes it deep: four
adapters, two methods.

- **File channel.** Exporting writes one audit event per claim (`exported`, a bulk disclosure of
  identifiers). The file is generated on request and never stored. *Amended at ticket 07's review:
  functional AC-4.5 wins, so exported claims stay `approved` until the officer confirms the upload
  in the payer's portal; confirming marks them `submitted` with the batch reference.*
- **CSV injection.** Every text cell that begins with `=`, `+`, `-`, `@`, tab or carriage return is
  prefixed with `'`, then RFC 4180 quoted. Amounts are formatted from integer cents by the exporter
  and never pass through the text path, so a payer layout that needs `-12.50` still gets it. The same
  `csv.ts` parses remittances (BOM, CRLF, quoted newlines, a row cap). Round-trip property test.
- **Assisted channel.** `send` returns the checklist; the claim becomes `submitted` only when the
  officer records the portal reference (`submit` action with `portalReference`, required for
  `assisted`).

### F10 (M) Where rule sets live, and which one a claim used

ADR 0002 says rule sets are data, but not where. Benchmarks appear both in the rule sets and in
Settings.

**Fix (ADR 0008 draft).** Rule sets are committed JSON under `src/domain/rules/data/`, each with
`id`, `effectiveFrom`, `effectiveTo`, `sources[]` (URL, retrieved date) and the figures; git review
is their audit trail. Benchmarks the research has not confirmed ship as `null`. Settings may fill a
blank benchmark only with a source URL and an as-of date, and the override is shown as such. Every
claim stores the `rule_set_id` it was built with, so a new rule set never silently re-prices a
submitted claim. All dates are SGT calendar dates (`sgtDay(now)`); the 30-day CHAS deadline is
`visit_date + 30` inclusive, held as `windowDays` in the rule set.

### F11 (M) Browser-side protections Access doesn't give

Access authenticates by cookie, so a cross-site form post would carry it.
- Mutating routes require `Content-Type: application/json` and an `Origin` equal to the request's
  own origin (403 otherwise). The remittance upload sends the CSV as a JSON string, not multipart.
- `public/_headers` (Vite copies it into `dist/`): CSP `default-src 'self'`, `frame-ancestors 'none'`
  (the reveal button must not be clickjackable), `Referrer-Policy: no-referrer`. API responses carry
  `Cache-Control: no-store`.
- Logs never include request bodies, identity values or packets; error logs carry a code and the
  claim ID only.

### F12 (M) Tooling gaps for the connector, generator and local runs

- Node 20.20 has no `node:sqlite` and the repo has no TypeScript runner. Add `tsx` (devDependency)
  for `connector/` and `mock/` scripts, and use `sql.js` (already present, move it to
  `dependencies`) to read and write SQLite in both. One SQLite library across tests, generator and
  connector.
- Add `zod` (dependency) for the many parse-at-the-edge shapes (source visit, settings, payer
  templates, request bodies). Hand-written parsers across eight blocks would drift.
- Local secrets live in `.dev.vars`, which crew may not touch. `npm run dev:functions` should pass
  public, dev-only values with `--binding` (`DEV_USER`, `ROLE_REVIEWERS`, `ROLE_OFFICERS`,
  `IDENTIFIER_KEY` set to a fixed published dev key, `DEMO_MODE=yes`). Note: `.gitignore` ignores
  `.dev.vars.*`, so a `.dev.vars.example` would need `!.dev.vars.example`.

### F13 (L) The synthetic clinic must be deterministic and move with the calendar

- `generateClinic({ seed, asOf })` uses a seeded PRNG and places every visit relative to `asOf`.
  Tests pass a fixed `asOf`; the demo passes today, so "due in 4 days" is always true on screen.
  Without this, every 30-day-window test is a time bomb.
- The synthetic block is `T9` (T9000000–T9999999); the generator asserts it never leaves the block.

### F14 (L) Missing repo documents

`CLAUDE.md` points at `README.md` (layout, commands, configuration, deploy) and the card at
`CHANGELOG.md`; neither exists. Block 1 writes the README skeleton (with the environment table and
the Access setup), the release gate writes the changelog.

---

## 2. Seams

The highest seams already exist; the build adds two, each with more than one adapter.

| Seam | Kind | Adapters | What is tested there |
|---|---|---|---|
| Pure domain interfaces (`buildVisitClaims`, `applyAction`, `matchRemittance`, `buildPacket`, `toCsv`/`parseCsv`, `money`, `nric`) | existing pattern | n/a (pure) | every rule, the waterfall, the lifecycle, matching; property tests for money sums, waterfall conservation, CSV round trip, NRIC check letters |
| Function handler `onRequest({ request, env, params })` with `createD1()` | **existing** (vitest config) | real D1 (prod), sql.js D1 (tests) | auth, roles, every route end to end against the real migrations |
| Global `fetch`, stubbed in `tests/setup.ts` | **existing** | network (prod), per-test stub | Anthropic, Access key set, `api` channel, connector posting to the desk |
| `SubmissionChannel` (`server/channels/`) | **new** | assisted, file, api, simulator | packet fields per payer template, file layout, send results |
| `SourceReader` (`connector/sources/`) | **new** | sqlite, csv | reading through a source mapping |

No `AiClient` or clock seam: the Anthropic SDK goes through `fetch` (stub it, as landing-page's
`installNetwork` does), and time is `vi.setSystemTime` at the route seam and an explicit `today`
argument in the domain.

**The end-to-end test** that proves success criterion 8 runs entirely in Vitest:
`generateClinic` → SQLite file in a temp dir → connector reads it through
`connector/mappings/synthetic-clinic.json` → its `fetch` stub calls the `/api/imports` handler on
an in-memory D1 → approve → simulator send → simulator pays → remittance CSV matched.

---

## 3. Module layout and interfaces

```
src/
  domain/                 pure TypeScript, no I/O. Imported by server, functions, UI, connector, mock.
    result.ts             Result<T, E>
    money.ts              Cents
    dates.ts              IsoDate, SGT day arithmetic
    nric.ts               NRIC/FIN check, synthetic test, masking
    types.ts              glossary types and every closed union (statuses, actions, finding codes, audit actions)
    source-visit.ts       parse + canonicalise a source visit; split identity from clinical
    settings.ts           DeskSettings schema and defaults (branches, dentists, payers, templates, waterfall)
    csv.ts                RFC 4180 write with formula escaping; parse
    rules/
      index.ts            ruleSetFor
      chas.ts medisave.ts insurance.ts      per-scheme pricing and checks (internal)
      data/*.json         dated rule sets with sources
    claims/
      build.ts            buildVisitClaims (the deep module)
      waterfall.ts        internal
      findings.ts         finding catalogue: code, severity, message template
    lifecycle.ts          applyAction, allowedActions, statusAfterBuild
    matcher.ts            matchRemittance
    packet.ts             buildPacket
  api/                    request/response types per area, one file per owning block
  ds.ts                   the only import of src/design-system/
  lib/icons.ts            Lucide registry
  ui/ App.tsx router.ts api.ts pages/ components/ ai/
server/                   shared Functions code (never a route, landing-page convention)
  env.ts http.ts auth.ts access-jwt.ts crypto.ts
  repo/ visits.ts claims.ts audit.ts settings.ts code-map.ts remittances.ts simulator.ts overview.ts
  services/ imports.ts claims.ts submissions.ts remittances.ts
  channels/ index.ts assisted.ts file.ts api.ts simulator.ts
  ai/ anthropic.ts deidentify.ts run.ts tasks/{code-suggestion,rejection-explainer,justification,source-mapping}.ts
functions/api/            thin route files: parse params, call one service, return
connector/ cli.ts mapping.ts post.ts sources/{sqlite,csv}.ts mappings/synthetic-clinic.json
mock/synthetic-clinic/ generate.ts write-sqlite.ts schema.sql
migrations/0001_init.sql
public/_headers
tests/helpers/ d1.ts (exists) http.ts env.ts fixtures.ts network.ts access.ts arbitraries.ts seed.ts
tests/setup.ts
```

### Domain core (pure)

```ts
// money.ts — integer cents, SGD. Never a float past the parse edge.
export type Cents = number & { readonly __brand: "Cents" };
export function cents(n: number): Cents;                 // throws unless a safe non-negative integer
export function parseDollars(text: string): Result<Cents, "invalid">;   // "462.50" -> 46250
export function add(...xs: Cents[]): Cents;
export function subtract(a: Cents, b: Cents): Cents;     // throws if b > a: callers cap first
export function min(...xs: Cents[]): Cents;
export function formatSgd(c: Cents): string;             // "$462.50"

// nric.ts
export type Nric = string & { readonly __brand: "Nric" };
export function parseNric(raw: string): Nric | null;     // trims, upper-cases, checks the check letter (S/T/F/G/M)
export function isSynthetic(n: Nric): boolean;           // T9xxxxxx (birth years 2090-2099; see GLOSSARY)
export function maskNric(n: Nric): string;               // "S••••567D"

// source-visit.ts
export function parseSourceVisit(input: unknown): Result<SourceVisit, FieldProblem[]>;
export function splitVisit(v: SourceVisit, today: IsoDate): { identity: VisitIdentity; clinical: ClinicalVisit };
export function canonicalJson(v: unknown): string;       // sorted keys: the content-hash input

// rules/index.ts
export function ruleSetFor<S extends RuleScheme>(scheme: S, visitDate: IsoDate,
  overrides?: BenchmarkOverride[]): RuleSetOf<S> | null; // null: no rule set covers the date (a blocking finding)

// claims/build.ts — the domain's deepest module
export function buildVisitClaims(input: {
  visit: ClinicalVisit;
  settings: DeskSettings;            // branches (GST, registrations), dentists (accreditation), payers, waterfall order
  codeMap: CodeMap;
  history: PatientHistory;           // this clinic's earlier claims for the patient: counts by limit group and year, same-day CHAS claims
  fixed: FixedClaim[];               // submitted claims of this visit: their amounts are not recomputed (F5)
  annotations: ClaimAnnotations;     // justification text, pre-authorisation and MCAF references entered in the desk
  today: IsoDate;
}): {
  claims: DraftClaim[];              // one per payer that applies: lines, fee, claimed, findings, ruleSetId, deadline, status
  split: SplitSegment[];             // the bill split, patient last; sum === visit total
  visitFindings: Finding[];          // e.g. an unmapped treatment
};

// lifecycle.ts
export function statusAfterBuild(findings: Finding[]): "needs_attention" | "ready";
export function allowedActions(claim: ClaimState, actor: Actor): ClaimActionKind[];
export function applyAction(claim: ClaimState, action: ClaimAction, actor: Actor, now: string):
  Result<{ next: ClaimState; audit: AuditDraft[] }, LifecycleError>;
// ClaimAction (decisions-g2 §2; the union in src/domain/types.ts is the source):
//   approve | unapprove | submit{portalReference?} | portal_refused{message}
//   | accept{acceptedCents?, reason?} | reject{reason}
//   | record_payment{cents, paidOn, remittanceLineId?} | accept_short_payment{reason}
//   | reopen | withdraw{reason} | write_off{reason} | acknowledge_change{note}

// matcher.ts — patient hashes are computed by the server before this is called
export function matchRemittance(lines: RemittanceLine[], candidates: MatchCandidate[]): LineMatch[];
// LineMatch = {kind:"reference"|"patient_date_amount", claimId} | {kind:"ambiguous", claimIds} | {kind:"unmatched"}
// A line matches only when exactly one candidate fits; never two lines to one claim.

// packet.ts — only the template's fields, in the template's order (MOH Circular 02/2026)
export function buildPacket(claim: ClaimForPacket, template: PayerTemplate, identity: VisitIdentity | null): ClaimPacket;
// identity null -> sensitive fields carry masked values (the screen); non-null only for send/export/reveal

// csv.ts
export function toCsv(columns: CsvColumn[], rows: Record<string, CsvCell>[]): string;
export function parseCsv(text: string, opts: { maxRows: number }): Result<string[][], CsvProblem>;
```

Lifecycle transitions (statuses stored snake_case, shown in words):

```
build ─► needs_attention ⇄ ready            (computed from blocking findings, not an action)
ready ─approve(reviewer)─► approved ─unapprove─► ready      (re-import with changes also clears approval)
approved ─submit─► submitted ─accept─► accepted ─record_payment─► paid   (once payments reach the accepted amount)
submitted ─record_payment─► paid   (implicit acceptance at the paid amount, audited "accepted by remittance")
accepted ─accept_short_payment{reason}─► paid   (the difference is written off)
approved ─portal_refused{message}─► rejected   (no portal reference)
submitted ─reject{reason}─► rejected ─reopen─► (rebuild) needs_attention | ready
acknowledge_change{note} clears changed-after-submission; status unchanged
rejected ─write_off─► written_off
needs_attention | ready | approved ─withdraw─► withdrawn
```

### Server

```ts
// env.ts
export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; DEV_USER?: string;
  ROLE_REVIEWERS?: string; ROLE_OFFICERS?: string;
  CONNECTOR_TOKEN?: string; IDENTIFIER_KEY?: string; ALLOW_REAL_IDENTIFIERS?: string;
  ANTHROPIC_API_KEY?: string; ANTHROPIC_BASE_URL?: string; AI_DAILY_CALL_CAP?: string;
  DEMO_MODE?: string;
  [payerToken: `PAYER_${string}_API_TOKEN`]: string | undefined;
}

// http.ts — every route file is one call to route(); auth runs inside the handler, so the
// handler seam tests it (a _middleware would be skipped when tests call onRequest directly)
export function route<P extends Record<string, string> = {}>(
  opts: { auth: "access" | "connector"; roles?: Role[]; maxBytes?: number },
  handler: (ctx: { request: Request; env: Env; params: P; actor: Actor; now: number }) => Promise<Response>,
): PagesFunction<Env>;
export function json(body: unknown, status?: number): Response;            // always no-store
export function problem(status: number, code: string, detail?: Record<string, unknown>): Response;
export function readJson<T>(request: Request, parse: (u: unknown) => Result<T, unknown>, maxBytes: number): Promise<Result<T, Response>>;

// auth.ts / access-jwt.ts
export function authenticate(request: Request, env: Env): Promise<Actor | AuthFailure>;   // Actor = { email, roles }
export function verifyAccessJwt(token: string, cfg: { teamDomain: string; aud: string }): Promise<{ email: string } | null>;
export function checkConnectorToken(request: Request, env: Env): Promise<boolean>;        // constant-time

// crypto.ts
export function identifierKeys(env: Env, opts?: { loopback?: boolean }): Promise<IdentifierKeys | null>;
// null -> fail closed; also null for the published dev key unless opts.loopback (matched by SHA-256 fingerprint)
// route({ identity: true }) calls this after authentication and hands the handler `keys`, or answers 503
// identity_not_configured; no handler derives keys itself
export function patientHash(k: IdentifierKeys, nric: Nric): Promise<string>;  // "v1:<hex>"
export function contentHash(k: IdentifierKeys, canonical: string): Promise<string>;
export function sealIdentity(k: IdentifierKeys, id: VisitIdentity, row: SealedRow): Promise<string>;
export function openIdentity(k: IdentifierKeys, sealed: string, row: SealedRow): Promise<VisitIdentity>;
// SealedRow = { visitKey, revision }: bound as AES-GCM additional data ("visitKey:revision"), so a
// sealed blob copied to another visit or revision fails to open
```

**Repositories** are aggregate-shaped and return statements for the service to batch:

```ts
// repo/visits.ts
heads(db, visitKeys: string[]): Promise<Map<string, { revision: number; contentHash: string }>>;
revisionStatements(db, rev: NewRevision): D1PreparedStatement[];
loadClinical(db, visitKey): Promise<ClinicalVisit>; loadIdentity(db, k, visitKey): Promise<VisitIdentity>;
// repo/claims.ts
list(db, filter: ClaimFilter, page: Cursor): Promise<Page<ClaimRow>>;      // never touches identity
detail(db, id): Promise<ClaimDetail | null>;
forVisit(db, visitKey): Promise<ClaimState[]>;
history(db, patientHash, year): Promise<PatientHistory>;
upsertBuiltStatements(db, built: BuiltClaim[]): D1PreparedStatement[];
transitionStatement(db, id, expectedVersion, nonce, patch): D1PreparedStatement;
// repo/audit.ts
auditStatement(db, draft: AuditDraft, guard?: { claimId: string; nonce: string }): D1PreparedStatement;
list(db, entity: { type: string; id: string }): Promise<AuditEvent[]>;
// repo/settings.ts — one versioned JSON document
get(db): Promise<{ version: number; settings: DeskSettings }>;   // defaults when empty
saveStatement(db, settings, expectedVersion, actor): D1PreparedStatement;
```

**Services** are the backend's deep modules; route files call exactly one function:

```ts
importVisits(deps: Deps, req: { source: ImportSource; visits: unknown[] }, actor: Actor): Promise<ImportSummary>;
  // parse -> synthetic guard -> split + hash + seal -> compare heads -> for each new/changed visit:
  // gather history + fixed + annotations -> buildVisitClaims -> upsert unsubmitted, flag submitted,
  // clear stale approvals -> one batch per visit -> summary {received, new, changed, unchanged, flagged, refused}
act(deps, claimId, action: ClaimAction, expectedVersion: number, actor): Promise<Result<ClaimDetail, ActError>>;
actMany(deps, claimIds, action, actor): Promise<ActManyResult>;     // batch approve
reveal(deps, claimId, field: IdentityField, actor): Promise<string>; // audit first, then answer
submit(deps, claimIds, actor): Promise<SubmitResult>;                // groups by payer, channelFor(payer)
importRemittance(deps, { payerId, csv }, actor): Promise<Result<RemittanceSummary, RemittanceError>>; // amended at ticket 08
runAiTask<I, O>(deps, task: AiTask<I, O>, input: I): Promise<AiOutcome<O>>;
  // AiOutcome: {ok:true, suggestion} | {ok:false, reason:"not_configured"|"cap"|"busy"|"unavailable"|"identifier_found"|"bad_output"}
// Deps = { db: D1Database; env: Env; now: number; keys: IdentifierKeys }
```

**Channels:**

```ts
export interface SubmissionChannel {
  readonly kind: "assisted" | "file" | "api" | "simulator";
  prepare(claim: ClaimForPacket, template: PayerTemplate, identity: VisitIdentity): ClaimPacket;
  send(packets: ClaimPacket[], ctx: { env: Env; payer: PayerSettings; db: D1Database; now: number }): Promise<SendResult>;
}
type SendResult =
  | { kind: "checklist"; packets: ClaimPacket[] }                          // assisted: person submits, records reference
  | { kind: "file"; filename: string; csv: string; batchRef: string }      // file: claims submitted with batchRef
  | { kind: "sent"; results: { claimId: string; ok: boolean; portalReference?: string; error?: string }[] }; // api, simulator
export function channelFor(payer: PayerSettings): SubmissionChannel;
```

### Connector

```ts
export interface SourceReader {                    // sqlite.ts, csv.ts
  describe(): Promise<SourceSchema>;               // table and column names only: input to the mapping assistant
  read(mapping: SourceMapping, since?: IsoDate): AsyncIterable<unknown>;   // raw visit objects for parseSourceVisit
}
// cli.ts: `claims-connector describe|dry-run|push --mapping <file> --source <path> [--since]`
// push: parse locally (same parseSourceVisit), page by 100, POST /api/imports with
// Authorization: Bearer $CONNECTOR_TOKEN (+ Access service-token headers from env), retry 3x on 5xx.
// The desk URL and tokens come from the environment, never a file in the repo.
```

### Synthetic clinic generator

```ts
// mock/synthetic-clinic/generate.ts — pure, no fs
export function generateClinic(opts: { seed: number; asOf: IsoDate }): {
  clinic: ClinicProfile; settings: DeskSettings; codeMap: CodeMap;   // its own clinic codes and their mappings
  visits: SourceVisit[];                                             // ~60 patients, ~200 visits, 2 branches, 3 dentists
  cases: Record<CaseName, string[]>;                                 // visit keys per edge case, for tests
};
// write-sqlite.ts: writes the clinic's own tables (a CMS-like schema, not ours) with sql.js
```

Every tier (PG, MG, Blue, Orange, Green, PA), expired card, past window, same-day duplicate,
unfinished crown, no MCAF, MSP code, multi-TOSP, Flexi age 60+, insurance with pre-authorisation,
above-benchmark fee, unmapped clinic code, and a re-import pair with a changed fee. The `cases` map
lets tests name the edge case instead of hunting for a visit.

### UI

```ts
// src/ui/api.ts — typed against src/api/*; the UI never computes an amount, only formats Cents
export const api: { get<T>(path: string): Promise<T>; post<T>(path: string, body: unknown): Promise<T> };
// src/ui/router.ts — a 40-line history router; no dependency
// src/ui/ai/index.tsx — slot components with final props, stubbed by block 1, implemented by block 6:
export function CodeSuggestion(p: { clinicCode: string; description: string; onAccept(e: CodeMapEntry): void }): JSX.Element | null;
export function RejectionExplainer(p: { claimId: string }): JSX.Element | null;
export function JustificationDraft(p: { claimId: string; onUse(text: string): void }): JSX.Element | null;
export function MappingProposal(p: { onAccept(m: SourceMapping): void }): JSX.Element | null;
```

Shared components: `BillSplit`, `StatusBadge`, `DeadlineText`, `MoneyCell`, `MaskedIdentifier`
(reveal button; posts to the reveal route and says the reveal is recorded), `FindingList`.

---

## 4. Build order for parallel worktrees

The PRD's eight blocks hold, with block 1 split into a backend foundation, a UI shell, the synthetic clinic and a walking skeleton, and the
rest in two waves. Ownership is by file; a block edits only its own files plus the shared files its
row names.

| Wave | Block | Owns (creates and alone edits) | Needs |
|---|---|---|---|
| 0 | **01 Backend foundation** | `package.json` (adds `zod`, `tsx`; `sql.js` to dependencies; `dev:functions` bindings; `connector` and `mock:clinic` scripts), `tsconfig.json`, `vitest.config.ts`, `migrations/0001_init.sql` (the **whole** schema in §5), `src/domain/{result,money,dates,nric,types,source-visit,source-mapping,settings,csv}.ts`, `src/api/common.ts`, `src/domain/validation.ts`, `server/{env,http,auth,access-jwt,crypto,bytes}.ts`, `server/repo/{audit,settings}.ts`, `functions/api/me.ts`, `public/_headers`, `tests/helpers/{http,env,network,access,arbitraries,seed}.ts`, `tests/setup.ts`, `README.md` | - |
| 0 | **01b UI shell** | `src/ds.ts`, `src/lib/icons.ts` (every icon the screens in `docs/design.md` need), `src/ui/{App,router,api}.ts(x)`, a placeholder page per route at its final file name in `src/ui/pages/`, `src/ui/ai/index.tsx` stubs, `src/ui/components/*` shared set | 01 |
| 0 | **02a Synthetic clinic** | `mock/synthetic-clinic/**` (generator complete with all edge cases and R1/R2, SQLite writer, `schema.sql`, `cli.ts`) | 01 (runs alongside 01b) |
| 0 | **02 Walking skeleton** | `server/repo/{visits,claims}.ts`, `server/repo/code-map.ts` (read side), `server/services/{imports,rebuild}.ts`, `src/domain/claims/build.ts` + `rules/` with the CHAS rule set only, `src/api/{imports,claims}.ts`, `functions/api/{imports/index,imports/synthetic,claims/index}.ts`, `src/ui/pages/{Queue,Imports}.tsx`, `tests/helpers/fixtures.ts` | 01, 01b, 02a |
| 1 | **03 Rules and waterfall** | `src/domain/rules/**`, `src/domain/claims/**` (MediSave TOSP, Flexi, insurance, waterfall, full finding catalogue) | 02 |
| 1 | **04 Lifecycle, audit, claim detail** | `src/domain/lifecycle.ts`, `server/services/claims.ts`, `functions/api/claims/[id]/**`, `functions/api/claims/actions.ts`, `src/api/claim-detail.ts`, `src/ui/pages/ClaimDetail.tsx`; edits 02's `Queue.tsx` and `functions/api/claims/index.ts` | 02 |
| 1 | **05 Connector** | `connector/**` | 02 (the import handler; the generator arrives through 02a) |
| 1 | **06 Settings, code map, overview** | `server/repo/overview.ts`, writes in `server/repo/code-map.ts`, `functions/api/{settings,overview}.ts`, `functions/api/code-map/**`, `src/api/settings.ts`, `src/ui/pages/{Settings,Overview}.tsx` | 02 |
| 2 | **07 Channels and simulator** | `src/domain/packet.ts`, `server/channels/**`, `server/services/submissions.ts`, `server/repo/simulator.ts`, `functions/api/{submissions,simulator}/**`, `src/api/submissions.ts`, `src/ui/pages/{AssistedSubmit,Simulator}.tsx`, `functions/api/claims/[id]/packet.ts` | 03, 04, 06 |
| 2 | **08 Remittances** | `src/domain/matcher.ts`, `server/{repo,services}/remittances.ts`, `functions/api/remittances/**`, `src/api/remittances.ts`, `src/ui/pages/Remittances.tsx` | 03, 04 |
| 2 | **09 AI** | `server/ai/**`, `functions/api/ai/**`, `src/api/ai.ts`, `src/ui/ai/**` (replaces the stubs) | 03, 04, 06 |
| 3 | **10 End to end** | `tests/e2e/**` | 05, 07, 08, 09 |

**Edits outside the table, recorded at merge.** Block 03 also edited `server/services/rebuild.ts` (oldest-first rebuild). Block 04 also edited
`server/services/{rebuild,deadlines}.ts`, `server/repo/{claims,submissions}.ts`, `server/claim-http.ts`,
`src/api/{claim-actions,claim-limits,common}.ts`, `src/ui/format.ts`, `src/ui/app.css`, the shared components it renders,
`src/ui/pages/Queue.tsx`, `functions/api/claims/index.ts`, `ERROR_CODES` and `src/domain/types.ts`, `migrations/0001_init.sql` (the
portal-reference trigger, in place before release) and `src/domain/claims/build.ts` (the `splitAcross` export only). Block 07 also edited `src/domain/types.ts` (`exported`, `sent_not_recorded`), `server/repo/visits.ts` (`clinicalAt`), `server/bytes.ts` (`sha256Hex`), `src/ui/format.ts`, `app.css`, `src/domain/settings.ts` (`portalUrl`, a 12-field template cap), the synthetic payers' `portalUrl`, and `ClaimHistory.tsx` (the "Payer simulator" label, by conductor decision). Block 11 added `migrations/0002_key_rotation.sql`, `possible_duplicate` (409, reviewer confirms) on the remittance upload, and `redirect: "manual"` in `src/ui/api.ts` so an Access redirect reads as the session ending. Block 08 also edited `tests/helpers/{arbitraries,payments}.ts`, `ERROR_CODES`, the `RemittanceColumnsSchema` export in `src/domain/settings.ts`, `app.css` and the `/payments/r1` heading in `App.test.tsx`. Block 09 also added `tests/helpers/ai.ts` and six `ai_*` codes in `src/api/common.ts`. Wave 2 blocks start
from the merged tree, so these files are now shared: 07, 08 and 09 may add to `server/repo/submissions.ts`, `src/ui/format.ts` and
`app.css` but must not change what is there without saying so in their report.

So: one developer on 01, then two in parallel on 01b and 02a, then one on 02; four in wave 1; three in wave 2. The end-to-end test (§2) lands
with the last block of wave 2 to merge.

**Rules that keep merges clean.**
- Closed unions (claim statuses, actions, finding codes, audit actions, payer IDs for the
  synthetic clinic, identity fields) are declared complete in `src/domain/types.ts` by block 01.
  A later block adding a member is a one-line change the conductor merges.
- Schema changes after 0001 are discouraged. If one is needed, block NN names it
  `migrations/00NN_<slug>.sql`, so numbers never collide.
- The finding catalogue (`src/domain/claims/findings.ts`) belongs to block 03; block 02 creates it
  with the CHAS codes and block 03 completes it.
- AI UI goes in `src/ui/ai/` slots, so blocks 04 and 06 render `<RejectionExplainer>` and
  `<CodeSuggestion>` without waiting for block 09.
- `GLOSSARY.md`, `docs/adr/` and `CHANGELOG.md` are edited only by the conductor.

---

## 5. D1 schema outline (`migrations/0001_init.sql`)

All money is `INTEGER` cents; all instants are ISO 8601 UTC text; all calendar dates are SGT
`YYYY-MM-DD`. Status and kind columns carry `CHECK (... IN (...))`. Two open-ended columns
deliberately have none: `audit_events.action` and `findings.code`. Both lists grow as later blocks
land, SQLite cannot alter a CHECK without rebuilding the table, and the append-only audit log must
never be rebuilt; the TypeScript unions guard them. Do not add one.

| Table | Columns (key ones) | Constraints and indexes |
|---|---|---|
| `imports` | `id` TEXT PK, `source` (connector, synthetic, upload), `actor`, `started_at`, `finished_at`, `received`, `new`, `changed`, `unchanged`, `flagged`, `refused` | |
| `visits` | `visit_key` TEXT PK (clinic visit ID), `current_revision`, `content_hash`, `branch_id`, `visit_date`, `patient_hash`, `patient_mask` | index (`patient_hash`, `visit_date`) |
| `visit_revisions` | `visit_key`, `revision`, `import_id`, `content_hash`, `clinical_json`, `identity_sealed`, `created_at` | PK (`visit_key`, `revision`); immutable (triggers refuse UPDATE/DELETE) |
| `claims` | `id` TEXT PK, `visit_key`, `payer_id`, `scheme` (chas, medisave_tosp, medisave_flexi, insurance), `branch_id`, `status`, `version`, `last_action`, `rule_set_id`, `built_from_revision`, `approved_revision`, `submitted_revision`, `fee_cents`, `claimed_cents`, `paid_cents`, `deadline_date`, `portal_reference`, `channel`, `changed_after_submission`, `self_approved`, `approved_by`, `approved_at`, `rejection_reason`, `patient_hash`, `patient_mask`, `visit_date`, `annotations_json`, `accepted_cents`, `overpaid`, `checkout_by`, `checkout_until`, `created_at`, `updated_at` | UNIQUE (`visit_key`, `payer_id`); index (`status`, `deadline_date`), (`portal_reference`), (`patient_hash`, `visit_date`), (`payer_id`, `status`) |
| `claim_lines` | `claim_id`, `line_no`, `treatment_ref`, `scheme_code`, `tooth`, `quantity`, `fee_cents`, `considered_cents`, `claimed_cents` | PK (`claim_id`, `line_no`) |
| `findings` | `claim_id`, `seq`, `code`, `severity` (blocking, warning), `params_json`, `rule_ref`, `line_no` (nullable: the claim line the finding concerns; NULL for a claim-wide finding) | PK (`claim_id`, `seq`); replaced wholesale on each build |
| `submissions` | `id` TEXT PK, `claim_id`, `attempt`, `channel`, `batch_ref`, `packet_masked_json`, `packet_hash`, `result` (checklist, exported, sent, failed), `portal_reference`, `error`, `actor`, `at` | UNIQUE (`claim_id`, `attempt`) |
| `audit_events` | `id` INTEGER PK AUTOINCREMENT, `at`, `actor`, `action`, `entity_type`, `entity_id`, `detail_json` | append-only: triggers refuse UPDATE and DELETE (landing-page `0003` pattern); index (`entity_type`, `entity_id`) |
| `remittances` | `id` TEXT PK, `payer_id`, `file_name`, `file_hash`, `imported_at`, `actor`, `lines`, `matched` | UNIQUE (`payer_id`, `file_hash`) |
| `remittance_lines` | `remittance_id`, `line_no`, `portal_reference`, `patient_hash`, `visit_date`, `amount_cents`, `paid_on`, `claim_id` NULL, `match_kind` (reference, patient_date_amount, manual) NULL | PK (`remittance_id`, `line_no`); partial UNIQUE (`remittance_id`, `claim_id`) WHERE `claim_id` IS NOT NULL (a claim paid in part can be paid again from a later file) |
| `settings` | `id` = 1, `version`, `doc_json`, `updated_by`, `updated_at` | CHECK (`id` = 1) |
| `code_map` | `clinic_code`, `target` (chas, tosp, benefit), `payer_id` ('' for chas/tosp), `target_code`, `origin` (manual, ai_accepted), `updated_by`, `updated_at` | PK (`clinic_code`, `target`, `payer_id`) |
| `sim_inbox` | `id` TEXT PK, `claim_id`, `payer_id`, `packet_masked_json`, `state` (received, accepted, rejected, paid), `reason`, `sim_reference`, `paid_cents`, `updated_at` | UNIQUE (`claim_id`, `sim_reference`) |
| `ai_usage` | `day`, `calls`, `cost_nano_usd` | PK (`day`) |

Remittance CSVs carry NRICs: the import hashes them with the match key and stores only the hash.
Settings hold branches, dentists, payers (scheme, channel, template fields in order, API URL),
benchmark overrides and the waterfall order, validated by `DeskSettings` on every read and write.

---

## 6. API routes

Every route except `/api/imports` uses Access auth (F1). Mutations need JSON and a same-origin
`Origin` (F11). Roles: **O** claims officer, **R** reviewer (reviewers can do everything officers
can). Lists are cursor-paged and never include identity.

| Method and path | Role | Does |
|---|---|---|
| `GET /api/me` | any | email, roles, whether AI is configured, whether demo mode is on |
| `POST /api/imports` | connector token | up to 100 source visits; returns the import summary |
| `POST /api/imports/synthetic` | O, `DEMO_MODE` only | generates the synthetic clinic for today and imports it through the same service |
| `GET /api/imports` | O | recent imports with counts |
| `GET /api/overview` | O | counts that lead to work: needs attention, ready, approved, due in 5 days, rejected | 
| `GET /api/claims` | O | queue: filter by status, scheme, payer, branch, due, changed after submission |
| `GET /api/claims/:id` | O | claim, lines, findings, bill split, sibling claims, submissions, audit history |
| `POST /api/claims/:id/actions` | O; R for approve | `{ action, expectedVersion, ... }` through `applyAction`; 409 when stale |
| `POST /api/claims/actions` | R | batch approve or unapprove |
| `PUT /api/claims/:id/annotations` | O | justification, pre-authorisation and MCAF references; rebuilds the claim |
| `POST /api/claims/:id/reveal` | O | `{ field }`; audits, then returns the one value |
| `GET /api/claims/:id/packet` | O | masked packet in payer order, for the assisted checklist |
| `POST /api/submissions` | O | `{ claimIds }`; per payer: checklist, file (CSV in the body as a download), or send results |
| `GET /api/simulator/inbox` | O | claims the simulator has received |
| `POST /api/simulator/inbox/:id` | O | `{ decision: accept, reject, pay, reason?, amount? }`; records the outcome as actor `simulator` |
| `POST /api/remittances` | O | `{ payerId, fileName, csv }`; parses, matches, records payments |
| `GET /api/remittances/:id` | O | lines with match state |
| `POST /api/remittances/:id/lines/:n/match` | O | manual match to a claim |
| `GET`, `PUT /api/settings` | R to write, O to read | the settings document, with `expectedVersion` |
| `POST /api/settings/rebuild` | R | carries on a settings or code-map rebuild that stopped at the 100-visit limit; answers how many visits are still to rebuild |
| `GET /api/settings/reseal` | R | how many rows sit under each key version, and how many can't move (added at ticket 11) |
| `POST /api/settings/reseal` | R | moves the next batch of rows to the current key version, one audit event per batch (added at ticket 11) |
| `GET /api/code-map`, `PUT`, `DELETE /api/code-map/:clinicCode/:target/:payerId` | R to write | the code map |
| `POST /api/ai/code-suggestion` | O | `{ clinicCode, description }` |
| `POST /api/ai/rejection-explainer` | O | `{ claimId }`; uses the claim's lines, findings and the de-identified reason |
| `POST /api/ai/justification` | O | `{ claimId, notes }` |
| `POST /api/ai/source-mapping` | R | `{ schema }` from `claims-connector describe` |

Errors are `{ error: code, ...detail }`; the page owns the words.

---

## 7. Security notes

- **Access header trust.** F1. Only the verified JWT counts; `DEV_USER` only on loopback (localhost, 127.0.0.1, [::1]); fail
  closed when unconfigured; one Access application must cover the custom domain, `pages.dev` and
  previews.
- **Connector token.** `CONNECTOR_TOKEN` is valid only on `POST /api/imports`, compared in constant
  time (HMAC both sides, compare digests), at least 32 random bytes. A request with a bad token gets
  401 with no detail. The connector also needs to pass Access: give it an Access service token
  (`CF-Access-Client-Id`/`-Secret`), or a bypass policy scoped to `/api/imports` only. Prefer the
  service token: two independent secrets. Rotation is a coordinated change of the Pages variable
  and the clinic's connector environment.
- **Identifier masking and hashing key.** F2. `IDENTIFIER_KEY` → HKDF → HMAC key for patient and
  content hashes, AES-GCM key for sealed identity. Masking happens on the server; the UI never
  receives a raw identifier except from the audited reveal route. File exports and API sends open
  identity and audit one event per claim. Remittance identifiers are hashed on arrival and discarded.
- **CSV injection.** F9. Formula-leading text cells are prefixed with `'` and quoted; amounts are
  emitted from integers. Applies to the file channel and any other download.
- **AI.** F8. A single `deidentify` gate, fail closed, exact-match redaction of the visit's own
  identity, a daily call cap, no SDK retries, SDK logging off.
- **`api` channel.** F3. Derived variable names, https only, no redirects, bounded responses.
- **Browser.** F11. JSON-only mutations with an Origin check, CSP with `frame-ancestors 'none'`,
  `no-store`.
- **Real data.** The synthetic-only guard (F2) holds until `ALLOW_REAL_IDENTIFIERS=yes`; D1 created
  with `--location apac`; the data-intermediary agreement stays a prerequisite.

---

## 8. Blast radius

Greenfield; nothing outside this repo changes. Within the repo:

- **Configs:** `package.json` (deps `zod`; `sql.js` to dependencies; devDep `tsx`; scripts
  `connector`, `mock:clinic`, `dev:functions` bindings), `tsconfig.json` and `vitest.config.ts`
  (add `connector`, `mock`).
- **Schema:** one new migration with fourteen tables and append-only triggers.
- **Environment (PRD §5.4 grows):** add `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `IDENTIFIER_KEY`,
  `ALLOW_REAL_IDENTIFIERS`, `DEMO_MODE`, `AI_DAILY_CALL_CAP`; keep `DEV_USER` local-only.
- **Docs:** README (new), PRD §5.3 (channel has two methods) and §5.4 (variables), GLOSSARY (two
  MediSave payers if the conductor agrees), ADRs 0006–0009.
- **Read only, mirrored:** `repos/landing-page/server/{anthropic,crypto,http}.js` patterns, ported
  to TypeScript, not imported.

No wide refactor, so no expand–contract sequencing is needed.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| D1 per-invocation query limit and Workers CPU time on large imports | pages of 100 visits; one batch per visit; queue lists read only `claims` columns, never revision JSON |
| Concurrent approvals or connector runs | version + nonce guard (F7), unique keys, 409 to the UI |
| Access key-set fetch fails | cached keys; fail closed with 503, never open |
| `changes()`/batch behaviour differs between sql.js and D1 | the nonce guard avoids `changes()`; block 01 also runs one `dev:functions` smoke against local D1 |
| Anthropic rate limit, billing, outage | AI fails closed per call; the desk works without it (ADR 0004); daily cap |
| Rule figures go stale (TOSP update in 2026, more benchmarks) | dated rule sets with sources; a claim pins its rule set; a visit with no covering rule set is a blocking finding |
| Real identifiers arrive before the agreement | synthetic-only guard |
| Time-dependent tests break later | `asOf` in the generator, `vi.setSystemTime` at routes, explicit `today` in the domain |
| Payer field orders and remittance formats are unknown | templates and column mappings are settings, not code; the simulator exercises the lifecycle |

---

## 10. ADR drafts (missing decisions)

For the conductor to file through `domain-modeling`, in the repo's one-paragraph style.

**0006 Identifiers are sealed, hashed with a key, and masked on the server.**
Source visits are split at import into a de-identified clinical part and an identity part. The
identity part is encrypted with AES-GCM; matching uses an HMAC of the NRIC/FIN; both keys derive
from one `IDENTIFIER_KEY`. Only the reveal route, channel sends and file exports open identity, and
each writes an audit event. Until `ALLOW_REAL_IDENTIFIERS` is set, imports refuse any identifier
outside the synthetic block. We rejected plaintext identifiers in the snapshot (they would sit in D1
history and exports) and an unkeyed hash (reversible by enumeration). Retrofitting encryption after
real data arrives would need a data migration, so it is cheapest now.

**0007 Who is signed in comes from a verified Access token; the connector has its own token.**
The desk trusts only a verified `Cf-Access-Jwt-Assertion`, never the email header, because a Pages
project also answers on hostnames Access may not cover. Unconfigured means closed. The connector
authenticates with a bearer token valid on one route, plus an Access service token. Roles come from
email allowlists in the environment.

**0008 Rule sets are committed JSON; settings can only fill confirmed blanks; claims pin their
rule set.** Refines ADR 0002 with where the data lives and how a claim stays reproducible.

**0009 One claim per visit per payer; resubmission is an attempt, not a new claim; submitted
claims are fixed inputs to the waterfall.** Includes the two MediSave payers, approval bound to the
built revision, and the `upstream_rejected` warning. Hard to reverse because the unique key, the
audit trail and remittance matching all hang off claim identity.

No prototype is needed: every open design question can be settled on paper. The unknowns that
remain are client facts (PRD §6), and the design keeps each of them in settings.

---

## 11. Ticket review

Done 2026-11-13: see `reviews/tickets.md`. §4 above is updated to match the edited tickets.
