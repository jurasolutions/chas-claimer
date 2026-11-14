import { useEffect, useState } from "react";
import type { OverviewResponse } from "../../api/overview";
import { cents } from "../../domain/money";
import { CLAIM_STATUSES } from "../../domain/types";
import { Alert, Button, Card, Icon } from "../../ds";
import { api } from "../api";
import { MoneyCell } from "../components/MoneyCell";
import { PageHeader } from "../components/PageHeader";
import { statusWords } from "../components/StatusBadge";
import { followLink, Link } from "../router";

type Counts = { state: "loading" } | { state: "failed" } | { state: "ready"; overview: OverviewResponse };

/** "1 claim", "3 claims". */
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const queue = (params: Record<string, string>) => `/claims?${new URLSearchParams(params).toString()}`;

/** The sentence of counts that each lead to work (docs/design.md, Layout). */
function Sentence({ overview }: { overview: OverviewResponse }) {
  const { byStatus, chasDueSoon } = overview;
  return (
    <>
      <Link href={queue({ status: "needs_attention" })}>{plural(byStatus.needs_attention, "needs attention", "need attention")}</Link>,{" "}
      <Link href={queue({ status: "ready" })}>{`${byStatus.ready} ready`}</Link>,{" "}
      <Link href={queue({ scheme: "chas", due: String(chasDueSoon.days) })}>
        {`${plural(chasDueSoon.count, "CHAS claim", "CHAS claims")} due in ${chasDueSoon.days} days`}
      </Link>
      .
    </>
  );
}

function ByStatus({ byStatus }: { byStatus: OverviewResponse["byStatus"] }) {
  return (
    <section className="today__section" aria-labelledby="today-status">
      <h2 id="today-status" className="today__heading">
        Claims by status
      </h2>
      <Card padding="0">
        <ul className="today-list">
          {CLAIM_STATUSES.map((status) => (
            <li key={status}>
              <Link className="today-list__row" href={queue({ status })}>
                <span>{statusWords(status)}</span> <span className="today-list__figure">{byStatus[status]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function WaitingOnPayers({ overview }: { overview: OverviewResponse }) {
  const { outstandingByPayer, paymentStatements, unmatchedRemittanceLines } = overview;
  return (
    <section className="today__section" aria-labelledby="today-payers">
      <h2 id="today-payers" className="today__heading">
        Waiting on payers
      </h2>
      <Card padding="0">
        {outstandingByPayer.length === 0 ? (
          <p className="today-list__empty muted">Nothing is waiting on a payer.</p>
        ) : (
          <ul className="today-list">
            {outstandingByPayer.map((payer) => (
              <li key={payer.payerId} className="today-list__row">
                <span className="today-list__payer">
                  <Link href={queue({ payer: payer.payerId, status: "submitted,accepted" })} translate="no">
                    {payer.payerName}
                  </Link>
                  <span className="muted">{plural(payer.claims, "claim", "claims")}</span>
                </span>
                <MoneyCell cents={cents(payer.cents)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="today__remittances">
        {unmatchedRemittanceLines > 0 ? (
          <Link href="/payments">{`${plural(unmatchedRemittanceLines, "remittance line", "remittance lines")} matched no claim`}</Link>
        ) : paymentStatements === 0 ? (
          // With no statement on file there is nothing to match, so claim no match (QA D04).
          <span className="muted">No payment statements yet.</span>
        ) : (
          <span className="muted">Every remittance line matched a claim.</span>
        )}
      </p>
    </section>
  );
}

/**
 * Today (functional AC-8.3): a sentence of counts that each lead into the filtered queue, then
 * every status, what each payer still owes and remittance lines no claim matched. No KPI tiles
 * (docs/design.md, Review against the brief). The server does every count.
 */
export function Overview() {
  const [counts, setCounts] = useState<Counts>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setCounts({ state: "loading" });
    api.get<OverviewResponse>("/api/overview").then(
      (overview) => current && setCounts({ state: "ready", overview }),
      () => current && setCounts({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <>
      <PageHeader
        title="Today"
        lede={counts.state === "ready" ? <Sentence overview={counts.overview} /> : null}
        actions={
          <Button href="/imports" onClick={followLink} iconLeft={<Icon name="file-up" size={16} />}>
            Import visits
          </Button>
        }
      />

      {counts.state === "loading" ? <p className="muted">Counting today's claims…</p> : null}

      {counts.state === "failed" ? (
        <Alert tone="danger" role="alert" title="Today's counts didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {counts.state === "ready" ? (
        <div className="today">
          <ByStatus byStatus={counts.overview.byStatus} />
          <WaitingOnPayers overview={counts.overview} />
        </div>
      ) : null}
    </>
  );
}
