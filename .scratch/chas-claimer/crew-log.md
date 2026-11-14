# Crew log: chas-claimer

## 2026-11-13T21:30+08:00 conductor (intake)

status:    done
persona:   conductor
ticket:    -
artifacts: docs/agents/crew.md, CLAUDE.md, docs/agents/{issue-tracker,domain,triage-labels}.md, project scaffold
decisions: size L (new product, three payer channels, a UI, a backend; tickets and a parallel build) -> route L
decisions: gates G0–G4 delegated by Ting Yu on 2026-11-13 ("make reasonable assumptions with crew and progress this development until it is ready ... dont come back to me unless everything is done and committed first version in the repo"); the conductor answers each gate with the recommended option and records it here
decisions: stack mirrors repos/landing-page (React + Vite, Cloudflare Pages Functions, D1, @anthropic-ai/sdk, Vitest with sql.js D1) but in strict TypeScript, because claims carry money and many payer-specific shapes
questions: -
evidence:  npx vitest run -> 1 passed; tsc --noEmit -> clean; vite build -> built

## 2026-11-13T21:35+08:00 skill-scout

status:    done
persona:   skill-scout
ticket:    -
artifacts: .scratch/chas-claimer/scout/{cloudflare-wrangler-workers,property-based-testing,security-and-hardening}.md
decisions: cloudflare wrangler + workers-best-practices -> recommend w/ conditions, Medium; skills only, full plugin floors High + account MCP
decisions: trailofbits property-based-testing -> recommend w/ conditions, Low; rules engine, money caps, CSV roundtrips; CC-BY-SA so not vendorable
decisions: addyosmani security-and-hardening -> recommend w/ conditions, Medium; skill folder only (checklist floors High); privacy/LLM/audit guidance
decisions: microsoft/playwright-cli -> no card; playwright MCP (crew extra) already connected and emits code
decisions: PDPA/healthcare-claims skills -> no card; 1-47 installs, individual authors, legal content unverifiable
decisions: Playwright cannot run in Pages Functions; portal automation needs Browser Rendering or a local runner (architecture input)
questions: add fast-check as a devDependency for property tests? Recommended: yes
evidence:  scan.mjs -> wrangler Low, workers-best-practices Medium, PBT Low, security skill Medium (+checklist High), full cloudflare plugin High
evidence:  npm pack @playwright/cli@0.1.24 -> shipped skill identical to repo
evidence:  claude plugin list / ~/.claude/skills -> unchanged (nothing installed)

## 2026-11-13T21:50+08:00 qa-lead (strategy)

status:    done
persona:   qa-lead
ticket:    -
artifacts: .scratch/chas-claimer/reviews/test-strategy.md
decisions: seams S1-S7 taken from PRD 5.1/5.3 and the existing harness; reviews/technical.md absent, so the tech lead confirms or disputes them there
decisions: 76 case IDs across SC1-SC8, each mapped to a build block; fast-check properties for money/waterfall, ADR 0003 (history never changes blocks), NRIC, lifecycle, matching, AI de-identification, CSV round trip
decisions: pinned boundaries (30-day window, card expiry inclusive, SGT dates, age 60, benchmark from 1 Sep 2026) as testable assumptions
decisions: build must provide an injectable clock, SGT date strings, one channel interface, one AI module, a seedable generator
decisions: 11 mechanical exit criteria; SC3.7 timed UAT is the only waivable case
questions: S0000 synthetic NRIC block holds early-issued real NRICs (at least one of them is widely reported as issued). Recommended: switch to the T9 block (T90-T99 = birth years 2090-2099, cannot be issued yet), valid check letter; update GLOSSARY, CLAUDE.md, PRD 4
questions: Access header trust: confirm Access covers *.pages.dev or verify the Access JWT. Recommended: verify the JWT
evidence:  npx vitest run -> 1 file, 1 test passed (baseline)
evidence:  fast-check import -> 3.23.2
evidence:  exit-criterion-3 grep on current tree -> no matches (exit 1)

## 2026-11-13T21:55+08:00 tech-lead

status:    done
persona:   tech-lead
ticket:    -
artifacts: .scratch/chas-claimer/reviews/technical.md
decisions: verify the Access JWT, never the email header; DEV_USER only on localhost; fail closed (F1)
decisions: IDENTIFIER_KEY -> HMAC patient hash + AES-GCM sealed identity; split identity at import; synthetic-only guard (F2)
decisions: api channel token variable derived from payer ID, https only (F3)
decisions: block 1 split into 01 foundation (whole schema, types, http/auth, UI shell, AI slots) + 02 skeleton; then 4 and 3 parallel blocks
decisions: channel = prepare + send; outcomes live in lifecycle; MediSave as two payers (Flexi, TOSP)
decisions: add zod, tsx; sql.js to dependencies; vitest/tsconfig include connector/ and mock/
questions: Q1 Access app must cover custom domain + pages.dev + previews, connector gets an Access service token? Recommended: yes
questions: Q2 multi-TOSP cap and insurance amount rule? Recommended: highest table limit; remainder capped by policy limit (warn)
evidence:  npx vitest run -> 1 passed; npm run typecheck -> clean

## 2026-11-13T22:10+08:00 functional-lead

status:    needs-human
persona:   functional-lead
ticket:    -
artifacts: .scratch/chas-claimer/reviews/functional.md, .scratch/chas-claimer/reviews/uat-script.md
decisions: 6 blocking (multi-visit claim date, outcome/payment amounts, re-import voids approval, S0000 IDs may be real, waterfall when upper payer blocked, 30-day clock), 17 should-fix, 7 notes; each with a default the build can use
decisions: Given/When/Then ACs for blocks 1-8; synthetic data set D01-D27 plus remittances R1/R2 with hand-computed amounts
decisions: in-progress crown lines are held, not blocking, so the prep visit's consultation still gets claimed in time
questions: move synthetic IDs off S0000 to an unissuable block such as T9 (agrees with qa-lead)? Recommended: yes
questions: compare benchmarks on the GST-inclusive fee? Recommended: yes
questions: Flexi-MediSave dental effective date? Recommended: 1 Jul 2026, marked unconfirmed
evidence:  amounts recomputed by hand against research 1.5 and 2.1 tables; review only, no code to run

## 2026-11-13T23:10+08:00 conductor (G1, spec, G2)

status:    done
persona:   conductor
ticket:    -
artifacts: .scratch/chas-claimer/interview.md, GLOSSARY.md, docs/adr/0001-0009, jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md, .scratch/chas-claimer/spec.md, .scratch/chas-claimer/decisions-g2.md, docs/design.md
decisions: G1 opened by delegation after four interview rounds (29 questions, recommended answers accepted)
decisions: G2 opened by delegation: PRD + decisions-g2.md; every blocking finding from the functional (B1-B6) and technical (F1-F4) reviews resolved with the reviewer's default
decisions: synthetic identifiers moved to the T9 block (QA lead and functional lead both flagged S0000)
decisions: scout cards noted; only fast-check adopted (devDependency); no skills installed
questions: -
evidence:  review files present: functional.md, technical.md, test-strategy.md, uat-script.md

## 2026-11-13T23:40+08:00 tech-lead (ticket review)

status:    needs-human
persona:   tech-lead
ticket:    -
artifacts: reviews/tickets.md, issues/01-09 (contract lists appended; blockers on 07/08/09), issues/10-end-to-end-flow.md (new), reviews/technical.md §4/§5/§11
decisions: 03 added as blocker of 07, 08, 09 (D04b insurance, benchmark finding)
decisions: 02 lands rebuild service, full claims repo, code-map read side, final builder inputs, fixtures, so 04/06 and 03 never share files in wave 1
decisions: 04 lands full action set, checkout, channel-at-approval, slot placements, so 07/08/09 never edit services/claims.ts, ClaimDetail or Queue
decisions: schema: remittance line unique per file, remittances.file_hash; DeskSettings and SourceMapping complete in 01
decisions: ticket 10 owns the SC8.3 end-to-end test
questions: split 01 (backend / 01b UI shell) and 02 (02a generator / 02 skeleton) to fit one context window? Recommended: yes
evidence:  grep 'Blocked by' issues/*.md -> 07: 03,04,06; 08: 03,04; 09: 03,04,06; 10: 05,07,08,09

## 2026-11-13T23:55+08:00 tech-lead (ticket split, T1)

status:    done
persona:   tech-lead
ticket:    -
artifacts: issues/01-foundation.md (rewritten), issues/01b-ui-shell.md (new), issues/02a-synthetic-clinic.md (new), issues/02-walking-skeleton.md (rewritten), reviews/technical.md §4, reviews/tickets.md T1
decisions: 01 = backend only (schema, domain, server spine, /api/me, configs, README); UI shell AC moved to 01b
decisions: 02a owns mock/** complete with SC7.7/7.9/7.10 tests; 02 keeps every original AC plus SC1.11-1.13 and the CHAS D-case table
questions: -
evidence:  grep 'Blocked by' issues/*.md -> 01: none; 01b: 01; 02a: 01; 02: 01, 01b, 02a; 03-06: 02

## 2026-11-13T23:40+08:00 conductor (G3)

status:    done
persona:   conductor
ticket:    -
artifacts: .scratch/chas-claimer/issues/01, 01b, 02a, 02, 03-10
decisions: G3 opened by delegation on the tech lead's reviewed breakdown (01 and 02 split per tickets.md T1)
questions: -
evidence:  grep 'Blocked by' issues/*.md -> frontier is 01

## 2026-11-13T developer (ticket 01, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    01
artifacts: branch crew/chas-claimer-01-foundation, 16 commits 31563b2..aa80259
decisions: no NRIC literals outside T9; no SQL CHECK on audit action/finding code; claims.channel null until approval;
           audit nonce guard covers claims only (06 must note); CONNECTOR_TOKEN < 32 bytes = unset (503);
           JWKS refresh on unknown kid at most once a minute, nbf 60s leeway; HKDF fixed salt, domain-separated hashes;
           CSP allows Google Fonts and inline styles for the design system, scripts 'self'; property tests seed 20261113
questions: -
evidence:  npm test -> 15 files, 126 passed; typecheck clean; build exit 0; tree clean
```

## 2026-11-13T reviewer (ticket 01)

```
status:    done
persona:   reviewer
ticket:    01
artifacts: reviews/code-review-01.md
decisions: approve; no blocking findings, no blocked path touched. Should-fix before 02 writes sealed rows:
           Sec-1 AAD on identity seal; Sec-2 refuse published dev IDENTIFIER_KEY off loopback;
           Sp-1 route({identity:true}) fail-closed; S-1 Finding.lineNo has no findings column
questions: CSP Google Fonts + unsafe-inline styles (Sp-3); line_no column vs drop lineNo; doc updates
evidence:  vitest 15 files 126 passed; typecheck clean; build exit 0
```

## 2026-11-13T conductor (merge 01, decisions on review questions)

```
status:    done
persona:   conductor
ticket:    01
artifacts: crew/chas-claimer merge 3543838; worktree removed
decisions: Sp-3 accepted: the design system needs Google Fonts and inline styles; scripts stay 'self'.
           S-1: add line_no to findings (findings attach to a claim line). Sec-1, Sec-2, Sp-1, S-1 and the
           doc updates go to a follow-up ticket 01-fix on crew/chas-claimer before 02 starts.
questions: -
evidence:  git merge --no-ff -> 3543838
```

## 2026-11-13T developer (ticket 01-fix, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    01-fix
artifacts: branch crew/chas-claimer-01-fix 35686f9..cb0ba00
decisions: dev key matched by SHA-256 fingerprint, refused off loopback; route({identity:true}) hands keys,
           auth runs first (401 before 503); 0001 edited in place (not deployed); CSP documented, unchanged;
           nits Sec-3..5, N-1, N-5..7, Sp-2, Sp-5..7 skipped
questions: -
evidence:  npm test 15 files 133 passed; typecheck, build exit 0
```

## 2026-11-13T conductor (re-review and merge 01-fix)

```
status:    done
persona:   conductor
ticket:    01-fix
artifacts: merge into crew/chas-claimer
decisions: re-reviewed the four findings by diff (AAD bound to visitKey:revision, loopback from request URL
           hostname, identity routes fail closed in the spine, line_no column); conductor check instead of a
           second reviewer run because the change is small and scoped to the reviewer's own findings
questions: -
evidence:  vitest 133 passed; typecheck clean (rerun by conductor)
```

## 2026-11-13T developer (ticket 01b, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    01b
artifacts: branch crew/chas-claimer-01b-ui-shell 956c58d..851af37 (src/ui, src/lib, src/ds.ts, src/main.tsx)
decisions: api put/delete; reveal response assumed {value}; top bar below 1024px; /imports under Today;
           App draws the simulator banner; router followLink; FindingList takes describe until catalogue lands;
           BillSplit colours by payer id
questions: reveal shape; catalogue wording home; reveal role (S11 vs route table O); formatSgd negatives wrong
evidence:  typecheck 0; 24 files 201 tests passed; build 0; tree clean
```

## 2026-11-13T conductor (answers to 01b's questions)

```
status:    done
persona:   conductor
ticket:    01b
artifacts: issues/02, issues/04 addenda
decisions: reveal route answers {value: string} (01b's assumption stands; owner of the route follows it).
           Finding wording lives in src/domain/claims/findings.ts (technical §4: 02 creates it, 03 completes it);
           02 wires FindingList's describe prop to it. Route-table "O" means officer or reviewer (reviewers can do
           everything officers can, S11) — no conflict. formatSgd negative cents: fix in ticket 02 with a test.
questions: -
evidence:  -
```

## 2026-11-13T reviewer (ticket 01b)

```
status:    done
persona:   reviewer
ticket:    01b
artifacts: reviews/code-review-01b.md
decisions: approve; no blocking findings. Should-fix: R-1 router decodeURIComponent throws on malformed path;
           Sp-1 MaskedIdentifier copy contradicts G2 #10; Sp-2 DeadlineText reads browser clock and hard-codes 5 days;
           St-1 app.css "tokens only" comment untrue
questions: fix before 02 or with it?
evidence:  201 tests passed; typecheck, build clean
```

## 2026-11-13T conductor (01b round 2)

```
status:    done
persona:   conductor
ticket:    01b
artifacts: -
decisions: the four should-fix items land on the 01b branch before merge (02 builds directly on the shell);
           developer also merges crew/chas-claimer in to pick up 01-fix; error boundary added with R-1
questions: -
evidence:  -
```

## 2026-11-13T developer (ticket 01b round 2, appended by conductor)

```
status:    done
persona:   developer
ticket:    01b
artifacts: da488a7 (merge crew/chas-claimer), 0b35dd5, dac2846, c3c9d66, 7361977, 788bb7b
decisions: DeadlineTextProps {deadline, daysLeft, warning, windowDays?} from server; page error boundary in <main>
           keyed by path; 403 on reveal -> "You don't have access to reveal this."; matchPath null on bad escape;
           borders via --border-hairline
questions: (already answered by conductor)
evidence:  25 files 216 tests passed; typecheck, build clean
```

## 2026-11-13T conductor (merge 01b)

```
status:    done
persona:   conductor
ticket:    01b
artifacts: merge into crew/chas-claimer; issues/02 addendum (DeadlineText props, never log ApiError.body)
decisions: re-checked R-1, Sp-1, Sp-2, St-1 by test run and grep; merged
questions: -
evidence:  vitest 216 passed; typecheck clean (conductor rerun)
```

## 2026-11-13T developer (ticket 02a, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    02a
artifacts: branch crew/chas-claimer-02a-synthetic-clinic 3f830ea..89c9aac (mock/synthetic-clinic/**, README section)
decisions: clinic's own settings in config.ts (DEFAULT_SETTINGS conflicts with UAT 2.1); SQLite money in cents with
           desk enum spellings; in-progress lines fee 0 GST null; MCAF on every visit of the patient; R1 refs MHCP-000n;
           CLI writes R1/R2 CSVs beside --out, prints counts and paths only; 36 case keys
questions: SourceVisit lacks notes, policy validity, second CHAS card, pre-auth; CHAS/benchmark keys for 02; multi-card for 05
evidence:  22 files 187 tests passed; typecheck 0; build ok; mock:clinic seed 7 -> 60 patients, 200 visits, R1 5, R2 1
```

## 2026-11-13T conductor (02a round 2)

```
status:    done
persona:   conductor
ticket:    02a
artifacts: issues/05 addendum
decisions: extend SourceVisit now (02a owns the edit, agreed exception): notes in sealed VisitIdentity (they carry
           identifiers); chasCards array replaces chasCard (D21, highest valid subsidy wins per S5); policy validFrom/
           validTo (D17); preAuths on the policy (D16). 02a documents its procedure keys; 02 follows them.
           Connector collects every card row (05).
questions: -
evidence:  -
```

## 2026-11-13T developer (ticket 02a round 2, appended by conductor)

```
status:    done
persona:   developer
ticket:    02a
artifacts: 60b77ac (merge crew/chas-claimer), 00e4fa8 SourceVisit, a3cbd9f synthetic clinic, 7d8cc7b README key table + drift test
decisions: pre-auth references and notes sealed in VisitIdentity; clinical keeps chasCards, policy dates, pre-auth
           benefit code and approval date (hash changes on pre-auth change); preauthorisations gains benefit_code, approved_on
questions: source-mapping lacks notes/policy dates/pre-auths -> ticket 05 (addendum written); multi-card -> 05 (done)
evidence:  32 files 282 tests passed; typecheck clean; build ok; mock:clinic 60 patients, 200 visits, 36 cases
```

## 2026-11-13T reviewer (ticket 02a)

```
status:    done
persona:   reviewer
ticket:    02a
artifacts: reviews/code-review-02a.md
decisions: approve, no blocking. Should-fix: AI path opens identity (ADR 0006 gap); schema.sql "lowest card_id";
           filler dentists ignore branch; README omits remittance-reference swap. crew.md test scope stale
questions: amend ADR 0006/0004 for notes and preAuthRefs as identity + AI scrub opener (recommended yes)
evidence:  32 files 282 passed; typecheck, build 0; mock:clinic seed 1 twice byte-identical; 0 non-T9 NRICs
```

## 2026-11-13T conductor (02a round 3)

```
status:    done
persona:   conductor
ticket:    02a
artifacts: docs/adr/0006, docs/adr/0004 amended; docs/agents/crew.md test scope
decisions: ADR amendment accepted (notes and pre-auth refs are identity; AI scrub path is an audited opener);
           code items (schema.sql comment/model, filler dentist by branch, README swap) back to the 02a developer
questions: -
evidence:  -
```

## 2026-11-13T developer (ticket 02a round 3, appended by conductor)

```
status:    done
persona:   developer
ticket:    02a
artifacts: 1a54f2f filler dentist by branch, 70da722 schema comment + README swap, c435fbd nits
decisions: East -> Dr A, West -> Dr B (Dr C also at West); filler output changed, cases unchanged
questions: (ADR amendment already done by conductor; source-mapping gap carried to 05)
evidence:  32 files 283 passed; typecheck 0; build ok
```

## 2026-11-13T conductor (merge 02a)

```
status:    done
persona:   conductor
ticket:    02a
artifacts: merge into crew/chas-claimer; worktree removed
decisions: main checkout needed `npm install` (zod added by 01 in a worktree); after install all green
questions: -
evidence:  vitest 32 files 283 passed; typecheck clean; build ok (conductor, on crew/chas-claimer)
```

## 2026-11-14T developer (ticket 02, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    02
artifacts: branch crew/chas-claimer-02-walking-skeleton e26eaed..cb8e8f9
decisions: server computes deadlineView; rows carry ClaimState + payerName; list default 50 max 100;
           synthetic load 404 unless DEMO_MODE, seeds settings/code map if missing, uses today's SGT date;
           import guard refuses the whole batch (422 with importId and indexes); sent claims flagged on any revision
           change; approved_revision kept on non-material rebuild; LoadSyntheticClinic.tsx shared; formatSgd fixed
questions: later visits not rebuilt on earlier change; CHAS rule set overlaps 03; d1.ts sync batch touches 01's helper
evidence:  42 files 422 passed; typecheck clean; build ok; Playwright 360x780 /claims 50 rows, no overflow
```

## 2026-11-14T conductor (answers to 02)

```
status:    done
persona:   conductor
ticket:    02
artifacts: issues/03 addendum
decisions: rebuild-later-visits goes to 03 (it owns frequency counts); 03 extends 02's CHAS rule set and
           catalogue; d1.ts helper change accepted (test helper, no contract impact). Ting Yu granted the
           conductor merge permission (2026-11-13).
questions: -
evidence:  -
```

## 2026-11-14T reviewer (ticket 02)

```
status:    done
persona:   reviewer
ticket:    02
artifacts: reviews/code-review-02.md
decisions: changes-requested on B-1 (approved_revision set from the old built_from_revision in the same UPDATE, so the
           approval pins the old revision; reproduced). Should fix: S-1..S-4, Sp-1 ignored count, Sp-2 deadline on
           queue load, Sp-3 D07/D08 amounts, Sp-4 synthetic import skips 100 cap. Security and UI: nits only
questions: D07/D08 provisional? ignored count via migration 0002?
evidence:  42 files 422 passed; typecheck, build clean; blocked-path diff empty
```

## 2026-11-14T conductor (02 round 2)

```
status:    done
persona:   conductor
ticket:    02
artifacts: -
decisions: B-1 plus every should-fix item goes back to the developer. Ignored count is added to 0001 in place, as was
           done for line_no, because nothing is deployed. D07/D08 are corrected now wherever the CHAS rule set alone
           decides the amount. Assertions that depend on ticket 03 are marked provisional and named.
questions: -
evidence:  -
```

## 2026-11-14T developer (ticket 02 round 2, appended by conductor)

```
status:    done
persona:   developer
ticket:    02
artifacts: 568d535 B-1, d736b0d, a61dc54, 1668dc5, 8188af6, e64c074, 606fc98, 8861e33, 1e2d8e9, c15b265
decisions: B-1 binds visit.revision (regression test); 100 cap per invocation, synthetic import pages; route option
           `enabled` (404 before auth when DEMO_MODE off); queue GET rebuilds claims whose deadline state moved (max 50,
           audited, reason deadline); D07/D08 assert CHAS $0 only; formatSgd takes Cents, formatSgdDifference for signed;
           Sec-2, Sec-3 deferred
questions: rebuild on GET acceptable?
evidence:  45 files 445 passed; typecheck, build 0; tree clean
```

## 2026-11-14T conductor (re-review and merge 02)

```
status:    done
persona:   conductor
ticket:    02
artifacts: merge into crew/chas-claimer; issues/03, issues/04 addenda; worktree removed
decisions: B-1 re-checked by diff plus its regression test. Rebuilding on GET is accepted for v1: it only touches
           claims whose deadline state moved, which keeps it bounded and idempotent. Approve and submission
           re-checks go to 04. Sec-2 goes to 04 and Sec-3 to 03.
questions: -
evidence:  on crew/chas-claimer after merge: 45 files 445 passed; typecheck clean; build ok
```

## 2026-11-14T developer (ticket 05, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    05
artifacts: branch crew/chas-claimer-05-connector fd1d0f4..03b018c; connector/**, source-mapping.ts, csv.ts parseCsvRecords, README section
decisions: each page (<=100) its own import, sorted by visitOrder, reruns write nothing for unchanged visits;
           visits parsed at the clinic, bad rows reported by row/line and path and skipped; TableSource + readVisits;
           CSV source = folder of <table>.csv; billedCents unmapped; retries 3x (1/2/4s) on 5xx/network only;
           redirects not followed (reported as Access refusal); https only, http to loopback; env-only secrets;
           exit 0/1/2
questions: -
evidence:  49 files 485 passed; tsc 0; build ok; clean; mutation of masking/page size turned 7 tests red
```

## 2026-11-14T reviewer (ticket 05)

```
status:    done
persona:   reviewer
ticket:    05
artifacts: reviews/code-review-05.md
decisions: changes-requested: SP-1/S-1 describe prints row values for a headerless CSV (reproduced, synthetic NRIC
           and name). Should fix ST-1 duplicate dollars(), ST-2 duplicate loopback list, SP-2 leak test omits notes and
           pre-auth refs. AC-7.5 per page accepted as nit
questions: require the Access pair for non-loopback desks (SP-5)? recommended yes
evidence:  49 files 485 passed; typecheck, build clean; probe reproduced the leak
```

## 2026-11-14T conductor (05 round 2)

```
status:    done
persona:   conductor
ticket:    05
artifacts: -
decisions: blocking leak plus ST-1, ST-2, SP-2 back to the developer; SP-5 yes: non-loopback desks need both Access
           token halves or the connector exits 2
questions: -
evidence:  -
```

## 2026-11-14T developer (ticket 05 round 2, appended by conductor)

```
status:    done
persona:   developer
ticket:    05
artifacts: 80739da SP-1, 0904484 ST-1, 69fa43a + ef1297e ST-2/SP-5, 80f324f SP-2, 8b5378d ST-3, 92657d1 README
decisions: header-row guard in the CSV reader (describe, dry-run, push), errors name positions only; dollars() wraps
           parseDollars; isLoopbackHost in src/domain/hosts.ts shared with server/auth.ts; Access pair required off
           loopback, one-of-two refused; SP-2 test asserts notes and PAREF in the request, absent from clinical_json
questions: -
evidence:  50 files 493 passed; typecheck clean; build ok
```

## 2026-11-14T conductor (re-review and merge 05)

```
status:    done
persona:   conductor
ticket:    05
artifacts: merge into crew/chas-claimer; worktree removed
decisions: SP-1 re-checked: two regression tests refuse headerless files by position, never echo a value
questions: -
evidence:  see merge verification line below
```

## 2026-11-14T developer (ticket 06, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    06
artifacts: branch crew/chas-claimer-06-settings c30dff4..618f047
decisions: unchanged overrides not re-judged (ADR 0008); settings save is one audited batch, 409 on stale, rebuild
           only what changed (<=100 per request, resumable); Today looks 5 days ahead (technical §6 said 7); null
           code-map target = not claimable; DELETE audited as code_map_saved; focus to first refused field
questions: synthetic CONSULTATION/CROWN_PERMANENT overrides; AC-8.2 check after 03; parseKey not URL-decoding;
           api.delete sends no JSON content type (403), UI avoids DELETE
evidence:  51 files 497 passed; typecheck, build clean; no horizontal scroll at 360/1280
```

## 2026-11-14T reviewer (ticket 06)

```
status:    done
persona:   reviewer
ticket:    06
artifacts: reviews/code-review-06.md
decisions: changes-requested. Blocking: mapped codes can't be edited, corrected or removed from the UI. Should fix:
           remove benchmark overrides, parseKey decode, api.delete 403, stale `before` in settings save, audit SQL in
           repo, ownership of auth.ts/app.css edits, doc comment, Today evidence, drop synthetic overrides. 5 days correct
questions: reword AC-8.1; add POST /api/settings/rebuild and Today 5 days to technical §6
evidence:  51 files 497 passed; typecheck, build clean
```

## 2026-11-14T conductor (06 round 2; spec doc updates)

```
status:    done
persona:   conductor
ticket:    06
artifacts: reviews/functional.md AC-8.1 reworded; reviews/technical.md §6 (5 days, settings/rebuild route)
decisions: every review item back to the developer, who also merges crew/chas-claimer (05's hosts.ts). The doc
           questions were answered by editing the specs.
questions: -
evidence:  -
```

## 2026-11-14T developer (ticket 06 round 2, appended by conductor)

```
status:    done
persona:   developer
ticket:    06
artifacts: 6681985, 1462ddd, 50541f3, 282dd97, 7fe257d, e2e9cb4, af76f71, 8bf80e7, d060248, f22a27a
decisions: code-map edits are per-entry PUT/DELETE, last write wins, trail keeps the replaced code; Add offered only for
           open targets; override removal goes out with the next versioned save; synthetic overrides dropped;
           auth.ts roleLists(env) for read-only roles; app.css for Settings/Today layout
questions: a code mapped only to TOSP gets no CHAS line and no unmapped finding
evidence:  56 files 556 passed; typecheck, build 0; Today 360/1280 no horizontal scroll (wrangler pages dev)
```

## 2026-11-14T conductor (merge 06)

```
status:    done
persona:   conductor
ticket:    06
artifacts: merge into crew/chas-claimer; worktree removed
decisions: a TOSP-only mapping giving no CHAS line is intended: the code map decides per scheme (functional N5,
           surgical removals map to TOSP only); an explicit mapping means "considered", so no unmapped finding
questions: -
evidence:  see verification on crew/chas-claimer after merge
```

## 2026-11-14T developer (ticket 03, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    03
artifacts: branch crew/chas-claimer-03-rules-and-waterfall d3c44b4..f079e06 (from 01d0b7d)
decisions: ruleRef = rule-set id; Flexi always warns on yearly amount; capped $0 CHAS claim kept (ADR 0003);
           Flexi age = lower of patient and account holder; annotations never clear findings; insurance capped at
           remaining annual limit with warning; benchmark override shows settings source; limits count claimed cents;
           history back to longest CHAS period + 1 year; import rebuilds the patient's later unsent visits oldest first
questions: PARTLY-1 fixture past CHAS window so "partly used" untested; deadline/settings/code-map rebuilds don't cascade
evidence:  47 files 566 passed; typecheck, build clean; one flaky App.errors.test.tsx run (passes alone)
```

## 2026-11-14T reviewer (ticket 03)

```
status:    done
persona:   reviewer
ticket:    03
artifacts: reviews/code-review-03.md
decisions: changes-requested. Blocking: rules use visit.date instead of the claim (completion) date for card validity,
           rule set, window, same-day, MCAF, policy-active, deadline; repro overbills the insurer by $620. 7 Spec and 4
           Standards should-fix (insurance limit caps instead of warning; limit per payer not per policy; later-visit
           rebuild misses earlier dates; hard-coded fallback figures; duplicated helpers). Security clean
questions: insurance limit cut or warn; PARTLY-1; rebuild order
evidence:  47 files 566 passed; typecheck, build 0; tsx repro of the held-line overbill
```

## 2026-11-14T conductor (03 round 2)

```
status:    done
persona:   conductor
ticket:    03
artifacts: -
decisions: insurance limit: bill in full and warn, count per policy (§8, ADR 0003); PARTLY-1 already covered;
           rebuildVisits processes a patient's visits oldest first by orderKey for every trigger, implemented once in
           the shared service (03 merges crew/chas-claimer with 06 first)
questions: -
evidence:  -
```

## 2026-11-14T developer (ticket 04, worktree, appended by conductor)

```
status:    done
persona:   developer
ticket:    04
artifacts: branch crew/chas-claimer-04-lifecycle 31d6972..adae54d (merged crew/chas-claimer at 871e24f)
decisions: shared edits: arbitraries, rebuild.ts, claims/submissions repos, deadlines `same`, ERROR_CODES, Queue.tsx,
           app.css, format.ts; checkout and failed submissions bump version; concurrent approvals -> one success, one
           409, one audit event; actMany caps 50; reveal audited before return, fails closed 500; checkout HTTP route
           left to 07; DS gaps noted (aria-describedby, Dialog overscroll, Button loading)
questions: lifecycle audit stores reason text vs "no error free text"; builder never emits upstream_rejected /
           waiting_on_upper_payer
evidence:  704/704 twice; typecheck, build clean; earlier runs flaked once each on imports.test.ts SC1.13 and
           App.errors.test.tsx (outside this diff)
```

## 2026-11-14T conductor (answers to 04)

```
status:    done
persona:   conductor
ticket:    04
artifacts: -
decisions: reason text in lifecycle audit is accepted: decisions-g2 §2 requires reasons and the audit trail stays
           in D1, never sent to AI ("no error free text" covers system error messages). The two missing upstream
           findings were sent to ticket 03's round 2 (it owns the builder). The two flaky tests are logged for the
           QA phase as a release blocker if they recur.
questions: -
evidence:  -
```

## 2026-11-14T reviewer (ticket 04)

```
status:    done
persona:   reviewer
ticket:    04
artifacts: reviews/code-review-04.md
decisions: changes-requested. Blocking: Queue.tsx has no Submit entry point (07-09 may not edit it). Should fix:
           submit doesn't check approved vs built revision (F5.2); duplicate portal reference check outside the batch,
           no unique index; portal-refusal copy says ready (it's rejected); server message for invalid input lost;
           no one-click Withdraw (S8); limits restated; splitVisit copies splitBill; edits outside technical §4
questions: nav link enough?; guarded insert or index?; record extra files in technical §4
evidence:  704 passed twice (64 files); typecheck, build 0; security clean
```

## 2026-11-14T conductor (04 round 2)

```
status:    done
persona:   conductor
ticket:    04
artifacts: reviews/code-review-04.md copied from the worktree
decisions: per-row Submit link on approved claims; partial unique index in 0001 (in place) plus a guarded INSERT in
           the batch; every should-fix back to the developer; conductor records extra files in technical §4 after merge
questions: -
evidence:  -
```

## 2026-11-14T developer (ticket 03, round 2)

```
status:    done
persona:   developer
ticket:    03
artifacts: src/domain/claims/{build,plan,insurance,medisave,findings}.ts, src/domain/rules/{shared,medisave}.ts,
           src/domain/claims/rebuild.ts, tests alongside
decisions: held line judged on its completion date (7c4deed); insurer billed in full past the yearly limit with a
           warning, per policy (42f063a); upper-payer states table-tested (125fbb3); rebuild oldest first by
           orderKey for every trigger (593a775); no default figures in findings (c8296d0); lower payers held when
           every CHAS line waits on the code map (332d8a1)
questions: (a) rebuild withdraws a claim no longer built, remap can't revive it: accept with follow-up;
           (b) ADR 0003 entry for insurance_deadline_passed; (c) one claim per visit and payer for mixed prep visits
evidence:  vitest 749/750 (App.errors.test.tsx timeout, passes alone); typecheck 0; build 0
```

## 2026-11-14T conductor (ticket 03 merge)

```
status:    done
persona:   conductor
ticket:    03
artifacts: merge e7bb63b into crew/chas-claimer; docs/adr/0003 amended; .scratch/chas-claimer/follow-ups.md
decisions: (a) accepted for v1, recorded as follow-up 1; (b) insurance_deadline_passed stays blocking (certain from
           the clinic's own setting, like the CHAS window; ships blank), ADR 0003 amended; (c) accepted per ADR 0009,
           follow-up 2. Remaining visit.date uses checked: fixed-input placeholder plan, orderKey, year fallback only
questions: -
evidence:  worktree vitest 750/750, tsc 0; merged branch vitest 750/750 (59 files), tsc 0
```

## 2026-11-14T developer (ticket 04, round 2)

```
status:    done
persona:   developer
ticket:    04
artifacts: crew/chas-claimer-04-lifecycle: adae54d 522ce89 43209f7 3b7b050 3b96ee6 953ae68 f818332 0841a5d 4d927c6 ffde00b,
           nits 4016ff4, merge of crew/chas-claimer b32840c
decisions: portal-reference uniqueness held by a trigger (payer lives on claims), racy pre-read removed; UI shows the
           server's reasons; open dialog lifted to ClaimDetail (S8 one-click Withdraw); build.ts exports splitAcross and
           the stored-claim split ranks payers with 03's rankOf; "Clear approval" wording; annotations capped in the service
questions: lifecycle audit stores reason/message text; zod default messages may reach users on invalid input
evidence:  913/913 twice, no flakes; tsc 0; build 0
```

## 2026-11-14T conductor (ticket 04 merge)

```
status:    done
persona:   conductor
ticket:    04
artifacts: merge 4bad928 into crew/chas-claimer; reviews/technical.md §4 records the edits outside the table
decisions: round-2 fixes checked in code (lifecycle.ts:104 stale-approval refusal, Queue.tsx submit link, 0001 trigger);
           reason text in the lifecycle audit accepted (earlier decision; it is officer-entered text, never identity);
           zod default messages accepted for v1, QA to check the copy on each invalid-input path
questions: -
evidence:  worktree vitest 913/913, tsc 0, build 0; merged branch vitest 913/913 (69 files), tsc 0
```

## 2026-11-14T developer (ticket 09)

```
status:    done
persona:   developer
ticket:    09
artifacts: crew/chas-claimer-09-ai from d32de7f: 0c3405a 7913130 4801e18 6885a7a 83be9ca e99df57 f52f2d5 a561e79 f699ee4 dd42f8f
decisions: justification takes {claimId}; server opens sealed notes, scrubs, audits revealed {field:notes,purpose:ai_justification};
           explainer audits identity reveal, 409 unless rejected; whole user message passes deidentify (emails first);
           AI_DAILY_CALL_CAP "0" disables, invalid -> 200; code suggestion CHAS-only enum or null; mapping proposal
           reviewer-only from pasted describe output; shared edits src/api/common.ts (six ai_* codes), tests/helpers/ai.ts
questions: follow-ups: ClaimHistory.tsx:134 omits reveal purpose; shippedMapping() fails under jsdom; README row omits cap "0";
           DS Field lacks aria-describedby
evidence:  vitest 76 files / 1023 passed; tsc 0; build 0; tree clean
```

## 2026-11-14T07:55+08:00 reviewer (ticket 09)

```
status:    done
persona:   reviewer
ticket:    09
artifacts: reviews/code-review-09.md
decisions: approve with fixes, no blocking. Fix in 09: DOB in non-ISO formats passes deidentify (reproduced;
           deidentify.ts:43). Conductor at merge: README:72 cap "0"; record tests/helpers/ai.ts in technical §4.
           Defer: ClaimHistory reveal purpose (a), shippedMapping jsdom (b), DS Field aria-describedby (d, DS source).
           Nits: index.tsx:250 dead reject, :44 generic 409 copy, client-supplied code description
questions: Ting Yu: DS Field aria-describedby change at source?
evidence:  vitest 76 files / 1023 passed; tsc 0; build 0; blocked paths clean; gate probe via esbuild
```

## 2026-11-14T developer (ticket 08)

```
status:    done
persona:   developer
ticket:    08
artifacts: crew/chas-claimer-08-remittances from d32de7f: 4d0b8bb 46f3990 14ff500 19f1186 c56a793 bb1a994 f31bfd4 2f6a82b fd103df
           039188f e0459d7 17b9112 4f5c88b 944b4fc 3ab8dab 7486a26, merge 52bd840 (crew at 77a9109), 7dab97d.
           Shared: tests/helpers/{arbitraries,payments}.ts, ERROR_CODES, RemittanceColumnsSchema export in settings.ts,
           app.css statement table, App.test.tsx /payments/r1 heading
decisions: service returns Result (differs from technical.md:454); reviewers save column mappings with the upload;
           act runs before the line update (two concurrent hand matches could both record); a reference line never falls
           back to patient/date/amount; zero or refund lines left for a person; concurrent duplicate file imported once;
           ISO dates only; one-line-one-claim tested in domain with a UNIQUE backstop
questions: UAT 7.4 "then undo" not built; ticket says officers map columns, AC-8.4 says reviewers (went with reviewers)
evidence:  AC-5.1-5.7 and S12 tagged; vitest 1009/1009; tsc 0; build 0
```

## 2026-11-14T developer (ticket 09, review fixes)

```
status:    done
persona:   developer
ticket:    09
artifacts: 553cd1d (DOB in any written form, labelled birth dates refused), 28be667 (README cap 0), 8a97e5c (409 copy, dead
           reject), c2f4e14 (code suggestion uses the clinic's description), merge 8175b50
decisions: 3c reuses codeMap.unmapped() in the route; request text goes out only for a code the desk doesn't hold, still gated
questions: -
evidence:  vitest 76 files / 1027 passed; tsc 0; build 0; each fix test failed first
```

## 2026-11-14T conductor (ticket 09 merge)

```
status:    done
persona:   conductor
ticket:    09
artifacts: merge 12145d8; docs/adr/0004 amended (third-party names known limit); technical §4 note; follow-ups 4-6
decisions: deferred ClaimHistory reveal purpose, shippedMapping under jsdom, DS Field aria-describedby (design system is
           read-only here; needs a change at source)
questions: Ting Yu: approve the Field aria-describedby change in jurasolutions/design-system (recommended: yes, then sync:ds)
evidence:  worktree vitest 1027/1027, tsc 0, build 0
```

## 2026-11-14T developer (ticket 07)

```
status:    done
persona:   developer
ticket:    07
artifacts: crew/chas-claimer-07-channels HEAD 2369e8e (merge of crew/chas-claimer): 620f474 packet, 415864e checklist hold,
           6dcbf2f channels, 05095e6 simulator decisions, bfe7b54 checklist and send page, 1b5cd86 simulator page, bc837ba README.
           Add-only outside ownership: src/ui/app.css, src/domain/types.ts (one union line), README (own section)
decisions: AC-4.5 over F9: exported claims stay approved until the officer confirms the upload; "Open portal" link left out;
           `exported` added to AUDIT_ACTIONS; no migration; idempotency key fixed per visit revision; api channel sends one
           claim at a time, stores no token; simulator keeps masked packets, records decisions as system:simulator;
           web-design-review fixes (amount alignment, touch-action)
questions: ClaimHistory shows system:simulator as "The desk"; change to "Payer simulator" (recommend yes)
evidence:  vitest 962/962; tsc 0; build 0 (after merge)
```

## 2026-11-14T00:04:40Z reviewer (ticket 08)

```
status:    done
persona:   reviewer
ticket:    08
artifacts: .scratch/chas-claimer/reviews/code-review-08.md (verdict: changes-requested), reviewing crew/chas-claimer-08-remittances
           7dab97d against merge-base 77a9109
decisions: blocking B1: one statement line can pay twice (matchByHand and recordPayment commit the payment and the line in
           separate batches; breaks F7 and "a line never matches two claims"). Should fix: import statement budget, changes()
           across batch, duplicated NRIC guard and payment step, UAT 7.4 undo missing, test-strategy SC5.3 wording, one-click
           hand match. Spec agent's clawback finding rejected (decisions-g2 §14). Reviewers mapping columns is correct (AC-8.4)
questions: 1) B1 fix: reserve-then-pay inside the ticket's files, or extend act in claims.ts? (recommend reserve-then-pay)
           2) UAT 7.4 undo: build now or defer and amend UAT? (recommend defer to a follow-up ticket)
evidence:  vitest 1009/1009; tsc 0; build 0; repro Race A recorded 19998 cents for a 9999-cent line; Race B threw
           UNIQUE constraint 500 after payment committed; R1 import prepared 57 statements for 3 matched lines
```

## 2026-11-14T00:10:49Z reviewer (ticket 07)

```
status:    done
persona:   reviewer
ticket:    07
artifacts: .scratch/chas-claimer/reviews/code-review-07.md (verdict: changes-requested), reviewing crew/chas-claimer-07-channels
           2369e8e against merge-base 3c30f77
decisions: blocking: a send can leave the desk unaudited. clear() skips the CHAS 30-day re-check (decisions-g2 §5) and
           sendGroup writes no attempt or audit when act refuses after the payer answered (F9, README:294); api leaks a
           full-identity packet with no record. Should fix: checkout route outside row 07 and calling two services, SQL in
           service, idempotency key unchanged after reject/reopen (S6), Open portal missing, 12-field cap, token-absence
           tests, simulator can record payments in prod. AC-4.5 over F9 accepted (amend F9)
questions: 1) Fix: deadline gate in clear + always record "sent, not recorded" attempt+audit (recommend yes)
           2) Open portal: add optional https portalUrl (recommend) or amend ticket
           3) Idempotency key per submission cycle, not per revision (recommend yes)
           4) Gate simulator channel off in production (recommend yes)
           5) ClaimHistory label "Payer simulator" (recommend yes)
evidence:  vitest 962/962; tsc 0; build ok; repro past-deadline send: api endpoint hit once, 0 attempts, no send audit;
           simulator leaves orphan "received" row
```

## 2026-11-14T developer (ticket 08, round 2)

```
status:    done
persona:   developer
ticket:    08
artifacts: daf252a (hold before pay, audited release, recount), 4f81ffc (cap 50 lines, budget test), ae8bacd (valid synthetic
           NRIC), 35ff71b (confirm before a hand match), merge adb3d9d (crew with 09, no conflicts)
decisions: reserve-then-pay with audited release; matched count is a recount; one payment path; 50-line cap from measured D1
           cost; one shared NRIC check; UAT 7.4 undo deferred; web review fixes (translate="no", aria-busy)
questions: statements over 50 lines need paging; a line stays held on a hard crash between hold and act; SC5.3 vs AC-5.3;
           technical.md should say the import returns a Result
evidence:  vitest 84 files / 1134 passed; tsc 0; build 0; tree clean
```

## 2026-11-14T conductor (ticket 08 merge)

```
status:    done
persona:   conductor
ticket:    08
artifacts: merge 365d22f; test-strategy SC5.3 and technical §3 importRemittance amended; technical §4 note; follow-ups 8-9
decisions: 50-line cap accepted for v1 (clear split-the-file message; paging is follow-up 8); stuck hold on hard crash is
           follow-up 9; SC5.3 brought in line with AC-5.3 (partial payment recorded, claim stays accepted)
questions: -
evidence:  worktree vitest 1134/1134, tsc 0, build 0; merged branch vitest 1134/1134 (84 files), tsc 0
```

## 2026-11-14T developer (ticket 07, round 2)

```
status:    done
persona:   developer
ticket:    07
artifacts: ca90332 345e5dc 788ab3f 6dbd670 6a22b73 d1a27d4 dff9929 942c2a7 ad71eba f325acb 11a942e bdbd506; merge 244613b
decisions: deadline re-check before send; sent_not_recorded attempt and audit; portalUrl (null default, https); idempotency key
           per cycle; simulator gated by DEMO_MODE=yes or loopback; 12-field template cap; shared add-only edits listed
questions: README DEMO_MODE row should say it turns on the simulator
evidence:  vitest 93 files / 1203 passed; tsc 0; build 0; tree clean
notes:     nav always shows "Payer simulator"; /api/me demoMode ignores loopback; no portalUrl field in Settings; >12 stored
           fields throws on read; default payers on simulator, so a deployed desk refuses until channels are set
```

## 2026-11-14T conductor (ticket 07 merge)

```
status:    done
persona:   conductor
ticket:    07
artifacts: merge a5ed352; README DEMO_MODE row; technical §4 note; follow-ups 10-12
decisions: fixes checked in code (submissions.ts:208-217 deadline, :277-299 sent_not_recorded, simulator 404 gate);
           nav label and /api/me loopback go to ticket 10 or QA; skipped nits accepted
questions: -
evidence:  worktree vitest 1203/1203, tsc 0, build 0; merged branch vitest 1203/1203 (93 files), tsc 0
```

## 2026-11-14T infra (deploy plan)

```
status:    needs-human
persona:   infra
ticket:    -
artifacts: reviews/infra.md, .github/workflows/ci.yml, .nvmrc, .dev.vars.example, .gitignore, README.md (Deploy), scripts/setup-wizard.sh
           (9dc60fa on crew/chas-claimer-infra)
decisions: conductor authorised creating ci.yml; preview gets its own D1 and IDENTIFIER_KEY, no connector or payer tokens; don't use
           the Pages preview Access toggle (second AUD); migrations through a git-ignored .wrangler/d1-remote.toml, no wrangler.toml;
           no env drift (14 variables)
questions: Q1 plan tier (recommend Workers Paid); Q2 custom domain (add to Access before Pages); Q3 Cloudflare residency commitment in
           writing before real identifiers (recommend yes); Q4 IDENTIFIER_KEY rotation (recommend fix before real data)
evidence:  action-validator ci.yml 0; bash -n wizard 0; TZ=UTC vitest 1203/1203; typecheck 0; build 0; local d1 migrations list finds 0001
```

## 2026-11-14T conductor (infra merge, ticket 11)

```
status:    done
persona:   conductor
ticket:    11
artifacts: merge 8ccf4ea; issues/11-hardening.md (50a3319); follow-up 13
decisions: Q4/I1 fixed now in ticket 11 with I2, I4, the simulator nav link and /api/me demo mode; I3 HSTS is a zone setting for
           Ting Yu; Q1-Q3 go to Ting Yu in the final summary; Node 22 deferred (local toolchain is Node 20; can't verify here)
questions: -
evidence:  wizard scanned: no destructive or unconfirmed commands, no secret echo; merged branch vitest 1203/1203, tsc 0
```

## 2026-11-14T developer (ticket 10)

```
status:    done
persona:   developer
ticket:    10
artifacts: crew/chas-claimer-10-e2e from e53bbe0: c49c82f (flow, connector import to R1 payment, with and without a key), 186525a
           (AC-3.7 on D04b, AC-8.1, AC-8.2 through the settings route); tests/e2e/whole-flow.test.ts only, no seams
decisions: CHAS through the assisted checklist with keyed-in references; simulator accept/reject/pay on D06, D10, D26; Meridian
           detail ruleSet null by design (insurance.ts:61); AC-8.2 also asserts submitted and other dentists' claims unchanged
questions: -
evidence:  whole-flow 7/7; full suite x3: 94 files / 1210 passed each, neither flaky test failed; tsc 0; build 0; no skip/only/todo
```

## 2026-11-14T conductor (ticket 10 merge)

```
status:    done
persona:   conductor
ticket:    10
artifacts: merge into crew/chas-claimer
decisions: test-only ticket merged on a conductor read of the test structure; the final reviewer pass covers it against main
questions: -
evidence:  merged branch vitest and tsc below
```

## 2026-11-14T01:39:25Z reviewer (ticket 11)

```
status:    needs-human
persona:   reviewer
ticket:    11
artifacts: .scratch/chas-claimer/reviews/code-review-11.md (crew/chas-claimer-11-hardening d89535d vs merge-base 8e6bec9)
decisions: changes-requested on B1 alone: reseal reports remaining 0 while remittances.file_hash and orphan remittance-line
           patient_hash stay on the old key; README step 6 then unsets it, so a payer file can be imported twice (double payment)
           and orphan lines lose their patient. Should fix: forgotten PREVIOUS guard, I4 fires on any network TypeError and
           replaces the page, 32-char leftovers in .dev.vars.example and setup-wizard.sh, SQL in service, triple adopt.
           security-review skill failed (no origin/HEAD); pass done by hand, crypto sound. No blocked paths touched
questions: Q1 remittance duplicate guard across rotation (rec: report unmovable rows, refuse same payer+file name+line count
           under a retired key unless a reviewer confirms); Q2 keep migration 0002 (rec: keep); Q3 D1 plan vs reseal batch of
           ~250 statements (rec: confirm Workers Paid, else RESEAL_BATCH 8)
evidence:  review worktree at d89535d: vitest 95 files / 1246 passed, tsc 0, build 0; worktree removed afterwards
```

## 2026-11-14T developer (ticket 11)

```
status:    done
persona:   developer
ticket:    11
artifacts: ed32ff9 (I2), 31b0361 (simulator nav, /api/me), def1b32 (I4), 6addf59 (keyring), 0a9d92a (joinVisit), 02fb30c (dual-key
           matching), b4bb7d5 (migration 0002), b583935 (reseal route), 8a4d406 (README), merge d89535d
decisions: fetch failure while online = session end; keyring fails closed; patient hashes adopted on sight; 0002 trigger allows a
           re-key only; reseal 50 per batch, one audit per batch, failed rows counted and skipped
questions: ADR 0006 amendment; POST /api/settings/reseal in technical §6; App.errors.test.tsx flaked once
evidence:  vitest 95 files / 1246 passed; tsc 0; build 0
```

## 2026-11-14T conductor (ticket 11 round 2)

```
status:    done
persona:   conductor
ticket:    11
artifacts: -
decisions: B1: unmovable rows (statement file hashes, unmatched lines' patient hashes) reported as "can't move", key version stored
           beside them, retired-key duplicate upload refused unless a reviewer confirms (audited); keep 0002; I4 detects the
           Access redirect only (redirect: manual, opaqueredirect); reseal batch sized to 08's 700-statement budget; README states
           Workers Paid; every should-fix back to the developer
questions: -
evidence:  -
```

## 2026-11-14T qa-engineer (release candidate, QA 01)

```
status:    done (major defects open)
persona:   qa-engineer
ticket:    -
artifacts: reviews/qa-01.md (UAT 66 steps, charter, D01-D20); it.fails: Queue.test.tsx (D01), claims/[id]/index.test.ts:62 (D02),
           ClaimDetail.test.tsx:375 (D06), claims/[id]/checkout.test.ts:69 (D09), overview.test.ts:85 (D18); D15 copy fix
decisions: major D01 (02), D02 (03), D06 (04), D18 (06); D09 (07) borderline; minor D03 D04 D07 D08 D10 D12 D13 D19 D20
questions: D11 (06) rebuild clears approvals on unchanged claims; D14 (07) api leg can't run locally; 5.8 manual timing
evidence:  suite x3 1210 passed; rerun 1210 passed + 5 expected fail; typecheck 0; build 0
```

## 2026-11-14T conductor (QA merge, tickets 12a and 12b)

```
status:    done
persona:   conductor
ticket:    12a, 12b
artifacts: merge 341cd6d; issues/12a-qa-claim-detail-and-builder.md, issues/12b-qa-queue-overview-submit.md; UAT 5.10 and 7.5 staging only
decisions: every major and minor defect fixed before release; D11 answered by decisions-g2 §13 (only changed claims lose approval);
           D14: api leg moves to staging; D17's stale submit list raised to a fix (double-export risk) with a server backstop;
           other D17 notes either in 12a/12b or follow-ups
questions: -
evidence:  merged branch vitest 1210 passed + 5 expected fail
```

## 2026-11-14T developer (ticket 11, round 2)

```
status:    done
persona:   developer
ticket:    11
artifacts: 2aa2af3 f01e409 8dd4544 85c7f7f bf7cb34 f6bb6ed 09f9d01 43115cf 039ae98 bc9d494 37534be f6ad2ad; merge 9742409
decisions: B1, S-1..S-5 and most nits fixed; possible_duplicate 409, reviewer confirms, both audited; 401 or opaqueredirect shows the
           session-ended banner; RESEAL_BATCH 150 (at most 306 of 700 statements, assumes Workers Paid); 0002 kept
questions: ADR 0006 amendment; technical §6 reseal routes; App.errors.test.tsx "recovers when you move to another page" flaky
evidence:  suite x2 1276 passed + 5 expected fail; tsc 0; build 0
```

## 2026-11-14T conductor (ticket 11 merge)

```
status:    done
persona:   conductor
ticket:    11
artifacts: merge 473543c; docs/adr/0006 amended; technical §6 reseal routes and §4 note
decisions: migrations 0001 and 0002 both apply at first deploy (nothing is deployed yet); Workers Paid is a stated requirement;
           the App.errors flake recurred, so it is a release blocker: fixed before the quality gate
questions: -
evidence:  worktree and merged branch: vitest 1276 passed + 5 expected fail, tsc 0, build 0
```

## 2026-11-14T conductor (flaky tests)

```
status:    done
persona:   conductor
ticket:    -
artifacts: src/ui/App.errors.test.tsx, server/services/imports.test.ts
decisions: App.errors: the Claims heading and the error heading render after the click or the /api/me answer settles; the test
           checked synchronously and raced a loaded machine; now waits with findByRole. SC1.13: 100 fresh desks under a fixed
           seed only ever failed on time, never on an assertion; explicit 60 s timeout. Test-only changes
questions: -
evidence:  App.errors alone x5 2/2; full suite x5 (2 + 3) 1276 passed + 5 expected fail, no flake; tsc 0
```

## 2026-11-14T developer (ticket 12b, worktree)

```
status:    done
persona:   developer
ticket:    12b
artifacts: branch crew/chas-claimer-12b-qa, tip 206a418 (merged crew/chas-claimer at d9ae698); src/dialog.tsx focus wrapper re-exported from src/ds.ts
decisions: changed filter is a select (existing test asserts no checkbox); D06 local dialog focus wrapper until the DS fixes it at source;
           D10 cause: DS Button has no default type, so it submits inside a form (check 12a ClaimActions); OverviewResponse gains
           paymentStatements; D19 translation is connector-side (connector/problems.ts); no edit to the App.errors flake (d9ae698 fixed it)
questions: -
evidence:  vitest 98 files 1305 passed + 1 expected fail (D02, 12a's); tsc clean; build ok
notes:     outside-area: server/services/claims.ts, server/repo/claims.ts, ClaimDetail.test.tsx, src/ds.ts, StatusBadge.tsx, src/dialog.tsx,
           app.css, src/api/overview.ts, Settings.tsx, connector/mapping.ts, connector/cli.ts. Unfixed UI notes: Overview duplicates
           STATUS_WORDS; modal overscroll and select dark mode are DS issues
```

## 2026-11-14T developer (ticket 12a, worktree)

```
status:    done
persona:   developer
ticket:    12a
artifacts: branch crew/chas-claimer-12a-qa, merge aa2cf56 (crew/chas-claimer at d9ae698); migrations/0003 (visit notes, D02)
decisions: migration numbered 0003 (0002 is ticket 11's); D13 insurer claims show only "Built from visit revision"; D05 stored amount
           kept, unsent claim with a blocking finding says it can't be submitted; D07/D17 settled claims read "What the checks found"
           without severity, rejected keeps "What to fix"; paid claim not offered record_payment (remittance still can); Reopen confirms
questions: D24 notes on a visit with no claims have no page: follow-up visit view (accepted as follow-up);
           D03 branch names in the queue list (UAT 3.3) need branchName on the list API: check after merging 12b
evidence:  vitest 97 files 1299 passed + 4 expected fail; tsc 0; build ok; web-design-review no findings
```

## 2026-11-14T reviewer (ticket 12 integration)

```
status:    done
persona:   reviewer
ticket:    12 (12b then 12a merged on crew/chas-claimer-12-int, da718ff, vs d9ae698)
artifacts: reviews/code-review-12.md
decisions: approve with fixes, no blockers. SP-1 queue rows lack branch (UAT 3.3); SP-2 frozen claim shows later-revision visit notes (D12);
           ST-1 scheme names defined three times; nits ST-2..7, SP-3/4. Security: none. No blocked paths, no it.fails left
questions: SP-1 and SP-2 now or follow-up: conductor chose fix now (both cheap, both touch UAT/D12 acceptance)
evidence:  touched tests 239 passed; conductor full run on integration 1328 passed + 0 expected fail; tsc 0; build ok
```

## 2026-11-14T developer (ticket 12 fix round, worktree)

```
status:    done
persona:   developer
ticket:    12 fix round (code-review-12)
artifacts: 33b2467 SP-1 queue branch name; a15952c SP-2 frozen claim hides later-revision remarks (keeps withdrawn/voided notes);
           8d957ab ST-1 SCHEME_NAMES in src/domain/types.ts; afc871a ST-2; 6f4b96c SP-4
decisions: ST-3 pushed back: SENT_STATUSES includes paid, swapping it fails the D17 test (lifecycle.test.ts:322); finding text unchanged
questions: -
evidence:  vitest 98 files 1333 passed (+5); tsc clean; build ok; red tests confirmed before each fix
```

## 2026-11-14T conductor (ticket 12 merge)

```
status:    done
persona:   conductor
ticket:    12a, 12b, fix round
artifacts: crew/chas-claimer fast-forwarded to 1d4f2da (12b merge c1a1823, 12a merge da718ff, fixes, README note on migration 0003)
decisions: one integration branch and one combined review, since overlap was 3 files and merged cleanly; ST-3 pushback accepted
           (verified SENT_STATUSES has paid); D24 visit view stays a follow-up; ST-4..7 DS-upstream nits stay in follow-ups
questions: -
evidence:  integration: vitest 98 files 1333 passed, 0 expected fail (all five QA it.fails now pass); tsc 0; build ok;
           git diff d9ae698 -- src/design-system empty
```

## 2026-11-14T02:58:00Z reviewer (final, whole branch)

```
status:    needs-human
persona:   reviewer
ticket:    final
artifacts: .scratch/chas-claimer/reviews/code-review-final.md
decisions: verdict changes-requested at 6f05fdb (base bcbd9f6). Blocking: S-B1 real issued
           NRIC at crew-log.md:43 (commit 3885cec); SP-B1 SC7.6 git-ls-files guard missing
           (exit criterion 6); SP-B2 SC2.12/SC2.13 properties missing (exit criterion 4).
           Should fix: numRuns 20/25, SC1.8 and SC7.2 tests, local paths in issues/reviews,
           sentence case in AssistedSubmit, duplicated readCapped/sha256/cents helpers, dead
           exports, stale comments, glossary terms. Ticket 10 reviewed: no own findings.
questions: Q1 rewrite author email before first push? rec: yes, Jura noreply.
           Q2 squash or rewrite? rec: redact at HEAD, squash to main, never push crew/*.
           Q3 UAT 5.8 timed check? rec: run once before G4, else written waiver.
           Q4 QA re-run at release commit? rec: yes, UAT 4/5/10 in browser.
evidence:  vitest 98 files 1333 passed; tsc clean; build ok; src/design-system diff identical;
           network-import grep none; S0000 grep hit crew-log.md:43; git grep ls-files in
           tests empty; numRuns grep 20 and 25; git branch -r empty (nothing pushed)
```

## 2026-11-14T conductor (final review decisions)

```
status:    done
persona:   conductor
ticket:    final
artifacts: 68892cf redactions in .scratch (reported NRIC in crew-log, real-format phones in two reviews, absolute local paths in
           issues 01-09); follow-ups 20 (third-party names to AI) and 21 (SC3.7 waiver)
decisions: Q2 history: main's own commit 3885cec carries the reported NRIC, so a squash onto main is not enough. At G4 main is
           rebuilt as a new unpushed history with the release tree; old main and crew/* stay as local branches, never pushed.
           Nothing has been pushed, so no shared history is rewritten
           Q1 author: user.email is unset (commits show the LAN default); release commits use the identity the Jura landing-page
           repo already releases under (Jura release, GitHub noreply), set per command, not in git config
           Q3 SC3.7 / UAT 5.8: needs a person; waived at G4 per exit criterion 9, kept on follow-ups (21)
           Q4 QA: re-run browser QA B1-B10 at the release candidate (exit criterion 11)
questions: -
evidence:  grep for NRIC shapes outside T9, home paths and LAN IPs in .scratch/docs/README/GLOSSARY after redaction -> only the
           test file the fix round moves to T9
```

## 2026-11-14T developer (final review fix round, worktree)

```
status:    done
persona:   developer
ticket:    final fix round (code-review-final)
artifacts: branch crew/chas-claimer-final-fix, 15 commits e6f5297..3e2ea6c from 68892cf; new findings.property.test.ts and the SC7.6
           tracked-files guard; e6f5297 also edits reviews/code-review-09.md:70 (test data)
decisions: SC2.12 property excludes same-day duplicates and the visit's own rejection (ADR 0003); SC7.2 oracle null for range codes;
           readCapped in server/bytes.ts with a Content-Length check; readSqlite kept (mock/ never ships); formatSgd negative branch
           dropped; inSentence keeps acronyms
questions: $830 ward limit not in shipped config. Conductor: out of scope, the desk builds dental claims with no ward charges
evidence:  vitest x2 100 files 1402 passed; tsc clean; build ok
```

## 2026-11-14T reviewer (final fix round)

```
status:    done
persona:   reviewer
ticket:    final-fix
artifacts: reviews/code-review-final-fix.md
decisions: approve; final review blockers closed (S-B1, SP-B1 guard proven by probes, SP-B2 properties at 300/200 runs). Should fix:
           SE-S1 phone guard misses numbers after ':' or '#'; SE-S2 scratchpad path with username in code-review-04.md:99;
           SP-S1 MediSave cap of 2 per system not enforced; ST-S1 formatSgd garbles negatives. Nits listed
questions: per-system reading: conductor answers yes (research rated High, sg-dental-claims.md:242), sent back for a second round
evidence:  vitest 100 files 1402 passed; tsc 0; build 0; guard probes 14 caught, 4 gaps
```

## 2026-11-14T developer (final fix round 2, worktree)

```
status:    done
persona:   developer
ticket:    final fix round 2 (code-review-final-fix)
artifacts: afe43d3 SP-S1 maxPerSystem 2 + tosp_too_many_in_system; 6d8fdd0 ST-S1 formatSgd over formatDecimal; 9fa9ad0 guard: phone after
           ':'/'#', lowercase NRIC, folder-slug and session temp home paths, two scratchpad paths redacted; e0751f1 SE-N2 test; 8178afd
           "previous key"; merge 1bde559 with crew/chas-claimer b730353
decisions: per body system (conductor); claim history skips a non-whole-cent amount instead of throwing; SE-N2 needed no code change
questions: author metadata and history: already decided by the conductor (G4 rebuilds main)
evidence:  vitest x2 100 files 1413 passed; tsc clean; build ok; guard passes on all tracked files
```

## 2026-11-14T conductor (final fix merge)

```
status:    done
persona:   conductor
ticket:    final fix rounds 1-2
artifacts: crew/chas-claimer fast-forwarded to 1bde559; worktree and branches removed
decisions: round 2 not re-reviewed by a separate reviewer: small, each item maps to a reviewed finding, conductor read the SP-S1 and
           money diffs; QA re-run at the release candidate is the next independent check
questions: -
evidence:  conductor run on 1bde559: vitest 100 files 1413 passed; tsc 0; build ok; src/design-system diff empty
```

## 2026-11-14T qa-engineer (QA 02, release candidate 2eef6fd)

```
status:    done
persona:   qa-engineer
ticket:    release candidate
artifacts: reviews/qa-02.md; screenshots in the session scratchpad (not the repo)
decisions: read-only run; 16 QA 01 defects re-verified fixed; new N2 Major (batch dialog overflows, no scroll), N1 N3 N4 N5 N6 N7 Minor,
           N8 question; follow-up 1 seen live (waterfall reorder withdraws a claim with no way back)
questions: N2 blocking? N8 show shortfall? escalate follow-up 1?
evidence:  suite 100 files 1413 passed; tsc 0; build 0; UAT 4 12/12, 5 14 pass + 5.10 staging + 5.8 waived, 10 6/6; B1-B10 10 pass
```

## 2026-11-14T conductor (QA 02 triage)

```
status:    done
persona:   conductor
ticket:    QA 02
artifacts: two developers dispatched: qa02-ui (N2, N1, N4, N8, settings note for follow-up 1), qa02-server (N3, N5 via migration 0004, N6, N7)
decisions: N2 is a major with an open defect, so it blocks release (exit criteria); all minors fixed too since each is small and N3 is
           the D12 family. N8: yes, name the shortfall. Follow-up 1: full revive stays a follow-up (lifecycle change), v1 warns on the
           settings page before a reorder; flagged for Ting Yu in the final summary
questions: -
evidence:  qa-02.md section 6 read in full
```

## 2026-11-14T developer (QA 02 server, worktree)

```
status:    done
persona:   developer
ticket:    QA 02 N3 N5 N6 N7
artifacts: branch crew/chas-claimer-qa02-server: a14e88b N3 frozen own share plus a "rest" split segment; 6d5faf4 N5 migration
           0004_reference_case.sql + README; 270d6ca N6 findingsInForce drops deadline_approaching once sent or closed; 42b6119 N7
decisions: N6 filters on read so stored rows are fixed too; N7 one annotated reference covers every pre-auth benefit on that claim (as packet)
questions: BillSplit draws "rest" in the insurer colour with "Rest of the bill" aria text: needs a neutral fill (taken at integration);
           0004 applies before the code at deploy (nothing deployed yet; wizard applies the whole folder)
evidence:  vitest 101 files 1430 passed incl SC7.6 guard; tsc 0; build 0; N7 test fails with fix reverted
```

## 2026-11-14T developer (QA 02 UI, worktree)

```
status:    done
persona:   developer
ticket:    QA 02 N1 N2 N4 N8, follow-up 1 note
artifacts: branch crew/chas-claimer-qa02-ui: 7e42ad8 N2, d283698 N4, e219e20 follow-up 1 note, e15c1eb N8, 60f7ef7 9af9507 453e027 N1
           (src/ui/focus.ts useFocusOnSettle + .settled-focus)
decisions: N8 no server change: paid page measures shortfall against claimed, accept-short dialog against accepted (or claimed)
questions: aria-disabled for busy buttons app-wide (follow-up); DS dialog Close button about 11px wide (DS upstream, follow-up 18)
evidence:  vitest 101 files 1442 passed; tsc 0; build 0; N2 live Playwright 50 claims/61 warnings: Close, Cancel, Approve anyway in
           viewport at 1280x720 and 360x800, body scrolls, no sideways scroll
```

## 2026-11-14T reviewer (QA 02 integration)

```
status:    done
persona:   reviewer
ticket:    QA 02 integration (crew/chas-claimer-qa02-int f9669ba vs 2eef6fd)
artifacts: reviews/code-review-qa02.md
decisions: changes-requested: B1 frozenVisitSplit lumps unsent unchanged siblings into "rest" (D04b shows CHAS + rest, not the full split;
           breaks docs/design.md and AC-3.7). Should fix S1 src->server type import in ClaimHistory; SP1 no test with several frozen claims.
           N1, N2, N4-N8 and settings note fine. No security or blocked-path findings
questions: "rest" for unchanged siblings deliberate? Conductor: no, take the reviewer's fix (full split when the frozen share still matches)
evidence:  vitest 1460 passed; tsc 0; build ok; N5 tests fail without 0004 and with the base remittances repo; B1 reproduced
```

## 2026-11-14T developer (QA 02 review fixes, worktree)

```
status:    done
persona:   developer
ticket:    QA 02 review B1 SP1 S1 + nits
artifacts: 6acb036 B1/SP1/S3 frozenVisitSplit; 11266d6 S1 RebuildReason in src/domain/types.ts; 0c3a3e6 S2 S4 SP2
decisions: full split when every sent claim from that revision still gets its claimedCents and no open sibling is from another revision,
           else own share + rest; every sent claim draws the same bill. SP3 SP5 SP6 skipped
questions: -
evidence:  vitest 102 files 1463 passed incl guard; tsc 0; build 0; D04b and SP1-unchanged tests failed before the fix
```

## 2026-11-14T conductor (QA 02 merge)

```
status:    done
persona:   conductor
ticket:    QA 02 fixes
artifacts: crew/chas-claimer fast-forwarded to 0c3a3e6 (server + UI merges, f9669ba BillSplit rest fill, review fixes)
decisions: B1 fix read and accepted by the conductor without a second reviewer round (one function, reviewer's own proposal, three
           targeted tests); browser QA 03 re-check needed since src/ changed after QA 02 (exit criterion 11)
questions: -
evidence:  vitest 102 files 1463 passed; tsc 0; build ok; no src->server imports; src/design-system diff empty
```

## 2026-11-14T qa-engineer (QA 03, ce75b80)

```
status:    changes-needed
persona:   qa-engineer
ticket:    release candidate re-check after QA 02 fixes
artifacts: reviews/qa-03.md; red test and screenshots in the session scratchpad
decisions: D01 Critical: a waterfall reorder after a lower-ranked payer was sent rebuilds the unsent insurer over the sent amount
           (D04b Meridian $288 -> $688, claims total $400 over the fee, no finding; fixedDiffers computed, never read).
           D02 Minor: focus falls to body after 7 more actions (N1 residual)
questions: D01 blocks G4?
evidence:  1463 passed; tsc 0; build 0; guard passes; B1-B10 9/10 (B9 fails on D01); N1-N8 7/8 (N1 -> D02)
```

## 2026-11-14T conductor (QA 03 triage)

```
status:    done
persona:   conductor
ticket:    QA 03
artifacts: developer dispatched on crew/chas-claimer-qa03 for D01 and D02
decisions: D01 blocks release: an over-claim is a money defect. Fix at the cause (fixed amounts come off the fee before any unsent plan,
           fixedDiffers surfaces as a blocking finding) plus a property test over every waterfall order and sent subset; D02 fixed too
questions: -
evidence:  qa-03.md section 6 read; red test reproduces "expected +0 to be 40000"
```

## 2026-11-14T developer (QA 03 fixes, worktree)

```
status:    done
persona:   developer
ticket:    QA 03 D01 D02
artifacts: branch crew/chas-claimer-qa03: 1d737b6 D01 (sent claims off the visit first, warning lower_payer_sent_first, blocking
           sent_claims_exceed_fee, ADR 0009 updated); ca3647d D02 (useFocusOnSettle at the seven sites)
decisions: no migration (findings.code has no CHECK); the SP1 test in claims.test.ts encoded the bug and was changed
questions: approval kept when amount unchanged: conductor yes (existing design, approval clears only on a material difference);
           DS Dialog does not return focus on cancel: follow-up with 14/18
evidence:  vitest x2 102 files 1489 passed; typecheck 0; build 0
```

## 2026-11-14T reviewer (QA 03 fixes)

```
status:    done
persona:   reviewer
ticket:    QA 03 D01 D02
artifacts: reviews/code-review-qa03.md
decisions: changes-requested: B1 sent_claims_exceed_fee is stored only as a visit remark, so it blocks nothing and laterRemarks hides it on
           sent claims; fixedDiffers still unread. D01 over-claim fixed and verified; D02 seven sites fixed and tested. Should fix: ADR 0003
           doesn't list the new code. Security, UI, blocked paths: none
questions: -
evidence:  vitest 102 files 1489 passed; typecheck 0; build 0; guard 10 passed; probe (D04b send all, re-import at half fee) showed no finding
```

## 2026-11-14T developer (QA 03 review fix, worktree)

```
status:    done
persona:   developer
ticket:    QA 03 B1 + N2 N7
artifacts: 030f74c sent_claims_exceed_fee blocks every unsent claim (status, queue blockingCount, approve, submit) and shows on sent
           claims' pages via laterRemarks (FROZEN_FINDING_CODES); d744944 ADRs 0003 and 0009; 3bf2f4e N7 copy, N2 hook doc
decisions: fixedDiffers deleted (unread; changed-after-submission already marks a sent claim the rules would price differently, and a
           blocking version would hold normal re-imports); unsent claims stay at $0 while blocked
questions: approval when unchanged: answered yes earlier; DS Dialog focus return on cancel: follow-up
evidence:  vitest x2 102 files 1492 passed; typecheck 0; build 0; B1 probe tests failed before, pass after
```

## 2026-11-14T conductor (QA 03 merge)

```
status:    done
persona:   conductor
ticket:    QA 03
artifacts: crew/chas-claimer fast-forwarded to 3bf2f4e; worktree and branches removed
decisions: B1 fix checked against the reviewer's probe by its tests (finding on sent pages, queue count, approve and submit refused);
           no second reviewer round; a targeted browser QA 04 re-check of D01 follows since src/ changed (exit criterion 11)
questions: -
evidence:  conductor run: vitest 102 files 1492 passed; tsc 0; build ok; no src/design-system diff; fixedDiffers gone
```

## 2026-11-14T release-manager

```
status:    needs-human
persona:   release-manager
ticket:    -
artifacts: CHANGELOG.md; reviews/release.md (release notes, deploy order, rollback, G4 plan, what Ting Yu must do, release checklist)
decisions: package.json already 0.1.0; no PR on this path, root commit message drafted; push names only main; AI off via
           AI_DAILY_CALL_CAP=0 or unset key (redeploy)
questions: quality gate first (conductor: yes, after QA 04); qa02/qa03 fix rounds had no second review (conductor: accepted, each was the
           reviewer's own proposal with targeted tests, and QA 04 re-checks in the browser); card says no release tags
           (conductor: no tag, release.md amended)
evidence:  vitest 102 files 1492 passed; typecheck 0; build ok; guard with the new files indexed 8 passed
```

## 2026-11-14T qa-engineer (QA 04, 392f46f)

```
status:    done
persona:   qa-engineer
ticket:    QA 04
artifacts: reviews/qa-04.md; screenshots and red-test copy in the session scratchpad
decisions: D03 Minor: on a claim held by sent_claims_exceed_fee, Who pays shows a sent Flexi claim below its claimed amount (splitAcross
           via claimDetail); display only, on a blocked claim
questions: D03 before release? Conductor: follow-up 24 (Minor, blocked state, finding explains it; exit criteria allow minors)
evidence:  suite 102 files 1492 passed; tsc 0; build 0; B1-B10 10/10; QA 03 D01 2/2, D02 a-g 7/7; waivers 5.8 (G4), 5.10 api and 7.5 (staging)
```

## 2026-11-14T qa-lead (quality gate)

```
status:    done
persona:   qa-lead
ticket:    -
artifacts: reviews/quality-gate.md
decisions: GO with waivers at 392f46f: criteria 2-7 and 11 met; 9 via W1 (SC3.7); 1, 8, 10 via W2 (fix rounds without a second reviewer),
           W3 (security-review skill never ran; manual passes, no open high), W4 ($830 ward limit out of scope), W5 (defects in qa-NN.md);
           0 critical, 0 major, 5 minor open
questions: grant W2, W3, W5 at G4?
evidence:  npm test 102 files 1492 passed; typecheck 0; build 0; guard 8 passed on tracked and on a scratch index with the release files;
           no skip/only; e2e 7 passed
```

## 2026-11-14T conductor (G4 waivers)

```
status:    done
persona:   conductor
ticket:    G4
artifacts: follow-ups 24 (QA 04 D03), 25 (second review of 0c3a3e6..3bf2f4e, security-review skill next release)
decisions: G4 delegated by Ting Yu (2026-11-13: "dont come back to me unless everything is done and committed first version in the repo";
           "i give you permission to run merge yourself"). W1 SC3.7 and W4 ward limit already granted; W2, W3, W5 granted: undeployed first
           version, QA 04 is the independent check, manual security passes found no high, QA records live in qa-NN.md. All five kept on
           follow-ups. Ship path per release.md section 5: main rebuilt as one root commit under the Jura release identity, no tag (card),
           push main only
questions: -
evidence:  quality-gate.md read; verdict GO with waivers
```
