import { useId, useState, type FormEvent } from "react";
import type { AnnotationsRequest } from "../../api/claim-actions";
import type { ClaimDetail } from "../../api/claim-detail";
import { MAX_ACTION_TEXT, MAX_PORTAL_REFERENCE } from "../../api/claim-limits";
import { UNSENT_STATUSES } from "../../domain/claims/state";
import { Button, Field, Input, Textarea } from "../../ds";
import { JustificationDraft } from "../ai";
import { api } from "../api";
import { useFocusOnSettle } from "../focus";
import { failureOf, SettledFailureAlert, type Failure } from "./ClaimActions";

type Key = "justification" | "preAuthReference" | "mcafReference";
type Values = Record<Key, string>;

const LABEL: Record<Key, string> = {
  justification: "Clinical justification",
  preAuthReference: "Pre-authorisation reference",
  mcafReference: "MCAF reference",
};

const annotationsPath = (id: string) => `/api/claims/${encodeURIComponent(id)}/annotations`;

/** The form's values for what the claim holds now. */
const valuesOf = (annotations: ClaimDetail["claim"]["annotations"]): Values => ({
  justification: annotations.justification ?? "",
  preAuthReference: annotations.preAuthReference ?? "",
  mcafReference: annotations.mcafReference ?? "",
});

/** What goes to the server: every field, trimmed, an empty one as null so it is cleared. */
function request(values: Values, expectedVersion: number): AnnotationsRequest {
  const value = (key: Key) => values[key].trim() || null;
  return {
    annotations: { justification: value("justification"), preAuthReference: value("preAuthReference"), mcafReference: value("mcafReference") },
    expectedVersion,
  };
}

export interface ClaimAnnotationsProps {
  detail: ClaimDetail;
  /** The claim as the server holds it after the save. */
  onDone(next: ClaimDetail): void;
  /** Fetch the claim again: what is on screen is out of date. */
  onReload(): void;
}

/**
 * The justification and portal references a claim carries to the payer. Editable until the claim
 * is sent; after that they are what was sent, shown as text. Saving replaces all three, and the
 * server rebuilds the claim's findings from them.
 */
export function ClaimAnnotations({ detail, onDone, onReload }: ClaimAnnotationsProps) {
  const { claim } = detail;
  const id = useId();
  const [values, setValues] = useState<Values>(() => valuesOf(claim.annotations));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Goes up with each save that went through, and back to 0 once a field changes again. Save is
  // disabled while it runs, so the word that it saved takes focus (QA 03 D02c).
  const [saved, setSaved] = useState(0);
  const savedRef = useFocusOnSettle<HTMLParagraphElement>(saved);

  if (!UNSENT_STATUSES.has(claim.status)) {
    const kept = (Object.keys(LABEL) as Key[]).filter((key) => claim.annotations[key]);
    if (!kept.length) return null;
    return (
      <section className="claim-detail__annotations" aria-labelledby={`${id}-title`}>
        <h3 id={`${id}-title`}>Justification and references</h3>
        <dl className="claim-facts">
          {kept.map((key) => (
            <div key={key}>
              <dt>{LABEL[key]}</dt>
              <dd>{claim.annotations[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }

  const set = (key: Key) => (event: { target: { value: string } }) => {
    setSaved(0);
    setValues((v) => ({ ...v, [key]: event.target.value }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const next = await api.put<ClaimDetail>(annotationsPath(claim.id), request(values, claim.version));
      setValues(valuesOf(next.claim.annotations));
      onDone(next);
      setSaved((n) => n + 1);
    } catch (error) {
      const next = failureOf(error);
      setFailure(next);
      if (next.reload) onReload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="claim-detail__annotations" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Justification and references</h3>
      <form className="action-form" onSubmit={save} noValidate>
        <SettledFailureAlert failure={failure} />
        <Field
          label={LABEL.justification}
          hint="Needed when a fee is above the benchmark. The payer reads it."
          htmlFor={`${id}-justification`}
        >
          <Textarea
            id={`${id}-justification`}
            name="justification"
            autoComplete="off"
            rows={3}
            maxLength={MAX_ACTION_TEXT}
            value={values.justification}
            onChange={set("justification")}
          />
        </Field>
        <JustificationDraft claimId={claim.id} onUse={(text) => set("justification")({ target: { value: text } })} />
        <Field label={LABEL.preAuthReference} hint="Optional. From the insurer's approval." htmlFor={`${id}-preauth`}>
          <Input
            id={`${id}-preauth`}
            name="preAuthReference"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_PORTAL_REFERENCE}
            value={values.preAuthReference}
            onChange={set("preAuthReference")}
          />
        </Field>
        <Field label={LABEL.mcafReference} hint="Optional. For a MediSave claim." htmlFor={`${id}-mcaf`}>
          <Input
            id={`${id}-mcaf`}
            name="mcafReference"
            autoComplete="off"
            spellCheck={false}
            maxLength={MAX_PORTAL_REFERENCE}
            value={values.mcafReference}
            onChange={set("mcafReference")}
          />
        </Field>
        <div>
          <Button variant="secondary" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
        {saved ? (
          <p ref={savedRef} tabIndex={-1} className="muted settled-focus" role="status">
            Saved. The checks ran again on what you entered.
          </p>
        ) : null}
      </form>
    </section>
  );
}
