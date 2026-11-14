# Risk card: cloudflare `wrangler` + `workers-best-practices` (skills only)

| | |
|---|---|
| **Verdict** | recommend with conditions (the two skills as loose skills; **not** the full `cloudflare` plugin) |
| **Risk** | Medium (scanner floor: Medium; `wrangler` alone is Low) |
| **Source** | cloudflare/skills @ b052c32bab7dd493513260228a36c88294f343f1 (the SHA `claude-plugins-official` pins), paths `skills/wrangler`, `skills/workers-best-practices` |
| **Maintainer** | Cloudflare, the stack's own vendor. Listed in Anthropic's official catalog. CODEOWNERS and a Semgrep CI workflow in the repo |
| **Licence** | Apache-2.0; vendorable: yes (keep the LICENSE and a NOTICE line) |
| **Kind** | instruction-only skills (2). The full plugin adds 12 more skills and a remote MCP server |
| **Always-on cost** | ~120 tokens for the two skills (`wrangler` ~60, `workers-best-practices` ~60); ~2.5k and ~2k when invoked |
| **Vetted** | 2026-11-13, by crew:skill-scout |

## What it does

`wrangler` tells the agent to inspect the project's own Wrangler version, scripts and config before running commands, to look up current docs rather than rely on memory, and to treat secrets, remote bindings and `secret put` (which deploys) with care. `workers-best-practices` is a review list for Workers code: unbounded body buffering (128 MB limit), floating promises and `ctx.waitUntil`, module-level request state, `Math.random` for tokens, timing-safe secret comparison, generated `Env` types and structured logging.

## Gain for this task

Nothing installed covers Cloudflare. Pages Functions run on the Workers runtime, so most of the review list applies directly to this build. Three areas are useful in particular. Streaming CSV and batch exports avoids hitting the memory limit. Audit-log writes need to be awaited or attached to `waitUntil`, so they are never dropped. Any admin or API token check needs a timing-safe comparison. `wrangler` keeps agents on the pinned `wrangler@4.86.0` in `package.json` and away from remote D1 by accident.

## Files reviewed

- `skills/wrangler/SKILL.md`: guidance only. Links to developers.cloudflare.com; no scripts.
- `skills/workers-best-practices/SKILL.md`: anti-pattern table; links to Cloudflare docs.
- `skills/workers-best-practices/references/configuration.md`: compatibility date, `nodejs_compat`, `wrangler types`, secrets, observability config.
- `skills/workers-best-practices/references/runtime-patterns.md`: streaming, `waitUntil`, bindings over REST, Queues and Workflows, Web Crypto, `vitest-pool-workers`.
- `skills/workers-best-practices/references/platform-apis.md`: handler signatures, binding access, serialization boundaries.
- Plugin manifest and `.mcp.json` (read to decide against the full plugin): HTTP MCP server `https://mcp.cloudflare.com/mcp`.

## Red flags

- `workers-best-practices/references/runtime-patterns.md:228,234`: scanner `telemetry` (medium) on `fetch("https://api.example.com/webhook", ...)`. It is a code example of a floating promise, not a call the skill makes.
- **Full plugin (not recommended): scanner floor High.** 103 `secret-path-read` hits, mostly curl examples using `$CLOUDFLARE_API_TOKEN` across the `cloudflare` skill's references. `turnstile-spin` ships four shell scripts that call Cloudflare APIs with a token and offer to write a skill into `.claude/skills/`. The bundled MCP server is an OAuth-scoped remote server that can act on the Cloudflare account. That conflicts with "Secrets and Pages settings are Ting Yu's".

## Notes

- skills.sh audits (Gen Agent Trust Hub, Socket, Snyk) all pass for both skills, which corroborates this card.
- The `cloudflare` skill's `references/browser-rendering/`, `d1/`, `pages/` and `pages-functions/` folders each scan Low. They are good reading for the portal-automation design question: Playwright cannot run inside a Pages Function, but Cloudflare Browser Rendering (`@cloudflare/playwright`) can. They are reference docs, not part of this install.
- Both skills lean towards Workers-first conventions (`wrangler.jsonc`, `wrangler types` from a config file, `@cloudflare/vitest-pool-workers`). This repo is Pages, uses `wrangler.local.toml` for local D1 only, and tests D1 with sql.js.

## Conditions of use

- Skills only. Do not install the `cloudflare` plugin, and do not connect the Cloudflare MCP server.
- Pinned to b052c32. Re-vet before copying a newer version.
- The repo's operating card wins. Never add a `wrangler.toml` or `wrangler.jsonc` to the repo. Never run `wrangler login`, `deploy`, `pages deploy`, `secret put` or `d1 ... --remote`; those are Ting Yu's. Switching the test harness to `vitest-pool-workers` is a decision for the conductor, not an incidental change.
- Structured logging must never log NRIC/FIN, names, phone numbers or claim payloads (repo rule; the skill's examples log request paths only).

## Install / uninstall

```
git clone --no-checkout https://github.com/cloudflare/skills.git "$TMPDIR/cloudflare-skills" && git -C "$TMPDIR/cloudflare-skills" checkout -q b052c32bab7dd493513260228a36c88294f343f1 && cp -R "$TMPDIR/cloudflare-skills/skills/wrangler" "$TMPDIR/cloudflare-skills/skills/workers-best-practices" ~/.claude/skills/
rm -r ~/.claude/skills/wrangler ~/.claude/skills/workers-best-practices
```

For crew: vendor both (Apache-2.0, instruction-only) as a `cloudflare` source pinned at b052c32, or add to `registry/extras.json` as loose skills. Leave the plugin out.
