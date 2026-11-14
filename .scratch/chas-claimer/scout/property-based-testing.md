# Risk card: property-based-testing (Trail of Bits)

| | |
|---|---|
| **Verdict** | recommend with conditions |
| **Risk** | Low (scanner floor: Low) |
| **Source** | trailofbits/skills @ 149d7b21f4067765b82e67029730b42d228ef4b4 (plugin v1.2.3), path `plugins/property-based-testing` |
| **Maintainer** | Trail of Bits, a security firm with a long public record (Echidna, Slither, Semgrep rules). Plugin authored by Henrik Brodin; repo active (last commit 2026-11-12) |
| **Licence** | CC-BY-SA-4.0; vendorable: **no** (crew vendoring needs MIT, Apache-2.0, BSD or ISC). Personal install with attribution is fine |
| **Kind** | plugin with one instruction-only skill; no agents, hooks, MCP or LSP servers |
| **Always-on cost** | ~223 tokens (~840 when invoked; references loaded one at a time) |
| **Vetted** | 2026-11-13, by crew:skill-scout |

## What it does

It teaches the agent to write, review and triage property-based tests: pick the strongest property the code supports (roundtrip, oracle, idempotence, invariant), put constraints in the generator instead of filters, pin known edge cases, and avoid tautological or vacuous properties. It also covers when to refactor so a pure core can be asserted, and how to tell a wrong property from a real bug once a counterexample shrinks. It names fast-check as the TypeScript library.

## Gain for this task

The core of chas-claimer is a pure rules engine that handles money: subsidy tiers, per-visit and annual caps, MediSave withdrawal limits, and claim validity. It also does encode and decode work: batch CSV export and any re-import, NRIC normalisation and checksums, date and amount formatting. Those are exactly the shapes where properties find bugs that example tests miss. Examples: `parse(render(batch)) == batch` for every payer file, "the subsidy is never negative and never above the cap", "normalising an NRIC twice equals normalising it once", and "the checksum validator accepts every generated valid ID and rejects every single-character mutation". mattpocock `tdd` (installed) gives the red-green loop but no property discipline, so the two fit together without overlap.

## Files reviewed

- `.claude-plugin/plugin.json`: name, version, author only.
- `skills/property-based-testing/SKILL.md`: property catalog, tautology and vacuity, routing. It says adding a PBT dependency is the user's call.
- `references/generating.md`, `reviewing.md`, `interpreting-failures.md`, `libraries.md`, `refactoring.md`: guidance with Python, Solidity and pseudo-code examples; one link to secure-contracts.com.
- `agents/openai.yaml`: display metadata for another harness; not loaded by Claude Code.
- `assets/trail-of-bits-mark.svg`: plain SVG, no script, no links.
- `skills/property-based-testing/README.md`: maintainer notes on evals; not linked from SKILL.md.
- Outside the footprint, read for context: `evals/`, `evals-extra/` (`run.sh` and `effectiveness.sh` start Claude sessions for trigger-rate evals, run by hand, never loaded), and a Python and Solidity fixture.

## Red flags

None.

## Notes

- The whole `trailofbits/skills` repo floors High (413 findings across 40+ plugins: CI `curl | sh` for uv, attack-pattern docs in `agentic-actions-auditor`, zero-width characters in `audit-context-building`). None of it is in this plugin's footprint, and none is installed by the command below. Installing the marketplace only registers the catalog; install this plugin by name.
- skills.sh audits were not needed; the scan and full read are clean.
- Examples are mostly Python/Hypothesis; the agent has to translate `@given` and `assume` into fast-check's `fc.property` and `fc.pre`. The skill says so implicitly ("syntax is not knowledge a current model lacks").
- The frontmatter sets `effort: low` for the skill.

## Conditions of use

- Adding `fast-check` as a devDependency is a user decision (the skill says so itself); the conductor should raise it once, with the first property it unlocks.
- Generators for identifiers must produce **synthetic NRIC/FIN only, with the reserved test prefix** from `GLOSSARY.md`. Never use a generator that can emit an unprefixed, realistic ID, because shrunk counterexamples land in test output and the repo is public.
- Use a fixed seed in CI, so a failure can be reproduced from the log.
- Developer and test-strategy personas only.

## Install / uninstall

```
claude plugin marketplace add trailofbits/skills
claude plugin install property-based-testing@trailofbits
claude plugin uninstall property-based-testing@trailofbits
```

The marketplace tracks `main`, not the pinned SHA. For an exact pin, copy the skill instead:

```
git clone --no-checkout https://github.com/trailofbits/skills.git "$TMPDIR/tob-skills" && git -C "$TMPDIR/tob-skills" checkout -q 149d7b21f4067765b82e67029730b42d228ef4b4 && cp -R "$TMPDIR/tob-skills/plugins/property-based-testing/skills/property-based-testing" ~/.claude/skills/
rm -r ~/.claude/skills/property-based-testing
```

For crew: leave it out of `vendor/` (CC-BY-SA-4.0); add to `registry/extras.json` as a plugin extra if it earns its place.
