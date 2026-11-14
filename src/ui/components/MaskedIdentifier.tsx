import { useState } from "react";
import type { IdentityField } from "../../domain/types";
import { Button } from "../../ds";
import { ApiError, api } from "../api";
import { useFocusOnSettle } from "../focus";

interface MaskedIdentifierProps {
  claimId: string;
  field: IdentityField;
  /** The masked value the server sent ("T••••000J"). */
  masked: string;
  /** What the value is, for the button's name ("NRIC/FIN"). */
  label: string;
}

type State =
  | { kind: "masked"; problem?: string }
  | { kind: "loading" }
  | { kind: "shown"; value: string };

function problemWords(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "forbidden") return "You don't have access to reveal this.";
    if (error.code === "identity_not_configured") return "Identifiers can't be opened until the identifier key is set up.";
  }
  return "That didn't work. Try again.";
}

/**
 * An identifier that stays masked until someone presses Show. Each Show posts to the audited
 * reveal route once and says the reveal is recorded; Hide forgets the value.
 */
export function MaskedIdentifier({ claimId, field, masked, label }: MaskedIdentifierProps) {
  const [state, setState] = useState<State>({ kind: "masked" });
  // Show is disabled while it asks, which drops focus to the body, so once the reveal settles focus
  // moves to the identifier and its note; the next Tab reaches Hide (QA N1).
  const [settled, setSettled] = useState(0);
  const wrapRef = useFocusOnSettle<HTMLSpanElement>(settled);

  async function show() {
    setState({ kind: "loading" });
    try {
      const { value } = await api.post<{ value: string }>(`/api/claims/${encodeURIComponent(claimId)}/reveal`, { field });
      setState({ kind: "shown", value });
      setSettled((n) => n + 1);
    } catch (error) {
      setState({ kind: "masked", problem: problemWords(error) });
      setSettled((n) => n + 1);
    }
  }

  const shown = state.kind === "shown";
  return (
    <span ref={wrapRef} tabIndex={-1} className="masked-identifier settled-focus">
      <code className="literal" translate="no">
        {shown ? state.value : masked}
      </code>
      {shown ? (
        <Button variant="ghost" size="sm" onClick={() => setState({ kind: "masked" })}>
          Hide<span className="visually-hidden"> {label}</span>
        </Button>
      ) : (
        <Button variant="ghost" size="sm" onClick={show} disabled={state.kind === "loading"} aria-busy={state.kind === "loading"}>
          Show<span className="visually-hidden"> {label}</span>
        </Button>
      )}
      <span className="masked-identifier__note" aria-live="polite">
        {shown ? "Shown and recorded in the claim's history." : state.kind === "masked" ? state.problem : null}
      </span>
    </span>
  );
}
