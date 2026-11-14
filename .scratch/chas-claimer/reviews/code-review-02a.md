# Code review: ticket 02a (synthetic clinic), round 2

- **Branch:** `crew/chas-claimer-02a-synthetic-clinic` at 7d8cc7b (worktree `.claude/worktrees/agent-a6fc8f42f49d72b1e`)
- **Compared with:** `git diff crew/chas-claimer...HEAD`, where the merge-base is beb4d99
- **Commits:** 3f830ea, 7ab578a, 818434f, 0fe1afa, 1281056, f417dbe, 6917c84, 89c9aac, 60b77ac (merge), 00e4fa8, a3cbd9f, 7d8cc7b
- **Spec:** `.scratch/chas-claimer/issues/02a-synthetic-clinic.md`, `reviews/uat-script.md` §2.1–2.3, the conductor's round-2 decision on `SourceVisit` (sealed notes and pre-auth refs, a `chasCards` array, policy validity, pre-auths on the policy) and the ticket 05 addendum

## Verdict: approve

None of the findings below is blocking. Every file in the diff was read. Tests, typecheck and build all pass, and the generated clinic contains only synthetic identifiers. Three should-fix items are listed below; fix them before ticket 05 builds on this schema, or carry them into it. The ADR 0006 item needs a decision from the user (see Questions).

## Standards

### Blocking
None.

### Should fix
1. **The `notes` identity field sets up an identity-opening path that ADR 0006 does not list.**
   - **Where:** `src/domain/source-visit.ts:110` and `src/domain/source-visit.ts:163`.
   - **What the code says:** both comments say "only the AI path opens and scrubs it".
   - **The rule it breaks:** ADR 0006 line 3 says "Only the reveal route, channel sends and file exports open identity, and each writes an audit event."
   - **What is missing:** no ADR amendment lists `notes` or `preAuthRefs` as identity fields, or records the AI de-identification step as an opener with its own audit event. `docs/agents/domain.md` §"Flag ADR conflicts" requires the conflict to be recorded.
   - **What is fine:** the 02a code itself opens nothing for the AI.
   - **Why it matters now:** the comment commits the ticket that builds the AI path to a route the ADRs don't allow. ADR 0004 says AI requests carry "de-identified text only", so that path has to open sealed free text, scrub it, and then send it.
   - **Fix:** amend ADR 0006 (and, in one line, ADR 0004) before any ticket opens `notes` for the AI.
2. **The schema comment contradicts how cards are carried.**
   - **Where:** `mock/synthetic-clinic/schema.sql:25`, which reads "The lowest card_id is the one a visit carries."
   - **The rule it breaks:** the ticket 05 addendum (`issues/05-connector.md:22-23`) says the connector "collects every card row into `chasCards`, never just the first or lowest id". `projectVisits` (`records.ts`) already carries every card in record order.
   - **Why it matters:** the ticket 05 author reads this schema to build the connector.
   - **Fix:** change the comment so it says a visit carries every card the patient holds.

### Nits (judgement calls from the smell baseline)
3. **Hard-coded GST rate.** `mock/synthetic-clinic/cases.ts:48` sets `GST_RATE = 0.09` with no source or as-of date. It is mock data, so the numbers rule (CLAUDE.md) applies only loosely, but a one-line source comment costs nothing.
4. **Duplicated code.**
   - The routine fees in `filler.ts:15-19` (CON 2800, SCL 5000) repeat `cases.ts:206-207`.
   - The six-digit padding expression appears twice, at `identities.ts:53` and `:61`.
   - Possible fix: share one `ROUTINE` fee table and a `digits6(rng)` helper.
5. **Mysterious names.**
   - `cases.ts:50` declares `type Policy = "MERIDIAN" | "HARBOUR" | "HARBOUR_ENDED"`. It is a label set, not a GLOSSARY **Policy**, so rename it to something like `PolicyLabel`.
   - `one`, `T` and `cap` (`cases.ts:123-126`, `:204`) are terse.
6. **Latent bug in `jan`.** `cases.ts:127` builds `` `${yearOf(T)}-01-0${day}` ``, which is only valid for days 1–9. The only calls use days 1–3 (`:247`, `:261-262`), so nothing fails today. Use `padStart(2, "0")`.
7. **Unbalanced backtick.** The doc comment at `cases.ts:83` reads "`(date) minus `years`".
8. **NRIC cast without validation.** `write-sqlite.ts:133` and `:147` cast database text `as Nric`. That is acceptable for a mock reader. The real connector (ticket 05) must parse instead of casting.
9. **Test codes differ from config.** `tests/helpers/arbitraries.ts` uses the benefit code `"HTPA-CRN"`, while config uses `H-CRN`. This is cosmetic.
10. **Stale operating card.** `docs/agents/crew.md:10` still says vitest includes only `src/`, `server/`, `functions/` and `tests/`, but the vitest config now includes `mock/**`. The card is not in this diff; the conductor should update it.
11. **Benchmark as-of date.** The benchmark `asOf` of 2025-09-01 (`config.ts:22-24`, `:94-97`) is the press-release date. The rates took effect on 2025-10-01.

### Checked and fine
- The diff has no Primitive Obsession beyond item 8.
- `REIMPORT_REVISED_FEE` has a single source: `generate.ts:60` imports it from `cases.ts:274`. The README's $55.00 is the separate UAT 5.12 example, so the reported shotgun surgery does not hold.
- `mulberry32` duplicates nothing in the repo.

## Spec

### Blocking
None. Every acceptance criterion has a passing test:
- SC7.7 is a property test over 25 seeds.
- SC7.9 checks the case map against UAT §2.2.
- SC7.10 checks byte-identical output.
- D01–D27 match UAT §2.2.
- R1 and R2 match §2.3 line for line (`remittances.ts:41-57`).
- Settings and the code map match §2.1.
- The round-2 `SourceVisit` additions reach the visit through the single mapping `projectVisits` (`records.ts:77-121`). Notes and pre-auth refs sit in `VisitIdentity`, and `ClinicalPolicy` carries neither a member ID nor a pre-auth reference.

### Should fix
12. **Routine visits ignore which branch each dentist works at.**
    - **Where:** `mock/synthetic-clinic/filler.ts:55` chooses `rng() < 0.5 ? "DR-A" : "DR-B"` whatever the branch.
    - **The spec line it breaks:** UAT §2.1, line 34: "Dr A (East, MediSave-accredited), Dr B (West, accredited)".
    - **Effect:** routine visits show Dr A at West and Dr B at East.
    - **Fix:** derive the dentist from `branchId`, and assert it in `clinic.test.ts`.
13. **The README doesn't tell the tester to swap in real payment references.**
    - `remittances.ts:57` hard-codes R2's reference as `MDP-0001`, and R1 uses `MHCP-000n`.
    - UAT 5.10 expects "simulator references", and UAT 7.5 expects R2 to mark D04b's Meridian claim `paid`, which needs the references to match.
    - The swap instruction is only in a code comment (`remittances.ts:2-3`). The README's synthetic clinic section (`README.md:184`) never mentions it.
    - **Fix:** add one README line telling the tester to swap in the references a run records. The alternative is to have the simulator issue these references deterministically.

### Nits
14. **D19 dates collapse in early January.**
    - Near 1 January, `notBefore(d, jan(i + 1))` (`cases.ts:246-248`) lands D19's three scalings on the same day or on consecutive days, because UAT row 80 requires all three in T's calendar year. This is a conscious trade-off.
    - `clinic.test.ts:77` checks only the year. Add a distinct-date assertion if the frequency rule ever counts days.
15. **Two additions not in the ticket's case list.** Both are harmless and traceable.
    - The `multiTosp` case (P36, `cases.ts:264-267`) traces to decisions-g2 §7.
    - The Harbour `H-FIL` and `H-EXT` rows (`config.ts:124-125`) follow from §2.1's "covers fillings, extractions".

### Noted, not a 02a finding
- **D14 has no MCAF, which matches the spec.** `cases.ts:149` gives D14 no MCAF. That matches UAT §2.2 row 73, which gives the D14 patient no MCAF. The UAT expects "no Flexi-MediSave (under 60)", and with no MCAF that refusal could come from the missing MCAF rather than the age rule. If the age rule needs testing on its own, give D14 an MCAF in the UAT first.
- **Mappings deferred to ticket 05.** `src/domain/source-mapping.ts:61` has no mapping yet for notes, policy validity or pre-auths. Ticket 05's addendum (`issues/05-connector.md:22-23`) covers this.
- **Ticket 01's default settings differ from UAT §2.1.** Its `DEFAULT_SETTINGS.preAuthBenefitCodes` (`src/domain/settings.ts`) does not match §2.1. 02a uses its own `syntheticSettings()`, so this is out of scope here.

## Security

The `security-review` skill failed (`fatal: ambiguous argument 'origin/HEAD...'`, because the repo has no `origin` remote). I did the security pass by hand on the same diff.

### Blocking
None.

### Checks
- **Patient data.** The generated `clinic.sqlite`, `clinic.r1-chas.csv` and `clinic.r2-meridian.csv` for seed 1 contain:
  - no NRIC-shaped strings `[STFGM]\d{7}[A-Z]` outside the T9 block
  - 61 unique T9 IDs (60 patients plus one spouse)
  - no phone number without the `+65 0000` prefix
  - only `Example Street, Singapore 000nnn` addresses and `TEST-` member IDs

  `identities.ts:56` refuses to build any non-T9 identifier. `deny-list.test.ts` keeps real insurer and TPA names, and the codes A01 and N01, out of the generated data and the sources.
- **Secrets.** No secret-like strings appear in the diff. `apiAuthHeader: "Authorization"` is a header name only. The only URLs are `simulator.example.test` and the MOH source.
- **SQL.** Inserts are parameterised and reads use fixed SQL. Only the tests interpolate constants.
- **Network and AI.** The mock code makes no network calls, and nothing reaches Anthropic. Notes and pre-auth refs are sealed in `VisitIdentity`, and a property test shows they never leak into the clinical part.
- **Output.** The CLI (`cli.ts`) parses its arguments strictly and bounds the seed. It prints counts and paths only, and on failure it prints the error message only. `cli.test.ts` asserts that no identifier is printed.
- **Input bounds.** Zod caps bound input sizes: notes ≤ 4000, chasCards ≤ 10, preAuths ≤ 50.
- **Blocked paths.** The diff does not touch `src/design-system/`, `dist/`, `.env` or `.dev.vars`, and `git diff --stat` on those paths is empty. The diff has no UI files, so `web-design-review` does not apply.

The ADR 0006 item (Standards 1) is the security-relevant design gap. Fix it before any code opens `notes` for the AI.

## Questions for the user
- **Amend ADR 0006 for notes and pre-auth refs?** Recommended: yes, before the AI ticket. Add `notes` and `preAuthRefs` to the identity list. Record the AI de-identification step as an identity opener: it opens notes only to scrub them, and it writes an audit event. Add a line to ADR 0004 saying scrubbed notes are the only free text that reaches the model.

## Evidence (run by the reviewer at 7d8cc7b)
- `npx vitest run`: 32 files, 282 tests, all passed. The config includes `mock/**/*.test.ts`.
- `npm run typecheck`: exit 0.
- `npm run build`: exit 0. `git status --short` is empty afterwards.
- `npm run mock:clinic -- --seed 1 --as-of 2026-11-13 --out <scratch>/{a,b}/clinic.sqlite`, run twice: `cmp` finds all three files byte-identical. Output: "60 patients, 200 visits, 36 cases", R1 with 5 lines, R2 with 1 line.
- An identifier scan of the generated files found 0 non-T9 NRICs and 0 phone numbers without the `+65 0000` prefix.
- `git diff --stat crew/chas-claimer...HEAD -- src/design-system dist .env .dev.vars`: empty.
