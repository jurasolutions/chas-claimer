import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ClaimDetail } from "../../api/claim-detail";
import { MAX_ACTION_TEXT, MAX_BATCH_ITEMS, MAX_PORTAL_REFERENCE } from "../../api/claim-limits";
import { type ClaimListResponse, type ClaimRow, MAX_CLAIMS_PAGE } from "../../api/claims";
import type { ProblemBody } from "../../api/common";
import type {
  ConfirmExportResponse,
  PacketFieldView,
  PacketView,
  SendFailure,
  SubmitGroup,
  SubmitResponse,
} from "../../api/submissions";
import type { ClaimAction } from "../../domain/types";
import { Alert, Button, Card, Checkbox, Dialog, Field, Input, Textarea } from "../../ds";
import { nameOf } from "../components/BatchApprove";
import { BillSplit } from "../components/BillSplit";
import { actionsPath, type Failure, FailureAlert, failureOf, submitPath } from "../components/ClaimActions";
import { DeadlineText } from "../components/DeadlineText";
import { MaskedIdentifier } from "../components/MaskedIdentifier";
import { MoneyCell } from "../components/MoneyCell";
import { PageHeader } from "../components/PageHeader";
import { ApiError, api } from "../api";
import { useFocusOnSettle } from "../focus";
import { formatDateTime, inSentence, plural } from "../format";
import { Link, useLocation } from "../router";

const claimPath = (id: string) => `/claims/${encodeURIComponent(id)}`;
const checkoutPath = (id: string) => `/api/claims/${encodeURIComponent(id)}/checkout`;
const APPROVED_PATH = `/api/claims?status=approved&limit=${MAX_CLAIMS_PAGE}`;

/**
 * Submission (block 07). With `?claim=` it is that claim's assisted checklist: what to enter in the
 * payer's portal, field by field, and the one primary action, "Record portal reference". Without it,
 * it lists the approved claims and sends the selected ones down the channel each was approved for.
 */
export function AssistedSubmit() {
  const claimId = useLocation().query.get("claim");
  return claimId ? <ClaimChecklist key={claimId} claimId={claimId} /> : <SendApproved />;
}

/* ------------------------------------------------------------------ one claim's checklist */

type Hold =
  | { state: "loading" }
  | { state: "held"; packet: PacketView }
  | { state: "taken"; by: string; until: string | null }
  | { state: "closed"; detail: string }
  | { state: "failed"; message: string };

type Done = { kind: "submitted"; reference: string } | { kind: "refused" };

/** What holding the claim's checklist answered, in the page's terms. */
function holdOf(error: unknown): Hold {
  if (error instanceof ApiError && error.code === "checked_out") {
    const by = typeof error.body.by === "string" ? error.body.by : "another officer";
    return { state: "taken", by, until: typeof error.body.until === "string" ? error.body.until : null };
  }
  if (error instanceof ApiError && error.code === "not_allowed") {
    const detail = typeof error.body.detail === "string" ? error.body.detail : "This claim can't be submitted as it stands now.";
    return { state: "closed", detail };
  }
  if (error instanceof ApiError && error.status === 404) return { state: "closed", detail: "There's no claim at this address." };
  return { state: "failed", message: failureOf(error).message };
}

function ClaimChecklist({ claimId }: { claimId: string }) {
  const [hold, setHold] = useState<Hold>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [split, setSplit] = useState<ClaimDetail["split"] | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [takingOver, setTakingOver] = useState(false);

  // Holding the checklist tells every other officer who is entering this claim (AC-4.8).
  useEffect(() => {
    let current = true;
    setHold({ state: "loading" });
    api.post<PacketView>(checkoutPath(claimId), {}).then(
      (packet) => current && setHold({ state: "held", packet }),
      (error: unknown) => current && setHold(holdOf(error)),
    );
    return () => {
      current = false;
    };
  }, [claimId, attempt]);

  // The split is context, not the job: if it doesn't load, the checklist still works without it.
  useEffect(() => {
    let current = true;
    api.get<Pick<ClaimDetail, "split">>(`/api/claims/${encodeURIComponent(claimId)}`).then(
      (detail) => current && setSplit(detail.split),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [claimId]);

  /** Read the claim again without blanking the page, after it changed under the officer. */
  const refresh = () =>
    api.post<PacketView>(checkoutPath(claimId), {}).then(
      (packet) => setHold({ state: "held", packet }),
      (error: unknown) => setHold(holdOf(error)),
    );

  async function takeOver() {
    try {
      const packet = await api.post<PacketView>(checkoutPath(claimId), { takeOver: true });
      setHold({ state: "held", packet });
    } catch (error) {
      setHold(holdOf(error));
    } finally {
      setTakingOver(false);
    }
  }

  const payerName = hold.state === "held" ? hold.packet.payerName : null;
  return (
    <>
      <PageHeader
        title={payerName ? `Submit to ${payerName}` : "Submit a claim"}
        lede={payerName && !done ? `Enter each field in the ${payerName} portal, then record the reference it gives you.` : undefined}
      />
      <p>
        <Link href="/submit">Back to approved claims</Link>
      </p>
      {split ? (
        <div className="checklist-split">
          <BillSplit segments={split.segments} feeCents={split.feeCents} size="checklist" highlightClaimId={claimId} />
        </div>
      ) : null}

      {hold.state === "loading" ? <p className="muted">Loading the claim…</p> : null}

      {hold.state === "failed" ? (
        <Alert tone="danger" role="alert" title={hold.message}>
          <span className="retry-line">
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {hold.state === "closed" ? (
        <Alert tone="warning" title={hold.detail}>
          <Link href={claimPath(claimId)}>Open the claim</Link>
        </Alert>
      ) : null}

      {hold.state === "taken" ? (
        <Alert tone="warning" title={`Being submitted by ${hold.by}`}>
          <p>
            {hold.until ? `They hold this claim until ${formatDateTime(hold.until)}. ` : null}
            Take it over only if you know they've stopped.
          </p>
          <Button variant="secondary" size="sm" onClick={() => setTakingOver(true)}>
            Take over
          </Button>
        </Alert>
      ) : null}

      {hold.state === "taken" && takingOver ? (
        <Dialog
          open
          title="Take over this claim"
          description={`${hold.by} is working through this claim's checklist. If they've already entered it in the portal, it could be sent twice.`}
          onClose={() => setTakingOver(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setTakingOver(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={takeOver}>
                Take over the claim
              </Button>
            </>
          }
        />
      ) : null}

      {done ? <DoneNote done={done} claimId={claimId} /> : null}

      {hold.state === "held" && !done ? (
        <Checklist packet={hold.packet} onDone={setDone} onStale={refresh} />
      ) : null}
    </>
  );
}

function DoneNote({ done, claimId }: { done: Done; claimId: string }) {
  // The note replaces the checklist and its buttons, so focus moves here (QA N1). The DS Alert
  // doesn't take a ref, so the wrapper holds it.
  const noteRef = useFocusOnSettle<HTMLDivElement>(done);
  return (
    <div ref={noteRef} tabIndex={-1} className="settled-focus">
      <DoneWords done={done} claimId={claimId} />
    </div>
  );
}

function DoneWords({ done, claimId }: { done: Done; claimId: string }) {
  if (done.kind === "submitted") {
    return (
      <Alert tone="success" role="status">
        <p>
          Submitted with portal reference{" "}
          <code className="literal" translate="no">
            {done.reference}
          </code>
          .
        </p>
        <Link href="/submit">Back to approved claims</Link>
      </Alert>
    );
  }
  return (
    <Alert tone="info" role="status">
      <p>Recorded as refused by the portal. The claim is now rejected: reopen it to fix it and send it again.</p>
      <Link href={claimPath(claimId)}>Open the claim</Link>
    </Alert>
  );
}

interface ChecklistProps {
  packet: PacketView;
  onDone: (done: Done) => void;
  /** The claim changed since it was read: read it again. */
  onStale: () => void;
}

function Checklist({ packet, onDone, onStale }: ChecklistProps) {
  const id = useId();
  const [reference, setReference] = useState("");
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refusing, setRefusing] = useState(false);

  /** Every status change goes through the claim's own action route, at the version on screen. */
  async function act(action: ClaimAction): Promise<boolean> {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(actionsPath(packet.claimId), { action, expectedVersion: packet.version });
      return true;
    } catch (error) {
      const failed = failureOf(error);
      setFailure(failed);
      if (failed.reload) onStale();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function record(event: FormEvent) {
    event.preventDefault();
    const portalReference = reference.trim();
    if (portalReference === "") {
      setMissing(true);
      document.getElementById(`${id}-reference`)?.focus();
      return;
    }
    setMissing(false);
    if (await act({ kind: "submit", portalReference })) onDone({ kind: "submitted", reference: portalReference });
  }

  /** The refusal dialog and the reference form each start clean, never showing the other's failure (QA D10). */
  function startRefusing() {
    setFailure(null);
    setRefusing(true);
  }

  function stopRefusing() {
    setFailure(null);
    setRefusing(false);
  }

  async function refuse(message: string) {
    if (await act({ kind: "portal_refused", message })) {
      setRefusing(false);
      onDone({ kind: "refused" });
    }
  }

  return (
    <>
      <PacketFields packet={packet} />
      <Card>
        <form className="action-form" onSubmit={record} noValidate>
          {refusing ? null : <FailureAlert failure={failure} />}
          <Field label="Portal reference" htmlFor={`${id}-reference`}>
            <Input
              id={`${id}-reference`}
              name="portalReference"
              autoComplete="off"
              spellCheck={false}
              required
              maxLength={MAX_PORTAL_REFERENCE}
              value={reference}
              onChange={(event: { target: { value: string } }) => setReference(event.target.value)}
              invalid={missing}
              aria-invalid={missing}
              aria-describedby={`${id}-reference-note`}
            />
            <FieldNote id={`${id}-reference-note`} error={missing ? "Enter the reference the portal gave you." : undefined}>
              The reference the portal shows once it accepts the claim.
            </FieldNote>
          </Field>
          <div className="checklist-actions">
            <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>
              Record portal reference
            </Button>
            {/* type="button": inside the form, the design system's Button would send the reference again. */}
            <Button variant="secondary" type="button" onClick={startRefusing} disabled={busy}>
              Portal refused
            </Button>
          </div>
        </form>
      </Card>
      {refusing ? (
        <RefusalDialog busy={busy} failure={failure} onSend={refuse} onClose={stopRefusing} />
      ) : null}
    </>
  );
}

/**
 * A field's hint, or its error in place of the hint, with an id for the input's `aria-describedby`
 * (QA D20). The design system's Field draws its note without one, so a screen reader missed it.
 */
function FieldNote({ id, error, children }: { id: string; error?: string | undefined; children?: ReactNode }) {
  return (
    <span id={id} className={error ? "field-note field-note--error" : "field-note"}>
      {error ?? children}
    </span>
  );
}

/** The payer's fields in its template order, each copyable unless it is a withheld identifier (AC-4.2). */
function PacketFields({ packet }: { packet: PacketView }) {
  const headingId = useId();
  const [copied, setCopied] = useState("");

  async function copy(field: PacketFieldView) {
    try {
      await navigator.clipboard.writeText(field.text ?? "");
      setCopied(`Copied ${inSentence(field.label)}.`);
    } catch {
      setCopied(`${field.label} didn't copy. Select it and copy it yourself.`);
    }
  }

  return (
    <section className="packet" aria-labelledby={headingId}>
      <Card>
        <h2 id={headingId} className="packet__title">
          What to enter in the portal
        </h2>
        {packet.portalUrl ? (
          <p>
            <a href={packet.portalUrl} target="_blank" rel="noopener noreferrer">
              Open portal<span className="visually-hidden"> (opens in a new tab)</span>
            </a>
          </p>
        ) : null}
        <dl className="claim-facts packet__fields">
          {packet.fields.map((field) => (
            <div key={field.key}>
              <dt>{field.label}</dt>
              <dd>
                <FieldValue claimId={packet.claimId} field={field} onCopy={() => copy(field)} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="packet__copied muted" aria-live="polite">
          {copied}
        </p>
      </Card>
    </section>
  );
}

function FieldValue({ claimId, field, onCopy }: { claimId: string; field: PacketFieldView; onCopy: () => void }) {
  if (field.masked && field.revealField) {
    return <MaskedIdentifier claimId={claimId} field={field.revealField} masked={field.text ?? "Withheld"} label={inSentence(field.label)} />;
  }
  if (field.masked) return <span className="muted">Withheld</span>;
  if (field.text === null) return <span className="muted">Leave blank</span>;
  return (
    <span className="packet__value">
      <code className="literal" translate="no">
        {field.text}
      </code>
      <Button variant="ghost" size="sm" onClick={onCopy}>
        Copy<span className="visually-hidden"> {inSentence(field.label)}</span>
      </Button>
    </span>
  );
}

interface RefusalDialogProps {
  busy: boolean;
  failure: Failure | null;
  onSend: (message: string) => void;
  onClose: () => void;
}

/** AC-4.4: what the portal said when it refused the claim. The claim becomes rejected. */
function RefusalDialog({ busy, failure, onSend, onClose }: RefusalDialogProps) {
  const id = useId();
  const formId = `${id}-form`;
  const [message, setMessage] = useState("");
  const [missing, setMissing] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (text === "") {
      setMissing(true);
      document.getElementById(`${id}-message`)?.focus();
      return;
    }
    setMissing(false);
    onSend(text);
  };

  const error = missing ? "Enter the portal's message." : failure?.field === "message" ? failure.message : undefined;
  return (
    <Dialog
      open
      title="Record a portal refusal"
      description="The claim is marked rejected. Reopen it to fix it and send it again."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy} aria-busy={busy}>
            Record the refusal
          </Button>
        </>
      }
    >
      <form id={formId} className="action-form" onSubmit={submit} noValidate>
        <FailureAlert failure={failure?.field === "message" ? null : failure} />
        <Field label="What the portal said" htmlFor={`${id}-message`}>
          <Textarea
            id={`${id}-message`}
            name="message"
            autoComplete="off"
            rows={3}
            required
            maxLength={MAX_ACTION_TEXT}
            value={message}
            onChange={(event: { target: { value: string } }) => setMessage(event.target.value)}
            invalid={Boolean(error)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-message-note` : undefined}
          />
          {error ? <FieldNote id={`${id}-message-note`} error={error} /> : null}
        </Field>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ sending approved claims */

type Rows = { state: "loading" } | { state: "failed"; forbidden: boolean } | { state: "ready"; items: ClaimRow[]; next: string | null };

/** What one send answered, with the claims named as the officer saw them when they pressed Send. */
interface Sent {
  answer: SubmitResponse;
  names: ReadonlyMap<string, string>;
  versions: ReadonlyMap<string, number>;
}

/** Approved claims grouped by payer, in the order the server listed them. */
function byPayer(rows: readonly ClaimRow[]): { payerId: string; payerName: string; rows: ClaimRow[] }[] {
  const groups = new Map<string, { payerId: string; payerName: string; rows: ClaimRow[] }>();
  for (const row of rows) {
    const group = groups.get(row.payerId) ?? { payerId: row.payerId, payerName: row.payerName, rows: [] };
    group.rows.push(row);
    groups.set(row.payerId, group);
  }
  return [...groups.values()];
}

function SendApproved() {
  const [rows, setRows] = useState<Rows>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  useEffect(() => {
    let current = true;
    setRows({ state: "loading" });
    setSelected(new Set());
    api.get<ClaimListResponse>(APPROVED_PATH).then(
      (page) => current && setRows({ state: "ready", items: page.items, next: page.next }),
      (e: unknown) => current && setRows({ state: "failed", forbidden: e instanceof ApiError && e.status === 403 }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const toggle = (id: string) =>
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function send() {
    if (rows.state !== "ready") return;
    const chosen = rows.items.filter((row) => selected.has(row.id));
    if (chosen.length === 0) {
      setProblem("Select the claims to send first.");
      return;
    }
    if (chosen.length > MAX_BATCH_ITEMS) {
      setProblem(`Send up to ${MAX_BATCH_ITEMS} claims at a time. You've selected ${chosen.length}.`);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const items = chosen.map((row) => ({ id: row.id, version: row.version }));
      const answer = await api.post<SubmitResponse>("/api/submissions", { items });
      setSent({
        answer,
        names: new Map(chosen.map((row) => [row.id, nameOf(row)])),
        versions: new Map(items.map((item) => [item.id, item.version])),
      });
      // Claims that went out are no longer approved; the list shows what still waits.
      setAttempt((n) => n + 1);
    } catch (error) {
      setProblem(error instanceof ApiError && error.status === 403 ? "You don't have access to send claims." : "The claims weren't sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Submit claims" lede="Each claim goes to its payer the way it was approved to: the portal, a file or the payer's API." />
      {sent ? <SentResults sent={sent} onSubmitted={() => setAttempt((n) => n + 1)} /> : null}

      {rows.state === "loading" ? <p className="muted" aria-busy="true">Loading approved claims…</p> : null}

      {rows.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The approved claims didn't load.">
          {rows.forbidden ? (
            "Your account isn't on the desk's team list. Ask the clinic's administrator to add you."
          ) : (
            <span className="retry-line">
              Check your connection, then try again.
              <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </span>
          )}
        </Alert>
      ) : null}

      {rows.state === "ready" && rows.items.length === 0 ? (
        <Card className="empty-state">
          <h2 className="empty-state__title">No approved claims waiting</h2>
          <p className="muted">Claims show here once a reviewer approves them.</p>
          <p>
            <Link href="/claims">Open the claim queue</Link>
          </p>
        </Card>
      ) : null}

      {rows.state === "ready" && rows.items.length > 0 ? (
        <>
          {byPayer(rows.items).map((group) => (
            <section key={group.payerId} className="send-group" aria-labelledby={`send-${group.payerId}`}>
              <h2 id={`send-${group.payerId}`} className="send-group__title" translate="no">
                {group.payerName}
              </h2>
              <Card padding="0">
                <ul className="queue">
                  {group.rows.map((row) => (
                    <li key={row.id} className="claim-row">
                      <div className="claim-row__main">
                        <Checkbox
                          className="claim-row__select"
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                          label={<span className="visually-hidden">Select {nameOf(row)}</span>}
                        />
                        <Link className="claim-row__link" href={claimPath(row.id)}>
                          <code className="literal claim-row__patient" translate="no">
                            {row.patientMask}
                          </code>
                          <span className="claim-row__payer" translate="no">
                            {row.payerName}
                          </span>
                        </Link>
                        <MoneyCell cents={row.claimedCents} />
                      </div>
                      {row.deadline ? (
                        <div className="claim-row__meta">
                          <DeadlineText {...row.deadline} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          {rows.next ? (
            <p className="muted">
              {`These are the first ${MAX_CLAIMS_PAGE} approved claims. Send them, and the rest show here next.`}
            </p>
          ) : null}
          <div className="send-actions">
            <Button variant="primary" onClick={send} disabled={busy} aria-busy={busy}>
              Send selected
            </Button>
            <span className="muted" aria-live="polite">
              {selected.size > 0 ? `${plural(selected.size, "claim")} selected` : null}
            </span>
          </div>
          {problem ? <p className="send-actions__problem" role="alert">{problem}</p> : null}
        </>
      ) : null}
    </>
  );
}

/** Why a send failed, finishing the sentence "{claim} wasn't sent." */
function sendFailureWords(error: SendFailure): string {
  if (error === "timeout") return "The payer didn't answer in time. The claim is still approved, so you can send it again.";
  if (error === "network") return "The desk couldn't reach the payer. The claim is still approved, so you can send it again.";
  if (error === "redirect") return "The payer's API tried to send the desk somewhere else, and the desk doesn't follow that. Check the payer's API address.";
  if (error === "bad_response") return "The payer answered with something the desk doesn't understand. Check with the payer before you send it again.";
  if (error.startsWith("http_")) return `The payer answered with an error (${error.slice(5)}). The claim is still approved. Check with the payer before you send it again.`;
  return "The payer answered, but the claim changed on the desk meanwhile, so its reference wasn't recorded. Open the claim and check with the payer.";
}

/** Why the desk refused a claim, finishing the sentence "{claim} wasn't sent." */
function problemWords(problem: ProblemBody): string {
  if (typeof problem.detail === "string" && problem.detail.trim() !== "") return problem.detail;
  switch (problem.error) {
    case "stale":
      return "It changed since you selected it. Check it and send it again.";
    case "checked_out":
      return `${typeof problem.by === "string" ? problem.by : "Another officer"} is submitting it.`;
    case "forbidden":
      return "You don't have access to send it.";
    default:
      return "It can't be sent as it stands now. Open it to see why.";
  }
}

/** `onSubmitted` runs when claims stop waiting after the send, so the list can drop them (QA D17). */
function SentResults({ sent, onSubmitted }: { sent: Sent; onSubmitted: () => void }) {
  const nameOfId = (id: string) => sent.names.get(id) ?? id;
  // Take the officer to what happened, so a screen reader starts there too.
  const headingRef = useFocusOnSettle<HTMLHeadingElement>(sent);

  return (
    <section className="send-results" aria-labelledby="send-results-title">
      <Card>
        <h2 id="send-results-title" ref={headingRef} tabIndex={-1} className="send-results__title">
          What was sent
        </h2>
        {sent.answer.groups.map((group) => (
          <SentGroup
            key={`${group.kind}-${group.payerId}`}
            group={group}
            nameOfId={nameOfId}
            versions={sent.versions}
            onSubmitted={onSubmitted}
          />
        ))}
        {sent.answer.refused.length > 0 ? (
          <div className="send-results__group">
            <h3>Not sent</h3>
            <ul className="batch-failures">
              {sent.answer.refused.map((r) => (
                <li key={r.id}>
                  <code className="literal" translate="no">
                    {nameOfId(r.id)}
                  </code>{" "}
                  wasn't sent. {problemWords(r.error)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

interface SentGroupProps {
  group: SubmitGroup;
  nameOfId: (id: string) => string;
  versions: ReadonlyMap<string, number>;
  onSubmitted: () => void;
}

function SentGroup({ group, nameOfId, versions, onSubmitted }: SentGroupProps) {
  if (group.kind === "checklist") {
    return (
      <div className="send-results__group">
        <h3 translate="no">{group.payerName}</h3>
        <p>Enter each claim in the payer's portal from its checklist, then record the reference the portal gives you.</p>
        <ul className="send-results__list">
          {group.claimIds.map((id) => (
            <li key={id}>
              <Link href={submitPath(id)}>Open the checklist for {nameOfId(id)}</Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (group.kind === "file") return <ExportedFile group={group} nameOfId={nameOfId} versions={versions} onSubmitted={onSubmitted} />;
  return (
    <div className="send-results__group">
      <h3 translate="no">{group.payerName}</h3>
      <ul className="send-results__list">
        {group.results.map((result) =>
          result.ok ? (
            <li key={result.claimId}>
              <code className="literal" translate="no">
                {nameOfId(result.claimId)}
              </code>{" "}
              is submitted with reference{" "}
              <code className="literal" translate="no">
                {result.portalReference}
              </code>
              .
            </li>
          ) : result.portalReference ? (
            // The payer took it, but the desk couldn't record the answer; the claim's history keeps the send.
            <li key={result.claimId}>
              <code className="literal" translate="no">
                {nameOfId(result.claimId)}
              </code>{" "}
              reached the payer with reference{" "}
              <code className="literal" translate="no">
                {result.portalReference}
              </code>
              , but the desk couldn't record it, because the claim changed meanwhile. Open the claim and check with the payer
              before you send it again.
            </li>
          ) : (
            <li key={result.claimId}>
              <code className="literal" translate="no">
                {nameOfId(result.claimId)}
              </code>{" "}
              wasn't sent. {sendFailureWords(result.error)}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

type Upload = { state: "waiting" } | { state: "busy" } | { state: "failed" } | { state: "done"; answer: ConfirmExportResponse };

/** AC-4.5: the payer's file, and the officer's word that it was uploaded, which submits its claims. */
function ExportedFile({ group, nameOfId, versions, onSubmitted }: SentGroupProps & { group: Extract<SubmitGroup, { kind: "file" }> }) {
  const [upload, setUpload] = useState<Upload>({ state: "waiting" });
  // The count replaces the button that confirmed the upload, so focus moves to it (QA N1).
  const countRef = useFocusOnSettle<HTMLParagraphElement>(upload.state === "done");
  const href = `data:text/csv;charset=utf-8,${encodeURIComponent(group.csv)}`;

  async function confirm() {
    setUpload({ state: "busy" });
    try {
      const items = group.claimIds.map((id) => ({ id, version: versions.get(id) ?? 0 }));
      const answer = await api.post<ConfirmExportResponse>("/api/submissions/confirm", { batchRef: group.batchRef, items });
      setUpload({ state: "done", answer });
      // The confirmed claims are submitted now; a second file mustn't pick them up.
      onSubmitted();
    } catch {
      setUpload({ state: "failed" });
    }
  }

  return (
    <div className="send-results__group">
      <h3 translate="no">{group.payerName}</h3>
      <p>
        {`${plural(group.claimIds.length, "claim")} in one file. Download it and upload it to the payer, then come back and say so. The claims stay approved until you do.`}
      </p>
      <p>
        <a className="send-results__download" href={href} download={group.filename}>
          Download <span translate="no">{group.filename}</span>
        </a>
      </p>
      {upload.state === "done" ? (
        <>
          <p ref={countRef} tabIndex={-1} className="settled-focus" role="status">
            {`${plural(upload.answer.done.length, "claim")} marked submitted.`}
          </p>
          {upload.answer.failed.length > 0 ? (
            <ul className="batch-failures">
              {upload.answer.failed.map((f) => (
                <li key={f.id}>
                  <code className="literal" translate="no">
                    {nameOfId(f.id)}
                  </code>{" "}
                  wasn't marked submitted. {problemWords(f.error)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={confirm} disabled={upload.state === "busy"} aria-busy={upload.state === "busy"}>
            I've uploaded the file
          </Button>
          {upload.state === "failed" ? <p role="alert">That didn't go through. Try again.</p> : null}
        </>
      )}
    </div>
  );
}
