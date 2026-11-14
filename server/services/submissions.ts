/**
 * Submitting approved claims (ticket 07): each claim's packet built from the payer's template, and the
 * send down the claim's channel. The lifecycle moves themselves go through the claims service's `act`,
 * so the checkout, the reference check and the audit trail stay in one place.
 */
import type { ProblemBody } from "../../src/api/common";
import type { ConfirmExportResponse, PacketView, SentResult, SimulatorDecision, SimulatorItem, SubmitGroup, SubmitResponse } from "../../src/api/submissions";
import { deadlineState, type DeadlineState } from "../../src/domain/claims/build";
import type { ClaimState } from "../../src/domain/claims/state";
import { sgtDay } from "../../src/domain/dates";
import { cents, subtract } from "../../src/domain/money";
import { buildPacket, cellText, type ClaimForPacket, type ClaimPacket, type PayerTemplate } from "../../src/domain/packet";
import { err, ok, type Result } from "../../src/domain/result";
import type { DeskSettings, PayerSettings } from "../../src/domain/settings";
import { canonicalJson, type VisitIdentity } from "../../src/domain/source-visit";
import { type Actor, actorId, type Channel, type ClaimAction, type SimState } from "../../src/domain/types";
import { sha256Hex } from "../bytes";
import { channelFor, type Outgoing } from "../channels";
import { actErrorBody } from "../claim-http";
import type { IdentifierKeys } from "../crypto";
import type { Env } from "../env";
import * as audit from "../repo/audit";
import * as claims from "../repo/claims";
import * as settingsRepo from "../repo/settings";
import * as simulator from "../repo/simulator";
import * as submissionsRepo from "../repo/submissions";
import type { SimClaim } from "../repo/simulator";
import { clinicalAt, loadIdentity } from "../repo/visits";
import { act, type ActError, checkout, recordFailedSubmission, takeOver } from "./claims";
import { same as sameDeadline } from "./deadlines";
import { RebuildConflictError, rebuildVisits } from "./rebuild";

/** Everything a packet is built from, read once. */
export interface PacketSource {
  claim: ClaimState;
  settings: DeskSettings;
  payer: PayerSettings | null;
  channel: Channel;
  input: ClaimForPacket;
  template: PayerTemplate;
}

export async function packetSource(db: D1Database, claimId: string): Promise<PacketSource | null> {
  const claim = await claims.detail(db, claimId);
  if (!claim) return null;
  const { settings } = await settingsRepo.get(db);
  return sourceFor(db, claim, settings);
}

export async function sourceFor(db: D1Database, claim: ClaimState, settings: DeskSettings): Promise<PacketSource> {
  const clinical = await clinicalAt(db, claim.visitKey, claim.builtFromRevision);
  const payer = settings.payers.find((p) => p.id === claim.payerId) ?? null;
  const branchName = settings.branches.find((b) => b.id === clinical?.branchId)?.name ?? clinical?.branchId ?? "";
  const dentistName = settings.dentists.find((d) => d.id === clinical?.dentistId)?.name ?? clinical?.dentistId ?? "";
  return {
    claim,
    settings,
    payer,
    channel: claim.channel ?? payer?.channel ?? "assisted",
    input: { claim, clinical: clinical ?? { treatments: [], policies: [], medisave: null }, branchName, dentistName },
    template: { payerId: claim.payerId, fields: payer?.templateFields ?? [] },
  };
}

/** The packet with identity open: only for a send, an export or a reveal. */
export function openPacket(source: PacketSource, identity: VisitIdentity): ClaimPacket {
  return buildPacket(source.input, source.template, identity);
}

/** `GET /api/claims/:id/packet`: the masked packet in the payer's order, with who holds the claim. */
export async function packetView(deps: { db: D1Database; now: number }, claimId: string): Promise<PacketView | null> {
  const source = await packetSource(deps.db, claimId);
  if (!source) return null;
  const { claim } = source;
  const packet = buildPacket(source.input, source.template, null);
  const held = claim.checkoutBy !== null && claim.checkoutUntil !== null && Date.parse(claim.checkoutUntil) > deps.now;
  return {
    claimId: claim.id,
    payerId: claim.payerId,
    payerName: source.payer?.name ?? claim.payerId,
    channel: source.channel,
    status: claim.status,
    version: claim.version,
    portalReference: claim.portalReference,
    portalUrl: source.payer?.portalUrl ?? null,
    checkout: held ? { by: claim.checkoutBy!, until: claim.checkoutUntil! } : null,
    fields: packet.fields.map((f) => ({ key: f.key, label: f.label, text: cellText(f.value), masked: f.masked, revealField: f.identityField })),
  };
}

/**
 * An officer opens an approved claim's checklist: hold it for them (or, once they confirm, take it
 * over from whoever holds it) and answer the masked packet they will work from (AC-4.8).
 */
export async function holdForChecklist(
  deps: { db: D1Database; now: number },
  claimId: string,
  actor: Actor,
  opts: { takeOver: boolean },
): Promise<Result<PacketView, ActError>> {
  const held = await (opts.takeOver ? takeOver : checkout)(deps, claimId, actor);
  if (!held.ok) return held;
  const view = await packetView(deps, claimId);
  return view ? ok(view) : err({ code: "not_found" });
}

export interface SubmitDeps {
  db: D1Database;
  env: Env;
  now: number;
  keys: IdentifierKeys;
  /** Whether the payer simulator runs for this request (`simulatorOn`). Off, its claims are refused. */
  simulator: boolean;
}

type Item = { id: string; version: number };
type Refusal = { id: string; status: number; error: ProblemBody };

/** A claim cleared to go: its masked packet (what the trail keeps), and what the channel sends. */
interface Ready {
  claim: ClaimState;
  payer: PayerSettings;
  channel: Channel;
  masked: { masked: ClaimPacket; hash: string };
  outgoing: Outgoing;
}

/**
 * `POST /api/submissions` (AC-4.1 to AC-4.7): sends approved claims down the channel each was approved
 * for (S15), grouped by payer and channel in the order the officer listed them. A claim that cannot go
 * is refused on its own with the body the single-claim route would answer; the rest still go.
 *
 * - `assisted` answers the checklist; the officer records each portal reference through `act`.
 * - `file` answers the payer's file and audits the export per claim. The claims stay approved until
 *   the officer confirms the upload (`confirmExport`).
 * - `api` and `simulator` send now. A claim the payer took becomes submitted with its reference; a
 *   failed send leaves it approved with the failed attempt on its trail.
 */
export async function submitClaims(deps: SubmitDeps, items: Item[], actor: Actor): Promise<SubmitResponse> {
  const { settings } = await settingsRepo.get(deps.db);
  const at = new Date(deps.now).toISOString();
  const refused: Refusal[] = [];
  const groups = new Map<string, Ready[]>();
  for (const item of items) {
    const ready = await clear(deps, settings, item, actor, at);
    if ("code" in ready) {
      refused.push(refusal(item.id, ready));
      continue;
    }
    const key = `${ready.payer.id}\u0000${ready.channel}`;
    groups.set(key, [...(groups.get(key) ?? []), ready]);
  }
  const answered: SubmitGroup[] = [];
  for (const group of groups.values()) answered.push(await sendGroup(deps, group, actor, at));
  return { groups: answered, refused };
}

/** The checks `act` would make before a submit, made before anything is sent, plus the channel's own. */
async function clear(deps: SubmitDeps, settings: DeskSettings, item: Item, actor: Actor, at: string): Promise<Ready | ActError> {
  const seen = await claims.detail(deps.db, item.id);
  if (!seen) return { code: "not_found" };
  if (seen.version !== item.version) return { code: "stale", currentVersion: seen.version };
  const claim = await withTodaysDeadline(deps, seen, actor);
  if ("code" in claim) return claim;
  if (claim.findings.some((f) => f.code === "past_submission_window")) {
    return { code: "not_allowed", detail: "This claim's CHAS submission window has closed, so it cannot be sent." };
  }
  if (claim.status !== "approved") return { code: "not_allowed", detail: `A ${claim.status.replace(/_/g, " ")} claim is not waiting to be sent.` };
  if (claim.approvedRevision !== claim.builtFromRevision) {
    return { code: "not_allowed", detail: "The visit changed after this claim was approved. Check it and approve it again." };
  }
  if (claim.checkoutBy && claim.checkoutUntil && claim.checkoutBy !== actorId(actor) && claim.checkoutUntil > at) {
    return { code: "checked_out", by: claim.checkoutBy, until: claim.checkoutUntil };
  }
  const source = await sourceFor(deps.db, claim, settings);
  if (!source.payer) return { code: "not_allowed", detail: "This claim's payer is no longer in settings." };
  if (source.channel === "simulator" && !deps.simulator) return { code: "not_allowed", detail: "The payer simulator is off on this deployment." };
  const channel = channelFor(source.channel);
  const unavailable = channel.unavailable(source.payer, deps.env);
  if (unavailable) return { code: "not_allowed", detail: unavailable };
  const masked = buildPacket(source.input, source.template, null);
  let packet = masked;
  if (channel.opensIdentity) {
    const identity = await loadIdentity(deps.db, deps.keys, claim.visitKey);
    if (!identity) return { code: "not_allowed", detail: "This visit's patient details cannot be opened, so the claim cannot be sent." };
    packet = openPacket(source, identity);
  }
  const cycle = (await submissionsRepo.list(deps.db, claim.id)).filter((s) => s.result !== "failed").length;
  return {
    claim,
    payer: source.payer,
    channel: source.channel,
    masked: { masked, hash: await sha256Hex(canonicalJson(masked)) },
    outgoing: { packet, revision: claim.builtFromRevision, cycle },
  };
}

/** The deadline finding a claim was last built with. */
function storedDeadline(claim: ClaimState): DeadlineState {
  for (const f of claim.findings) {
    if (f.code === "past_submission_window") return { code: f.code };
    if (f.code === "deadline_approaching") return { code: f.code, daysLeft: (f.params as { daysLeft: number }).daysLeft };
  }
  return null;
}

/**
 * decisions-g2 #5, before anything is sent: a CHAS claim whose deadline finding has moved since it was
 * built is rebuilt for today, as `act` does before a submit, so a window that closed after approval
 * stops the send here rather than after the payer has the claim. `act` checks again when it records
 * the reference; this check is the one that keeps the packet from leaving.
 */
async function withTodaysDeadline(deps: SubmitDeps, claim: ClaimState, actor: Actor): Promise<ClaimState | ActError> {
  if (claim.scheme !== "chas" || !claim.deadline) return claim;
  if (sameDeadline(storedDeadline(claim), deadlineState(claim.deadline, sgtDay(deps.now)))) return claim;
  try {
    await rebuildVisits(deps, [claim.visitKey], actor, "deadline");
  } catch (e) {
    if (!(e instanceof RebuildConflictError)) throw e;
    const moved = await claims.detail(deps.db, claim.id);
    return moved ? { code: "stale", currentVersion: moved.version } : { code: "not_found" };
  }
  return (await claims.detail(deps.db, claim.id)) ?? { code: "not_found" };
}

async function sendGroup(deps: SubmitDeps, group: Ready[], actor: Actor, at: string): Promise<SubmitGroup> {
  const { payer, channel } = group[0]!;
  const result = await channelFor(channel).send(
    group.map((r) => r.outgoing),
    { env: deps.env, payer, db: deps.db, now: deps.now },
  );
  const named = { payerId: payer.id, payerName: payer.name };
  switch (result.kind) {
    case "checklist":
      return { kind: "checklist", ...named, claimIds: result.claimIds };
    case "file":
      // F9: one event per claim per export. The claims do not move, so the events are not guarded by a version.
      await deps.db.batch(
        group.map((r) =>
          audit.auditStatement(deps.db, {
            at,
            actor: actorId(actor),
            action: "exported",
            entityType: "claim",
            entityId: r.claim.id,
            detail: { batchRef: result.batchRef, payerId: payer.id, channel: "file" },
          }),
        ),
      );
      return { kind: "file", ...named, claimIds: result.claimIds, filename: result.filename, csv: result.csv, batchRef: result.batchRef };
    case "sent": {
      const results: SentResult[] = [];
      for (const sent of result.results) {
        const ready = group.find((r) => r.claim.id === sent.claimId)!;
        if (sent.ok) {
          const done = await act(deps, ready.claim.id, { kind: "submit", portalReference: sent.reference }, ready.claim.version, actor, { packet: ready.masked });
          if (done.ok) {
            results.push({ claimId: sent.claimId, ok: true, portalReference: sent.reference });
          } else {
            await keepUnrecordedSend(deps, ready, sent.reference, done.error.code, actor, at);
            results.push({ claimId: sent.claimId, ok: false, error: done.error.code, portalReference: sent.reference });
          }
        } else {
          await recordFailedSubmission(deps, ready.claim.id, actor, { error: sent.error, packet: ready.masked });
          results.push({ claimId: sent.claimId, ok: false, error: sent.error });
        }
      }
      return { kind: "sent", ...named, results };
    }
  }
}

/**
 * The payer took the claim, but `act` would not record its answer: the claim moved on the desk while
 * the payer was answering, its reference names another claim, or someone took the checklist. The send
 * happened all the same (on the api channel, with the patient's details), so the trail keeps it: a
 * failed attempt carrying the payer's reference, and a `sent_not_recorded` event. A simulator row is
 * taken back out of its inbox, since no claim on the desk now points at it.
 */
async function keepUnrecordedSend(deps: SubmitDeps, ready: Ready, reference: string, refusedAs: string, actor: Actor, at: string): Promise<void> {
  const claimId = ready.claim.id;
  const attempt = (portalReference: string | null) =>
    submissionsRepo.submissionStatement(deps.db, {
      claimId,
      channel: ready.channel,
      batchRef: null,
      packetMasked: ready.masked.masked,
      packetHash: ready.masked.hash,
      result: "failed",
      portalReference,
      error: "not_recorded",
      actor: actorId(actor),
      at,
    });
  const rest = [
    audit.auditStatement(deps.db, {
      at,
      actor: actorId(actor),
      action: "sent_not_recorded",
      entityType: "claim",
      entityId: claimId,
      detail: { portalReference: reference, channel: ready.channel, refusedAs },
    }),
    ...(ready.channel === "simulator" ? [simulator.discardStatement(deps.db, claimId, reference)] : []),
  ];
  try {
    await deps.db.batch([attempt(reference), ...rest]);
  } catch (e) {
    if (!submissionsRepo.isReferenceTaken(e)) throw e;
    // The reference already names another claim at this payer, so the attempt cannot carry it; the event still does.
    await deps.db.batch([attempt(null), ...rest]);
  }
}

/**
 * `POST /api/submissions/confirm` (AC-4.5): the officer uploaded an exported file, so each of its
 * claims becomes submitted under the file's batch reference. A claim that was not in that file, or
 * changed since, is refused on its own.
 */
export async function confirmExport(deps: { db: D1Database; now: number }, batchRef: string, items: Item[], actor: Actor): Promise<ConfirmExportResponse> {
  const { settings } = await settingsRepo.get(deps.db);
  const done: ConfirmExportResponse["done"] = [];
  const failed: Refusal[] = [];
  for (const item of items) {
    const claim = await claims.detail(deps.db, item.id);
    if (!claim) {
      failed.push(refusal(item.id, { code: "not_found" }));
      continue;
    }
    const trail = await audit.list(deps.db, { type: "claim", id: item.id });
    if (!trail.some((e) => e.action === "exported" && e.detail.batchRef === batchRef)) {
      failed.push(refusal(item.id, { code: "not_allowed", detail: "This claim was not in that file." }));
      continue;
    }
    const source = await sourceFor(deps.db, claim, settings);
    const masked = buildPacket(source.input, source.template, null);
    const submitted = await act(deps, item.id, { kind: "submit" }, item.version, actor, {
      batchRef,
      packet: { masked, hash: await sha256Hex(canonicalJson(masked)) },
    });
    if (submitted.ok) done.push({ id: item.id, version: submitted.value.version });
    else failed.push(refusal(item.id, submitted.error));
  }
  return { done, failed };
}

const SIMULATOR: Actor = { kind: "system", name: "simulator" };

/** `GET /api/simulator/inbox` (AC-4.7): what the simulator received, newest first, masked as sent. */
export async function simulatorInbox(db: D1Database): Promise<SimulatorItem[]> {
  const { settings } = await settingsRepo.get(db);
  const rows = await simulator.inbox(db);
  return Promise.all(rows.map(async (row) => simulatorItem(row, await claims.detail(db, row.claimId), settings)));
}

/**
 * `POST /api/simulator/inbox/:id` (AC-4.7): the simulated payer accepts, rejects or pays a claim it
 * received. The claim moves through `act` as the simulator, so the lifecycle's own checks and the
 * audit trail apply as they would to a real payer's answer. The claim's version guards the move, so
 * of two decisions made at once only one lands; the inbox row then records it.
 */
export async function simulatorDecide(
  deps: { db: D1Database; now: number },
  id: string,
  request: SimulatorDecision,
): Promise<{ ok: true; item: SimulatorItem } | { ok: false; error: ActError }> {
  const row = await simulator.get(deps.db, id);
  if (!row) return { ok: false, error: { code: "not_found" } };
  const allowedFrom: readonly SimState[] = request.decision === "pay" ? ["received", "accepted"] : ["received"];
  if (!allowedFrom.includes(row.state)) {
    return { ok: false, error: { code: "not_allowed", detail: `The simulated payer has already ${row.state} this claim.` } };
  }
  const claim = await claims.detail(deps.db, row.claimId);
  if (!claim) return { ok: false, error: { code: "not_found" } };

  const action = simulatorAction(request, claim, deps.now);
  if ("code" in action) return { ok: false, error: action };
  const moved = await act(deps, claim.id, action, claim.version, SIMULATOR);
  if (!moved.ok) return { ok: false, error: moved.error };

  const at = new Date(deps.now).toISOString();
  const to =
    request.decision === "accept"
      ? { state: "accepted" as const, reason: request.reason ?? null, paidCents: null }
      : request.decision === "reject"
        ? { state: "rejected" as const, reason: request.reason, paidCents: null }
        : { state: "paid" as const, reason: null, paidCents: moved.value.paidCents };
  if (!(await simulator.decide(deps.db, id, row.state, { ...to, at }))) {
    return { ok: false, error: { code: "not_allowed", detail: "The simulated payer decided this claim a moment ago." } };
  }
  const { settings } = await settingsRepo.get(deps.db);
  return { ok: true, item: simulatorItem((await simulator.get(deps.db, id))!, moved.value, settings) };
}

/** The lifecycle action behind a simulated decision. A payment defaults to what is still owed. */
function simulatorAction(request: SimulatorDecision, claim: ClaimState, now: number): ClaimAction | ActError {
  switch (request.decision) {
    case "accept":
      return { kind: "accept", ...(request.amount !== undefined ? { acceptedCents: cents(request.amount) } : {}), ...(request.reason ? { reason: request.reason } : {}) };
    case "reject":
      return { kind: "reject", reason: request.reason };
    case "pay": {
      const owed = claim.acceptedCents ?? claim.claimedCents;
      if (request.amount === undefined && claim.paidCents >= owed) return { code: "not_allowed", detail: "Nothing is still owed on this claim." };
      const amount = request.amount !== undefined ? cents(request.amount) : subtract(owed, claim.paidCents);
      return { kind: "record_payment", cents: amount, paidOn: sgtDay(now) };
    }
  }
}

function simulatorItem(row: SimClaim, claim: ClaimState | null, settings: DeskSettings): SimulatorItem {
  const packet = row.packetMasked as ClaimPacket;
  return {
    id: row.id,
    claimId: row.claimId,
    payerId: row.payerId,
    payerName: settings.payers.find((p) => p.id === row.payerId)?.name ?? row.payerId,
    simReference: row.simReference,
    state: row.state,
    reason: row.reason,
    paidCents: row.paidCents,
    claimedCents: claim?.claimedCents ?? 0,
    acceptedCents: claim?.acceptedCents ?? null,
    claimStatus: claim?.status ?? null,
    fields: (packet.fields ?? []).map((f) => ({ key: f.key, label: f.label, text: cellText(f.value), masked: f.masked, revealField: f.identityField })),
    updatedAt: row.updatedAt,
  };
}

function refusal(id: string, error: ActError): Refusal {
  const { status, body } = actErrorBody(error);
  return { id, status, error: body };
}
