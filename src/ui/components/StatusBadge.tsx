import { Badge, type BadgeProps } from "../../ds";
import type { ClaimStatus } from "../../domain/types";

const STATUS: Record<ClaimStatus, { words: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  needs_attention: { words: "Needs attention", tone: "warning" },
  ready: { words: "Ready", tone: "neutral" },
  approved: { words: "Approved", tone: "brand" },
  submitted: { words: "Submitted", tone: "info" },
  accepted: { words: "Accepted", tone: "info" },
  rejected: { words: "Rejected", tone: "danger" },
  paid: { words: "Paid", tone: "success" },
  withdrawn: { words: "Withdrawn", tone: "neutral" },
  written_off: { words: "Written off", tone: "neutral" },
};

/** A claim's status in words ("Needs attention"), for anywhere that names one outside a badge. */
export const statusWords = (status: ClaimStatus): string => STATUS[status].words;

/** A claim's status as words in a badge tone (docs/design.md, Tokens). */
export function StatusBadge({ status }: { status: ClaimStatus }) {
  const { words, tone } = STATUS[status];
  return (
    <Badge tone={tone} data-tone={tone}>
      {words}
    </Badge>
  );
}
