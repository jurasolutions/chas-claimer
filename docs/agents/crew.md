# Crew operating card

_Read by every crew persona before acting. Repo rules outrank crew defaults. Last verified: 2026-11-13._

## Commands

| Purpose | Command | Verified |
|---|---|---|
| Install dependencies | `npm install` | verified 2026-11-13 (Node 20.20.2, npm 10.8.2; lockfile committed) |
| Test, all | `npm test` (`vitest run`; includes `src/`, `server/`, `functions/`, `tests/` and `mock/` test files and excludes `.claude/worktrees/**`) | verified 2026-11-13: 1 file, 1 test passed |
| Test, one file | `npx vitest run tests/smoke.test.ts` | verified 2026-11-13 |
| Typecheck | `npm run typecheck` (`tsc --noEmit`; excludes `src/design-system/` and `.claude/worktrees`) | verified 2026-11-13: clean |
| Lint | none | unverified: no linter configured; `tsc` strict mode is the static check |
| Build | `npm run build` (`vite build` into `dist/`) | verified 2026-11-13 |
| Run the app | `npm run dev` (UI only, http://localhost:5173, API calls fail) or `npm run dev:functions` (build, then UI + Functions + local D1 on http://localhost:8788; run `npm run db:migrate:local` once first) | verified 2026-11-14: migrations 0001–0003 applied; `/` and `/api/me` answer 200 on :8788 as the demo reviewer |

Vite's dev server does not run Pages Functions. Use `npm run dev:functions` to exercise the API.

## Branches

- **Base branch for crew work:** `main`
- **Protected (crew never pushes or merges into these):** `main`, until Ting Yu opens G4. For the first version Ting Yu delegated G0–G4 (2026-11-13, "make reasonable assumptions ... dont come back to me unless everything is done and committed first version in the repo"): the conductor merges the first version into `main` and pushes it.
- **Ship path:** push to `main` on `github.com/jurasolutions/chas-claimer`. No deploy is wired to the repo yet; Cloudflare Pages is connected by Ting Yu (see `README.md`, "Deploy").

## Rules that gate the crew

- **PRD rule:** required. "PRD before build. No code without a written PRD and explicit sign-off." and "New PRDs are written to `prd/pending/` as `prd-{project-name}-YYYY-MM-DD.md`." (`jurasolutions/CLAUDE.md`). Sign-off is recorded in the PRD's Sign-off section. This build's PRD: `jurasolutions/prd/pending/prd-chas-claimer-2026-11-13.md`.
- **Blocked paths (read-only):** `src/design-system/` (synced copy; `npm run sync:ds`), `jurasolutions/design-system/`, `jurasolutions/inputs/`, `.env`, `.dev.vars` (never edited, committed or printed), generated `dist/`.
- **Design system:** `jurasolutions/design-system/`, vendored as `src/design-system/` and imported only through `src/ds.ts`. Read its `SKILL.md`, then `README.md`, then a component's `.prompt.md` (at source) before using it. Governs tokens, components, icons (register each Lucide icon in `src/lib/icons.ts`) and voice (§3). "Anything carrying the Jura name is built from the design system's tokens and components, never ad-hoc styles or a second icon/font set." (`jurasolutions/CLAUDE.md`)
- **Voice for human-facing text:** commits in plain sentence-case imperatives. UI copy follows `design-system/README.md` §3: sentence case, second person, short declaratives, no buzzwords, no emoji, no exclamation marks.
- **Other repo rules:**
  - "This repo is public. No real patient data, ever" (`CLAUDE.md`). Synthetic NRICs only, with the reserved test prefix.
  - Tests never touch the network: every `fetch` is stubbed (`tests/setup.ts`). Never call Anthropic or a payer endpoint for real.
  - Nothing sent to Anthropic carries an identifier (`CLAUDE.md`, "No AI on identifiers").
  - Secrets and Pages settings are Ting Yu's. Never commit a secret, never add a `wrangler.toml`.
  - Jura only: no Notion, no Zapier, never read `taskwise-*` or ZenexFlow folders.

## Release

- **Versioning:** `version` in `package.json` (0.1.0 for the first version). No release tags.
- **Changelog:** `CHANGELOG.md`.
- **Deploy target and how:** Cloudflare Pages (git integration on `main`, build `npm run build`, output `dist`, Functions in `functions/`), once Ting Yu connects it. D1 binding `DB` and secrets set in the Pages dashboard.
- **Rollback:** revert the commit on `main` and push, or "Rollback to this deployment" in the Pages dashboard.

## Tracker

Issues and feature folders: see `docs/agents/issue-tracker.md`. Domain glossary: `GLOSSARY.md`. ADRs: `docs/adr/`.
