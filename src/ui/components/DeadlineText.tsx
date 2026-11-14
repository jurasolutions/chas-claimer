import { Badge } from "../../ds";
import type { IsoDate } from "../../domain/dates";
import { formatDate } from "../format";

/**
 * Everything here comes from the server's claim view: the component formats it and decides
 * nothing. The server counts the days in Singapore time and owns the warning rule (the CHAS
 * window from day 25, per-payer windows for MediSave and insurers), so a skewed device clock or a
 * changed setting can't make the screen disagree with the claim's findings.
 */
export interface DeadlineTextProps {
  /** The last day the claim can go to its payer (`claims.deadline_date`). */
  deadline: IsoDate;
  /** Days from today (SGT, on the server) to the deadline: 0 is today, negative once it has passed. */
  daysLeft: number;
  /** True while the claim carries the "Last N days to submit" warning (`deadline_approaching`). */
  warning: boolean;
  /** The window the deadline closes, named in the words when given ("Past the 30-day window"). */
  windowDays?: number;
}

function wordsFor(daysLeft: number, windowDays: number | undefined): string {
  if (daysLeft < 0) return windowDays ? `Past the ${windowDays}-day window` : "Past the deadline";
  if (daysLeft === 0) return "Due today";
  if (daysLeft === 1) return "Due tomorrow";
  return `Due in ${daysLeft} days`;
}

/** A deadline in words, with a badge tone added when it is close or gone. Never colour alone. */
export function DeadlineText({ deadline, daysLeft, warning, windowDays }: DeadlineTextProps) {
  const date = formatDate(deadline);
  const tone = daysLeft < 0 ? "danger" : warning ? "warning" : null;

  const time = (
    <time dateTime={deadline} title={date}>
      {wordsFor(daysLeft, windowDays)}
      <span className="visually-hidden">, {date}</span>
    </time>
  );
  if (!tone) return <span className="muted">{time}</span>;
  return (
    <Badge tone={tone} data-tone={tone}>
      {time}
    </Badge>
  );
}
