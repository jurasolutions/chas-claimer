import { describe, expect, it } from "vitest";
import { cents } from "../../src/domain/money";
import type { IsoDate } from "../../src/domain/dates";
import type { Actor, PayerId } from "../../src/domain/types";
import { OFFICER, REVIEWER } from "../../tests/helpers/env";
import { caseVisits, CLINIC, configuredDesk, CONNECTOR_ACTOR, NOW, OFFICER_ACTOR, visitByKey } from "../../tests/helpers/fixtures";
import * as audit from "../repo/audit";
import * as claims from "../repo/claims";
import * as submissions from "../repo/submissions";
import { act, actMany, checkout, claimDetail, recordFailedSubmission, reveal, saveAnnotations, takeOver } from "./claims";
import { recheckDeadlines } from "./deadlines";
import { importVisits } from "./imports";
import { saveSettings } from "./settings";

const REVIEWER_ACTOR: Actor = { kind: "person", email: REVIEWER, roles: ["officer", "reviewer"] };

async function chasClaim(db: D1Database, visitKey: string) {
  const claim = (await claims.forVisit(db, visitKey)).find((c) => c.scheme === "chas");
  if (!claim) throw new Error(`no CHAS claim for ${visitKey}`);
  return claim;
}

/** The D04b claim of this scheme. */
async function schemeClaim(db: D1Database, scheme: string) {
  const claim = (await claims.forVisit(db, "SC-D04b")).find((c) => c.scheme === scheme);
  if (!claim) throw new Error(`no ${scheme} claim for SC-D04b`);
  return claim;
}

/** Approves the D04b claim of this scheme as the reviewer and submits it as the officer. */
async function submitted(deps: Parameters<typeof act>[0], db: D1Database, scheme: string, portalReference: string) {
  const claim = await schemeClaim(db, scheme);
  expect(await act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR)).toMatchObject({ ok: true });
  const approved = await schemeClaim(db, scheme);
  expect(await act(deps, claim.id, { kind: "submit", portalReference }, approved.version, OFFICER_ACTOR)).toMatchObject({ ok: true, value: { status: "submitted" } });
  return schemeClaim(db, scheme);
}

/** A desk holding only D01, imported by the officer: one ready CHAS claim of $50.50 on the assisted channel. */
async function d01Desk() {
  const desk = await configuredDesk();
  await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
  return { ...desk, claim: await chasClaim(desk.db, "SC-D01") };
}

describe("act: approve (AC-3.2, AC-3.3)", () => {
  it("approves a ready claim for a reviewer, fixes the payer's channel, and audits it as approved", async () => {
    const { db, deps, claim } = await d01Desk();

    const result = await act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);

    expect(result.ok).toBe(true);
    const after = await chasClaim(db, "SC-D01");
    expect(after).toMatchObject({
      status: "approved",
      approvedBy: REVIEWER,
      approvedAt: "2026-11-13T02:00:00.000Z",
      approvedRevision: claim.builtFromRevision,
      selfApproved: false,
      channel: "assisted",
      version: claim.version + 1,
    });
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.at(-1)).toMatchObject({ actor: REVIEWER, action: "approve", at: "2026-11-13T02:00:00.000Z", detail: { label: "approved" } });
  });

  it("records a reviewer approving their own import as a self-approval", async () => {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D01") }, REVIEWER_ACTOR);
    const claim = await chasClaim(desk.db, "SC-D01");

    await act(desk.deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);

    expect(await chasClaim(desk.db, "SC-D01")).toMatchObject({ status: "approved", selfApproved: true });
    const trail = await audit.list(desk.db, { type: "claim", id: claim.id });
    expect(trail.at(-1)?.detail).toMatchObject({ label: "approved (self-approval)" });
  });

  it("refuses an officer's approval and leaves the claim and its audit trail as they were", async () => {
    const { db, deps, claim } = await d01Desk();
    const before = await audit.list(db, { type: "claim", id: claim.id });

    const result = await act(deps, claim.id, { kind: "approve" }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "ready", version: claim.version });
    expect(await audit.list(db, { type: "claim", id: claim.id })).toEqual(before);
  });
});

describe("act: versions (AC-3.1)", () => {
  it("answers stale with the current version when the caller acted on an old one", async () => {
    const { deps, claim } = await d01Desk();

    const result = await act(deps, claim.id, { kind: "approve" }, claim.version - 1, REVIEWER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "stale", currentVersion: claim.version } });
  });

  it("lets one of two simultaneous approvals land, answers the other stale, and audits one approval", async () => {
    const { db, deps, claim } = await d01Desk();
    const second: Actor = { kind: "person", email: "second.reviewer@example.test", roles: ["reviewer"] };

    const results = await Promise.all([
      act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR),
      act(deps, claim.id, { kind: "approve" }, claim.version, second),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: { code: "stale", currentVersion: claim.version + 1 } }]);
    const approvals = (await audit.list(db, { type: "claim", id: claim.id })).filter((e) => e.action === "approve");
    expect(approvals).toHaveLength(1);
  });

  it("answers not found for a claim that does not exist", async () => {
    const { deps } = await d01Desk();

    expect(await act(deps, "no-such-claim", { kind: "approve" }, 1, REVIEWER_ACTOR)).toEqual({ ok: false, error: { code: "not_found" } });
  });
});

describe("actMany: batch approval (AC-3.4, S17)", () => {
  /** D01 and the six D02 consultations: every ready claim, as the queue showed them. */
  async function readyBatch() {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: [...caseVisits("D01"), ...caseVisits("D02")] }, OFFICER_ACTOR);
    const ready = (await claims.list(desk.db, { status: ["ready"] }, { now: NOW })).items;
    return { ...desk, ready };
  }

  it("approves every selected claim, one audit event each", async () => {
    const { db, deps, ready } = await readyBatch();
    expect(ready.length).toBeGreaterThanOrEqual(5);

    const batch = await actMany(deps, ready.map((c) => ({ id: c.id, version: c.version })), { kind: "approve" }, REVIEWER_ACTOR);
    if (!batch.ok) throw new Error(batch.error.problem);
    const result = batch.value;

    expect(result.failed).toEqual([]);
    expect(result.done.map((d) => d.id).sort()).toEqual(ready.map((c) => c.id).sort());
    for (const c of ready) {
      expect(await claims.detail(db, c.id)).toMatchObject({ status: "approved", approvedBy: REVIEWER });
      expect((await audit.list(db, { type: "claim", id: c.id })).filter((e) => e.action === "approve")).toHaveLength(1);
    }
  });

  it("approves the rest and names the one that gained a blocking finding since it was selected", async () => {
    const { db, deps, ready } = await readyBatch();
    const d01 = ready.find((c) => c.visitKey === "SC-D01")!;
    // The claim date is the latest completion, so the treatments move back with the visit.
    const d01Visit = visitByKey("SC-D01");
    const late = { ...d01Visit, date: "2026-09-01" as IsoDate, treatments: d01Visit.treatments.map((t) => ({ ...t, completedOn: "2026-09-01" as IsoDate })) };
    await importVisits(deps, { source: "synthetic", visits: [late] }, OFFICER_ACTOR);

    const batch = await actMany(deps, ready.map((c) => ({ id: c.id, version: c.version })), { kind: "approve" }, REVIEWER_ACTOR);
    if (!batch.ok) throw new Error(batch.error.problem);
    const result = batch.value;

    expect(result.done).toHaveLength(ready.length - 1);
    expect(result.failed).toEqual([{ id: d01.id, error: expect.objectContaining({ code: "stale" }) }]);
    expect(await claims.detail(db, d01.id)).toMatchObject({ status: "needs_attention", approvedBy: null });
  });

  it("refuses the whole batch for an officer, and approves nothing", async () => {
    const { db, deps, ready } = await readyBatch();

    const batch = await actMany(deps, ready.map((c) => ({ id: c.id, version: c.version })), { kind: "approve" }, OFFICER_ACTOR);
    if (!batch.ok) throw new Error(batch.error.problem);
    const result = batch.value;

    expect(result.done).toEqual([]);
    expect(result.failed.map((f) => f.error.code)).toEqual(ready.map(() => "forbidden"));
    expect((await claims.list(db, { status: ["approved"] }, { now: NOW })).items).toEqual([]);
  });

  it("takes at most 50 claims, and at least one", async () => {
    const { db, deps, ready } = await readyBatch();
    const one = { id: ready[0]!.id, version: ready[0]!.version };

    const tooMany = await actMany(deps, Array.from({ length: 51 }, () => one), { kind: "approve" }, REVIEWER_ACTOR);
    const none = await actMany(deps, [], { kind: "approve" }, REVIEWER_ACTOR);

    expect(tooMany).toMatchObject({ ok: false, error: { code: "invalid", field: "items" } });
    expect(none).toMatchObject({ ok: false, error: { code: "invalid", field: "items" } });
    expect(await claims.detail(db, one.id)).toMatchObject({ status: "ready" });
  });
});

/** D01 approved by the reviewer, ready to submit through the CHAS portal. */
async function approvedD01() {
  const desk = await d01Desk();
  const approved = await act(desk.deps, desk.claim.id, { kind: "approve" }, desk.claim.version, REVIEWER_ACTOR);
  if (!approved.ok) throw new Error("approval failed");
  return { ...desk, claim: approved.value };
}

describe("act: submit (S6, AC-4.3, AC-4.4)", () => {
  it("records the portal reference, and the attempt as a checklist submission carrying no identity", async () => {
    const { db, deps, claim } = await approvedD01();

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "submitted", portalReference: "MHCP-0001", submittedRevision: claim.approvedRevision } });
    const attempts = await submissions.list(db, claim.id);
    expect(attempts).toEqual([
      expect.objectContaining({ attempt: 1, channel: "assisted", result: "checklist", portalReference: "MHCP-0001", actor: OFFICER, error: null }),
    ]);
    expect(attempts[0]!.packetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(attempts[0]!.packetMasked)).not.toMatch(/T9\d{6}[A-Z]/);
  });

  it("refuses an empty portal reference and records no attempt", async () => {
    const { db, deps, claim } = await approvedD01();

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "  " }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "invalid", field: "portalReference" } });
    expect(await submissions.list(db, claim.id)).toEqual([]);
  });

  it("refuses a portal reference already given to another CHAS claim, and leaves the claim approved", async () => {
    const { db, deps, claim } = await approvedD01();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D02") }, OFFICER_ACTOR);
    const other = await chasClaim(db, "SC-D02-P02");
    const otherApproved = await act(deps, other.id, { kind: "approve" }, other.version, REVIEWER_ACTOR);
    if (!otherApproved.ok) throw new Error("approval failed");
    await act(deps, other.id, { kind: "submit", portalReference: "MHCP-0001" }, otherApproved.value.version, OFFICER_ACTOR);

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, claim.version, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "reference_taken", portalReference: "MHCP-0001" } });
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "approved", version: claim.version });
    expect(await submissions.list(db, claim.id)).toEqual([]);
  });

  it("N5: refuses a portal reference that differs from another CHAS claim's only in case or spacing", async () => {
    const { db, deps, claim } = await approvedD01();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D02") }, OFFICER_ACTOR);
    const other = await chasClaim(db, "SC-D02-P02");
    const otherApproved = await act(deps, other.id, { kind: "approve" }, other.version, REVIEWER_ACTOR);
    if (!otherApproved.ok) throw new Error("approval failed");
    await act(deps, other.id, { kind: "submit", portalReference: "MHCP-0001" }, otherApproved.value.version, OFFICER_ACTOR);

    const result = await act(deps, claim.id, { kind: "submit", portalReference: " mhcp-0001 " }, claim.version, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "reference_taken", portalReference: "mhcp-0001" } });
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "approved", version: claim.version });
  });

  it("lets only one of two claims submitted at the same moment carry the same portal reference", async () => {
    const { db, deps, claim } = await approvedD01();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D02") }, OFFICER_ACTOR);
    const other = await chasClaim(db, "SC-D02-P02");
    const otherApproved = await act(deps, other.id, { kind: "approve" }, other.version, REVIEWER_ACTOR);
    if (!otherApproved.ok) throw new Error("approval failed");

    const results = await Promise.all([
      act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, claim.version, OFFICER_ACTOR),
      act(deps, other.id, { kind: "submit", portalReference: "MHCP-0001" }, otherApproved.value.version, OFFICER_ACTOR),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: { code: "reference_taken", portalReference: "MHCP-0001" } }]);
    const statuses = [(await chasClaim(db, "SC-D01")).status, (await chasClaim(db, "SC-D02-P02")).status].sort();
    expect(statuses).toEqual(["approved", "submitted"]);
    const attempts = [...(await submissions.list(db, claim.id)), ...(await submissions.list(db, other.id))];
    expect(attempts.map((a) => a.portalReference)).toEqual(["MHCP-0001"]);
  });

  it("lets a claim sent again keep the portal reference it was first given", async () => {
    const { db, deps, claim } = await approvedD01();
    await submissions.submissionStatement(db, {
      claimId: claim.id,
      channel: "assisted",
      batchRef: null,
      packetMasked: {},
      packetHash: "h",
      result: "checklist",
      portalReference: "MHCP-0001",
      error: null,
      actor: OFFICER,
      at: "2026-11-13T01:00:00.000Z",
    }).run();

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "submitted", portalReference: "MHCP-0001" } });
  });

  it("records a portal refusal as a failed attempt and marks the claim rejected with no reference", async () => {
    const { db, deps, claim } = await approvedD01();

    const result = await act(deps, claim.id, { kind: "portal_refused", message: "Member not eligible on visit date" }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "rejected", portalReference: null } });
    expect(await submissions.list(db, claim.id)).toEqual([
      expect.objectContaining({ attempt: 1, result: "failed", portalReference: null, error: "Member not eligible on visit date" }),
    ]);
  });
});

describe("recordFailedSubmission (S6, AC-4.6)", () => {
  it("records a send that never got an answer as a failed attempt, and leaves the claim approved", async () => {
    const { db, deps, claim } = await approvedD01();

    const result = await recordFailedSubmission(deps, claim.id, OFFICER_ACTOR, { error: "The payer did not answer within 10 seconds" });

    expect(result).toMatchObject({ ok: true, value: { status: "approved", portalReference: null } });
    expect(await submissions.list(db, claim.id)).toEqual([
      expect.objectContaining({ attempt: 1, channel: "assisted", result: "failed", error: "The payer did not answer within 10 seconds", actor: OFFICER }),
    ]);
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.at(-1)).toMatchObject({ action: "submission_failed", actor: OFFICER, detail: { attempt: 1, channel: "assisted" } });
    expect(JSON.stringify(trail.at(-1)?.detail)).not.toContain("10 seconds");
  });

  it("refuses to record an attempt on a claim that is not approved", async () => {
    const { db, deps, claim } = await d01Desk();

    expect(await recordFailedSubmission(deps, claim.id, OFFICER_ACTOR, { error: "Timed out" })).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await submissions.list(db, claim.id)).toEqual([]);
  });
});

describe("deadlines on approval and submission (AC-3.5, decisions-g2 #5)", () => {
  const TOMORROW = NOW + 24 * 60 * 60 * 1000;

  /** D08b: scaling on the last day of its 30-day CHAS window. */
  async function d08bDesk() {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D08b") }, OFFICER_ACTOR);
    return { ...desk, claim: await chasClaim(desk.db, "SC-D08b") };
  }

  it("shows an approved claim as past the window once the day after its deadline comes", async () => {
    const { db, deps, claim } = await d08bDesk();
    expect(claim.status).toBe("ready");
    await act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);

    await recheckDeadlines({ ...deps, now: TOMORROW }, OFFICER_ACTOR);

    const after = await chasClaim(db, "SC-D08b");
    expect(after).toMatchObject({ status: "needs_attention", approvedBy: null });
    expect(after.findings.map((f) => f.code)).toContain("past_submission_window");
  });

  it("refuses to approve a claim whose window closed since it was built, and shows it as past the window", async () => {
    const { db, deps, claim } = await d08bDesk();

    const result = await act({ ...deps, now: TOMORROW }, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const after = await chasClaim(db, "SC-D08b");
    expect(after.status).toBe("needs_attention");
    expect(after.findings.map((f) => f.code)).toContain("past_submission_window");
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.map((e) => e.action)).not.toContain("approve");
    expect(trail.at(-1)).toMatchObject({ action: "rebuilt", detail: { reason: "deadline" } });
  });

  it("refuses to record a submission once the window has closed, and clears the approval", async () => {
    const { db, deps, claim } = await d08bDesk();
    await act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);
    const approved = await chasClaim(db, "SC-D08b");

    const result = await act({ ...deps, now: TOMORROW }, claim.id, { kind: "submit", portalReference: "CHAS-8801" }, approved.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await chasClaim(db, "SC-D08b")).toMatchObject({ status: "needs_attention", portalReference: null, approvedBy: null });
    expect(await submissions.list(db, claim.id)).toEqual([]);
  });

  it("N6: drops the submit-soon warning once the claim is submitted, in its detail and in the queue", async () => {
    const { db, deps, claim } = await d08bDesk();
    expect(claim.findings.map((f) => f.code)).toContain("deadline_approaching");
    await act(deps, claim.id, { kind: "approve" }, claim.version, REVIEWER_ACTOR);
    const approved = await chasClaim(db, "SC-D08b");

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0008" }, approved.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "submitted" } });
    expect((await chasClaim(db, "SC-D08b")).findings.map((f) => f.code)).not.toContain("deadline_approaching");
    const row = (await claims.list(db, { status: ["submitted"] }, { now: NOW })).items.find((r) => r.id === claim.id);
    expect(row?.findings.map((f) => f.code)).not.toContain("deadline_approaching");
  });
});

describe("act: reopen rebuilds the visit (decisions-g2 §2)", () => {
  it("rebuilds a reopened claim from the visit's current revision, recorded as a lifecycle rebuild", async () => {
    const { db, deps, claim } = await approvedD01();
    const refused = await act(deps, claim.id, { kind: "portal_refused", message: "Member not eligible on visit date" }, claim.version, OFFICER_ACTOR);
    if (!refused.ok) throw new Error("refusal failed");
    const revised = { ...visitByKey("SC-D01"), notes: "Revised after the refusal" };
    await importVisits(deps, { source: "connector", visits: [revised] }, CONNECTOR_ACTOR);
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "rejected", builtFromRevision: 1 });

    const result = await act(deps, claim.id, { kind: "reopen" }, refused.value.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "ready", builtFromRevision: 2, rejectionReason: null } });
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.slice(-2)).toMatchObject([
      { action: "reopen", actor: OFFICER },
      { action: "rebuilt", actor: OFFICER, detail: { revision: 2, reason: "lifecycle", from: "ready", to: "ready" } },
    ]);
  });
});

describe("saveAnnotations (AC-2.8, technical PUT annotations)", () => {
  const JUSTIFICATION = "Extended consultation for a complex medical history.";

  async function d18Desk() {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D18") }, OFFICER_ACTOR);
    return { ...desk, claim: await chasClaim(desk.db, "SC-D18") };
  }

  it("clears the benchmark finding once a justification of 20 characters is saved, and audits the field names only", async () => {
    const { db, deps, claim } = await d18Desk();
    expect(claim).toMatchObject({ status: "needs_attention", findings: [expect.objectContaining({ code: "benchmark_exceeded" })] });

    const result = await saveAnnotations(deps, claim.id, { justification: JUSTIFICATION }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "ready", annotations: { justification: JUSTIFICATION } } });
    if (!result.ok) return;
    expect(result.value.findings.map((f) => f.code)).not.toContain("benchmark_exceeded");
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.slice(-2)).toMatchObject([
      { action: "annotations_saved", actor: OFFICER, detail: { fields: ["justification"] } },
      { action: "rebuilt", detail: { reason: "annotations", from: "needs_attention", to: "ready" } },
    ]);
    expect(JSON.stringify(trail)).not.toContain("complex medical history");
  });

  it("keeps the finding for a justification under 20 characters", async () => {
    const { deps, claim } = await d18Desk();

    const result = await saveAnnotations(deps, claim.id, { justification: "Longer visit." }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "needs_attention", findings: [expect.objectContaining({ code: "benchmark_exceeded" })] } });
  });

  it("N7: clears pre_auth_missing once a pre-auth reference is saved on the claim", async () => {
    const desk = await configuredDesk();
    await importVisits(desk.deps, { source: "synthetic", visits: caseVisits("D16") }, OFFICER_ACTOR);
    const claim = (await claims.forVisit(desk.db, "SC-D16")).find((c) => c.payerId === "HARBOUR");
    if (!claim) throw new Error("no Harbour claim for SC-D16");
    expect(claim).toMatchObject({ status: "needs_attention", findings: [expect.objectContaining({ code: "pre_auth_missing" })] });

    const result = await saveAnnotations(desk.deps, claim.id, { preAuthReference: "PA-0016" }, claim.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "ready", annotations: { preAuthReference: "PA-0016" } } });
    if (!result.ok) return;
    expect(result.value.findings.map((f) => f.code)).not.toContain("pre_auth_missing");
  });

  it("refuses a stale version and leaves the claim and its trail as they were", async () => {
    const { db, deps, claim } = await d18Desk();
    const before = await audit.list(db, { type: "claim", id: claim.id });

    const result = await saveAnnotations(deps, claim.id, { justification: JUSTIFICATION }, claim.version - 1, OFFICER_ACTOR);

    expect(result).toEqual({ ok: false, error: { code: "stale", currentVersion: claim.version } });
    expect(await claims.detail(db, claim.id)).toMatchObject({ version: claim.version, annotations: {} });
    expect(await audit.list(db, { type: "claim", id: claim.id })).toEqual(before);
  });

  it("refuses annotations on a claim already sent to its payer", async () => {
    const { deps, claim } = await approvedD01();
    const sent = await act(deps, claim.id, { kind: "submit", portalReference: "CHAS-0001" }, claim.version, OFFICER_ACTOR);
    if (!sent.ok) throw new Error("submit failed");

    const result = await saveAnnotations(deps, claim.id, { preAuthReference: "PA-1" }, sent.value.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } });
  });

  it("refuses a field it does not know, or a value too long to be a reference", async () => {
    const { deps, claim } = await d18Desk();

    const unknown = await saveAnnotations(deps, claim.id, { diagnosis: "x" } as never, claim.version, OFFICER_ACTOR);
    const long = await saveAnnotations(deps, claim.id, { preAuthReference: "R".repeat(81) }, claim.version, OFFICER_ACTOR);

    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid", field: "diagnosis" } });
    expect(long).toMatchObject({ ok: false, error: { code: "invalid", field: "preAuthReference" } });
  });
});

const SECOND_OFFICER: Actor ={ kind: "person", email: "second.officer@example.test", roles: ["officer"] };
const HALF_HOUR = 30 * 60_000;

describe("checkout (S6)", () => {
  it("marks an approved claim as being submitted by the officer for 30 minutes, and audits it", async () => {
    const { db, deps, claim } = await approvedD01();

    const result = await checkout(deps, claim.id, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { checkoutBy: OFFICER, checkoutUntil: "2026-11-13T02:30:00.000Z" } });
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.at(-1)).toMatchObject({ actor: OFFICER, action: "checkout", detail: { until: "2026-11-13T02:30:00.000Z" } });
  });

  it("refuses another officer's submit while the checkout holds", async () => {
    const { deps, claim } = await approvedD01();
    const held = await checkout(deps, claim.id, OFFICER_ACTOR);
    if (!held.ok) throw new Error("checkout failed");

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, held.value.version, SECOND_OFFICER);

    expect(result).toEqual({ ok: false, error: { code: "checked_out", by: OFFICER, until: "2026-11-13T02:30:00.000Z" } });
  });

  it("lets the holder submit, and clears the checkout", async () => {
    const { deps, claim } = await approvedD01();
    const held = await checkout(deps, claim.id, OFFICER_ACTOR);
    if (!held.ok) throw new Error("checkout failed");

    const result = await act(deps, claim.id, { kind: "submit", portalReference: "MHCP-0001" }, held.value.version, OFFICER_ACTOR);

    expect(result).toMatchObject({ ok: true, value: { status: "submitted", checkoutBy: null, checkoutUntil: null } });
  });

  it("refuses a second officer's checkout while it holds, and lets them take it over", async () => {
    const { db, deps, claim } = await approvedD01();
    await checkout(deps, claim.id, OFFICER_ACTOR);

    expect(await checkout(deps, claim.id, SECOND_OFFICER)).toEqual({
      ok: false,
      error: { code: "checked_out", by: OFFICER, until: "2026-11-13T02:30:00.000Z" },
    });
    const taken = await takeOver({ ...deps, now: deps.now + 60_000 }, claim.id, SECOND_OFFICER);

    expect(taken).toMatchObject({ ok: true, value: { checkoutBy: "second.officer@example.test", checkoutUntil: "2026-11-13T02:31:00.000Z" } });
    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.at(-1)).toMatchObject({ actor: "second.officer@example.test", action: "checkout_taken_over", detail: { from: OFFICER } });
  });

  it("lets another officer check out once the 30 minutes have run out", async () => {
    const { deps, claim } = await approvedD01();
    await checkout(deps, claim.id, OFFICER_ACTOR);

    const later = await checkout({ ...deps, now: deps.now + HALF_HOUR }, claim.id, SECOND_OFFICER);

    expect(later).toMatchObject({ ok: true, value: { checkoutBy: "second.officer@example.test" } });
  });

  it("drops the hold with the approval when the claim is withdrawn (Sec-2)", async () => {
    const { db, deps, claim } = await approvedD01();
    const held = await checkout(deps, claim.id, OFFICER_ACTOR);
    if (!held.ok) throw new Error("checkout failed");

    const result = await act(deps, claim.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, held.value.version, REVIEWER_ACTOR);

    expect(result.ok).toBe(true);
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ status: "withdrawn", approvedBy: null, approvedRevision: null, checkoutBy: null, checkoutUntil: null });
  });

  it("drops the hold with the approval when a changed visit clears it", async () => {
    const { db, deps, claim } = await approvedD01();
    await checkout(deps, claim.id, OFFICER_ACTOR);
    const v1 = visitByKey("SC-D01");
    const v2 = { ...v1, treatments: v1.treatments.map((t) => ({ ...t, feeCents: cents(t.feeCents + 500) })) };

    await importVisits(deps, { source: "synthetic", visits: [v2] }, OFFICER_ACTOR);

    expect(await chasClaim(db, "SC-D01")).toMatchObject({ approvedBy: null, checkoutBy: null, checkoutUntil: null });
  });

  it("refuses to check out a claim that is not approved", async () => {
    const { db, deps, claim } = await d01Desk();

    expect(await checkout(deps, claim.id, OFFICER_ACTOR)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await chasClaim(db, "SC-D01")).toMatchObject({ checkoutBy: null, version: claim.version });
  });
});

describe("reveal (S11, AC-3.6)", () => {
  it("answers one identity field to an officer, and records which field was revealed but not its value", async () => {
    const { db, deps, claim } = await d01Desk();
    const nric = visitByKey("SC-D01").patient.nric;

    const result = await reveal(deps, claim.id, "nric", OFFICER_ACTOR);

    expect(result).toEqual({ ok: true, value: nric });
    const last = (await audit.list(db, { type: "claim", id: claim.id })).at(-1);
    expect(last).toMatchObject({ action: "revealed", actor: OFFICER, detail: { field: "nric" } });
    expect(JSON.stringify(last)).not.toContain(nric);
  });

  it("answers a reviewer too", async () => {
    const { deps, claim } = await d01Desk();
    expect(await reveal(deps, claim.id, "name", REVIEWER_ACTOR)).toEqual({ ok: true, value: visitByKey("SC-D01").patient.name });
  });

  it("returns nothing when the reveal cannot be recorded", async () => {
    const { db, deps, claim } = await d01Desk();
    await db.prepare("CREATE TRIGGER audit_down BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit down'); END").run();

    await expect(reveal(deps, claim.id, "nric", OFFICER_ACTOR)).rejects.toThrow(/audit down/);
  });

  it("refuses a field the visit has no value for, and records no reveal", async () => {
    const { db, deps, claim } = await d01Desk();
    const before = await audit.list(db, { type: "claim", id: claim.id });

    expect(await reveal(deps, claim.id, "account_holder_nric", REVIEWER_ACTOR)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(await audit.list(db, { type: "claim", id: claim.id })).toHaveLength(before.length);
  });

  it("reveals nothing to a system actor", async () => {
    const { deps, claim } = await d01Desk();
    expect(await reveal(deps, claim.id, "name", CONNECTOR_ACTOR)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("answers not_found for an unknown claim", async () => {
    const { deps } = await d01Desk();
    expect(await reveal(deps, "no-such-claim", "name", OFFICER_ACTOR)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

/** D01 with a second payer: a Meridian insurance claim of $20.00 on the scaling, written straight through the repo. */
async function twoPayerD01() {
  const desk = await d01Desk();
  const chas = desk.claim;
  const at = new Date(NOW).toISOString();
  const draft = {
    payerId: "MERIDIAN" as PayerId,
    scheme: "insurance" as const,
    ruleSetId: "meridian-test",
    lines: [{ lineNo: 1, treatmentRef: 1, schemeCode: "M-SCALE", tooth: null, quantity: 1, feeCents: cents(6000), consideredCents: cents(6540), claimedCents: cents(2000) }],
    feeCents: cents(6000),
    claimedCents: cents(2000),
    findings: [],
    deadline: null,
    claimDate: chas.visitDate,
    status: "ready" as const,
  };
  const visit = {
    visitKey: chas.visitKey,
    branchId: chas.branchId,
    patientHash: chas.patientHash,
    patientMask: chas.patientMask,
    visitDate: chas.visitDate,
    revision: chas.builtFromRevision,
  };
  const meridianId = crypto.randomUUID();
  const { statements } = claims.upsertBuiltStatements(desk.db, [{ nonce: crypto.randomUUID(), at, visit, draft, status: "ready", id: meridianId }]);
  await desk.db.batch(statements);
  return { ...desk, meridianId };
}

describe("claimDetail (AC-3.7)", () => {
  it("shows each line's clinic code, scheme code, considered fee and claimed amount, the rule set, the waterfall and the source revision", async () => {
    const { deps, claim, meridianId } = await twoPayerD01();

    const detail = await claimDetail(deps, claim.id, OFFICER_ACTOR);
    if (!detail) throw new Error("no detail");

    expect(detail.lines.map((l) => [l.clinicCode, l.schemeCode, l.consideredCents])).toEqual([
      ["CON", "CONSULTATION", 3052],
      ["SCL", "SCALING", 6540],
    ]);
    expect(detail.lines.map((l) => l.claimedCents)).toEqual(claim.lines.map((l) => l.claimedCents));
    expect(detail.claim.ruleSetId).toBe(claim.ruleSetId);
    expect(detail.claim.ruleSetId).not.toBe(claims.NO_RULE_SET);
    expect(detail.revision).toEqual({ builtFrom: 1, current: 1 });
    // SC7.5: where each amount's rules came from, and when they were read.
    expect(detail.ruleSet).toMatchObject({ id: "chas-2025-10-01", effectiveFrom: "2025-10-01", effectiveTo: null });
    expect(detail.ruleSet?.sources).toContainEqual({ url: "https://www.chas.sg/chas-dental-subsidies", retrieved: "2026-11-13" });
    expect(detail.payerName).toBe("CHAS");
    expect(detail.siblings).toEqual([
      { id: meridianId, payerId: "MERIDIAN", payerName: "Meridian Dental Plan", scheme: "insurance", status: "ready", claimedCents: 2000 },
    ]);

    // The visit's bill: $30.52 consultation and $65.40 scaling, GST in.
    const visitTotal = 9592;
    expect(detail.split).toEqual({
      feeCents: visitTotal,
      segments: [
        { payer: "CHAS", label: "CHAS", cents: claim.claimedCents, claimId: claim.id },
        { payer: "MERIDIAN", label: "Meridian Dental Plan", cents: 2000, claimId: meridianId },
        { payer: "patient", label: "Patient", cents: visitTotal - claim.claimedCents - 2000 },
      ],
    });
  });

  it("N3: a frozen claim's split keeps its own share as built when the waterfall changes after it", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D04b") }, OFFICER_ACTOR);
    const flexi = (await claims.forVisit(db, "SC-D04b")).find((c) => c.scheme === "medisave_flexi")!;
    expect(flexi.claimedCents).toBe(40000);
    const withdrawn = await act(deps, flexi.id, { kind: "withdraw", reason: "Patient chose to pay this part." }, flexi.version, REVIEWER_ACTOR);
    expect(withdrawn.ok).toBe(true);
    const insurerFirst = { ...CLINIC.settings, waterfall: ["chas", "insurance", "medisave"] as typeof CLINIC.settings.waterfall };
    expect(await saveSettings(deps, insurerFirst, 1, REVIEWER_ACTOR)).toMatchObject({ kind: "saved", body: { rebuild: { next: null } } });

    const detail = (await claimDetail(deps, flexi.id, OFFICER_ACTOR))!;

    expect(detail.frozenOn).not.toBeNull();
    const own = detail.split.segments.find((s) => s.claimId === flexi.id);
    expect(own?.cents).toBe(40000);
    expect(detail.split.feeCents).toBe(130800);
    // The other payers were rebuilt without this claim, so the rest of the bill is one remainder,
    // never today's figures for them beside this claim's share as built.
    expect(detail.split.segments).toEqual([own, { payer: "rest", label: "Rest of the bill", cents: 90800 }]);
  });

  it("B1: a submitted CHAS claim with its other payers still pending shows the visit's full split, the patient last", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D04b") }, OFFICER_ACTOR);
    const chas = await submitted(deps, db, "chas", "MHCP-0041");
    const [flexi, meridian] = await Promise.all([schemeClaim(db, "medisave_flexi"), schemeClaim(db, "insurance")]);
    expect([flexi.status, meridian.status]).toEqual(["ready", "ready"]);

    const detail = (await claimDetail(deps, chas.id, OFFICER_ACTOR))!;

    expect(detail.split).toEqual({
      feeCents: 130800,
      segments: [
        { payer: "CHAS", label: "CHAS", cents: 62000, claimId: chas.id },
        { payer: flexi.payerId, label: expect.any(String), cents: 40000, claimId: flexi.id },
        { payer: "MERIDIAN", label: "Meridian Dental Plan", cents: 28800, claimId: meridian.id },
        { payer: "patient", label: "Patient", cents: 0 },
      ],
    });
  });

  it("SP1: two frozen claims beside a pending one each show the full split while the settings are unchanged", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D04b") }, OFFICER_ACTOR);
    const chas = await submitted(deps, db, "chas", "MHCP-0042");
    const flexi = await submitted(deps, db, "medisave_flexi", "MHCP-0043");
    const meridian = await schemeClaim(db, "insurance");

    const fromChas = (await claimDetail(deps, chas.id, OFFICER_ACTOR))!.split;
    const fromFlexi = (await claimDetail(deps, flexi.id, OFFICER_ACTOR))!.split;

    expect(fromChas.segments.map((s) => [s.claimId ?? s.payer, s.cents])).toEqual([
      [chas.id, 62000],
      [flexi.id, 40000],
      [meridian.id, 28800],
      ["patient", 0],
    ]);
    expect(fromFlexi).toEqual(fromChas);
  });

  it("SP1: two frozen claims beside a pending one keep their own amounts once the waterfall changes, the insurer on what they left", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D04b") }, OFFICER_ACTOR);
    const chas = await submitted(deps, db, "chas", "MHCP-0044");
    const flexi = await submitted(deps, db, "medisave_flexi", "MHCP-0045");
    const meridian = await schemeClaim(db, "insurance");
    const insurerFirst = { ...CLINIC.settings, waterfall: ["chas", "insurance", "medisave"] as typeof CLINIC.settings.waterfall };
    expect(await saveSettings(deps, insurerFirst, 1, REVIEWER_ACTOR)).toMatchObject({ kind: "saved" });
    // Under today's order the pending insurer comes before MediSave, but both sent claims come off
    // the visit first (QA 03 D01), so the insurer is rebuilt on what they left and today's split
    // still gives each sent claim what it claimed. Before that fix the insurer took $688.00 and
    // this split fell back to a remainder.

    const fromChas = (await claimDetail(deps, chas.id, OFFICER_ACTOR))!.split;
    const fromFlexi = (await claimDetail(deps, flexi.id, OFFICER_ACTOR))!.split;

    expect(fromChas.segments.map((s) => [s.claimId ?? s.payer, s.cents])).toEqual([
      [chas.id, 62000],
      [meridian.id, 28800],
      [flexi.id, 40000],
      ["patient", 0],
    ]);
    expect(fromFlexi).toEqual(fromChas);
    expect(fromChas.feeCents).toBe(130800);
  });

  it("a frozen claim whose siblings are all frozen with it shows each at its claimed amount and the patient last", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "synthetic", visits: caseVisits("D01") }, OFFICER_ACTOR);
    const onVisit = await claims.forVisit(db, "SC-D01");
    for (const c of onVisit) {
      const done = await act(deps, c.id, { kind: "withdraw", reason: "Patient paid in full at the counter." }, c.version, REVIEWER_ACTOR);
      expect(done.ok).toBe(true);
    }
    const chas = onVisit.find((c) => c.scheme === "chas")!;

    const detail = (await claimDetail(deps, chas.id, OFFICER_ACTOR))!;

    // Only this claim is in its own frozen bill: the withdrawn sibling claims nothing any more,
    // and nothing else on the visit is open, so the remainder is the patient's.
    expect(detail.split.segments).toEqual([
      { payer: "CHAS", label: "CHAS", cents: chas.claimedCents, claimId: chas.id },
      { payer: "patient", label: "Patient", cents: 9592 - chas.claimedCents },
    ]);
  });

  it("carries the masked patient but never the patient hash or the NRIC", async () => {
    const { deps, claim } = await d01Desk();

    const detail = await claimDetail(deps, claim.id, OFFICER_ACTOR);

    expect(detail?.claim.patientMask).toBe(claim.patientMask);
    expect(JSON.stringify(detail)).not.toContain(claim.patientHash);
    expect(JSON.stringify(detail)).not.toContain(visitByKey("SC-D01").patient.nric);
  });

  it("offers approve to a reviewer and not to an officer", async () => {
    const { deps, claim } = await d01Desk();

    expect((await claimDetail(deps, claim.id, REVIEWER_ACTOR))?.actions).toContain("approve");
    expect((await claimDetail(deps, claim.id, OFFICER_ACTOR))?.actions).not.toContain("approve");
  });

  it("lists the claim's audit trail and its submissions", async () => {
    const { deps, claim } = await d01Desk();

    const detail = await claimDetail(deps, claim.id, OFFICER_ACTOR);

    expect(detail?.audit.map((e) => e.action)).toEqual(["built"]);
    expect(detail?.submissions).toEqual([]);
  });

  it("shows the deadline worked out for today while the claim is on the desk", async () => {
    const { deps, claim } = await d01Desk();

    const detail = await claimDetail(deps, claim.id, OFFICER_ACTOR);

    // D01 was three days before today, and CHAS gives thirty days from the visit.
    expect(detail?.deadline).toMatchObject({ daysLeft: 27, warning: false, windowDays: 30 });
  });

  it("answers null for an unknown claim", async () => {
    const { deps } = await d01Desk();
    expect(await claimDetail(deps, "no-such-claim", OFFICER_ACTOR)).toBeNull();
  });
});

describe("the audit trail end to end (AC-3.6)", () => {
  const HOUR = 3_600_000;

  it("records import, approval, reveal, submission, acceptance and payment in order, each with its actor and time", async () => {
    const { db, deps, claim } = await d01Desk();
    const at = (hours: number) => ({ ...deps, now: NOW + hours * HOUR });
    const version = async () => (await chasClaim(db, "SC-D01")).version;

    expect((await act(at(1), claim.id, { kind: "approve" }, await version(), REVIEWER_ACTOR)).ok).toBe(true);
    expect((await reveal(at(2), claim.id, "nric", OFFICER_ACTOR)).ok).toBe(true);
    expect((await act(at(3), claim.id, { kind: "submit", portalReference: "MHCP-0001" }, await version(), OFFICER_ACTOR)).ok).toBe(true);
    expect((await act(at(4), claim.id, { kind: "accept" }, await version(), OFFICER_ACTOR)).ok).toBe(true);
    const payment = { kind: "record_payment", cents: cents(5050), paidOn: "2026-11-20" as IsoDate } as const;
    expect((await act(at(5), claim.id, payment, await version(), OFFICER_ACTOR)).ok).toBe(true);

    const trail = await audit.list(db, { type: "claim", id: claim.id });
    expect(trail.map(({ action, actor, at: when }) => ({ action, actor, at: when }))).toEqual([
      { action: "built", actor: OFFICER, at: "2026-11-13T02:00:00.000Z" },
      { action: "approve", actor: REVIEWER, at: "2026-11-13T03:00:00.000Z" },
      { action: "revealed", actor: OFFICER, at: "2026-11-13T04:00:00.000Z" },
      { action: "submit", actor: OFFICER, at: "2026-11-13T05:00:00.000Z" },
      { action: "accept", actor: OFFICER, at: "2026-11-13T06:00:00.000Z" },
      { action: "record_payment", actor: OFFICER, at: "2026-11-13T07:00:00.000Z" },
    ]);
    expect((await chasClaim(db, "SC-D01")).status).toBe("paid");
  });

  it("refuses to change or remove an event once it is on the trail", async () => {
    const { db, claim } = await d01Desk();
    const [built] = await audit.list(db, { type: "claim", id: claim.id });

    await expect(db.prepare("UPDATE audit_events SET actor = 'someone@else' WHERE id = ?").bind(built!.id).run()).rejects.toThrow(/append-only/);
    await expect(db.prepare("DELETE FROM audit_events WHERE id = ?").bind(built!.id).run()).rejects.toThrow(/append-only/);
    expect(await audit.list(db, { type: "claim", id: claim.id })).toEqual([built]);
  });
});

describe("sent claims that pass the fee once the visit is re-imported (QA 03 B1)", () => {
  /** D04b with every treatment at half its fee: $708.00 in all, less than the $1,308.00 already claimed. */
  const halved = () => {
    const v = visitByKey("SC-D04b");
    return { ...v, treatments: v.treatments.map((t) => ({ ...t, feeCents: cents(Math.round(t.feeCents / 2)) })) };
  };
  const overFee = (sentCents: number) => expect.objectContaining({ code: "sent_claims_exceed_fee", severity: "blocking", params: { sentCents, feeCents: 70800 } });

  it("shows the finding on every sent claim's page, though each was built from the earlier revision", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D04b")] }, CONNECTOR_ACTOR);
    const sent = [await submitted(deps, db, "chas", "MHCP-0051"), await submitted(deps, db, "medisave_flexi", "MHCP-0052"), await submitted(deps, db, "insurance", "MHCP-0053")];
    expect(sent.map((c) => c.claimedCents)).toEqual([62000, 40000, 28800]);

    await importVisits(deps, { source: "connector", visits: [halved()] }, CONNECTOR_ACTOR);

    for (const c of sent) {
      const detail = (await claimDetail(deps, c.id, OFFICER_ACTOR))!;
      expect(detail.revision, c.payerId).toEqual({ builtFrom: 1, current: 2 });
      expect(detail.visit.findings, c.payerId).toContainEqual(overFee(130800));
    }
  });

  it("holds the claim still to send: blocking, counted in the queue, and refused for approval and submission", async () => {
    const { db, deps } = await configuredDesk();
    await importVisits(deps, { source: "connector", visits: [visitByKey("SC-D04b")] }, CONNECTOR_ACTOR);
    const chas = await submitted(deps, db, "chas", "MHCP-0054");
    await submitted(deps, db, "medisave_flexi", "MHCP-0055");

    await importVisits(deps, { source: "connector", visits: [halved()] }, CONNECTOR_ACTOR);

    const meridian = await schemeClaim(db, "insurance");
    expect(meridian).toMatchObject({ status: "needs_attention", claimedCents: 0 });
    expect(meridian.findings).toContainEqual(overFee(102000));
    const row = (await claims.list(db, { status: ["needs_attention"] }, { now: NOW })).items.find((r) => r.id === meridian.id);
    expect(row?.blockingCount).toBeGreaterThanOrEqual(1);
    expect(await act(deps, meridian.id, { kind: "approve" }, meridian.version, REVIEWER_ACTOR)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(await act(deps, meridian.id, { kind: "submit", portalReference: "MHCP-0056" }, meridian.version, OFFICER_ACTOR)).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    // The page says it once, on the claim, not again as a visit remark.
    const detail = (await claimDetail(deps, meridian.id, OFFICER_ACTOR))!;
    expect(detail.visit.findings.filter((f) => f.code === "sent_claims_exceed_fee")).toEqual([]);
    // The sent CHAS claim's page shows why the insurer is held.
    expect((await claimDetail(deps, chas.id, OFFICER_ACTOR))!.visit.findings).toContainEqual(overFee(102000));
  });
});
