# Ticket review: chas-claimer

*Tech lead, 2026-11-13. Reviewed tickets 01–09 against `reviews/technical.md` §4 and
`decisions-g2.md`. Small fixes are made in the tickets (each now ends with a "Contract with other
tickets" list); `technical.md` §4 and §5 are updated to match. Ranked, most serious first.*

## Decided

**T1 (accepted by the conductor at G3, split done 2026-11-13).** Tickets 01 and 02 did not fit one developer context window. 01 is the backend spine
(schema, crypto, Access JWT, route wrapper), every domain primitive, the whole UI shell with six
shared components and the design-system reading that comes with it, test helpers, configs and
the README. 02 adds 27 hand-computed synthetic cases plus R1/R2, a SQLite writer, the import
service, the CHAS rules and two screens. Both are on the critical path, so a compacted or failed
run stalls all of wave 1.
**Recommendation:** split into four, keeping waves 1 and 2 unchanged:
- **01** backend foundation (configs, schema, domain primitives, server spine, test helpers, README). Blocked by nothing.
- **01b** UI shell (`src/ds.ts`, icons, router, api client, frame, placeholder pages, shared components, AI stubs). Blocked by 01.
- **02a** synthetic clinic generator and SQLite writer (`mock/**`, pure). Blocked by 01; runs alongside 01b.
- **02** walking skeleton (import, CHAS rules, builder, repos, rebuild service, Queue and Imports). Blocked by 01, 01b, 02a.

The cost is one extra serial step, but 01b and 02a run in parallel. Done: `issues/01-foundation.md` and `issues/02-walking-skeleton.md` are rewritten, `issues/01b-ui-shell.md` and `issues/02a-synthetic-clinic.md` are new, every acceptance criterion moved with its work, and §4 of `technical.md` matches.

## Fixed in the tickets

**T2. Missing blocking edges on 03.** 07 (AC-4.1 and AC-4.6 use D04b's Meridian insurance claim),
08 (AC-5.4 is the same claim) and 09 (AC-6.2 needs the above-benchmark finding) all need 03's
insurance and benchmark rules. Added 03 to each. Scheduling does not change, because wave 2 starts
after wave 1.

**T3. Hidden edges inside wave 1.** 04's AC-3.7 (D04b across payers) and 06's AC-8.1 and AC-8.2,
plus the Flexi and TOSP rule-set notes, need 03, which runs alongside them. Now: 04 tests claim
detail with a seeded two-payer fixture, 06 tests that a save rebuilds the affected claims (on CHAS)
and renders `listRuleSets()` from a fixture, 03 asserts the MediSave-accreditation and benchmark
effects at builder level, and ticket 10 checks the real cases end to end.

**T4. Two wave-1 tickets would edit the same files.**
- **Rebuild.** 04 (annotations, reopen) and 06 (settings and code-map saves) both rebuild claims, and the only rebuild code is in 02's import service. 02 now extracts `server/services/rebuild.ts`.
- **Claims repository.** 04 and 06 would both add to `server/repo/claims.ts`. 02 now lands its whole interface.
- **Code map.** `server/repo/code-map.ts` belonged to 06, but 02's builder needs the code map first. 02 now creates the read side, and 06 adds the writes.
- **Builder inputs.** If 02 had passed empty `history`/`fixed`/`annotations`, 03 would have edited the import service and the repository. 02 now lands the builder's final inputs.

**T5. Wave-2 overlaps.** 07 and 08 would both change `server/services/claims.ts`: for the simulator
outcomes, for `record_payment` with a line ID, and for system actors. 07, 08 and 09 would all edit
`ClaimDetail.tsx` and `Queue.tsx`. 04 now lands the complete action set, the checkout service (S6),
the channel stamped at approval (S15), the "Paid X of Y" display with short-payment acceptance, the
Submit entry points and the AI slot placements. Ticket 07 now owns `claims/[id]/packet.ts`
explicitly, and 09 only fills the slots.

**T6. Schema that later tickets assume but 01 did not have.** A global UNIQUE (`claim_id`) on
remittance lines stopped a claim from being paid in part across two files. It is now per file.
There was also no file hash for S12's "same file twice adds no lines". Both are now in 01, because
schema changes after `0001` are discouraged.

**T7. Shared types and documents.** `SourceMapping` was needed by the `MappingProposal` stub, 05 and 09, but had no
home. It is now in `src/domain/source-mapping.ts` in 01. `DeskSettings` must be complete in 01,
including the remittance column mapping (08) and the accepted source mapping (06/09). The README
environment table and the per-ticket README sections are laid down by 01. All scripts are added in
01, and no later ticket touches `package.json` or the lockfile.

**T8. Unowned placement and storage.** AC-6.5's source mapping had no screen and nowhere to be
saved. It now goes in the 06 Settings "Clinic database" section and the settings document. AC-6.3's
`ai_accepted` origin is now accepted by 06's code-map PUT.

**T9. The end-to-end test had no ticket.** §4 said it "lands with the last block to merge", which
no developer owns. Added `issues/10-end-to-end-flow.md` (SC8.3, SC1.14, SC4.6/4.7, SC6.5, and the
cross-ticket ACs from T3). It is blocked by 05, 07, 08 and 09.

## Risk noted, no change

**T10. Rebuild on settings save and D1 limits.** Rebuilding every unsubmitted visit in one request
can exceed D1's per-invocation query limit. 06 now rebuilds only the affected visits, up to 100 per
request.

## Fits one context window

03, 04, 05, 06, 08, 09 and 10 fit. 07 (four channels, the simulator and two screens) is the
largest in wave 2, but it is cohesive behind the `SubmissionChannel` seam, so it stays one ticket.
