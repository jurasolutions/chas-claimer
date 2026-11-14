import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { ManualMatchRequest, OpenClaimOption, RemittanceDetail, RemittanceLineView, RemittanceListItem, RemittanceRequest, RemittanceSummary } from "../../api/remittances";
import type { SettingsResponse } from "../../api/settings";
import { cents, formatSgd } from "../../domain/money";
import type { PayerSettings, RemittanceColumns } from "../../domain/settings";
import type { StatementColumn, StatementProblem } from "../../domain/statement";
import type { ClaimStatus } from "../../domain/types";
import { Alert, Button, Card, Field, Input, Select } from "../../ds";
import { api, ApiError } from "../api";
import { MoneyCell } from "../components/MoneyCell";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useFocusOnSettle } from "../focus";
import { formatDate, formatDateTime, plural } from "../format";
import { useMe } from "../me";
import { Link } from "../router";

export interface RemittancesProps {
  /** From the path `/payments/:id`; absent on `/payments`, the list of payment statements. */
  remittanceId?: string;
}

/** Why a read failed: no access, nothing at that address, or anything else (worth another try). */
type LoadFailure = "forbidden" | "not_found" | "failed";

type Loaded<T> = { state: "loading" } | { state: "failed"; why: LoadFailure } | { state: "ready"; value: T };

function loadFailureOf(error: unknown): LoadFailure {
  if (error instanceof ApiError && error.status === 403) return "forbidden";
  if (error instanceof ApiError && error.status === 404) return "not_found";
  return "failed";
}

/** A GET that reloads when `attempt` moves on, and ignores an answer that arrives after the page moved on. */
function useLoad<T>(path: string, attempt: number): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    api.get<T>(path).then(
      (value) => current && setLoaded({ state: "ready", value }),
      (error: unknown) => current && setLoaded({ state: "failed", why: loadFailureOf(error) }),
    );
    return () => {
      current = false;
    };
  }, [path, attempt]);
  return loaded;
}

/** A chosen file's text. `FileReader` rather than `Blob.text()`, which older browsers lack. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Payment statements (block 08): upload one, see the recent ones, and match what the desk could not. */
export function Remittances({ remittanceId }: RemittancesProps) {
  return remittanceId === undefined ? <PaymentsList /> : <Statement remittanceId={remittanceId} />;
}

const HOW_MATCHED: Record<NonNullable<RemittanceLineView["match"]>["kind"], string> = {
  reference: "By reference",
  patient_date_amount: "By patient, date and amount",
  manual: "By hand",
};

const CLOSED: Partial<Record<ClaimStatus, string>> = { paid: "is already paid", withdrawn: "was withdrawn", written_off: "was written off", rejected: "was rejected" };

/** Why the desk left a line for a person, and what to do with it. */
function noteWords(line: RemittanceLineView, payerName: string): string {
  const note = line.note;
  switch (note?.kind) {
    case "no_claim":
      return line.portalReference === null ? `No ${payerName} claim fits its patient, visit date and amount.` : `No ${payerName} claim carries this reference.`;
    case "not_a_payment":
      return `This line pays nothing or takes money back. Settle it with ${payerName} outside the desk.`;
    case "closed":
      return `${note.visitKey} ${CLOSED[note.status] ?? "is closed"}.`;
    case "taken":
      return `Another line of this file already paid ${note.visitKey}.`;
    case "several":
      return `More than one claim fits its patient, visit date and amount: ${joinAnd(note.claims.map((c) => c.visitKey))}. Choose the one it pays.`;
    case "fits":
      return `${note.visitKey} fits it now. Check it, then match.`;
    default:
      return "Choose the claim it pays.";
  }
}

/** A statement line's amount. A refund line carries a minus sign, which `MoneyCell` never shows. */
function LineAmount({ amountCents }: { amountCents: number }) {
  return amountCents < 0 ? <span className="money">−{formatSgd(cents(-amountCents))}</span> : <MoneyCell cents={cents(amountCents)} />;
}

function claimOption(c: OpenClaimOption): { value: string; label: string } {
  const parts = [c.visitKey, c.patientMask, formatDate(c.visitDate), formatSgd(c.acceptedCents ?? c.claimedCents)];
  return { value: c.claimId, label: (c.portalReference ? [...parts, c.portalReference] : parts).join(" · ") };
}

/** The claim to offer first: the one that fits the line now, if the desk found one. */
function suggested(line: RemittanceLineView): string {
  return line.note?.kind === "fits" ? line.note.claimId : "";
}

/** Why a match didn't go through, and whether the statement should be read again (technical §6: the page owns the words). */
function matchRefusal(error: unknown, lineNo: number, visitKey: string): { message: string; reload: boolean } {
  const unreachable = { message: `Line ${lineNo} wasn't matched. Check your connection, then try again.`, reload: false };
  if (!(error instanceof ApiError)) return unreachable;
  switch (error.code) {
    case "stale":
      return { message: `${visitKey} changed while you were looking. The statement has been reloaded: check the claim, then match again.`, reload: true };
    case "not_allowed":
    case "not_found":
      return { message: `Line ${lineNo} can't pay ${visitKey} as things stand. The statement has been reloaded.`, reload: true };
    case "checked_out": {
      const by = typeof error.body.by === "string" ? error.body.by : "Someone";
      const until = typeof error.body.until === "string" ? ` Try again after ${formatDateTime(error.body.until)}.` : "";
      return { message: `${by} is submitting ${visitKey}.${until}`, reload: false };
    }
    case "forbidden":
      return { message: "You don't have access to do that.", reload: false };
    default:
      return unreachable;
  }
}

function Statement({ remittanceId }: { remittanceId: string }) {
  const [attempt, setAttempt] = useState(0);
  const path = `/api/remittances/${encodeURIComponent(remittanceId)}`;
  const loaded = useLoad<RemittanceDetail>(path, attempt);
  const settings = useLoad<SettingsResponse>("/api/settings", 0);
  // A match answers with the whole statement again; it stands in for the load until the next reload.
  const [answered, setAnswered] = useState<{ attempt: number; detail: RemittanceDetail } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // A confirmed match takes its line and buttons away, so focus moves to the result (QA N1).
  const resultRef = useFocusOnSettle<HTMLParagraphElement>(announcement);

  /** Reads the statement again in place, so a line's refusal stays on screen beside the fresh claims. */
  function reread() {
    api.get<RemittanceDetail>(path).then(
      (detail) => setAnswered({ attempt, detail }),
      () => undefined, // The refusal already on screen says what to do; the page keeps what it had.
    );
  }

  if (loaded.state !== "ready") {
    return (
      <>
        <PageHeader title="Payment statement" actions={<Link href="/payments">All payments</Link>} />
        {loaded.state === "loading" ? (
          <p className="muted">Loading the statement…</p>
        ) : (
          <Alert tone="danger" role="alert" title="The statement didn't load.">
            {loaded.why === "forbidden" ? (
              "Your account isn't on the desk's team list. Ask the clinic's administrator to add you."
            ) : loaded.why === "not_found" ? (
              <>
                There is no payment statement at this address. <Link href="/payments">Back to all payments</Link>
              </>
            ) : (
              <span className="retry-line">
                Check your connection, then try again.
                <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              </span>
            )}
          </Alert>
        )}
      </>
    );
  }
  const { remittance, lines, openClaims } = answered?.attempt === attempt ? answered.detail : loaded.value;
  const payerName = (settings.state === "ready" ? settings.value.settings.payers.find((p) => p.id === remittance.payerId)?.name : undefined) ?? remittance.payerId;
  const matched = lines.filter((l) => l.match !== null);
  const waiting = lines.filter((l) => l.match === null);

  return (
    <>
      <PageHeader
        title={remittance.fileName}
        lede={
          <>
            {payerName}, imported{" "}
            <time dateTime={remittance.importedAt}>{formatDateTime(remittance.importedAt)}</time>. {remittance.matched} of {plural(remittance.lines, "line")} matched.
          </>
        }
        actions={<Link href="/payments">All payments</Link>}
      />

      <p ref={resultRef} tabIndex={-1} className="statement-result settled-focus" role="status">
        {announcement}
      </p>

      {waiting.length > 0 ? (
        <section className="statement-waiting" aria-labelledby="statement-waiting">
          <h2 id="statement-waiting">Match by hand</h2>
          <Card padding="0">
            <ul className="statement-waiting__list">
              {waiting.map((line) => (
                <WaitingLine
                  key={line.lineNo}
                  line={line}
                  payerName={payerName}
                  openClaims={openClaims}
                  matchPath={`${path}/lines/${line.lineNo}/match`}
                  onMatched={(detail, visitKey) => {
                    setAnswered({ attempt, detail });
                    setAnnouncement(`Line ${line.lineNo} now pays ${visitKey}.`);
                  }}
                  onStale={reread}
                />
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {matched.length > 0 ? <PaidTable lines={matched} /> : null}
    </>
  );
}

interface WaitingLineProps {
  line: RemittanceLineView;
  payerName: string;
  openClaims: OpenClaimOption[];
  matchPath: string;
  onMatched: (detail: RemittanceDetail, visitKey: string) => void;
  /** The claim or line moved on since the page loaded: read the statement again. */
  onStale: () => void;
}

/** What a claim still waits on: the accepted amount (or the claimed one before a decision), less what was paid. */
const owedOn = (c: OpenClaimOption) => cents(Math.max(0, (c.acceptedCents ?? c.claimedCents) - c.paidCents));

/**
 * One line the desk left for a person: why, and (when it pays something) the claim to match it to. A
 * match records a payment, so the line names the claim and the amount and waits for a confirm first.
 */
function WaitingLine({ line, payerName, openClaims, matchPath, onMatched, onStale }: WaitingLineProps) {
  const id = useId();
  const [claimId, setClaimId] = useState(() => suggested(line));
  /** The claim a person chose, held while they confirm; null while they choose. */
  const [confirming, setConfirming] = useState<OpenClaimOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const payable = line.note?.kind !== "not_a_payment";
  const lineRef = useRef<HTMLLIElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const asked = useRef(false);

  // Focus follows the step: to the question when it opens, back to "Match line" when it closes.
  useEffect(() => {
    if (confirming) questionRef.current?.focus();
    else if (asked.current) lineRef.current?.querySelector<HTMLButtonElement>("button[type=submit]")?.focus();
    asked.current = confirming !== null;
  }, [confirming]);

  function choose(event: FormEvent) {
    event.preventDefault();
    const claim = openClaims.find((c) => c.claimId === claimId);
    if (!claim) return;
    setProblem(null);
    setConfirming(claim);
  }

  async function confirm() {
    const claim = confirming;
    if (!claim || busy) return;
    setBusy(true);
    try {
      const body: ManualMatchRequest = { claimId: claim.claimId, expectedVersion: claim.version };
      onMatched(await api.post<RemittanceDetail>(matchPath, body), claim.visitKey);
    } catch (error) {
      const refusal = matchRefusal(error, line.lineNo, claim.visitKey);
      setProblem(refusal.message);
      setBusy(false);
      setConfirming(null);
      if (refusal.reload) onStale();
    }
  }

  return (
    <li ref={lineRef} className="statement-waiting__line" role="group" aria-labelledby={id}>
      <div className="statement-waiting__head">
        <h3 id={id}>Line {line.lineNo}</h3>
        {line.portalReference ? (
          <code className="literal" translate="no">
            {line.portalReference}
          </code>
        ) : null}
        {line.visitDate ? (
          <span className="muted">
            Visit{" "}
            <time className="date" dateTime={line.visitDate}>
              {formatDate(line.visitDate)}
            </time>
          </span>
        ) : null}
        <LineAmount amountCents={line.amountCents} />
      </div>
      <p className="statement-waiting__note">{noteWords(line, payerName)}</p>
      {payable ? (
        <form className="statement-waiting__form" onSubmit={choose}>
          <Field label={`Claim line ${line.lineNo} pays`} htmlFor={`${id}-claim`}>
            <Select
              id={`${id}-claim`}
              placeholder={openClaims.length > 0 ? "Choose the claim" : "No open claims"}
              options={openClaims.map(claimOption)}
              value={claimId}
              disabled={confirming !== null}
              onChange={(e: { target: { value: string } }) => setClaimId(e.target.value)}
            />
          </Field>
          {confirming ? (
            <div className="statement-waiting__confirm">
              <p ref={questionRef} tabIndex={-1} className="statement-waiting__question">
                Record line {line.lineNo}'s <LineAmount amountCents={line.amountCents} /> as paid to {confirming.visitKey}?
              </p>
              <p className="statement-waiting__claim muted">
                {confirming.visitKey} is for{" "}
                <code className="literal" translate="no">
                  {confirming.patientMask}
                </code>
                's visit on{" "}
                <time className="date" dateTime={confirming.visitDate}>
                  {formatDate(confirming.visitDate)}
                </time>
                , with <MoneyCell cents={owedOn(confirming)} /> still owed.
              </p>
              <div className="statement-waiting__actions">
                <Button type="button" onClick={confirm} disabled={busy} aria-busy={busy}>
                  {busy ? "Matching…" : "Confirm match"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button type="submit" variant="secondary" disabled={!claimId}>
              Match line {line.lineNo}
            </Button>
          )}
          {problem ? (
            <Alert tone="danger" role="alert">
              {problem}
            </Alert>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

/** The lines the desk or a person recorded as payments, one claim each. Scrolls sideways in its own box on a phone. */
function PaidTable({ lines }: { lines: RemittanceLineView[] }) {
  return (
    <div className="table-scroll" role="region" aria-labelledby="statement-paid" tabIndex={0}>
      <table className="statement-lines">
        <caption id="statement-paid">Paid claims</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Reference</th>
            <th scope="col" className="num">
              Amount
            </th>
            <th scope="col">Claim</th>
            <th scope="col">How matched</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {lines.map(({ lineNo, portalReference, amountCents, match }) =>
            match ? (
              <tr key={lineNo}>
                <td>{lineNo}</td>
                <td>
                  {portalReference ? (
                    <code className="literal" translate="no">
                      {portalReference}
                    </code>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  <LineAmount amountCents={amountCents} />
                </td>
                <td>
                  <Link href={`/claims/${encodeURIComponent(match.claimId)}`}>{match.visitKey}</Link>
                </td>
                <td>{HOW_MATCHED[match.kind]}</td>
                <td>
                  <span className="statement-lines__status">
                    <StatusBadge status={match.status} />
                    {/* Still accepted after its payment: the payer paid less, and a person decides on the claim (AC-5.3). */}
                    {match.status === "accepted" ? (
                      <Link href={`/claims/${encodeURIComponent(match.claimId)}`}>
                        Paid less than accepted<span className="visually-hidden"> for {match.visitKey}</span>
                      </Link>
                    ) : null}
                  </span>
                </td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </div>
  );
}

function PaymentsList() {
  const [attempt, setAttempt] = useState(0);
  const list = useLoad<{ items: RemittanceListItem[] }>("/api/remittances", attempt);
  const settings = useLoad<SettingsResponse>("/api/settings", 0);
  const payers: PayerSettings[] = settings.state === "ready" ? settings.value.settings.payers : [];
  const payerName = (id: string) => payers.find((p) => p.id === id)?.name ?? id;
  const [summary, setSummary] = useState<RemittanceSummary | null>(null);
  // Upload statement is disabled while it runs, so the result takes focus (QA 03 D02e).
  const resultRef = useFocusOnSettle<HTMLParagraphElement>(summary);

  function afterUpload(done: RemittanceSummary) {
    setSummary(done);
    setAttempt((n) => n + 1);
  }

  return (
    <>
      <PageHeader title="Payments" />
      <UploadStatement payers={payers} onUploaded={afterUpload} />
      <p ref={resultRef} tabIndex={-1} className="statement-result settled-focus" role="status">
        {summary ? <UploadSummary summary={summary} /> : null}
      </p>

      {list.state === "loading" ? <p className="muted">Loading statements…</p> : null}

      {list.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The payment statements didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {list.state === "ready" && list.value.items.length > 0 ? (
        <Card padding="0">
          <ul className="imports">
            {list.value.items.map((item) => (
              <li key={item.id} className="import-row">
                <div className="import-row__head">
                  <Link href={`/payments/${encodeURIComponent(item.id)}`}>{item.fileName}</Link>
                  <time className="date muted" dateTime={item.importedAt}>
                    {formatDateTime(item.importedAt)}
                  </time>
                </div>
                <span>{payerName(item.payerId)}</span>
                <span className="muted">
                  {item.matched} of {plural(item.lines, "line")} matched
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function UploadSummary({ summary }: { summary: RemittanceSummary }) {
  if (summary.outcome === "empty") return <>No payment lines in this file. Nothing was changed.</>;
  const open = <Link href={`/payments/${encodeURIComponent(summary.remittanceId)}`}>Open the statement</Link>;
  if (summary.outcome === "already_imported") return <>This statement was imported before. Nothing was added. {open}</>;
  return (
    <>
      Read {plural(summary.lines, "payment line")}: {summary.matched} recorded as paid, {summary.forPerson} to match by hand. {open}
    </>
  );
}

/** "1", "1 and 3", "1, 2 and 3" (or "or"). */
function joinAnd(items: readonly (string | number)[], word = "and"): string {
  const words = items.map(String);
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} ${word} ${words.at(-1)}`;
}

function problemWords(problem: StatementProblem): string {
  switch (problem.kind) {
    case "missing_columns":
      return `The file has no ${joinAnd(problem.headers, "or")} column. Check you chose the right payer, or ask a reviewer to update the column names.`;
    case "bad_lines":
      return `Some lines don't read: ${problem.lines.map((l) => `line ${l.lineNo} (${l.column})`).join(", ")}. Correct them in the file, then upload it again. Dates are YYYY-MM-DD.`;
    case "too_many_lines":
      return `The file has more than ${problem.maxLines} payment lines. Split it into smaller files, then upload each.`;
    case "malformed":
      return "The file isn't a CSV the desk can read. Save it from the payer's portal as CSV, then upload it again.";
  }
}

/** Why an upload was refused, in words that say what to do next. Names headers and line numbers, never a value from the file. */
function refusalWords(error: unknown, payerName: (id: string) => string, confirmed: boolean): string {
  if (!(error instanceof ApiError)) return "The statement didn't upload. Nothing was changed. Try again in a moment.";
  const body = error.body as Record<string, unknown>;
  switch (error.code) {
    case "columns_not_mapped":
      return `${payerName(String(body.payerId))}'s statement columns aren't mapped yet. Ask a reviewer to map them, then upload again.`;
    case "statement_unreadable":
      return problemWords(body.problem as StatementProblem);
    case "real_identifier_refused": {
      const lines = Array.isArray(body.lines) ? (body.lines as number[]) : [];
      const which = lines.length === 1 ? `Line ${lines[0]} carries a real NRIC` : lines.length > 1 ? `Lines ${joinAnd(lines)} carry real NRICs` : "The file carries real NRICs";
      return `${which}. This desk takes synthetic records only, so nothing was imported.`;
    }
    case "too_large":
      return "The file is too large to upload. Split it into smaller files, then upload each.";
    case "forbidden":
      return confirmed ? "Only a reviewer can import a possible duplicate." : "Only a reviewer can change a payer's statement columns.";
    default:
      return "The statement didn't upload. Nothing was changed. Try again in a moment.";
  }
}

/** Each column of a statement as the reviewer names it, in the file's usual order. */
const COLUMN_FIELDS: readonly { key: StatementColumn; label: string }[] = [
  { key: "reference", label: "Claim reference column" },
  { key: "patientNric", label: "Patient NRIC column" },
  { key: "visitDate", label: "Visit date column" },
  { key: "amount", label: "Amount column" },
  { key: "paidOn", label: "Paid on column" },
];

type ColumnText = Record<StatementColumn, string>;

function columnText(columns: RemittanceColumns | null): ColumnText {
  return {
    reference: columns?.reference ?? "",
    patientNric: columns?.patientNric ?? "",
    visitDate: columns?.visitDate ?? "",
    amount: columns?.amount ?? "",
    paidOn: columns?.paidOn ?? "",
  };
}

/** A blank field is a column the file doesn't have. */
function columnsOf(text: ColumnText): RemittanceColumns {
  const header = (key: StatementColumn) => text[key].trim() || null;
  return { reference: header("reference"), patientNric: header("patientNric"), visitDate: header("visitDate"), amount: text.amount.trim(), paidOn: header("paidOn") };
}

function ColumnField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} className="literal" spellCheck={false} autoComplete="off" value={value} onChange={(e: { target: { value: string } }) => onChange(e.target.value)} />
    </Field>
  );
}

function UploadStatement({ payers, onUploaded }: { payers: PayerSettings[]; onUploaded: (summary: RemittanceSummary) => void }) {
  const id = useId();
  const canMap = useMe().roles.includes("reviewer");
  const [payerId, setPayerId] = useState("");
  const [columns, setColumns] = useState<ColumnText>(columnText(null));
  const payer = payers.find((p) => p.id === payerId);
  const mapped = canMap ? columns.amount.trim() !== "" : payer?.remittanceColumns != null;
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The earlier statement this file may repeat, from before the identifier key changed (review B1). */
  const [lookalike, setLookalike] = useState<{ remittanceId: string; fileName: string } | null>(null);
  // Goes up with each refusal. The button that sent the file was disabled while it ran, so the
  // refusal takes focus, even when it says the same as the last one (QA 03 D02e).
  const [refused, setRefused] = useState(0);
  const refusedRef = useFocusOnSettle<HTMLDivElement>(refused);
  const payerName = (pid: string) => payers.find((p) => p.id === pid)?.name ?? pid;

  function choosePayer(id: string) {
    setPayerId(id);
    setColumns(columnText(payers.find((p) => p.id === id)?.remittanceColumns ?? null));
    setLookalike(null);
  }

  function chooseFile(chosen: File | null) {
    setFile(chosen);
    setLookalike(null);
  }

  /** Sends the chosen file; `confirmed` is a reviewer's word that a possible duplicate is a different statement. */
  async function send(confirmed: boolean) {
    if (!payerId || !file || !mapped) return;
    setBusy(true);
    setRefusal(null);
    setLookalike(null);
    try {
      const body: RemittanceRequest = {
        payerId,
        fileName: file.name,
        csv: await readText(file),
        ...(canMap ? { columns: columnsOf(columns) } : {}),
        ...(confirmed ? { confirmPossibleDuplicate: true } : {}),
      };
      onUploaded(await api.post<RemittanceSummary>("/api/remittances", body));
    } catch (error) {
      if (error instanceof ApiError && error.code === "possible_duplicate") {
        setLookalike({ remittanceId: String((error.body as Record<string, unknown>).remittanceId), fileName: file.name });
      } else {
        setRefusal(refusalWords(error, payerName, confirmed));
      }
      setRefused((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  return (
    <Card className="statement-upload">
      <form onSubmit={submit}>
        <Field label="Payer" htmlFor={`${id}-payer`}>
          <Select
            id={`${id}-payer`}
            placeholder="Choose the payer"
            options={payers.map((p) => ({ value: p.id, label: p.name }))}
            value={payerId}
            onChange={(e: { target: { value: string } }) => choosePayer(e.target.value)}
          />
        </Field>
        {payer && canMap ? (
          <fieldset className="statement-columns">
            <legend>Statement columns</legend>
            <p className="settings-field__hint">The header of each column in {payer.name}'s file. Leave a column blank if the file doesn't have it. The amount column is needed.</p>
            <div className="statement-columns__grid">
              {COLUMN_FIELDS.map((f) => (
                <ColumnField key={f.key} label={f.label} value={columns[f.key]} onChange={(value) => setColumns((c) => ({ ...c, [f.key]: value }))} />
              ))}
            </div>
          </fieldset>
        ) : null}
        {payer && !canMap && !mapped ? <p className="settings-field__hint">A reviewer maps this payer's statement columns before its first upload.</p> : null}
        <Field label="Statement file" htmlFor={`${id}-file`}>
          <input id={`${id}-file`} name="statement" type="file" accept=".csv,text/csv" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
        </Field>
        {refusal || lookalike ? (
          <div ref={refusedRef} tabIndex={-1} className="settled-focus">
            {refusal ? (
              <Alert tone="danger" role="alert" title="The statement wasn't imported.">
                {refusal}
              </Alert>
            ) : null}
            {lookalike ? (
              <Alert tone="warning" role="alert" title="The statement wasn't imported.">
                <p>
                  {payerName(payerId)} already has a statement called <span className="literal" translate="no">{lookalike.fileName}</span> with the same number of lines, taken in before the
                  identifier key changed. The desk can't tell whether this is the same file, so nothing was imported.{" "}
                  <Link href={`/payments/${encodeURIComponent(lookalike.remittanceId)}`}>Open the earlier statement</Link> to compare.
                </p>
                {canMap ? (
                  <span className="retry-line">
                    If this one is different, you can import it anyway.
                    <Button type="button" variant="secondary" size="sm" onClick={() => void send(true)} disabled={busy} aria-busy={busy}>
                      Import anyway
                    </Button>
                  </span>
                ) : (
                  <p>If this one is different, ask a reviewer to import it.</p>
                )}
              </Alert>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" disabled={busy || !payerId || !file || !mapped}>
          Upload statement
        </Button>
      </form>
    </Card>
  );
}
