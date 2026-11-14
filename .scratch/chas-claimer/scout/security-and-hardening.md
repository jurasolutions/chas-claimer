# Risk card: security-and-hardening (addyosmani)

| | |
|---|---|
| **Verdict** | recommend with conditions (skill folder only, without the repo-level checklist) |
| **Risk** | Medium (scanner floor: Medium for the skill folder; High once `references/security-checklist.md` is included) |
| **Source** | addyosmani/agent-skills @ aeac41d4d005999432bb7312f7ff06383a91d59d (the commit crew already pins for `api-and-interface-design`), path `skills/security-and-hardening` |
| **Maintainer** | Addy Osmani, a long-standing Google Chrome engineering lead with a public record. Crew already vendors this source |
| **Licence** | MIT; vendorable: yes (the LICENSE is already in `vendor/addyosmani/`) |
| **Kind** | instruction-only skill (SKILL.md + one reference) |
| **Always-on cost** | ~120 tokens (description); ~4.5k for SKILL.md when invoked, ~3.5k more for `hardening-patterns.md` |
| **Vetted** | 2026-11-13, by crew:skill-scout |

## What it does

It is write-time security guidance. The agent maps trust boundaries and runs STRIDE before hardening, follows always / ask-first / never tiers, and applies controls for injection, access control, sessions, headers, input schemas, SSRF, secrets and the dependency supply chain. It has two sections that matter here: personal data and privacy (classify fields, collect only for a purpose, retention and deletion, sharing PII with an LLM vendor counts as sharing) and AI/LLM features (model output is untrusted input).

## Gain for this task

The built-in `security-review` reviews a finished diff. Nothing installed guides the developer while writing code that handles health data and government IDs. This skill covers the new concerns in the brief. It treats health data and government IDs as the "Sensitive" class, which calls for stricter access, encryption and audit logging. It frames repudiation as an audit-logging requirement. It treats any PII sent to Anthropic as third-party sharing, which backs the repo's "No AI on identifiers" rule. It requires a retention limit and a deletion path for every personal-data store. It also treats extracted claim fields returned by the model as untrusted input that must pass a schema before use. It is not PDPA-specific; see Notes.

## Files reviewed

- `skills/security-and-hardening/SKILL.md`: guidance; one external link (genai.owasp.org). It names two sibling skills that are not vendored (`observability-and-instrumentation`, `debugging-and-error-recovery`).
- `skills/security-and-hardening/references/hardening-patterns.md`: TypeScript patterns (Express, helmet, bcrypt, zod, ipaddr.js, express-rate-limit, Upstash), dependency triage tree, data classification table, LLM output handling.
- `references/security-checklist.md` (repo level, referenced as `../../references/security-checklist.md`): package-manager matrix, install-script gate, OWASP tables. **Excluded** from the recommended install; see Red flags.

## Red flags

- `SKILL.md:147`: scanner `telemetry` (medium) on "Keep PII out of telemetry". It is advice against telemetry, not telemetry. The floor still binds.
- `references/security-checklist.md:179`: scanner `config-tamper` (high) on a package-manager matrix row recommending `enableScripts: false` in `.yarnrc.yml`. By reading, it is a hardening recommendation, but it sets a High floor for any install that includes the checklist. That is why the checklist is excluded.

## Notes

- skills.sh audits (Gen Agent Trust Hub, Socket) pass. That is corroboration only.
- The whole `addyosmani/agent-skills` repo floors High, mainly from docs and hook READMEs that tell users to edit `.claude/settings.json`, plus a set of hooks in `hooks/`. None of that is in this skill's footprint.
- Without the checklist, two links in SKILL.md (`../../references/security-checklist.md`) and three in `hardening-patterns.md` (`../../../references/...`, already off by one level upstream) are dead. That costs little: the skill states every rule inline.
- Several patterns are Express/Node-specific (helmet, express-rate-limit, bcrypt). On Pages Functions, set headers on the `Response`, use Web Crypto, and back any rate limiter with D1 or KV. `workers-best-practices` (separate card) covers the runtime side.
- **PDPA is not covered by name.** The skill speaks of GDPR and CCPA. Singapore's PDPA obligations (consent, purpose, retention, protection, breach notification to PDPC) map onto the same controls, but a credible PDPA-specific skill was not found. The skills.sh candidates have 1 to 47 installs from individual authors, and their legal content can't be verified. The repo's own ADR is the right place to record which PDPA obligations the design meets.

## Conditions of use

- Install or vendor `skills/security-and-hardening/` only, pinned to aeac41d. Do not install the `agent-skills` plugin, its hooks or its slash commands.
- The repo's rules win where they are stricter: no AI on identifiers, synthetic data only, secrets in Pages env.
- The "Ask first" tier (new PII categories, new integrations, auth changes) maps to `needs-human` questions under crew protocol. It does not mean stopping to ask in the middle of a ticket.

## Install / uninstall

```
git clone --no-checkout https://github.com/addyosmani/agent-skills.git "$TMPDIR/addy-skills" && git -C "$TMPDIR/addy-skills" checkout -q aeac41d4d005999432bb7312f7ff06383a91d59d && cp -R "$TMPDIR/addy-skills/skills/security-and-hardening" ~/.claude/skills/
rm -r ~/.claude/skills/security-and-hardening
```

For crew: vendor it. Add `{ "name": "security-and-hardening", "source": "addyosmani", "path": "skills/security-and-hardening", "prefix": "" }` to `vendor/UPSTREAM.json` `skills` in `jurasolutions/repos/crew`, run `node scripts/sync-upstream.mjs sync --only addyosmani`, then add a Skill map row (Security: primary `crew:security-and-hardening` while writing, built-in `security-review` for the diff).
