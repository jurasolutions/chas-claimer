# 10: The whole flow on the synthetic clinic, end to end in Vitest

**What to build:** the one test that proves success criterion 8 (test strategy SC8.3, technical §2): `generateClinic` → SQLite file in a temp dir → the connector reads it through `connector/mappings/synthetic-clinic.json` → its `fetch` stub calls the `/api/imports` handler on an in-memory D1 → claims and findings for every scheme → an officer fixes one → a reviewer approves → submit through the simulator → the simulator accepts, rejects (with a reason) and pays → remittance R1 imported and matched → the audit trail is complete. Also the cross-ticket checks the wave-1 tickets could not make on their own: D04b's claim detail across payers (AC-3.7), a dentist's MediSave accreditation switched off in settings turning their unsubmitted MediSave claims to needs attention (AC-8.2), and the benchmark edit recomputing claims (AC-8.1). Test code only, in `tests/e2e/`; a failure here is reported against the owning ticket, not fixed in this one.

**Read first:** `reviews/test-strategy.md` (SC1.14, SC4.6, SC4.7, SC6.5, SC8.3), `reviews/technical.md` §2, `reviews/uat-script.md` §2, `reviews/tickets.md`.

**Blocked by:** 05, 07, 08, 09.

**Status:** ready-for-agent

- [ ] SC8.3 passes, with `ANTHROPIC_API_KEY` set (fetch stubbed) and again unset (SC6.5).
- [ ] SC1.14: every scheme has claims after the synthetic import.
- [ ] SC4.6 and SC4.7: one audit event per import, change, approval, submission attempt, reveal and outcome, and the event count never decreases across the flow.
- [ ] AC-3.7 on D04b, and AC-8.1 and AC-8.2 through the settings route.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.

**Conductor addendum (after 06, 2026-11-14).** Assert AC-8.2 end to end: saving a dentist as not MediSave-accredited puts that dentist's unsubmitted MediSave claims in `needs_attention` with `dentist_not_medisave_accredited`.
