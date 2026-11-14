import type { SubmissionView } from "../../api/claim-detail";
import { formatDateTime } from "../format";
import { CHANNEL, who } from "./ClaimHistory";

/** One attempt in a line: its number, the channel, then the portal reference or that it failed. */
function attemptWords(s: SubmissionView): string {
  const how = CHANNEL[s.channel] ? ` ${CHANNEL[s.channel]}` : "";
  const outcome =
    s.result === "failed"
      ? ": it didn't go through"
      : s.portalReference
        ? `, reference ${s.portalReference}`
        : s.result === "exported"
          ? ", file exported"
          : "";
  return `Attempt ${s.attempt}${how}${outcome}`;
}

/**
 * Each time the claim went to its payer, oldest first. A failed attempt carries the channel's own
 * message, so a person can tell a refused claim from a portal that was down.
 */
export function ClaimSubmissions({ submissions }: { submissions: readonly SubmissionView[] }) {
  if (submissions.length === 0) return null;
  return (
    <section className="claim-detail__submissions" aria-labelledby="claim-submissions">
      <h2 id="claim-submissions">Submissions</h2>
      <ol className="claim-history" aria-label="Submissions">
        {[...submissions]
          .sort((a, b) => a.attempt - b.attempt)
          .map((s) => (
            <li key={s.id} className="claim-history__event">
              <p className="claim-history__what">{attemptWords(s)}</p>
              {s.result === "failed" && s.error ? <p className="claim-history__error">{s.error}</p> : null}
              <p className="claim-history__who muted">
                {who(s.actor)} · <time dateTime={s.at}>{formatDateTime(s.at)}</time>
              </p>
            </li>
          ))}
      </ol>
    </section>
  );
}
