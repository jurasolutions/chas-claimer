# 06: Settings, the code map and the Today overview

**What to build:** a reviewer sets up the clinic (branches with GST and registrations, dentists with MediSave accreditation, payers with channel, panel, pre-auth codes, deadline and template fields, benchmark overrides with source, waterfall order) and keeps the code map (clinic code → CHAS procedure, TOSP code, each payer's benefit code, or "not claimable"); officers read it. The Today screen shows the sentence of counts that lead to work. Settings changes rebuild unsubmitted claims.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Functional AC-8.1 to AC-8.5, S15.
- [ ] Settings writes are versioned (409 on stale) and audited; roles are shown read-only from the environment.
- [ ] Rule sets are shown read-only with their sources and "as of" dates; Flexi-MediSave shows "Start date unconfirmed"; TOSP shows its edition note.
- [ ] The code map's unmapped list offers the CodeSuggestion AI slot (stub until 09).
- [ ] Today at 360px and 1280px per docs/design.md (no KPI tiles).

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Settings and code-map saves call `rebuildVisits` (02) only for the visits the change affects, at most 100 visits per request, to stay inside D1's per-invocation query limit; a larger change says how many are still to rebuild and continues on the next request.
- `PUT /api/code-map/...` accepts `origin` (`manual` or `ai_accepted`) and audits it, so 09's "accepted from AI suggestion" trail needs no change here.
- Settings has a "Clinic database" section that renders `<MappingProposal>` (stub until 09); an accepted mapping is saved in the settings document and can be downloaded as the connector's mapping file.
- Rule sets come from `listRuleSets()` (02). Test the screen with a fixture list; the Flexi-MediSave and TOSP notes themselves are 03's.
- AC-8.1 and AC-8.2 are tested here as "the save is versioned, audited and rebuilds the affected unsubmitted claims" on CHAS claims. The MediSave and benchmark outcomes are asserted at builder level in 03 and end to end in 10.
