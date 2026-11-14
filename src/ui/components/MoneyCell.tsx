import { formatSgd, type Cents } from "../../domain/money";

/** An amount the server sent, as dollars in tabular figures. It formats; it never adds up. */
export function MoneyCell({ cents }: { cents: Cents }) {
  return <span className="money">{formatSgd(cents)}</span>;
}
