import { useState } from "react";
import type { BatchRequest, BatchResponse } from "../../api/claim-actions";
import { MAX_BATCH_ITEMS } from "../../api/claim-limits";
import type { ClaimRow } from "../../api/claims";
import type { ProblemBody } from "../../api/common";
import { describeFinding } from "../../domain/claims/findings";
import { Alert, Button, Dialog } from "../../ds";
import { ApiError, api } from "../api";
import { plural } from "../format";
import { FindingList } from "./FindingList";

const BATCH_PATH = "/api/claims/actions";


/** How a person picks a claim out of the queue: its masked patient and its payer. */
export const nameOf = (row: Pick<ClaimRow, "patientMask" | "payerName">) => `${row.patientMask} ${row.payerName}`;

/** What a batch did, in the page's words, kept after the queue reloads. */
export interface BatchOutcome {
  approved: number;
  /** How many of those carried warnings when approved (S17). */
  withWarnings: number;
  /** Each claim that wasn't approved, named as the reviewer saw it, and why. */
  failed: { id: string; name: string; reason: string }[];
}

/** Why one claim in a batch wasn't approved, finishing the sentence that names it. */
function reasonOf(problem: ProblemBody): string {
  switch (problem.error) {
    case "stale":
      return "changed since you selected it. Open it to check what changed.";
    case "not_allowed":
      return "can't be approved as it stands now. Open it to see what needs fixing.";
    case "checked_out":
      return `is being submitted by ${typeof problem.by === "string" ? problem.by : "someone else"}.`;
    case "forbidden":
      return "needs a reviewer to approve it.";
    default:
      return "didn't go through. Try it again.";
  }
}

export interface BatchApproveProps {
  /** The rows the reviewer ticked, as they saw them: each is approved at that version. */
  chosen: readonly ClaimRow[];
  onSettled: (outcome: BatchOutcome) => void;
}

const warningsOf = (row: ClaimRow) => row.findings.filter((f) => f.severity === "warning");

/** Why the whole batch failed: nothing in it was approved, so the selection stays for another try. */
const batchFailureOf = (error: unknown) =>
  error instanceof ApiError && error.status === 403 ? "Only a reviewer can approve claims." : "The approval didn't go through. Try again.";

/**
 * The reviewer's batch: approve every ticked claim in one request (AC-3.4). If any of them carries
 * a warning, the reviewer sees each one, claim by claim, before the request goes (S17).
 */
export function BatchApprove({ chosen, onSettled }: BatchApproveProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const flagged = chosen.filter((row) => warningsOf(row).length > 0);
  const warningCount = flagged.reduce((n, row) => n + warningsOf(row).length, 0);
  const tooMany = chosen.length > MAX_BATCH_ITEMS;

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const body: BatchRequest = { action: "approve", items: chosen.map((row) => ({ id: row.id, version: row.version })) };
      const answer = await api.post<BatchResponse>(BATCH_PATH, body);
      const names = new Map(chosen.map((row) => [row.id, nameOf(row)]));
      setConfirming(false);
      onSettled({
        approved: answer.done.length,
        withWarnings: answer.done.filter((d) => d.warnings > 0).length,
        failed: answer.failed.map((f) => ({ id: f.id, name: names.get(f.id) ?? f.id, reason: reasonOf(f.error) })),
      });
    } catch (error) {
      setFailure(batchFailureOf(error));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    setFailure(null);
    if (flagged.length > 0) setConfirming(true);
    else void send();
  };
  const close = () => {
    setConfirming(false);
    setFailure(null);
  };
  const failed = failure ? <Alert tone="danger" role="alert" title={failure} /> : null;

  return (
    <div className="queue-batch">
      <Button variant="primary" disabled={busy || chosen.length === 0 || tooMany} aria-busy={busy} onClick={start}>
        {chosen.length === 0 ? "Approve selected" : `Approve ${plural(chosen.length, "claim")}`}
      </Button>
      {tooMany ? <p className="muted">Select up to {MAX_BATCH_ITEMS} claims at a time.</p> : null}
      {confirming ? null : failed}
      <Dialog
        open={confirming}
        title={`Approve ${plural(chosen.length, "claim")} with ${plural(warningCount, "warning")}?`}
        description="Check these before you approve. They don't stop the claims, but the payer may."
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void send()}>
              Approve anyway
            </Button>
          </>
        }
      >
        {failed}
        <ul className="batch-warnings">
          {flagged.map((row) => (
            <li key={row.id}>
              <h3 translate="no">{nameOf(row)}</h3>
              <FindingList findings={warningsOf(row)} describe={describeFinding} />
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

/** One line for the status region once a batch is back. */
export const describeBatch = (outcome: BatchOutcome) =>
  `Approved ${plural(outcome.approved, "claim")}${outcome.withWarnings > 0 ? `, ${outcome.withWarnings} with warnings` : ""}.`;

/** The claims a batch left behind, each by name, so none goes unnoticed (AC-3.4). */
export function BatchFailures({ outcome }: { outcome: BatchOutcome | null }) {
  if (!outcome || outcome.failed.length === 0) return null;
  const count = outcome.failed.length;
  return (
    <Alert tone="warning" role="alert" title={`${plural(count, "claim")} ${count === 1 ? "wasn't" : "weren't"} approved`}>
      <ul className="batch-failures">
        {outcome.failed.map((f) => (
          <li key={f.id}>
            <span translate="no">{f.name}</span> {f.reason}
          </li>
        ))}
      </ul>
    </Alert>
  );
}
