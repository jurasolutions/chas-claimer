import { useEffect, useState } from "react";
import type { ImportListItem, ImportListResponse, ImportSummary } from "../../api/imports";
import type { ImportSource } from "../../domain/types";
import { Alert, Button, Card } from "../../ds";
import { api } from "../api";
import { describeImport, LoadSyntheticClinic } from "../components/LoadSyntheticClinic";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { useMe } from "../me";

type List = { state: "loading" } | { state: "failed" } | { state: "ready"; items: ImportListItem[] };

const SOURCE: Record<ImportSource, string> = {
  connector: "Clinic records",
  synthetic: "Synthetic clinic",
  upload: "Uploaded file",
};

const COUNTS = [
  ["received", "Received"],
  ["new", "New"],
  ["changed", "Changed"],
  ["unchanged", "Unchanged"],
  ["ignored", "Ignored"],
  ["flagged", "Flagged"],
  ["refused", "Refused"],
] as const satisfies readonly (readonly [keyof ImportListItem, string])[];

/** Recent imports (block 02), newest first as the server returns them, each with its counts. */
export function Imports() {
  const me = useMe();
  const [list, setList] = useState<List>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<ImportSummary | null>(null);

  useEffect(() => {
    let current = true;
    setList({ state: "loading" });
    api.get<ImportListResponse>("/api/imports").then(
      (page) => current && setList({ state: "ready", items: page.items }),
      () => current && setList({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  function afterLoad(summary: ImportSummary) {
    setLoaded(summary);
    setAttempt((n) => n + 1);
  }

  return (
    <>
      <PageHeader title="Import visits" />
      <p className="import-result muted" role="status">
        {loaded ? describeImport(loaded) : null}
      </p>

      {list.state === "loading" ? <p className="muted">Loading imports…</p> : null}

      {list.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The imports didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {list.state === "ready" && list.items.length === 0 ? (
        <Card className="empty-state">
          <h2 className="empty-state__title">No imports yet</h2>
          {me.demoMode ? (
            <>
              <p className="muted">Load the synthetic clinic to see the desk with a month of made-up visits.</p>
              <LoadSyntheticClinic onLoaded={afterLoad} />
            </>
          ) : (
            <p className="muted">Imports list here once visits come in from the clinic's records.</p>
          )}
        </Card>
      ) : null}

      {list.state === "ready" && list.items.length > 0 ? (
        <Card padding="0">
          <ul className="imports">
            {list.items.map((item) => (
              <li key={item.id} className="import-row">
                <div className="import-row__head">
                  <strong className="import-row__source">{SOURCE[item.source]}</strong>
                  <time className="date muted" dateTime={item.startedAt}>
                    {formatDateTime(item.startedAt)}
                  </time>
                </div>
                <dl className="import-row__counts">
                  {COUNTS.map(([key, label]) => (
                    <div key={key} className="import-row__count">
                      <dt>{label}</dt>
                      <dd className="import-row__figure">{item[key]}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
