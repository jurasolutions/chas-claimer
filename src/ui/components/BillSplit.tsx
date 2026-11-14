import { formatSgd, type Cents } from "../../domain/money";
import type { SplitSegment } from "../../domain/types";
import { MoneyCell } from "./MoneyCell";

type Size = "detail" | "row" | "checklist";

interface BillSplitProps {
  /** The waterfall the server computed. The UI never adds these up; it only draws them. */
  segments: readonly SplitSegment[];
  /** The visit fee, as sent by the server. */
  feeCents: Cents;
  /** "detail" is full width with labels, "row" a thin unlabelled bar, "checklist" the bar alone. */
  size: Size;
  /** In a queue row, the row's own claim is drawn solid and the rest faded. */
  highlightClaimId?: string;
}

type Fill = "chas" | "medisave" | "insurer" | "patient" | "rest";

/**
 * CHAS, then MediSave, then any insurer, then the patient (docs/design.md, Bill split). A frozen
 * claim's "rest" is no one payer, so it gets a neutral fill of its own.
 */
function fillOf(payer: SplitSegment["payer"]): Fill {
  if (payer === "patient") return "patient";
  if (payer === "rest") return "rest";
  if (payer === "CHAS") return "chas";
  if (payer.startsWith("MEDISAVE")) return "medisave";
  return "insurer";
}

/** "CHAS pays $462.50, MediSave $400.00, patient pays $87.50 of $950.00". */
function sentence(segments: readonly SplitSegment[], fee: Cents): string {
  const parts = segments.map((s, i) => {
    const amount = formatSgd(s.cents);
    if (s.payer === "patient") return `patient pays ${amount}`;
    if (s.payer === "rest") return `and the rest of the bill is ${amount}`;
    return i === 0 ? `${s.label} pays ${amount}` : `${s.label} ${amount}`;
  });
  const text = `${parts.join(", ")} of ${formatSgd(fee)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who pays what for one visit, as one bar read left to right, with the patient always last. */
export function BillSplit({ segments, feeCents, size, highlightClaimId }: BillSplitProps) {
  const last = (s: SplitSegment) => s.payer === "patient" || s.payer === "rest";
  const ordered = [...segments.filter((s) => !last(s)), ...segments.filter(last)];

  return (
    <div className={`bill-split bill-split--${size}`}>
      <div className="bill-split__bar" role="img" aria-label={sentence(ordered, feeCents)}>
        {ordered.map((s, i) => {
          const own = size === "row" && highlightClaimId !== undefined && s.claimId === highlightClaimId;
          return (
            <span
              key={`${s.payer}-${i}`}
              className={`bill-split__segment bill-split__segment--${fillOf(s.payer)}`}
              data-payer={s.payer}
              data-own={own ? "" : undefined}
              data-faded={size === "row" && highlightClaimId !== undefined && !own ? "" : undefined}
              style={{ flexGrow: s.cents }}
            />
          );
        })}
      </div>
      {size === "detail" ? (
        <ul className="bill-split__legend">
          {ordered.map((s, i) => (
            <li key={`${s.payer}-${i}`}>
              <span className={`bill-split__swatch bill-split__segment--${fillOf(s.payer)}`} aria-hidden="true" />
              <span>{s.label}</span>
              <MoneyCell cents={s.cents} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
