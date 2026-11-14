# 12b: QA fixes, queue, overview, settings, submission and dialogs

**What to build:** fix the QA 01 defects on the queue, overview, settings feedback, the submit page and every
dialog, so a keyboard user can work the whole desk and nothing is submitted twice. Defect numbers refer to
`.scratch/chas-claimer/reviews/qa-01.md` §6.

**Blocked by:** 11 is in flight on `server/crypto.ts`, `server/auth.ts`, `src/ui/api.ts`, `App.tsx` and the
settings page's key-rotation panel; stay off those files except the settings feedback lines D08 names. 12a runs
in parallel on the claim builder, rebuild and claim detail.

**Status:** ready-for-agent

- [ ] D01 (major): filter controls on the queue for status, scheme, payer, branch, due and changed, kept in the
      URL so links still work (technical §6 route, UAT 3.3). The QA `it.fails` test passes.
- [ ] D06 (major, accessibility): an app wrapper around the design system's `Dialog` in `src/ds.ts` moves focus
      in on open, traps Tab, and returns focus to the opener on close; every dialog uses it. The vendored design
      system stays untouched; note the upstream fix as a follow-up.
- [ ] D18 (major): "due within 5 days" counts CHAS claims with 0 to 5 days left only, in both the overview and
      the queue filter (AC-8.3).
- [ ] D09: re-opening a checklist you already hold doesn't move the claim's version; D17: it doesn't log another
      checkout event either.
- [ ] D17: after a send or export, the submit list refreshes so a second export can't include claims already sent;
      the server refuses a claim that is no longer approved in any export or send, as a backstop.
- [ ] D10: the Portal refused dialog starts clean. D08: only the latest settings outcome shows. D20: the portal
      reference error is linked with `aria-describedby`. "Loading claims…" carries `aria-busy`.
- [ ] D04: with no payment statements, the overview says "No payment statements yet."
- [ ] D19: the connector reports a missing or malformed field as "Line 7: the visit date is missing." style
      messages, never raw Zod text and never a value.
