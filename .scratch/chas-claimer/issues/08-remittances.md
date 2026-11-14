# 08: Remittance import and matching

**What to build:** an officer uploads a payer's payment statement CSV, maps its columns once per payer, and the desk matches lines to claims by portal reference, then by patient, date and amount, records payments (partial, early, overpaid) through the lifecycle, and lists what's left to match by hand.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 03, 04.

**Status:** ready-for-agent

- [ ] Functional AC-5.1 to AC-5.7 and S12.
- [ ] Remittance identifiers are hashed on arrival and never stored in clear.
- [ ] Property: a line never matches two claims; a claim is never matched by two lines of one file.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Save the per-payer remittance column mapping in the settings document (field from 01) through `server/repo/settings.ts`; do not edit 06's settings screen.
- Record payments only through `act` with `record_payment` and the `remittance` actor; do not edit `server/services/claims.ts` or `ClaimDetail.tsx`.
