import type { Finding, Severity } from "../../domain/types";
import { Icon } from "../../ds";

interface FindingListProps {
  findings: readonly Finding[];
  /**
   * Turns a finding into a sentence that says what to do. The wording lives in the finding
   * catalogue (`src/domain/claims/findings.ts`, blocks 02 and 03), so the page passes it in.
   */
  describe: (finding: Finding) => string;
  /**
   * The claim is past the point of fixing (sent, paid, withdrawn or written off), so the findings
   * are a record of what the checks found and no longer say whether they block submission (D07).
   */
  settled?: boolean;
}

const SEVERITY: Record<Severity, { words: string; icon: string; rank: number }> = {
  blocking: { words: "Blocks submission", icon: "circle-alert", rank: 0 },
  warning: { words: "Check before submitting", icon: "triangle-alert", rank: 1 },
};

/** A claim's findings, blocking first, each saying what to do (docs/design.md, Principles). */
export function FindingList({ findings, describe, settled = false }: FindingListProps) {
  if (findings.length === 0) return <p className="muted">{settled ? "The checks found nothing on this claim." : "Nothing to fix on this claim."}</p>;

  const ordered = [...findings].sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
  return (
    <ul className="finding-list">
      {ordered.map((finding, i) => {
        const severity = SEVERITY[finding.severity];
        return (
          <li key={`${finding.code}-${finding.lineNo ?? ""}-${i}`} className={`finding finding--${finding.severity}`}>
            {settled ? null : (
              <span className="finding__severity">
                <Icon name={severity.icon} size={16} aria-hidden="true" />
                {severity.words}
              </span>
            )}
            <p className="finding__message">{describe(finding)}</p>
            {finding.lineNo !== undefined || finding.ruleRef ? (
              <p className="finding__source muted">
                {finding.lineNo !== undefined ? `Line ${finding.lineNo}` : null}
                {finding.lineNo !== undefined && finding.ruleRef ? " · " : null}
                {finding.ruleRef ? `Source: ${finding.ruleRef}` : null}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
