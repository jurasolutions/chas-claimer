import { useEffect, useState } from "react";
import type { ClaimListResponse, ClaimRow } from "../../api/claims";
import type { ImportSummary } from "../../api/imports";
import { describeFinding } from "../../domain/claims/findings";
import type { Finding } from "../../domain/types";
import { Alert, Button, Card, Checkbox } from "../../ds";
import { ApiError, api } from "../api";
import { BatchApprove, BatchFailures, type BatchOutcome, describeBatch, nameOf } from "../components/BatchApprove";
import { submitPath } from "../components/ClaimActions";
import { DeadlineText } from "../components/DeadlineText";
import { FindingList } from "../components/FindingList";
import { describeImport, LoadSyntheticClinic } from "../components/LoadSyntheticClinic";
import { MoneyCell } from "../components/MoneyCell";
import { PageHeader } from "../components/PageHeader";
import { QueueFilters } from "../components/QueueFilters";
import { StatusBadge } from "../components/StatusBadge";
import { useFocusOnSettle } from "../focus";
import { formatDate } from "../format";
import { useMe } from "../me";
import { Link, useLocation } from "../router";

type Rows = { state: "loading" } | { state: "failed"; forbidden: boolean } | { state: "ready"; items: ClaimRow[]; next: string | null };

/** Query parameters that page the queue rather than filter it. */
const PAGING = new Set(["cursor", "limit"]);

function claimsPath(search: string, cursor?: string): string {
  const params = new URLSearchParams(search);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return query ? `/api/claims?${query}` : "/api/claims";
}

const forbiddenOf = (e: unknown) => e instanceof ApiError && e.status === 403;

/**
 * The claim queue (block 02). Filters come from the query string, so Today's counts and any saved
 * link land on the same view; the server does the filtering and works out every deadline.
 */
export function Queue() {
  const me = useMe();
  const { search, query } = useLocation();
  const filtered = [...query.keys()].some((key) => !PAGING.has(key));

  const [rows, setRows] = useState<Rows>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const [loaded, setLoaded] = useState<ImportSummary | null>(null);
  // Reviewers tick ready claims to approve them together (AC-3.4); officers never see the boxes.
  const reviewer = me.roles.includes("reviewer");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batch, setBatch] = useState<BatchOutcome | null>(null);
  // The batch's button goes while the queue reloads, so its result takes the focus (QA 03 D02a).
  const batchRef = useFocusOnSettle<HTMLParagraphElement>(batch);

  useEffect(() => {
    let current = true;
    setRows({ state: "loading" });
    setMore("idle");
    setSelected(new Set());
    api.get<ClaimListResponse>(claimsPath(search)).then(
      (page) => current && setRows({ state: "ready", items: page.items, next: page.next }),
      (e: unknown) => current && setRows({ state: "failed", forbidden: forbiddenOf(e) }),
    );
    return () => {
      current = false;
    };
  }, [search, attempt]);

  async function showMore(cursor: string) {
    setMore("loading");
    try {
      const page = await api.get<ClaimListResponse>(claimsPath(search, cursor));
      setRows((now) => (now.state === "ready" ? { state: "ready", items: [...now.items, ...page.items], next: page.next } : now));
      setMore("idle");
    } catch {
      setMore("failed");
    }
  }

  function afterLoad(summary: ImportSummary) {
    setLoaded(summary);
    setAttempt((n) => n + 1);
  }

  function afterBatch(outcome: BatchOutcome) {
    setBatch(outcome);
    setAttempt((n) => n + 1);
  }

  const toggle = (id: string) =>
    setSelected((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chosen = rows.state === "ready" ? rows.items.filter((row) => selected.has(row.id)) : [];
  const selectable = rows.state === "ready" && reviewer && rows.items.some(approvable);

  return (
    <>
      <PageHeader title="Claims" />
      {/* Always present, so a screen reader announces the summary when it arrives. */}
      <p className="import-result muted" role="status">
        {loaded ? describeImport(loaded) : null}
      </p>
      <p ref={batchRef} tabIndex={-1} className="batch-result settled-focus" role="status">
        {batch ? describeBatch(batch) : null}
      </p>
      <BatchFailures outcome={batch} />
      <QueueFilters query={query} />

      {rows.state === "loading" ? (
        <p className="muted" aria-busy="true">
          Loading claims…
        </p>
      ) : null}

      {rows.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The claims didn't load.">
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
          {filtered ? (
            <>
              <h2 className="empty-state__title">No claims match these filters</h2>
              <p>
                <Link href="/claims">Show all open claims</Link>
              </p>
            </>
          ) : (
            <>
              <h2 className="empty-state__title">No claims waiting</h2>
              {me.demoMode ? (
                <>
                  <p className="muted">Load the synthetic clinic to see the desk with a month of made-up visits.</p>
                  <LoadSyntheticClinic onLoaded={afterLoad} />
                </>
              ) : (
                <p className="muted">Claims appear here once visits are imported from the clinic's records.</p>
              )}
            </>
          )}
        </Card>
      ) : null}

      {rows.state === "ready" && rows.items.length > 0 ? (
        <>
          {selectable ? <BatchApprove chosen={chosen} onSettled={afterBatch} /> : null}
          <Card padding="0">
            <ul className="queue">
              {rows.items.map((row) => (
                <ClaimRowItem
                  key={row.id}
                  row={row}
                  select={reviewer && approvable(row) ? { checked: selected.has(row.id), onToggle: () => toggle(row.id) } : undefined}
                />
              ))}
            </ul>
          </Card>
          {rows.next ? (
            <div className="queue__more">
              <Button variant="secondary" onClick={() => showMore(rows.next!)} disabled={more === "loading"} aria-busy={more === "loading"}>
                {more === "loading" ? "Loading more claims…" : "Show more claims"}
              </Button>
              {more === "failed" ? (
                <p className="queue__more-failed" role="alert">
                  More claims didn't load. Try again.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Only a ready claim can be approved; the server checks again when the batch arrives. */
const approvable = (row: ClaimRow) => row.status === "ready";

function fixCount(findings: readonly Finding[]): string {
  const blocking = findings.some((f) => f.severity === "blocking");
  const things = findings.length === 1 ? "1 thing" : `${findings.length} things`;
  return `${things} to ${blocking ? "fix" : "check"}`;
}

/**
 * One claim: who and which payer (the link), the amount, then status, visit date and deadline. On
 * a phone the second line wraps under the first instead of scrolling (docs/design.md, Queue).
 */
function ClaimRowItem({ row, select }: { row: ClaimRow; select?: { checked: boolean; onToggle: () => void } }) {
  return (
    <li className="claim-row">
      <div className="claim-row__main">
        {select ? (
          <Checkbox
            className="claim-row__select"
            checked={select.checked}
            onChange={select.onToggle}
            label={<span className="visually-hidden">Select {nameOf(row)}</span>}
          />
        ) : null}
        <Link className="claim-row__link" href={`/claims/${encodeURIComponent(row.id)}`}>
          <code className="literal claim-row__patient" translate="no">
            {row.patientMask}
          </code>
          <span className="claim-row__payer" translate="no">{row.payerName}</span>
        </Link>
        <MoneyCell cents={row.claimedCents} />
      </div>
      <div className="claim-row__meta">
        <StatusBadge status={row.status} />
        <span className="muted">
          Visit{" "}
          <time className="date" dateTime={row.visitDate}>
            {formatDate(row.visitDate)}
          </time>{" "}
          at <span translate="no">{row.branchName}</span>
        </span>
        {row.deadline ? <DeadlineText {...row.deadline} /> : null}
        {row.status === "approved" ? (
          <Link className="claim-row__submit" href={submitPath(row.id)}>
            Submit<span className="visually-hidden"> {nameOf(row)}</span>
          </Link>
        ) : null}
      </div>
      {row.findings.length > 0 ? (
        <details className="claim-row__findings">
          <summary>{fixCount(row.findings)}</summary>
          <FindingList findings={row.findings} describe={describeFinding} />
        </details>
      ) : null}
    </li>
  );
}
