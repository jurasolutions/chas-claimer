import type { RebuildReason } from "../../domain/types";
import type { IsoDate } from "../../domain/dates";
import { formatSgd, type Cents } from "../../domain/money";
import type { AuditEvent } from "../../domain/types";
import { formatDate, formatDateTime, plural } from "../format";

type Detail = Record<string, unknown>;

/** A field of an audit event's detail, read only when it has the expected type. */
const text = (detail: Detail, key: string): string | null => {
  const value = detail[key];
  return typeof value === "string" && value !== "" ? value : null;
};
const count = (detail: Detail, key: string): number | null => {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
/** An audit amount in dollars, or null when the detail has no whole number of cents to show. */
const money = (detail: Detail, key: string): string | null => {
  const value = count(detail, key);
  return value === null || !Number.isSafeInteger(value) ? null : formatSgd(value as Cents);
};
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const withText = (words: string, extra: string | null) => (extra ? `${words}: ${extra}` : words);

/** How a claim went to its payer, as words that follow "Submitted" or "Attempt 2". */
export const CHANNEL: Record<string, string> = {
  assisted: "by hand on the portal",
  file: "as a file upload",
  api: "through the payer's API",
  simulator: "to the simulator",
};

/** Why the desk rebuilt a claim, as words that follow "after". Typed against the server's reasons, so a new one can't go unworded. */
const REASON: Record<RebuildReason, string> = {
  import: "an import",
  settings: "a settings change",
  code_map: "a code-map change",
  annotations: "annotations were saved",
  deadline: "the deadline check",
  lifecycle: "a status change",
};

const FIELD: Record<string, string> = {
  nric: "NRIC/FIN",
  name: "name",
  phone: "phone number",
  date_of_birth: "date of birth",
  address: "address",
  member_id: "member ID",
  account_holder_nric: "account holder's NRIC/FIN",
  justification: "justification",
  preAuthReference: "pre-authorisation reference",
  mcafReference: "MCAF reference",
};

function rebuiltWords(prefix: string, detail: Detail): string {
  const reason = text(detail, "reason");
  const revision = count(detail, "revision");
  const after = reason && Object.hasOwn(REASON, reason) ? ` after ${REASON[reason as RebuildReason]}` : "";
  return `${prefix}${after}${revision === null ? "" : ` (visit revision ${revision})`}`;
}

/**
 * A withdrawal. The desk's own (a rebuild) records why the claim went (`why`) and what set off the
 * rebuild (`reason`, a RebuildReason); an officer's records the reason they typed (QA N4).
 */
function withdrawnWords(detail: Detail): string {
  const why = text(detail, "why");
  if (why === "voided_in_clinic") {
    const revision = count(detail, "revision");
    return `Withdrawn because the visit was voided in the clinic${revision === null ? "" : ` (visit revision ${revision})`}`;
  }
  if (why !== null) return rebuiltWords("Withdrawn", detail);
  return withText("Withdrawn", text(detail, "reason"));
}

/**
 * One audit event in plain words. The server records facts (amounts, reasons, revisions); the
 * page only words them. An action this page doesn't know yet still shows, as its name.
 */
export function historyWords(event: AuditEvent): string {
  const d = event.detail;
  switch (event.action) {
    case "built":
      return "Built from the visit";
    case "rebuilt":
      return rebuiltWords("Rebuilt", d);
    case "approval_cleared":
      return rebuiltWords("Approval cleared because the claim changed", d);
    case "flagged_changed":
      return d.voided === true ? "The visit was voided after submission" : "The visit changed after submission";
    case "approve": {
      const label = capitalise(text(d, "label") ?? "approved");
      const warnings = count(d, "warnings") ?? 0;
      return warnings > 0 ? `${label} with ${plural(warnings, "warning")}` : label;
    }
    case "unapprove":
      return "Approval cleared";
    case "submit": {
      const channel = text(d, "channel");
      const reference = text(d, "portalReference");
      const how = channel && CHANNEL[channel] ? ` ${CHANNEL[channel]}` : "";
      return `Submitted${how}${reference ? `, reference ${reference}` : ""}`;
    }
    case "portal_refused":
      return withText("The portal refused it", text(d, "message"));
    case "accept": {
      const accepted = money(d, "acceptedCents");
      const claimed = money(d, "claimedCents");
      const words = accepted && claimed && accepted !== claimed ? `Accepted at ${accepted} of ${claimed}` : "Accepted in full";
      return withText(words, text(d, "reason"));
    }
    case "accepted_by_remittance": {
      const accepted = money(d, "acceptedCents");
      return `Accepted by the payment${accepted ? ` at ${accepted}` : ""}`;
    }
    case "reject":
      return withText("Rejected", text(d, "reason"));
    case "record_payment": {
      const paid = money(d, "cents");
      const on = text(d, "paidOn");
      return `${paid ?? "A payment"} paid${on ? ` on ${formatDate(on as IsoDate)}` : ""}`;
    }
    case "accept_short_payment": {
      const off = money(d, "writtenOffCents");
      return withText(`Short payment accepted${off ? `, ${off} written off` : ""}`, text(d, "reason"));
    }
    case "reopen":
      return "Reopened";
    case "withdraw":
      return withdrawnWords(d);
    case "write_off":
      return withText("Written off", text(d, "reason"));
    case "acknowledge_change":
      return withText("Change after submission acknowledged", text(d, "note"));
    case "submission_failed": {
      const attempt = count(d, "attempt");
      return attempt === null ? "A submission attempt failed" : `Submission attempt ${attempt} failed`;
    }
    case "checkout":
      return "Opened the checklist to submit";
    case "checkout_taken_over": {
      const from = text(d, "from");
      return from ? `Took over the checklist from ${from}` : "Took over the checklist";
    }
    case "annotations_saved": {
      const fields = Array.isArray(d.fields) ? d.fields.filter((f): f is string => typeof f === "string") : [];
      return fields.length ? `Saved the ${fields.map((f) => FIELD[f] ?? f).join(" and ")}` : "Saved the annotations";
    }
    case "revealed": {
      const field = text(d, "field");
      return `Revealed the ${field ? (FIELD[field] ?? field) : "patient's details"}`;
    }
    default:
      return capitalise(event.action.replace(/_/g, " "));
  }
}

/** Who did it: a person's email, "Payer simulator" for the simulator's decisions, or "The desk" for the desk's own work. */
export const who = (actor: string) => (actor === "system:simulator" ? "Payer simulator" : actor.startsWith("system:") ? "The desk" : actor);

/** Oldest first; events recorded in the same instant keep the order they were written. */
const byTime = (a: AuditEvent, b: AuditEvent) => (a.at === b.at ? a.id - b.id : a.at < b.at ? -1 : 1);

/** The claim's history, oldest first: what happened, who did it and when (AC-3.6). */
export function ClaimHistory({ events }: { events: readonly AuditEvent[] }) {
  if (events.length === 0) return <p className="muted">Nothing has happened to this claim yet.</p>;
  return (
    <ol className="claim-history" aria-label="History">
      {[...events].sort(byTime).map((event) => (
        <li key={event.id} className="claim-history__event">
          <p className="claim-history__what">{historyWords(event)}</p>
          <p className="claim-history__who muted">
            {who(event.actor)} · <time dateTime={event.at}>{formatDateTime(event.at)}</time>
          </p>
        </li>
      ))}
    </ol>
  );
}
