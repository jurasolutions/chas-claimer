# 01b: UI shell: app frame, router, shared components and AI slots

**What to build:** the desk's front end that every screen ticket fills in: the design-system import point (`src/ds.ts`, the only import of `src/design-system/`), the icon registry (`src/lib/icons.ts`, every icon the screens in `docs/design.md` need), a small history router, the typed api client against `src/api/common.ts`, the app frame with left rail and phone top bar per `docs/design.md`, a placeholder page per route, the shared components BillSplit, StatusBadge, DeadlineText, MoneyCell, MaskedIdentifier (with the reveal button that posts to the reveal route and says the reveal is recorded) and FindingList, the AI slot components as stubs with their final props (technical §3, UI), and the "You don't have access to the claims desk" page driven by `GET /api/me`.

**Read first:** the PRD (`jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`), `.scratch/chas-claimer/decisions-g2.md` (wins on conflicts), `reviews/technical.md` (§3 UI interfaces; §4 lists the files this ticket owns), `reviews/functional.md` (S11 for the access page), `reviews/test-strategy.md`, `GLOSSARY.md`, `docs/design.md`, and the design system (`jurasolutions/design-system/SKILL.md`, `README.md`, each component's `.prompt.md`).

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] The app shell renders every route's placeholder in jsdom with the design system's components; the frame shows the left rail at 1280px and the top bar at 360px.
- [ ] BillSplit renders segments in waterfall order with an accessible sentence, and patient last.
- [ ] MoneyCell and DeadlineText only format values they are given; the UI computes no amounts.
- [ ] MaskedIdentifier shows the masked value until "Show" is pressed and then calls the reveal route once (fetch stubbed).
- [ ] With `GET /api/me` answering 403, every route shows "You don't have access to the claims desk".
- [ ] Each AI slot stub renders nothing (or "AI isn't set up") and type-checks against its final props.

**Contract with other tickets (tech lead ticket review, 2026-11-13).** These keep parallel tickets off each other's files; `reviews/tickets.md` says why.

- Placeholder pages use their final file names (`src/ui/pages/{Overview,Queue,Imports,ClaimDetail,AssistedSubmit,Simulator,Remittances,Settings}.tsx`), so later tickets replace a page file and never touch the router or `App.tsx`.
- Take every domain type from `src/domain/` (01); add none here. A missing type is a one-line change the conductor merges into 01's `types.ts`.
- The AI slot props in `src/ui/ai/index.tsx` are final: 04 and 06 render the slots, and 09 replaces only their bodies.
- Register every icon now. Later tickets that need another icon add one line to `src/lib/icons.ts`, and the conductor merges it.
- No server, migration, `package.json` or README change in this ticket.
