# 02: Walking skeleton: synthetic clinic to CHAS claims in the queue

**What to build:** a claims officer opens the desk, loads the synthetic clinic, and sees CHAS claims in the queue with masked identifiers, amounts and deadlines. Underneath: the import service (parse, synthetic guard, split, hash, seal, revisions by content hash, page cap of 100, idempotent, re-import flags submitted claims and clears approvals), with the rebuild step extracted for later tickets; the claim builder with the CHAS rule set only (the dated CHAS dental schedule from the research with sources) and the finding catalogue for CHAS; the visits, claims and code-map read repositories; the synthetic load route using `generateClinic` (02a); the claims list; the Imports and Queue screens in the shell from 01b.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 01, 01b, 02a.

**Status:** ready-for-agent

- [ ] Functional AC-1.1 to AC-1.8.
- [ ] `POST /api/imports` (connector token) and `POST /api/imports/synthetic` (officer, `DEMO_MODE` only) go through the same service; a non-`T9` NRIC is refused with 422 `real_identifier_refused` and is not echoed.
- [ ] SC1.11 to SC1.13: an import builds and stores claims with no manual step; re-import is idempotent by visit ID and content hash; importing the same batch twice leaves the database identical (property test).
- [ ] No list endpoint returns an unmasked identifier (asserted by test over the whole response).
- [ ] The CHAS rule set JSON carries id, effective dates and source URLs; every amount in it matches the research note §1.5.
- [ ] The CHAS D-cases from the generator's `cases` map produce the hand-computed CHAS amounts in `reviews/uat-script.md` (one table-driven test).
- [ ] Queue at 360px and 1280px renders per docs/design.md; the Imports screen shows recent imports with their counts.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- `buildVisitClaims` lands with its final signature from technical §3, and the import service already gathers `history`, `fixed` and `annotations` for it. Ticket 03 changes what happens inside the builder, never its inputs or the service.
- `server/repo/claims.ts` lands with the whole §3 interface (`list`, `detail`, `forVisit`, `history`, `upsertBuiltStatements`, `transitionStatement`) plus `unsubmittedVisitKeys(filter)`, so 04 and 06 do not both add to it in wave 1.
- Extract the rebuild step into `server/services/rebuild.ts`: `rebuildVisits(deps, visitKeys, actor, reason)` (history, fixed, annotations, build, upsert unsubmitted, flag submitted, clear stale approvals, one batch per visit). Import, annotations and reopen (04) and settings and code-map changes (06) all call it.
- `server/repo/code-map.ts` read side (`get`) is created here, because the builder needs the code map; 06 adds the writes. The synthetic load writes the generator's settings and code map before importing its visits.
- `src/domain/rules/index.ts` exports `listRuleSets()` with each set's id, scheme, effective dates, sources and an optional `note`, for the settings screen (06).
- `tests/helpers/fixtures.ts` gives later tickets a seeded desk (synthetic clinic imported into an in-memory D1). Later tickets add their own fixture files instead of editing this one.
- Use the generator (02a) and the shell (01b) as they are; do not edit `mock/**`, `src/ui/{App,router,api}.ts(x)` or the shared components.

**Conductor addendum (after 01b, 2026-11-13).**
- Fix `formatSgd` for negative cents (01's `src/domain/money.ts` floors toward minus infinity), test-first.
- Create `src/domain/claims/findings.ts` (the CHAS part of the catalogue) and wire the UI's `FindingList` `describe` prop to it.
- The claim view feeds the UI's `DeadlineText` with `{ deadline: IsoDate; daysLeft: number; warning: boolean; windowDays?: number }`, computed on the server (decisions-g2 §5). The UI never reads the clock.
- Never log `ApiError.body` (01b Sec-n1).
