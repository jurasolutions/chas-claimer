# CLAUDE.md — repos/chas-claimer

A claims desk for a Singapore dental clinic: it pulls claim-ready visits out of the clinic's own
records, checks them against each scheme's rules, and submits them to CHAS, MediSave and dental
insurers through one adapter per payer channel. Built by Jura Solutions. `README.md` covers
layout, commands, configuration and deployment.

## Standing rules

- **Jura only.** Never read `taskwise-*` or ZenexFlow folders. No Notion, no Zapier.
- **This repo is public.** No real patient data, ever: no NRIC/FIN, names, phone numbers or
  claim records from the clinic. Every record in `mock/` and the tests is synthetic, and every
  synthetic NRIC uses the reserved test prefix described in `GLOSSARY.md`.
- **Secrets stay out.** Payer credentials, API keys and the clinic database connection string
  live in Cloudflare Pages environment variables or `.dev.vars`, never in a file in the repo.
- **`src/design-system/` is read-only.** A synced copy of `jurasolutions/design-system/`;
  change it at source and run `npm run sync:ds`.
- **The numbers rule.** Never publish a figure Jura can't evidence. Subsidy rates and caps in
  the scheme rules are configuration with a source and an "as of" date, not hard-coded truth.
- **No AI on identifiers.** Nothing sent to Anthropic carries an NRIC/FIN, a name, a phone
  number or an address (see `docs/adr/`).

## Agent skills

Crew operating card: docs/agents/crew.md

### Issue tracker

Local markdown under `.scratch/<feature>/`; PRDs stay in `jurasolutions/prd/pending/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single context: `GLOSSARY.md`, `docs/adr/`, `docs/research/`. See `docs/agents/domain.md`.
