# 05: Connector: read the clinic database and send visits to the desk

**What to build:** a person at the clinic runs `claims-connector describe | dry-run | push` against the clinic's SQLite file or CSV export with a source mapping file, and the visits arrive in the desk. The synthetic clinic's mapping ships with it. The source seam takes more readers later (MySQL, SQL Server, Postgres) without changing the CLI.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Functional AC-7.1 to AC-7.5.
- [ ] `describe` prints table and column names only, never rows.
- [ ] Pages of at most 100 visits; retries 3 times on 5xx; desk URL and tokens only from the environment (`CLAIMS_DESK_URL`, `CONNECTOR_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`).
- [ ] An end-to-end Vitest run: generate → SQLite → connector reads through the shipped mapping → the import handler on an in-memory D1 (fetch stub routes to the handler) → claims exist.
- [ ] README section "Running the connector at the clinic".

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Use `SourceMapping` and `SourceSchema` from `src/domain/source-mapping.ts` (01); do not define the mapping shape in `connector/`.
- Fill the README section "Running the connector at the clinic" that 01 lays down; do not edit the rest of the README or `package.json`.

**Conductor addendum (after 02a, 2026-11-13).** A patient can have more than one CHAS card row in the clinic database (D21, two tiers held). The connector's source mapping collects every card row into `chasCards`, never just the first or lowest id.
Also: `src/domain/source-mapping.ts` has no mapping fields yet for dentist notes, policy `validFrom`/`validTo` or pre-authorisations (`benefitCode`, `reference`, `approvedOn`). Ticket 05 adds them, mapped into the extended SourceVisit (notes and pre-auth references go to the sealed identity).
