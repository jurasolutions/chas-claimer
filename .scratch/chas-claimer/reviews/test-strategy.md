# Test strategy: chas-claimer (Claims desk)

*QA lead, 2026-11-13. Spec: `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md` (SC = success
criterion in PRD §2, B = build block in PRD §5.5). Terms in bold are from `GLOSSARY.md`.*

This file is what the quality gate checks against. Every case ID below (for example `SC2.3`) must
be traceable to a passing test (file and test name) or a PASS line in a `reviews/qa-NN.md` before
the gate can say go.

---

## 0. Seams

`reviews/technical.md` did not exist when this strategy was written. The seams below come from PRD
§5.1 and §5.3 and the harness already in the repo (`vitest.config.ts`, `tests/setup.ts`,
`tests/helpers/d1.ts`). The tech lead should confirm them in `reviews/technical.md`; any
disagreement becomes a question in the crew log, and this file is updated to match.

| ID | Seam | What sits behind it | How tests drive it |
|---|---|---|---|
| **S1** | Domain core, `src/domain/` | Money, NRIC check and mask, rule sets, claim builder, payer waterfall, findings, lifecycle, remittance matcher, CSV render and parse | Pure function calls. Example tables plus fast-check properties |
| **S2** | Pages Functions, `functions/api/**` | D1 storage, roles, audit trail, import, approval, channels, AI endpoints | `onRequest({ request, env })` called directly, `env.DB = await createD1()` with the real migrations, `fetch` stubbed (the guard in `tests/setup.ts` stays as it is) |
| **S3** | Submission channel contract | `prepare(claim) → packet`, `send(packets)`, `recordOutcome` for `assisted`, `file`, `api`, `simulator` | One shared contract suite run against all four channels, plus per-channel cases |
| **S4** | AI gateway | The single module that builds every Anthropic request | Global `fetch` stub captures the outbound request body; canned model responses |
| **S5** | Connector, `server/` or `scripts/` CLI | Source reader (SQLite, CSV) through a **source mapping**, then an HTTPS poster | Reader called on the generated synthetic SQLite file; poster's `fetch` routed in-process to the S2 import handler |
| **S6** | UI components, `src/**` | React screens built from the design system | jsdom (`// @vitest-environment jsdom`) with Testing Library; API responses stubbed per test |
| **S7** | Running app | Built UI + Functions + local D1 (workerd/miniflare) | `npm run db:migrate:local` then `npm run dev:functions`, driven through the Playwright MCP at http://localhost:8788. Results recorded in `reviews/qa-NN.md` |

### Testability the build must provide

These are requirements on the developers, so the cases below can be written at the right seam.

1. **An injectable clock.** The 30-day window, card expiry and "today" in the UI read a `now`
   passed in (domain) or taken from `env` (Functions), never `Date.now()` inside a rule.
2. **Dates as SGT calendar dates.** Visit dates, card expiry and birth dates are `YYYY-MM-DD`
   strings interpreted in Asia/Singapore. Workers run in UTC; a date computed from a UTC timestamp
   moves an 00:30 SGT visit to the previous day.
3. **Rule sets passed in, not imported inside checks,** so tests can supply a fixture rule set.
4. **One channel interface** (PRD §5.3), so the contract suite can iterate the four channels.
5. **One AI module** that every AI feature calls, so one capture point sees every outbound request.
6. **A deterministic synthetic clinic generator** with a seed parameter, usable from tests without
   writing a file (an in-memory SQLite or plain objects), and writing the same bytes for the same seed.
7. **Test helpers** (to be added under `tests/helpers/`): `env.ts` (an env with DB, roles, tokens
   and an optional AI key), `request.ts` (call a handler as an officer, a reviewer, the connector or
   nobody), `builders.ts` (patient, card, visit, treatment, policy, claim builders with valid
   defaults), `arbitraries.ts` (fast-check arbitraries, see §5), `anthropic.ts` (a `fetch` stub that
   records requests and returns canned responses), `clock.ts`.

### Pinned boundaries

The research note does not settle these edges. The tests pin the assumption below; a different
answer from the clinic is a test change, not a code argument. The tech lead confirms or overrides
them in `reviews/technical.md`.

| Edge | Assumption the tests pin |
|---|---|
| 30-day CHAS window | Claimable when `today ≤ visit date + 30 days` (day 30 in, day 31 out) |
| Card expiry | A card is valid on its expiry date (expired means `visit date > expiry date`) |
| Same-day duplicate | Same patient, same SGT calendar date, any **branch**, both CHAS |
| Flexi-MediSave age | Age on the visit date; a patient whose 60th birthday is the visit date qualifies; 29 Feb birthdays turn a year older on 1 Mar in non-leap years |
| Rule set selection | The latest rule set whose effective date is on or before the visit date; a visit before every rule set is a blocking finding ("no rule set for this date") |
| Benchmark | A fee strictly above the top of a configured range, on a visit on or after 1 Sep 2026, needs a justification; a blank benchmark never flags |
| GST | Subsidy is computed on the fee including GST when the branch is GST-registered, on the fee alone otherwise |

---

## 1. Coverage map

Level key: **U** pure unit (example or table-driven) · **P** property-based (fast-check) · **I**
integration at the named seam · **UI** jsdom component test · **E2E-V** whole flow in Vitest at S2
and S5 · **BQA** browser QA on the running app (S7) · **UAT** a person, manual.

### SC1. A source visit becomes checked claims for every payer, split by the waterfall, with no re-typing

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC1.1 | Each tier (PG, MG, Blue, Orange, PA) gets the schedule amount per CHAS procedure, as the lesser of fee and maximum, per line, in cents | U table | S1 claim builder | 18 procedures × 4 tiers from research §1.5, plus PA; a fee below and above each cap | yes |
| SC1.2 | PA subsidy equals the fee; patient balance is zero for covered lines | U | S1 | PA patient, three covered procedures, one uncovered | yes |
| SC1.3 | GST applied before subsidy when the branch is GST-registered, not otherwise | U table | S1 | Two branches (one registered), same visit | yes |
| SC1.4 | Payer waterfall conserves money: CHAS + MediSave + insurance + patient balance = total charged, for any visit and any waterfall order | P | S1 waterfall | `arbVisit`, `arbWaterfallOrder` | yes |
| SC1.5 | No claim or line is negative; no payer claims more than the payer above it left; no line exceeds its cap | P | S1 | as SC1.4 | yes |
| SC1.6 | Worked example from the interview (Q13): MG patient aged 62, molar root canal, corporate plan; CHAS then Flexi-MediSave up to $400 a year then insurance then patient | U | S1 | One hand-computed fixture with expected cents per payer | yes |
| SC1.7 | Non-default waterfall order (insurance before MediSave) changes the split as configured | U | S1 | Same visit, two orders | yes |
| SC1.8 | MediSave TOSP claim capped at the table limit (1A $240 … 7C $5,290); at most 3 procedures per episode | U table | S1 | Every table cell from research §2.1; a 4-procedure episode | yes |
| SC1.9 | Insurance claim capped by the **policy**'s remaining annual limit, with a **benefit code** per line | U | S1 | Policy with limit partly used; unmapped benefit code | yes |
| SC1.10 | A treatment with no **code map** entry produces a finding, not a silent drop | U + I | S1, S2 | One unmapped clinic code | yes |
| SC1.11 | Import of a visit builds and stores its claims and lines, with no manual step | I | S2 `/api/imports` | 1 visit per scheme mix | yes |
| SC1.12 | Re-import is idempotent by visit ID and content hash: same content is a no-op; changed content updates unsubmitted claims; a submitted claim is left as sent and flagged **changed after submission** | I | S2 | Visit v1, v1 again, v2 before submission, v2 after submission | yes |
| SC1.13 | Importing the same batch twice leaves the database identical | P | S2 | `arbVisitBatch` (small, 1–5 visits) | yes |
| SC1.14 | The whole synthetic clinic imports and produces claims for every scheme | E2E-V | S2 | Synthetic clinic, fixed seed | yes |
| SC1.15 | Officer imports the synthetic clinic from the UI and sees claims in the queue | BQA | S7 | Synthetic clinic | recorded |

### SC2. Certain breaches block; uncertain ones warn (ADR 0003)

One table-driven test at S1 with a row per finding, each asserting the finding code and its
severity. Every row has a negative twin (the same visit one step inside the boundary, no finding).

| ID | Finding | Severity | Boundary case and its twin | Automated? |
|---|---|---|---|---|
| SC2.1 | Card expired on the visit date | block | expiry = visit − 1 day / expiry = visit date | yes |
| SC2.2 | CHAS Green claiming dental | block | Green / Blue, same procedure | yes |
| SC2.3 | Past the 30-day window | block | today = visit + 31 / visit + 30 | yes |
| SC2.4 | Same-day duplicate CHAS claim | block | two visits same SGT date (including different branches, and a 00:30 SGT visit with `TZ=UTC`) / consecutive dates | yes |
| SC2.5 | Unfinished multi-visit procedure (crown, root canal, denture) | block | `completed = false` / `true` | yes |
| SC2.6 | MediSave claim without an **MCAF** | block | no MCAF / MCAF(S) on file | yes |
| SC2.7 | MSP-ranked **TOSP code** | block | SF811T / SF812T (1B) | yes |
| SC2.8 | No rule set for the visit date | block | visit before the first rule set / on its effective date | yes |
| SC2.9 | Local annual count over a frequency limit (shared extraction 4/yr, filling 6/yr, root canal 2/yr, consultation 2/yr 6 months apart, denture 1 upper + 1 lower per 3 years, Flexi-MediSave $400/yr) | **warn** | count at limit + 1 / at limit | yes |
| SC2.10 | Fee above a configured **benchmark** on or after 1 Sep 2026 | needs justification (block until a justification is attached) | consultation fee $31.01 / $31.00; visit 31 Aug 2026 / 1 Sep 2026; blank benchmark never flags | yes |
| SC2.11 | Flexi-MediSave under 60, or dentist not MediSave-accredited | block (certain from the record and settings) | 59 years 364 days / 60th birthday | yes |
| SC2.12 | **Property (ADR 0003):** for any visit, adding any history of this clinic's earlier claims never adds or removes a *blocking* finding; history only changes warnings | P | S1, `arbVisit` × `arbHistory` | yes |
| SC2.13 | **Property:** checks are deterministic: the same visit, rule set and clock give the same findings in the same order | P | S1 | yes |
| SC2.14 | A claim with any blocking finding is `needs attention`; with only warnings it is `ready` | I | S2 | yes |
| SC2.15 | Officer cannot approve or submit a `needs attention` claim (API returns 409 and nothing changes) | I | S2 | yes |
| SC2.16 | Findings shown on claim detail with plain-language text; warnings visibly distinct from blocks | UI + BQA | S6, S7 | yes / recorded |

### SC3. Assisted submission of a CHAS claim in under a minute of copying, with the portal reference recorded

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC3.1 | The CHAS **claim packet** holds only CHAS fields, in a fixed portal order | U | S3 assisted `prepare` | One approved CHAS claim | yes |
| SC3.2 | Every packet field on the checklist has a copy button that writes exactly that value (`navigator.clipboard.writeText` stubbed) | UI | S6 checklist | as SC3.1 | yes |
| SC3.3 | The NRIC is masked on the checklist until revealed; copying or revealing it writes one audit event with the actor | UI + I | S6, S2 | as SC3.1 | yes |
| SC3.4 | Recording the **portal reference** moves the claim to `submitted`, stores the reference, writes an audit event; an empty or duplicate reference is refused | I | S2 | as SC3.1 | yes |
| SC3.5 | The checklist flow needs no typing except the portal reference and no navigation away from the page | UI | S6 | as SC3.1 | yes |
| SC3.6 | Officer works one CHAS claim end to end through the checklist at 360px and desktop width | BQA | S7 | Synthetic clinic | recorded |
| SC3.7 | A person copies one CHAS claim into a blank stand-in form, timed, under 60 seconds | UAT | Ting Yu or the clinic | One synthetic claim | manual |

### SC4. Reviewer approval and a complete audit trail

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC4.1 | Lifecycle transition table: every (from, to) pair of the 9 statuses is allowed or refused exactly as PRD §3 and interview Q20 say | U table | S1 lifecycle | 81 pairs | yes |
| SC4.2 | **Property:** any random sequence of actions keeps every claim in a legal status; amounts on a `submitted` or later claim never change | P | S1 | `arbActionSequence` | yes |
| SC4.3 | Only a **reviewer** can approve (officer gets 403); single and batch approval | I | S2 | `ROLE_REVIEWERS`, `ROLE_OFFICERS` | yes |
| SC4.4 | Self-approval is allowed and recorded as self-approval in the audit event | I | S2 | One user in both roles | yes |
| SC4.5 | No `Cf-Access-Authenticated-User-Email` and no `DEV_USER`: 401; a signed-in user in neither role: 403; when the Access header is present it wins over `DEV_USER` | I | S2 | Env variants | yes |
| SC4.6 | One audit event per import, change, approval, submission attempt (including failed ones), identifier reveal and outcome, each with actor, time and claim | I | S2 | Flow fixture | yes |
| SC4.7 | Audit trail is append-only: no Function issues UPDATE or DELETE on `audit_events` (code search test), and event count never decreases across the E2E flow | U + I | repo grep, S2 | n/a | yes |
| SC4.8 | Withdraw before submission and write-off after rejection; rejected back to `ready` for resubmission | I | S2 | Claims in each status | yes |
| SC4.9 | Claim detail shows the audit trail in order, with actors | UI + BQA | S6, S7 | Flow fixture | yes / recorded |

### SC5. Remittance matching

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC5.1 | Match by portal reference first | U | S1 matcher | Remittance lines with references | yes |
| SC5.2 | Then by patient + visit date + amount, only when exactly one candidate fits | U | S1 | Two claims that tie on all three (must stay unmatched) | yes |
| SC5.3 | Unknown reference and an amount mismatch with no reference stay unmatched for a person; nothing is guessed. A partial payment on a matched reference is recorded and the claim stays accepted (AC-5.3, amended at ticket 08) | U | S1 | One of each | yes |
| SC5.4 | **Property:** each remittance line matches at most one claim and each claim at most one line; re-importing the same file changes nothing | P | S1, S2 | `arbClaims` × `arbRemittance` | yes |
| SC5.5 | Per-payer column mapping parses a CSV (quotes, commas, BOM, CRLF, blank lines, thousands separators in amounts) into cents | U + P | S1 CSV parse | Fixture CSVs per payer | yes |
| SC5.6 | Import via Function moves matched claims to `paid`, records the match, writes audit events; manual match by a person works | I | S2 | Remittance CSV for the synthetic clinic | yes |
| SC5.7 | Officer imports a remittance and matches the leftovers by hand | BQA | S7 | as SC5.6 | recorded |

### SC6. AI features suggest only, carry no identifier, and the desk works with AI off

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC6.1 | Each of the four features (code map suggestion, rejection explainer, justification draft, source mapping proposal) sends a request through S4 and returns a suggestion | I | S2 + S4 | Canned model responses | yes |
| SC6.2 | **Property:** for any synthetic visit, including treatment text and dentist notes seeded with an NRIC, name, phone, address, policy number and member ID, the captured outbound body contains none of them | P | S4 | `arbVisit` with `arbIdentifierLadenText` | yes |
| SC6.3 | Source mapping proposal sends column names only: never a row value from the synthetic database | I | S4 | Synthetic SQLite with distinctive row values | yes |
| SC6.4 | A suggestion changes nothing until a person accepts it: code map, claim amounts, statuses unchanged after every AI call | I | S2 | Before/after database snapshot | yes |
| SC6.5 | `ANTHROPIC_API_KEY` unset: every AI endpoint answers "not configured", `fetch` is never called, and the E2E flow (SC8.3) passes | I + E2E-V | S2 | Env without the key | yes |
| SC6.6 | A hostile or malformed model response (invalid JSON, a code not in the rule set, an amount, markup) is shown as text or refused; it never sets a field | I + UI | S4, S6 | Canned bad responses | yes |
| SC6.7 | Model error, timeout or 429 gives a plain message and no state change | I | S4 | Stubbed failures | yes |
| SC6.8 | Accepting a code map suggestion from claim detail, with AI on against a stubbed model | BQA | S7 with `ANTHROPIC_BASE_URL` pointing at a local stand-in, or AI off showing "not configured" | n/a | recorded |

### SC7. Every amount traces to a dated rule set; no real patient data

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC7.1 | Every shipped rule set has an `https` source URL and an effective date; every amount has an "as of" date | U | S1 | Shipped rule sets | yes |
| SC7.2 | Shipped figures equal the research note: CHAS 18 × 4 table (§1.5), TOSP dental subset rankings and the 21 table limits and $830 ward limit (§2.1), Flexi-MediSave $400 | U table | S1 | An independent transcription of the research tables as the test oracle | yes |
| SC7.3 | Only the consultation ($21–$31) and crown ($750–$1,400) benchmarks are filled; the other 16 are blank, not zero | U | S1 | Shipped settings | yes |
| SC7.4 | **Property:** rule set selection returns the latest set effective on or before the visit date | P | S1 | `arbDate` × fixture rule sets | yes |
| SC7.5 | Claim detail shows each amount's rule set source and date | UI | S6 | One claim | yes |
| SC7.6 | **Synthetic-data guard:** a test scans every tracked file (`git ls-files`) for NRIC/FIN-shaped strings and fails on any outside the agreed synthetic block; also scans for Singapore phone-number shapes in seed data | U | repo | n/a | yes |
| SC7.7 | **Property:** the synthetic NRIC generator only emits IDs in the synthetic block with a valid check letter, and the NRIC validator accepts every one | P | S1 | `arbSyntheticNric` | yes |
| SC7.8 | **Property:** the validator rejects every single-character mutation of a valid ID (digit change, letter change, prefix change); normalising twice equals normalising once; the mask never shows more than the last three digits and the check letter | P | S1 | as SC7.7 | yes |
| SC7.9 | The synthetic clinic covers every case it promises: each tier, Green, PA, expired card, MediSave with and without MCAF, MSP code, Flexi-MediSave at 59 and 60, insurance with partly used limit, unfinished crown, same-day duplicate, above-benchmark fee, unmapped code, two branches with different GST status | U | generator | Fixed seed | yes |
| SC7.10 | The generator is deterministic: the same seed gives byte-identical output | U | generator | Two runs | yes |

### SC8. Build health and the end-to-end flow on the synthetic clinic

| ID | Criterion | Level | Seam / location | Data needed | Automated? |
|---|---|---|---|---|---|
| SC8.1 | `npm test`, `npm run typecheck`, `npm run build` pass | gate | fresh run | n/a | yes |
| SC8.2 | Migrations apply to an empty in-memory D1 and via `npm run db:migrate:local` | I + BQA | S2, S7 | n/a | yes / recorded |
| SC8.3 | **Whole flow in Vitest:** generate the synthetic clinic → connector reads it through the shipped mapping → posts to `/api/imports` → claims and findings → officer fixes one → reviewer approves → submit through the simulator → simulator accepts, rejects (with reason) and pays → remittance import → matched → audit trail complete | E2E-V | S5 → S2 → S3 | Synthetic clinic, fixed seed | yes |
| SC8.4 | The same flow through the running app in a browser (see §6, B1–B9) | BQA | S7 | Synthetic clinic | recorded |

### Build blocks

| Block | Cases it must turn green before its ticket closes |
|---|---|
| B1 Walking skeleton | SC1.1 (CHAS only), SC1.11, SC1.14 (CHAS), SC2.14, SC7.6, SC7.7, SC7.10, SC8.2, B1 in §6 |
| B2 Rule sets and claim building | SC1.1–SC1.10, SC1.12, SC1.13, SC2.1–SC2.13, SC7.1–SC7.4, SC7.8, SC7.9 |
| B3 Lifecycle, approval, audit, claim detail | SC2.15, SC2.16, SC4.1–SC4.9, SC7.5 |
| B4 Channels, checklist, file, API, simulator | SC3.1–SC3.6, §3 channel contract, file CSV properties, API channel cases, B4–B6 in §6 |
| B5 Remittance | SC5.1–SC5.7 |
| B6 AI features | SC6.1–SC6.8 |
| B7 Connector and source mapping | SC8.3 (connector leg), §3 connector cases |
| B8 Settings, code map, overview | §3 settings cases, B8–B9 in §6, SC8.3, SC8.4 |

---

## 2. Risk-based depth

Riskiest first. Each has negative cases and at least one end-to-end path (SC8.3 in Vitest, SC8.4
in the browser).

1. **Wrong money.** Subsidy, cap, GST, waterfall split. Negative cases: fee below the cap, fee
   exactly at the cap, zero fee, PA, Green, uncovered procedure, policy limit exhausted, Flexi
   balance exhausted. Properties SC1.4 and SC1.5 run on every commit. Amounts are integer cents
   end to end; a test asserts that every amount field in an API response is a safe integer.
2. **Identifier leaks.** To the model (SC6.2, SC6.3), to the screen and API unmasked (an
   integration test scans every list and detail JSON response for full NRIC shapes; a jsdom test
   scans rendered queue and detail HTML), to the repo (SC7.6), to an insurer beyond its template
   (§3, packet keys are a subset of the payer template's fields; clinical notes never present).
3. **A blocking rule that does not block,** or a warning that blocks (SC2 table with twins, SC2.12).
4. **Overwriting a submitted claim** on re-import (SC1.12). Negative case: a re-import with
   identical content must not flag.
5. **Auth and roles.** Missing header, wrong role, officer approving, connector with a missing or
   wrong bearer token (401), `DEV_USER` overriding a real Access identity (SC4.5).
6. **Irreversible outcomes.** A `paid` claim cannot be moved back by any action; a remittance
   match cannot be applied twice (SC4.1, SC5.4).
7. **External integrations.** API channel and AI calls only against stubbed `fetch` (§3, SC6.7):
   timeout, 4xx, 5xx, a non-JSON body, and a retry that must not double-submit (a second `send`
   for a `submitted` claim is refused).
8. **Time zone.** Date-sensitive suites also run with `TZ=UTC` and `TZ=Asia/Singapore`
   (`process.env.TZ` set per file) and must agree.

---

## 3. Further cases by component

These complete the build blocks; they are not acceptance criteria on their own but the gate counts
them under the block that owns them.

**Channel contract (S3), run against all four channels:** `prepare` is pure and deterministic;
packet keys are a subset of the payer's field template; `send` on an empty batch is a no-op; a
claim not `approved` is refused; every attempt writes an audit event, success or failure.

**File channel:** **property** `parse(render(batch)) == batch` for values containing commas,
quotes, newlines and non-ASCII names; a cell starting with `=`, `+`, `-` or `@` is escaped against
spreadsheet formula injection; column order follows the payer's configured layout.

**API channel:** URL and auth header name from settings, the token from `PAYER_<ID>_API_TOKEN`;
the token never appears in D1 (scan all `settings` rows), in an audit event or in a response; a
missing env token gives "not configured" and no request.

**Payer simulator:** receives claims, accept / reject with reason / pay drive the lifecycle;
reject without a reason is refused.

**Connector (S5):** reads the synthetic SQLite and a CSV export through the shipped mapping into
the same source visits (a cross-check test: SQLite path and CSV path give equal output); a
mapping that references a missing column fails with a clear message before posting anything; a
5xx from the desk is reported and the run exits non-zero; the bearer token comes from the
environment and is never printed.

**Settings and code map:** only a reviewer (or the role the tech lead names) can change
settings, payers, channels, benchmarks and the waterfall order; each change writes an audit
event; a benchmark entered with a source and "as of" date is accepted, without them refused.

**UI, every screen (S6):** renders with an empty database (empty states in the design-system
voice), shows a loading and an error state, uses `getByRole` / `getByLabelText` queries so every
control has an accessible name, and never renders a full NRIC outside the checklist reveal. A
treatment description containing `<script>` renders as text.

---

## 4. Non-functional

| Area | What the spec implies | How it is checked |
|---|---|---|
| Mobile | "Usable at 360px" (PRD §3) | BQA at 360 × 800 on each of the 8 screens: `document.documentElement.scrollWidth <= 360`, every primary action reachable, the checklist copy buttons usable |
| Accessibility | WCAG 2.2 AA for the UI | Accessible names enforced by Testing Library role queries (S6); keyboard-only pass through queue → detail → approve → checklist in BQA; Playwright accessibility snapshot per screen; `crew:web-design-review` on the UI files. Colour contrast is inherited from design-system tokens and not retested |
| Voice and numbers rule | Design system §3; no figure without a source | Code review plus a jsdom check that no screen copy contains an exclamation mark; every amount on screen comes from an API field, never a literal in a component (code review) |
| Privacy | PDPA, HCSA, MOH Circular 02/2026 | Risk items 2 and 5 above |
| Security | Public repo, secrets in env only | SC7.6, the API channel token cases, CSV injection, the `fetch` guard. `crew:security-review` on the branch before the gate |
| Migrations and rollback | First version, empty database | SC8.2. There is no earlier schema, so no down-migration is tested; rollback is a code revert (operating card) |
| Performance | Not specified (clinic volumes are open question 9) | Sanity only: the full synthetic clinic (about 200 visits) imports in one request in the in-memory D1 and under `dev:functions` without error. No budget is set |
| Browser matrix | Not specified | Chromium through the Playwright MCP only (see §7) |

---

## 5. Test data

Everything is synthetic, generated, and safe for a public repo.

- **Synthetic clinic** (B1): two branches (one GST-registered), three dentists (two
  MediSave-accredited), about 60 patients, about 200 visits, fixed seed, covering every case in
  SC7.9. Used by SC1.14, SC8.3, SC8.4 and the browser runs.
- **Builders** (`tests/helpers/builders.ts`): one valid default per entity, overridden per test.
  Table tests use builders, not the full clinic.
- **Oracle tables:** the CHAS schedule, TOSP subset and day-surgery limits transcribed from the
  research note into a test fixture by hand, independent of the shipped rule set file (SC7.2).
- **Hand-computed scenarios:** SC1.6 and at least one per scheme, with every cent worked out in a
  comment.
- **Remittance CSVs:** one per payer layout, with exact, ambiguous, partial and unknown lines.
- **Canned model responses:** a good suggestion per AI feature, plus malformed JSON, markup, an
  out-of-schedule code, a 429 and a 500.
- **fast-check arbitraries** (`tests/helpers/arbitraries.ts`): `arbCents` (0 to 10,000,000),
  `arbSyntheticNric`, `arbDate` (2025-01-01 to 2027-12-31, SGT dates), `arbTier`, `arbTreatment`,
  `arbVisit`, `arbHistory`, `arbWaterfallOrder`, `arbActionSequence`, `arbRemittance`,
  `arbIdentifierLadenText`. Constraints go in the generators, not in `fc.pre` filters.
- **fast-check settings:** a fixed seed in `tests/setup.ts` through `fc.configureGlobal`
  (overridable with `FC_SEED` to explore), `numRuns` never set below 100, and a pinned regression
  example (`examples:`) for every counterexample found during the build.
- **Identifiers in generators:** only `arbSyntheticNric` may produce an NRIC, and it only produces
  the agreed synthetic block (see the open question on that block in the crew log). Shrunk
  counterexamples appear in test output, so no generator may emit a realistic unprefixed ID.

---

## 6. Browser QA script (S7, Playwright MCP)

Run on the feature branch with `npm run db:migrate:local` then `npm run dev:functions`, at
desktop width and at 360 × 800. Assertions are DOM queries or accessibility snapshots; a
screenshot is taken only where the visual itself is the evidence (360px layout). Each scenario is
recorded in `reviews/qa-NN.md` as PASS or FAIL with the step that failed.

| ID | Scenario |
|---|---|
| B1 | Load the synthetic clinic; overview and imports show the run |
| B2 | Queue: filter by status, scheme and branch; blocked claims show their findings |
| B3 | Claim detail: fix a finding (map a code), claim moves to `ready`; audit trail shows the change |
| B4 | Reviewer approves a batch; an officer-only user cannot see or use approve |
| B5 | Assisted checklist for one CHAS claim: copy each field, reveal the NRIC once, record a portal reference; claim is `submitted` |
| B6 | File channel export downloads; simulator channel: accept one, reject one with a reason, pay one |
| B7 | Rejected claim: rejection explainer shows "not configured" with AI off; resubmit path to `ready` |
| B8 | Remittance import; automatic matches shown; match one leftover by hand |
| B9 | Settings: change waterfall order and a benchmark (with source and date); code map edit; each appears in the audit trail |
| B10 | 360px pass over all 8 screens and a keyboard-only pass over B2 → B5 |

---

## 7. Not tested, and why

| Gap | Why | Who accepts the risk |
|---|---|---|
| Real MHCP, NPHC and insurer or TPA portals: field lists, field order, rejection codes, behaviour | Not public, Singpass-gated, Singapore IPs only from 13 Nov 2026, and out of scope (PRD §3, ADR 0001). The checklist's "portal order" is our assumption until the clinic shows the real screens | Ting Yu, by the PRD's out-of-scope list; revisit with open questions 2, 5, 6 |
| Real API channel endpoints and credentials | None exist yet; the generic channel is tested against a stubbed `fetch` only | Ting Yu (PRD §3 out of scope) |
| Real Anthropic output quality | Tests never call Anthropic (operating card). Every output is a suggestion a person accepts (ADR 0004), so a poor suggestion costs time, not money | Ting Yu |
| Whether the research note matches MOH and CPF today | Tests prove the code matches the note (SC7.2), not that the note is current | Ting Yu and the clinic; rule sets carry sources and dates for that check |
| The 16 blank benchmarks | Not transcribed (open question 7); blank is tested as "never flags" | Ting Yu |
| Cloudflare Access, Pages bindings, D1 location hint, production deploy | Ting Yu's dashboard settings; covered by the infra review, not by tests. The desk trusts the Access email header; if Access is not in front of every hostname (including `*.pages.dev`), that header can be forged. The infra review must confirm Access covers every hostname, or the build verifies the Access JWT | Ting Yu, through the infra review |
| sql.js versus real D1 differences | Integration runs on sql.js; the browser runs (S7) use the local workerd D1, which narrows the gap. Production D1 limits are not exercised | Tech lead |
| Clinic databases other than SQLite and CSV | Out of scope (PRD §3) | Ting Yu |
| Browsers other than Chromium, real phones | No device matrix in the spec; clinic devices unknown | Ting Yu; add WebKit when the clinic names its devices |
| Load at clinic volume, concurrent edits by two officers | Volumes unknown (open question 9); one or two users expected | Tech lead; revisit with the volume answer |
| Legal sufficiency (PDPA, HCSA, data-intermediary agreement) | Not a test matter; the agreement is a prerequisite for real data (ADR 0005) | Ting Yu |

---

## 8. Exit criteria for the quality gate

Each line is checked mechanically. The gate marks each met or not met with its evidence.

1. **Traceability.** Every case ID in §1 (SC1.1 to SC8.4) names at least one passing automated test
   (file and test name) or a PASS line in a `reviews/qa-NN.md`. SC3.7 alone may be covered by a
   waiver (criterion 9).
2. **Fresh run** on `crew/chas-claimer` at the gated commit, by the QA lead: `npm test` exits 0
   with 0 failed tests; `npm run typecheck` exits 0; `npm run build` exits 0.
3. **No skipped or focused tests:** `grep -rnE "\.(skip|only|todo)\(|\b(xit|xdescribe|fit|fdescribe)\(" src server functions tests scripts --include='*.ts' --include='*.tsx' --exclude-dir=design-system` returns nothing (exit status 1).
4. **Property tests are real:** at least one fast-check property exists for each of money and
   waterfall (SC1.4, SC1.5), rules (SC2.12, SC2.13), NRIC (SC7.7, SC7.8), lifecycle (SC4.2),
   matching (SC5.4), AI de-identification (SC6.2) and file CSV round trip (§3); no `numRuns` below
   100; a fixed seed is configured.
5. **No network:** `tests/setup.ts` still fails any unstubbed `fetch`, and the fresh run passes with it.
6. **Synthetic-data guard** (SC7.6) is present and passes on the gated commit.
7. **AI off:** the whole-flow test (SC8.3) passes with `ANTHROPIC_API_KEY` unset.
8. **Defects:** zero open defects of severity *critical* or *major*. Each open *minor* is listed
   with an owner. Defects are filed as `issues/NN-defect-<slug>.md` with a `Severity:` line.
   - *Critical:* a wrong amount or payer split; an identifier reaching the model, an unmasked
     screen or API response, a log or the repo; a blocking rule that does not block; a submitted
     claim overwritten; an auth or role bypass; audit events lost or editable.
   - *Major:* any other acceptance criterion failing; a warning that blocks; a flow step that
     cannot be completed in the browser; a screen unusable at 360px; a broken keyboard path on
     B2 → B5.
   - *Minor:* cosmetic issues, copy that breaks the design-system voice, an accessibility issue
     with a working alternative.
9. **UAT:** SC3.7 run by a person, or explicitly waived at G4 with the waiver recorded in
   `reviews/quality-gate.md` and kept on Ting Yu's follow-up list.
10. **Reviews:** every `reviews/code-review-NN.md` ends in approve, or approve with only minor
    findings listed; a `crew:security-review` pass on the branch has no unresolved high finding.
11. **Browser QA:** B1 to B10 each PASS in a `reviews/qa-NN.md` dated on or after the last code
    change to `src/` or `functions/`.
