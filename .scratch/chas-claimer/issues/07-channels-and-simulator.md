# 07: Submission channels, the assisted checklist and the payer simulator

**What to build:** an officer submits approved claims. For an assisted payer they work through a checklist in the portal's order with copy buttons, an "Open portal" link, and record the portal reference (or "portal refused"); for a file payer they download a batch CSV in the payer's layout; for an api payer the desk sends JSON to the configured https endpoint with `PAYER_<ID>_API_TOKEN`; for the simulator the claim lands in the payer simulator, where a person accepts, rejects or pays it and the claim follows. Packets carry only the payer template's fields.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (layout, interfaces, schema, routes; §4 lists the files this ticket owns), `reviews/functional.md` (rules and ACs), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/adr/`, and for UI `docs/design.md` plus the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 03, 04, 06.

**Status:** ready-for-agent

- [ ] Functional AC-4.1 to AC-4.8.
- [ ] Technical F3: the api channel refuses http, IP literals and localhost, follows no redirects, caps the response, derives the token variable from the payer ID.
- [ ] Technical F9: file export neutralises formula cells; one audit event per claim per export or send.
- [ ] The simulator page carries "Payer simulator. Nothing here reaches a real payer." and never uses a real payer's name or look.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Own `functions/api/claims/[id]/packet.ts` (the assisted checklist's packet), even though it sits under 04's `claims/[id]/` folder.
- Use the channel stamped on the claim at approval, not the payer's current channel (S15). Call 04's `checkout`/`takeOver` for the checklist and `act` for every status change; do not edit `server/services/claims.ts`, `ClaimDetail.tsx` or `Queue.tsx`.
- Fill only the README section "Payer channels and API tokens".
