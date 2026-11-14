# 11: Hardening before real data: key rotation and the infra review's findings

**What to build:** a reviewer can rotate the identifier key without losing a single sealed identity or patient
match, and four smaller rough edges from the infra review and ticket 07 are smoothed: the connector token's
strength check, a clear message when the sign-in session ends, the simulator's nav link hidden when the
simulator is off, and `/api/me` reporting demo mode the same way the simulator routes decide it.

**Read first:** `.scratch/chas-claimer/reviews/infra.md` §9 and §10 (I1, I2, I4), `docs/adr/0006-identifiers-sealed-hashed-masked.md`,
`reviews/technical.md` §7, the crew-log conductor entry for ticket 07, `.scratch/chas-claimer/follow-ups.md`.

**Blocked by:** 07, 08, 09 (all merged).

**Status:** ready-for-agent

- [ ] I1: `IDENTIFIER_KEY` is the current key with `IDENTIFIER_KEY_VERSION` (default 1, so today's `v1:` values
      still open) and an optional `IDENTIFIER_KEY_PREVIOUS`. New values carry the current version prefix;
      `openIdentity` picks the key by prefix; patient lookup matches under both keys while the previous key is
      set. A reviewer-only, batched re-seal and re-hash route on the `settings/rebuild` cursor pattern moves rows
      to the current version, reports what remains, and writes one audit event per batch. The development-key
      fingerprint guard applies to both keys. README and ADR 0006 (conductor edits the ADR) describe the steps.
- [ ] I2: `CONNECTOR_TOKEN` must be at least 43 characters (32 random bytes in base64); the README says so.
- [ ] I4: a failed fetch on a signed-in page (Access redirect blocked by CSP) shows "Your session ended. Reload
      the page to sign in again." with a reload button, instead of a network error.
- [ ] The nav shows "Payer simulator" only when the simulator is on; `/api/me` reports demo mode true for
      `DEMO_MODE=yes` or a loopback host, using the same helper as the simulator routes.
- [ ] Tests first for each; full suite, typecheck and build pass.
