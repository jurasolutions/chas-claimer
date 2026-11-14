# 02a: The synthetic clinic

**What to build:** a deterministic, made-up dental clinic that every test, demo and the connector use: `generateClinic({ seed, asOf })` in `mock/synthetic-clinic/generate.ts` (pure, no file system). It returns the clinic profile, its `DeskSettings` (two branches, three dentists, fictional payers such as "Meridian Dental Plan" and "Harbour TPA" with made-up benefit codes), its code map, about 60 patients and 200 visits with `T9` identifiers, and a `cases` map from each case name to its visit keys. It also generates the remittance files R1 and R2 (`reviews/uat-script.md` §2.3, with the `MHCP-000n` references). Every case D01–D27 in `reviews/uat-script.md` §2.2 is present, dated relative to `asOf`. Also: the SQLite writer (`write-sqlite.ts` with sql.js) into a CMS-like schema of the clinic's own (`schema.sql`, not ours), and `mock/synthetic-clinic/cli.ts` for `npm run mock:clinic -- --seed <n> --as-of <date> --out <file>`.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (§1, §3, §11, §12 win on conflicts), `reviews/uat-script.md` §2, `reviews/technical.md` (§3 generator interface; F13; §4 lists the files this ticket owns), `reviews/functional.md`, `reviews/test-strategy.md` (SC7.7, SC7.9, SC7.10), `GLOSSARY.md`, `docs/adr/`.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] `npm test` and `npm run typecheck` pass.
- [ ] SC7.10: the same seed and `asOf` give byte-identical output, both from `generateClinic` and from the SQLite writer.
- [ ] SC7.7: every identifier the generator emits passes `parseNric` and `isSynthetic` (property test over seeds).
- [ ] SC7.9: the `cases` map names every case D01–D27, and each named visit has the feature it promises (each tier, Green, PA, expired card, MediSave with and without MCAF, MSP code, Flexi-MediSave at 59 and 60, insurance with a partly used limit, the unfinished crown, the above-benchmark fee, the unmapped clinic code, the re-import pair, and the dentist notes on D18 and D18b that carry the patient's synthetic name, identifier and phone).
- [ ] Every generated visit passes `parseSourceVisit` (01); the generated settings pass `DeskSettings`.
- [ ] Reading the SQLite file back gives the same visits as `generateClinic`. The CLI writes the file and prints only counts, never rows.
- [ ] R1 and R2 have the lines in uat-script §2.3, and their references and amounts point at the right cases.
- [ ] No real insurer, TPA or benefit code names appear (a test checks a deny list).

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Own all of `mock/synthetic-clinic/**`, complete with every case, so no wave-1 ticket edits the generator. A missing case found later is a conductor-merged change here, not a ticket's.
- Pure: no D1, no server code, no `functions/`. Ticket 02 imports the generator for `POST /api/imports/synthetic` and the test fixtures; 05 writes its SQLite file and reads it through the shipped mapping.
- Expected claim amounts per case belong to the tests that check them (02 for CHAS, 03 for the rest), not to the generator.
- Fill only the README section "The synthetic clinic".
