import { useEffect, useId, useState, type FormEvent } from "react";
import { MAX_ACTION_TEXT } from "../../api/claim-limits";
import type { SimulatorDecision, SimulatorInbox, SimulatorItem } from "../../api/submissions";
import { formatSgd, parseDollars, type Cents } from "../../domain/money";
import type { SimState } from "../../domain/types";
import { Alert, Badge, type BadgeProps, Button, Card, Dialog, Field, Input, Textarea } from "../../ds";
import { failureOf } from "../components/ClaimActions";
import { PageHeader } from "../components/PageHeader";
import { ApiError, api } from "../api";
import { useFocusOnSettle } from "../focus";
import { formatDateTime } from "../format";
import { Link } from "../router";

/**
 * The payer simulator (AC-4.7): the desk's own stand-in for a payer. It lists what the desk sent it,
 * masked as sent, and lets a person answer as the payer would: accept (in full or in part), reject
 * with a reason, or pay. Each answer moves the claim with the simulator as the actor.
 *
 * `App` draws the simulator banner above this page, so the page draws none of its own. It never
 * shows a real payer's name or look: an item is known by its simulator reference, not its payer.
 */

const INBOX_PATH = "/api/simulator/inbox";
const decidePath = (id: string) => `${INBOX_PATH}/${encodeURIComponent(id)}`;
const claimPath = (id: string) => `/claims/${encodeURIComponent(id)}`;

const STATE: Record<SimState, { words: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  received: { words: "Received", tone: "info" },
  accepted: { words: "Accepted", tone: "info" },
  rejected: { words: "Rejected", tone: "danger" },
  paid: { words: "Paid", tone: "success" },
};

type Inbox = { state: "loading" } | { state: "failed"; forbidden: boolean } | { state: "ready"; items: SimulatorItem[] };
type Kind = SimulatorDecision["decision"];

export function Simulator() {
  const [inbox, setInbox] = useState<Inbox>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [deciding, setDeciding] = useState<{ item: SimulatorItem; kind: Kind } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The decision dialog closes once it is answered, and the DS Dialog doesn't give focus back, so
  // focus goes to what changed: the claim just decided, or the notice that someone was first. Each
  // is a new object or a higher count, so a repeat moves focus again (QA 03 D02d).
  const [lastDecided, setLastDecided] = useState<{ id: string } | null>(null);
  const [overtakenCount, setOvertakenCount] = useState(0);
  const noticeRef = useFocusOnSettle<HTMLDivElement>(overtakenCount);

  useEffect(() => {
    let current = true;
    api.get<SimulatorInbox>(INBOX_PATH).then(
      (answer) => current && setInbox({ state: "ready", items: answer.items }),
      (e: unknown) => current && setInbox({ state: "failed", forbidden: e instanceof ApiError && e.status === 403 }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const reload = () => setAttempt((n) => n + 1);

  const decided = (item: SimulatorItem) => {
    setDeciding(null);
    setNotice(null);
    setLastDecided({ id: item.id });
    setInbox((now) => (now.state === "ready" ? { ...now, items: now.items.map((i) => (i.id === item.id ? item : i)) } : now));
  };

  /** Someone answered first, or the item is gone: say so, and show the inbox as it now stands. */
  const overtaken = (message: string) => {
    setDeciding(null);
    setNotice(message);
    setOvertakenCount((n) => n + 1);
    reload();
  };

  return (
    <>
      <PageHeader
        title="Payer simulator"
        lede="Answer the claims sent here the way a payer would. Each answer moves the claim on the desk, so you can try the whole round trip."
      />

      {notice ? (
        <div ref={noticeRef} tabIndex={-1} className="settled-focus">
          <Alert tone="warning" role="alert" title={notice}>
            The inbox has been reloaded, so it shows each claim as it stands now.
          </Alert>
        </div>
      ) : null}

      {inbox.state === "loading" ? <p className="muted">Loading the simulator's inbox…</p> : null}

      {inbox.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The simulator's inbox didn't load.">
          {inbox.forbidden ? (
            "Your account isn't on the desk's team list. Ask the clinic's administrator to add you."
          ) : (
            <span className="retry-line">
              Check your connection, then try again.
              <Button variant="secondary" size="sm" onClick={reload}>
                Try again
              </Button>
            </span>
          )}
        </Alert>
      ) : null}

      {inbox.state === "ready" && inbox.items.length === 0 ? (
        <Card className="empty-state">
          <h2 className="empty-state__title">Nothing has been sent to the simulator yet</h2>
          <p className="muted">Approved claims for a payer that uses the simulator arrive here when you send them.</p>
          <p>
            <Link href="/submit">Send approved claims</Link>
          </p>
        </Card>
      ) : null}

      {inbox.state === "ready" && inbox.items.length > 0 ? (
        <Card className="sim-inbox">
          {inbox.items.map((item) => (
            <InboxItem
              key={item.id}
              item={item}
              decided={lastDecided?.id === item.id ? lastDecided : null}
              onDecide={(kind) => setDeciding({ item, kind })}
            />
          ))}
        </Card>
      ) : null}

      {deciding ? (
        <DecisionDialog
          item={deciding.item}
          kind={deciding.kind}
          onDone={decided}
          onOvertaken={overtaken}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </>
  );
}

/** `decided` is set, as a new object each time, once a decision on this item goes through. */
function InboxItem({ item, decided, onDecide }: { item: SimulatorItem; decided: object | null; onDecide: (kind: Kind) => void }) {
  const headingId = useId();
  const state = STATE[item.state];
  const ref = useFocusOnSettle<HTMLElement>(decided);
  return (
    <article ref={ref} tabIndex={-1} className="sim-item settled-focus" aria-labelledby={headingId}>
      <div className="sim-item__head">
        <h2 id={headingId} className="sim-item__title">
          <code className="literal" translate="no">
            {item.simReference}
          </code>
        </h2>
        <Badge tone={state.tone} data-tone={state.tone}>
          {state.words}
        </Badge>
        <span className="muted sim-item__when">{`Updated ${formatDateTime(item.updatedAt)}`}</span>
      </div>

      <dl className="claim-facts sim-item__amounts">
        <div>
          <dt>Amount claimed</dt>
          <dd className="money">{formatSgd(item.claimedCents as Cents)}</dd>
        </div>
        {item.acceptedCents !== null ? (
          <div>
            <dt>Amount accepted</dt>
            <dd className="money">{formatSgd(item.acceptedCents as Cents)}</dd>
          </div>
        ) : null}
        {item.paidCents !== null ? (
          <div>
            <dt>Amount paid</dt>
            <dd className="money">{formatSgd(item.paidCents as Cents)}</dd>
          </div>
        ) : null}
        {item.reason ? (
          <div>
            <dt>{item.state === "rejected" ? "Why it was rejected" : "Reason"}</dt>
            <dd>{item.reason}</dd>
          </div>
        ) : null}
      </dl>

      <details className="sim-item__packet">
        <summary>What the desk sent</summary>
        <dl className="claim-facts">
          {item.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>
                {field.text === null ? (
                  <span className="muted">{field.masked ? "Withheld" : "Not given"}</span>
                ) : (
                  <code className="literal" translate="no">
                    {field.text}
                  </code>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="sim-item__actions">
        {item.state === "received" ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => onDecide("accept")}>
              Accept<span className="visually-hidden"> {item.simReference}</span>
            </Button>
            <Button variant="secondary" size="sm" onClick={() => onDecide("reject")}>
              Reject<span className="visually-hidden"> {item.simReference}</span>
            </Button>
          </>
        ) : null}
        {item.state === "accepted" ? (
          <Button variant="secondary" size="sm" onClick={() => onDecide("pay")}>
            Pay<span className="visually-hidden"> {item.simReference}</span>
          </Button>
        ) : null}
        <Link href={claimPath(item.claimId)}>
          Open the claim<span className="visually-hidden"> for {item.simReference}</span>
        </Link>
      </div>
    </article>
  );
}

const DIALOG: Record<Kind, { title: string; description: string; send: string }> = {
  accept: {
    title: "Accept this claim",
    description: "The claim is marked accepted on the desk. Leave the amount empty to accept everything claimed.",
    send: "Accept the claim",
  },
  reject: {
    title: "Reject this claim",
    description: "The claim is marked rejected on the desk, with your reason, so an officer can fix it and send it again.",
    send: "Reject the claim",
  },
  pay: {
    title: "Pay this claim",
    description: "A payment is recorded against the claim on the desk, dated today.",
    send: "Record the payment",
  },
};

interface DecisionDialogProps {
  item: SimulatorItem;
  kind: Kind;
  onDone: (item: SimulatorItem) => void;
  onOvertaken: (message: string) => void;
  onClose: () => void;
}

/** One simulated decision. Amounts are read here and sent as cents; the server checks the rest. */
function DecisionDialog({ item, kind, onDone, onOvertaken, onClose }: DecisionDialogProps) {
  const id = useId();
  const formId = `${id}-form`;
  const amountId = `${id}-amount`;
  const reasonId = `${id}-reason`;
  const words = DIALOG[kind];
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<{ amount?: string; reason?: string; other?: string }>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    let cents: number | undefined;
    if (kind !== "reject" && amount.trim() !== "") {
      const parsed = parseDollars(amount);
      if (!parsed.ok || parsed.value < 1) {
        setErrors({ amount: "Enter an amount like 550.00." });
        document.getElementById(amountId)?.focus();
        return;
      }
      cents = parsed.value;
    }
    if (kind === "reject" && text === "") {
      setErrors({ reason: "Give a reason." });
      document.getElementById(reasonId)?.focus();
      return;
    }

    const decision: SimulatorDecision =
      kind === "reject"
        ? { decision: "reject", reason: text }
        : kind === "accept"
          ? { decision: "accept", ...(cents !== undefined ? { amount: cents } : {}), ...(text ? { reason: text } : {}) }
          : { decision: "pay", ...(cents !== undefined ? { amount: cents } : {}) };

    setBusy(true);
    setErrors({});
    try {
      onDone(await api.post<SimulatorItem>(decidePath(item.id), decision));
    } catch (error) {
      setBusy(false);
      if (error instanceof ApiError && (error.code === "not_allowed" || error.code === "stale")) {
        const detail = typeof error.body.detail === "string" ? error.body.detail : "This claim changed while you had it open.";
        onOvertaken(detail);
        return;
      }
      if (error instanceof ApiError && error.code === "not_found") {
        onOvertaken("That claim is no longer in the simulator's inbox.");
        return;
      }
      const failure = failureOf(error);
      if (failure.field === "amount" || failure.field === "reason") setErrors({ [failure.field]: failure.message });
      else setErrors({ other: failure.message });
    }
  };

  return (
    <Dialog
      open
      title={words.title}
      description={words.description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy} aria-busy={busy}>
            {words.send}
          </Button>
        </>
      }
    >
      <form id={formId} className="action-form" onSubmit={submit} noValidate>
        {errors.other ? <Alert tone="danger" role="alert" title={errors.other} /> : null}
        {kind !== "reject" ? (
          <Field
            label={kind === "accept" ? "Amount accepted (optional)" : "Amount paid (optional)"}
            hint={
              kind === "accept"
                ? `In dollars. Leave it empty to accept the ${formatSgd(item.claimedCents as Cents)} claimed.`
                : "In dollars. Leave it empty to pay what is still owed."
            }
            error={errors.amount}
            htmlFor={amountId}
          >
            <Input
              id={amountId}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              placeholder="550.00…"
              value={amount}
              onChange={(event: { target: { value: string } }) => setAmount(event.target.value)}
              invalid={Boolean(errors.amount)}
              aria-invalid={Boolean(errors.amount)}
            />
          </Field>
        ) : null}
        {kind !== "pay" ? (
          <Field
            label={kind === "reject" ? "Reason" : "Reason (optional)"}
            hint={kind === "accept" ? "Say why, if you accept less than was claimed." : "What the payer tells the clinic."}
            error={errors.reason}
            htmlFor={reasonId}
          >
            <Textarea
              id={reasonId}
              name="reason"
              autoComplete="off"
              rows={3}
              required={kind === "reject"}
              maxLength={MAX_ACTION_TEXT}
              value={reason}
              onChange={(event: { target: { value: string } }) => setReason(event.target.value)}
              invalid={Boolean(errors.reason)}
              aria-invalid={Boolean(errors.reason)}
            />
          </Field>
        ) : null}
      </form>
    </Dialog>
  );
}
