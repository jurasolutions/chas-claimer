import { useId, useState, type FormEvent } from "react";
import type { ActionRequest } from "../../api/claim-actions";
import type { ClaimDetail } from "../../api/claim-detail";
import { MAX_ACTION_TEXT } from "../../api/claim-limits";
import { describeFinding } from "../../domain/claims/findings";
import { parseIsoDate } from "../../domain/dates";
import { formatSgd, parseDollars, subtract } from "../../domain/money";
import type { ClaimAction, ClaimActionKind } from "../../domain/types";
import { Alert, Button, Dialog, Field, Input, Textarea } from "../../ds";
import { api, ApiError } from "../api";
import { useFocusOnSettle } from "../focus";
import { formatDateTime, plural } from "../format";
import { followLink } from "../router";
import { FindingList } from "./FindingList";

/** What each action's button says. */
const LABEL: Record<ClaimActionKind, string> = {
  approve: "Approve",
  unapprove: "Clear approval",
  submit: "Submit",
  portal_refused: "Record a portal refusal",
  accept: "Record acceptance",
  reject: "Record a rejection",
  record_payment: "Record a payment",
  accept_short_payment: "Accept the short payment",
  reopen: "Reopen",
  withdraw: "Withdraw",
  write_off: "Write off",
  acknowledge_change: "Acknowledge the change",
};

/** The one action the page leads with, when the server offers it: the next step the claim needs. */
const LEADS: readonly ClaimActionKind[] = ["approve", "submit", "reopen", "accept_short_payment", "acknowledge_change"];


export const actionsPath = (id: string) => `/api/claims/${encodeURIComponent(id)}/actions`;
/** The assisted submission page for one claim; the queue and claim detail both lead there. */
export const submitPath = (id: string) => `/submit?claim=${encodeURIComponent(id)}`;

type TextKey = "reason" | "message" | "note";

/** What an action asks for before it can be sent. Actions with no form send on the click. */
interface Form {
  title: string;
  description?: string;
  confirm: string;
  text?: { key: TextKey; label: string; required: boolean; missing: string };
  amount?: { label: string; required: boolean; hint?: string };
  /** The day the money arrived (record_payment). */
  date?: { label: string };
}

const FORMS: Partial<Record<ClaimActionKind, Form>> = {
  reopen: {
    title: "Reopen this claim",
    description: "It goes back on the desk so you can fix it and send it again. The rejection stays in its history.",
    confirm: "Reopen",
  },
  withdraw: {
    title: "Withdraw this claim",
    description: "The claim won't be sent. You can't undo this.",
    confirm: "Withdraw",
    text: { key: "reason", label: "Reason", required: true, missing: "Say why." },
  },
  write_off: {
    title: "Write this claim off",
    description: "The desk stops chasing the payer for it.",
    confirm: "Write off",
    text: { key: "reason", label: "Reason", required: true, missing: "Say why." },
  },
  reject: {
    title: "Record a rejection",
    confirm: "Record the rejection",
    text: { key: "reason", label: "What the payer said", required: true, missing: "Enter the payer's reason." },
  },
  portal_refused: {
    title: "Record a portal refusal",
    description: "The claim is marked rejected. Reopen it to fix it and send it again.",
    confirm: "Record the refusal",
    text: { key: "message", label: "What the portal said", required: true, missing: "Enter the portal's message." },
  },
  accept_short_payment: {
    title: "Accept the short payment",
    description: "The difference is written off and the claim closes.",
    confirm: "Accept the short payment",
    text: { key: "reason", label: "Reason", required: true, missing: "Say why." },
  },
  acknowledge_change: {
    title: "Acknowledge the change",
    description: "The visit changed after this claim was submitted. Say what you did about it.",
    confirm: "Acknowledge",
    text: { key: "note", label: "Note", required: true, missing: "Add a note." },
  },
  accept: {
    title: "Record acceptance",
    confirm: "Record acceptance",
    amount: { label: "Amount accepted", required: false, hint: "Leave blank if the payer accepted the full amount." },
    text: { key: "reason", label: "Reason for a lower amount", required: false, missing: "" },
  },
  record_payment: {
    title: "Record a payment",
    confirm: "Record the payment",
    amount: { label: "Amount paid", required: true },
    date: { label: "Paid on" },
  },
};

interface Values {
  text: string;
  amount: string;
  date: string;
}
type Errors = Partial<Record<keyof Values, string>>;
const EMPTY: Values = { text: "", amount: "", date: "" };
/** The fields in the order an action's form lays them out. */
const FIELD_ORDER: readonly (keyof Values)[] = ["amount", "date", "text"];

const BAD_AMOUNT = "Enter an amount in dollars, like 50.50.";

/** Which form field carries each request field the server may refuse. */
const FIELD_OF: Record<string, keyof Values> = {
  reason: "text",
  message: "text",
  note: "text",
  acceptedCents: "amount",
  cents: "amount",
  paidOn: "date",
};

/** The form field a server refusal belongs next to, when this form shows it. */
function fieldOf(form: Form, failure: Failure | null): keyof Values | undefined {
  const key = failure?.field ? FIELD_OF[failure.field] : undefined;
  return key && form[key] ? key : undefined;
}

/** The action the form describes, or what to fix first. Shape only: the server decides the rest. */
function read(kind: ClaimActionKind, form: Form, values: Values): { action: ClaimAction } | { errors: Errors } {
  const errors: Errors = {};
  const text = values.text.trim();
  if (form.text?.required && text === "") errors.text = form.text.missing;

  const rawAmount = values.amount.trim();
  let amount: ReturnType<typeof parseDollars> | null = null;
  if (form.amount) {
    if (rawAmount !== "") amount = parseDollars(rawAmount);
    if (rawAmount === "" && form.amount.required) errors.amount = "Enter the amount.";
    else if (amount && !amount.ok) errors.amount = BAD_AMOUNT;
  }

  const paidOn = form.date ? parseIsoDate(values.date) : null;
  if (form.date && !paidOn) errors.date = "Enter the date the money arrived.";

  if (Object.keys(errors).length > 0) return { errors };
  const cents = amount?.ok ? amount.value : undefined;
  switch (kind) {
    case "withdraw":
    case "write_off":
    case "reject":
    case "accept_short_payment":
      return { action: { kind, reason: text } };
    case "portal_refused":
      return { action: { kind, message: text } };
    case "acknowledge_change":
      return { action: { kind, note: text } };
    case "accept":
      return {
        action: { kind, ...(cents === undefined ? {} : { acceptedCents: cents }), ...(text ? { reason: text } : {}) },
      };
    case "record_payment":
      return { action: { kind, cents: cents!, paidOn: paidOn! } };
    default:
      return { action: { kind } as ClaimAction };
  }
}

/**
 * What accepting a short payment gives up, in words: the gap between what was paid and what the
 * payer accepted (the claim itself when the payer didn't say), the amount the domain writes off (QA N8).
 */
export function shortWords(claim: ClaimDetail["claim"]): string | undefined {
  const accepted = claim.acceptedCents ?? claim.claimedCents;
  if (claim.paidCents >= accepted) return undefined;
  const gap = formatSgd(subtract(accepted, claim.paidCents));
  const of = claim.acceptedCents === null || claim.acceptedCents === claim.claimedCents ? "what was claimed" : `the ${formatSgd(accepted)} the payer accepted`;
  return `This closes the claim ${gap} short of ${of}. The difference is written off.`;
}

/** Why an action didn't go through, and whether the claim on screen is now out of date. */
export interface Failure {
  message: string;
  /** The request field the server refused, when it named one (`reason`, `acceptedCents`, ...). */
  field?: string;
  reload: boolean;
}

/** The server's first reason for refusing what was entered, and the field it names. */
function firstIssue(body: Record<string, unknown>): { message: string; field?: string } | null {
  const issue: unknown = Array.isArray(body.issues) ? body.issues[0] : undefined;
  if (typeof issue !== "object" || issue === null) return null;
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string" || message.trim() === "") return null;
  const field = typeof path === "string" ? path.split(".").pop() : undefined;
  return field ? { message, field } : { message };
}

/** The page owns the words for each error code (technical §6). */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) return { message: "That didn't go through. Try again.", reload: false };
  switch (error.code) {
    case "stale":
      return { message: "This claim changed while you had it open. Check it and try again.", reload: true };
    case "not_allowed":
      return { message: "That can't be done as the claim stands now. It has been reloaded.", reload: true };
    case "checked_out": {
      const by = typeof error.body.by === "string" ? error.body.by : "Someone";
      const until = typeof error.body.until === "string" ? ` Try again after ${formatDateTime(error.body.until)}.` : "";
      return { message: `${by} is submitting this claim.${until}`, reload: false };
    }
    case "forbidden":
      return { message: "You don't have access to do that.", reload: false };
    case "invalid": {
      const issue = firstIssue(error.body);
      return issue ? { ...issue, reload: false } : { message: "Check what you entered and try again.", reload: false };
    }
    case "reference_taken": {
      const reference = typeof error.body.portalReference === "string" ? error.body.portalReference : "That reference";
      return { message: `${reference} is already on another claim to this payer. Check the reference the portal gave you.`, reload: false };
    }
    default:
      return { message: "That didn't go through. Try again.", reload: false };
  }
}

export const FailureAlert = ({ failure }: { failure: Failure | null }) =>
  failure ? <Alert tone="danger" role="alert" title={failure.message} /> : null;

/**
 * A refusal shown on the page rather than in a dialog. The button that ran the action was disabled
 * while it ran, and a stale claim reloads under it, so focus would fall to the body: the refusal
 * takes it each time a new one arrives (QA 03 D02g).
 */
export function SettledFailureAlert({ failure }: { failure: Failure | null }) {
  const ref = useFocusOnSettle<HTMLDivElement>(failure);
  if (!failure) return null;
  return (
    <div ref={ref} tabIndex={-1} className="settled-focus">
      <FailureAlert failure={failure} />
    </div>
  );
}

interface ActionFormProps {
  kind: ClaimActionKind;
  form: Form;
  busy: boolean;
  failure: Failure | null;
  onSend: (action: ClaimAction) => void;
  onClose: () => void;
}

/**
 * The dialog an action opens to ask for its reason, amount or date. Required is marked on the
 * control (read out by a screen reader), not as an asterisk in the label: almost every field here
 * is required, and an optional one says so in its hint.
 */
function ActionForm({ kind, form, busy, failure, onSend, onClose }: ActionFormProps) {
  const id = useId();
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const formId = `${id}-form`;
  // A refusal that names a field shows next to it; anything else goes in the alert at the top.
  const refused = fieldOf(form, failure);
  const shown: Errors = refused && failure ? { [refused]: failure.message, ...errors } : errors;
  const set = (key: keyof Values) => (event: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = read(kind, form, values);
    if ("errors" in result) {
      setErrors(result.errors);
      // Take the viewer to the first field that needs fixing, in the order the form shows them.
      const first = FIELD_ORDER.find((key) => result.errors[key]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
    } else {
      setErrors({});
      onSend(result.action);
    }
  };

  return (
    <Dialog
      open
      title={form.title}
      description={form.description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy} aria-busy={busy}>
            {form.confirm}
          </Button>
        </>
      }
    >
      <form id={formId} className="action-form" onSubmit={submit} noValidate>
        <FailureAlert failure={refused ? null : failure} />
        {form.amount ? (
          <Field label={form.amount.label} hint={form.amount.hint} error={shown.amount} htmlFor={`${id}-amount`}>
            <Input
              id={`${id}-amount`}
              name="amount"
              inputMode="decimal"
              required={form.amount.required}
              autoComplete="off"
              value={values.amount}
              onChange={set("amount")}
              invalid={Boolean(shown.amount)}
              aria-invalid={Boolean(shown.amount)}
            />
          </Field>
        ) : null}
        {form.date ? (
          <Field label={form.date.label} error={shown.date} htmlFor={`${id}-date`}>
            <Input id={`${id}-date`} name="date" type="date" autoComplete="off" required value={values.date} onChange={set("date")} invalid={Boolean(shown.date)} aria-invalid={Boolean(shown.date)} />
          </Field>
        ) : null}
        {form.text ? (
          <Field label={form.text.label} error={shown.text} htmlFor={`${id}-text`}>
            <Textarea
              id={`${id}-text`}
              name={form.text.key}
              autoComplete="off"
              rows={3}
              required={form.text.required}
              maxLength={MAX_ACTION_TEXT}
              value={values.text}
              onChange={set("text")}
              invalid={Boolean(shown.text)}
              aria-invalid={Boolean(shown.text)}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}

interface ClaimActionsProps {
  detail: ClaimDetail;
  /** The claim as it stands after the action. */
  onDone: (next: ClaimDetail) => void;
  /** Fetch the claim again: it changed under the viewer. */
  onReload: () => void;
  /**
   * The action whose dialog is open. The page holds it so a fix elsewhere on the page, such as
   * withdrawing a claim that can never be paid (S8), opens the same dialog.
   */
  open: ClaimActionKind | null;
  onOpen: (kind: ClaimActionKind | null) => void;
}

/** A refusal, with the action it answered, so a dialog never shows another action's refusal. */
interface Refusal extends Failure {
  on: ClaimActionKind;
}

/**
 * The buttons for what this viewer may do now. The server decides which (`detail.actions`); the
 * page only asks for what it needs to send and sends the version it read.
 */
export function ClaimActions({ detail, onDone, onReload, open, onOpen: setOpen }: ClaimActionsProps) {
  const [busy, setBusy] = useState(false);
  const [refusal, setFailure] = useState<Refusal | null>(null);
  const failure = refusal && (open === null || refusal.on === open) ? refusal : null;
  const { claim } = detail;
  const warnings = claim.findings.filter((f) => f.severity === "warning");
  const lead = LEADS.find((kind) => detail.actions.includes(kind));

  const send = async (action: ClaimAction) => {
    setBusy(true);
    setFailure(null);
    try {
      const body: ActionRequest = { action, expectedVersion: claim.version };
      onDone(await api.post<ClaimDetail>(actionsPath(claim.id), body));
      setOpen(null);
    } catch (error) {
      const next = failureOf(error);
      setFailure({ ...next, on: action.kind });
      // What the viewer was about to do may no longer make sense: show the claim as it is now.
      if (next.reload) {
        setOpen(null);
        onReload();
      }
    } finally {
      setBusy(false);
    }
  };

  const click = (kind: ClaimActionKind) => {
    setFailure(null);
    // S17: a reviewer sees every warning before the approval goes through.
    if (kind === "approve" && warnings.length > 0) setOpen("approve");
    else if (FORMS[kind]) setOpen(kind);
    else void send({ kind } as ClaimAction);
  };
  const close = () => {
    setOpen(null);
    setFailure(null);
  };
  const base = open ? FORMS[open] : undefined;
  const short = open === "accept_short_payment" ? shortWords(claim) : undefined;
  const form = base && short ? { ...base, description: short } : base;

  if (detail.actions.length === 0) return null;
  return (
    <div className="claim-actions" role="group" aria-label="Actions">
      {detail.actions.map((kind) => {
        const variant = kind === lead ? "primary" : "secondary";
        // Submitting has its own page: the checklist, the packet and the channel (ticket 07).
        if (kind === "submit") {
          return (
            <Button key={kind} variant={variant} href={submitPath(claim.id)} onClick={followLink}>
              {LABEL[kind]}
            </Button>
          );
        }
        return (
          <Button key={kind} variant={variant} disabled={busy} aria-busy={busy} onClick={() => click(kind)}>
            {LABEL[kind]}
          </Button>
        );
      })}
      {open ? null : <SettledFailureAlert failure={failure} />}
      <Dialog
        open={open === "approve"}
        title={`Approve with ${plural(warnings.length, "warning")}?`}
        description="Check these before you approve. They don't stop the claim, but the payer may."
        onClose={close}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void send({ kind: "approve" })}>
              Approve anyway
            </Button>
          </>
        }
      >
        <FailureAlert failure={failure} />
        <FindingList findings={warnings} describe={describeFinding} />
      </Dialog>
      {open && form ? <ActionForm key={open} kind={open} form={form} busy={busy} failure={failure} onSend={(a) => void send(a)} onClose={close} /> : null}
    </div>
  );
}
