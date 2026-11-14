/**
 * The AI slots (technical §3, UI; spec Block 6). Each is a button that asks the server for a
 * suggestion and shows it beside the work, marked as AI's. Nothing is saved until the person
 * accepts it through the screen's own route; dismissing it changes nothing.
 *
 * The buttons render whether or not `GET /api/me` says AI is configured. Without a key, pressing
 * one says "AI isn't set up" and asks nothing of the server (AC-6.1). Bodies carry ids and codes;
 * the server de-identifies everything it sends on (docs/adr). The model's words are shown as text,
 * never as markup.
 */
import { useId, useState, type JSX, type ReactNode } from "react";
import {
  MAX_AI_DESCRIPTION,
  type CodeSuggestionResponse,
  type JustificationResponse,
  type RejectionExplainerResponse,
  type SourceMappingResponse,
} from "../../api/ai";
import type { SourceMapping } from "../../domain/source-mapping";
import type { CodeMapEntry } from "../../domain/types";
import { Alert, Button, Field, Textarea } from "../../ds";
import { api, ApiError } from "../api";
import { useMe } from "../me";
import { parseDescribe } from "./describe";
import "./ai.css";

interface AiFailure {
  title: string;
  detail?: string;
}

const FAILURES: Record<string, AiFailure> = {
  ai_not_configured: { title: "AI isn't set up", detail: "Everything else works without it. Whoever runs the desk can add an Anthropic key." },
  ai_cap_reached: { title: "Today's AI limit is reached", detail: "Suggestions are back tomorrow. You can carry on by hand." },
  ai_busy: { title: "AI is busy", detail: "Try again in a minute." },
  ai_unavailable: { title: "AI couldn't answer just now", detail: "Try again in a minute." },
  ai_unusable: { title: "AI's answer couldn't be used", detail: "Nothing changed. Try again, or carry on by hand." },
  ai_identifiers_remain: { title: "That wasn't sent to AI", detail: "It still held a patient's details. Carry on by hand." },
  not_allowed: { title: "This claim isn't rejected any more", detail: "Only a rejected claim can be explained." },
  forbidden: { title: "You don't have access to do that." },
};

function aiFailureOf(error: unknown): AiFailure {
  if (!(error instanceof ApiError)) return { title: "That didn't go through", detail: "Check your connection and try again." };
  return FAILURES[error.code] ?? { title: "That didn't go through. Try again." };
}

type Ask<T> = { state: "idle" } | { state: "busy" } | { state: "done"; value: T } | { state: "failed"; failure: AiFailure };

/** Moves focus to an element by id, when it is there. */
function focusOn(id: string) {
  document.getElementById(id)?.focus();
}

/**
 * One request to an AI route: idle, busy, then an answer or a plain failure. `close` clears the
 * answer and hands focus back to the slot's button, since the button the person pressed is gone.
 */
function useAsk<T>() {
  const { aiConfigured } = useMe();
  const triggerId = useId();
  const [ask, setAsk] = useState<Ask<T>>({ state: "idle" });
  /** When AI has no key, shows so and answers true; the caller then asks nothing of the server. */
  const refuseIfOff = () => {
    if (!aiConfigured) setAsk({ state: "failed", failure: FAILURES.ai_not_configured! });
    return !aiConfigured;
  };
  const run = async (call: () => Promise<T>) => {
    if (refuseIfOff()) return;
    setAsk({ state: "busy" });
    try {
      setAsk({ state: "done", value: await call() });
    } catch (error) {
      setAsk({ state: "failed", failure: aiFailureOf(error) });
    }
  };
  const reset = () => setAsk({ state: "idle" });
  const close = () => {
    reset();
    focusOn(triggerId);
  };
  return { ask, triggerId, run, refuseIfOff, reset, close };
}

/** The slot's frame: its button, a live line while it waits, and a failure when there is one. */
function Slot<T>({ label, triggerId, ask, onAsk, children }: { label: string; triggerId: string; ask: Ask<T>; onAsk(): void; children?: ReactNode }) {
  const busy = ask.state === "busy";
  return (
    <div className="ai-slot">
      <div className="ai-slot__actions">
        <Button id={triggerId} type="button" variant="ghost" size="sm" disabled={busy} onClick={onAsk}>
          {label}
        </Button>
        <span className="ai-slot__status muted" aria-live="polite">
          {busy ? "Asking AI…" : ""}
        </span>
      </div>
      {ask.state === "failed" ? (
        <Alert tone="warning" role="alert" title={ask.failure.title}>
          {ask.failure.detail}
        </Alert>
      ) : null}
      {children}
    </div>
  );
}

/** What AI said, marked as AI's, with what the person can do about it. */
function Suggestion({ note, children, actions }: { note: string; children: ReactNode; actions: ReactNode }) {
  const id = useId();
  return (
    <div className="ai-slot__result" role="group" aria-labelledby={id}>
      <p id={id} className="ai-slot__note muted">
        {note}
      </p>
      {children}
      <div className="ai-slot__actions">{actions}</div>
    </div>
  );
}

/** Proposes a code-map entry for an unmapped clinic code. The person accepts it or not. */
export function CodeSuggestion({ clinicCode, description, onAccept }: { clinicCode: string; description: string; onAccept(e: CodeMapEntry): void }): JSX.Element | null {
  const me = useMe();
  const { ask, triggerId, run, close } = useAsk<CodeSuggestionResponse["suggestion"]>();
  const suggest = () =>
    run(async () => {
      const body = { clinicCode, description: description.slice(0, MAX_AI_DESCRIPTION) };
      return (await api.post<CodeSuggestionResponse>("/api/ai/code-suggestion", body)).suggestion;
    });
  const accept = (s: CodeSuggestionResponse["suggestion"]) => {
    onAccept({ clinicCode, target: s.target, payerId: s.payerId, targetCode: s.targetCode, origin: "ai_accepted", updatedBy: me.email, updatedAt: new Date().toISOString() });
    close();
  };
  return (
    <Slot label="Suggest code" triggerId={triggerId} ask={ask} onAsk={suggest}>
      {ask.state === "done" ? (
        <Suggestion
          note="Suggested by AI. Check it before you accept."
          actions={
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => accept(ask.value)}>
                Accept suggestion
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Dismiss
              </Button>
            </>
          }
        >
          <p>
            {ask.value.targetCode === null ? (
              "Not claimable under CHAS"
            ) : (
              <>
                {"CHAS procedure "}
                <span className="literal" translate="no">
                  {ask.value.targetCode}
                </span>
              </>
            )}
          </p>
          <p className="ai-slot__text">{ask.value.reason}</p>
        </Suggestion>
      ) : null}
    </Slot>
  );
}

/** Explains a payer's rejection in plain words, with what to change. */
export function RejectionExplainer({ claimId }: { claimId: string }): JSX.Element | null {
  const { ask, triggerId, run, close } = useAsk<RejectionExplainerResponse["suggestion"]>();
  const explain = () => run(async () => (await api.post<RejectionExplainerResponse>("/api/ai/rejection-explainer", { claimId })).suggestion);
  return (
    <Slot label="Explain the rejection" triggerId={triggerId} ask={ask} onAsk={explain}>
      {ask.state === "done" ? (
        <Suggestion
          note="Explained by AI. The claim hasn't changed."
          actions={
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Dismiss
            </Button>
          }
        >
          <p className="ai-slot__text">{ask.value.explanation}</p>
          <p className="ai-slot__text">
            <strong>What might fix it: </strong>
            {ask.value.fix}
          </p>
        </Suggestion>
      ) : null}
    </Slot>
  );
}

/** Drafts a clinical justification the person edits before using. */
export function JustificationDraft({ claimId, onUse }: { claimId: string; onUse(text: string): void }): JSX.Element | null {
  const { ask, triggerId, run, close } = useAsk<string>();
  const draft = () => run(async () => (await api.post<JustificationResponse>("/api/ai/justification", { claimId })).draft);
  return (
    <Slot label="Draft a justification" triggerId={triggerId} ask={ask} onAsk={draft}>
      {ask.state === "done" ? (
        <Suggestion
          note="Drafted by AI. Read it and edit it before you save."
          actions={
            <>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onUse(ask.value);
                  close();
                }}
              >
                Use this draft
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                Dismiss
              </Button>
            </>
          }
        >
          <p className="ai-slot__text">{ask.value}</p>
        </Suggestion>
      ) : null}
    </Slot>
  );
}

const ENTITIES: Array<[string, (m: SourceMapping) => string | null | undefined]> = [
  ["Visits", (m) => m.visits.table],
  ["Patients", (m) => m.patients.table],
  ["Treatment lines", (m) => m.treatments.table],
  ["CHAS cards", (m) => m.chasCards?.table],
  ["Insurance policies", (m) => m.policies?.table],
  ["MediSave details", (m) => m.medisave?.table],
  ["Pre-authorisations", (m) => m.preAuths?.table],
];

/**
 * Proposes how the clinic database's tables map onto the desk's fields. The person pastes what the
 * connector's `describe` command prints (names only), so the connector's token never comes here.
 */
export function MappingProposal({ onAccept }: { onAccept(m: SourceMapping): void }): JSX.Element | null {
  const fieldId = `${useId()}-describe`;
  const { ask, triggerId, run, refuseIfOff, reset } = useAsk<SourceMappingResponse["suggestion"]>();
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [unreadable, setUnreadable] = useState(false);

  const open = () => {
    if (refuseIfOff()) return;
    reset();
    setPasting(true);
  };
  const close = () => {
    setPasting(false);
    setText("");
    setUnreadable(false);
    focusOn(triggerId);
  };
  const propose = () => {
    const schema = parseDescribe(text);
    setUnreadable(schema === null);
    if (!schema) return focusOn(fieldId);
    void run(async () => (await api.post<SourceMappingResponse>("/api/ai/source-mapping", { schema })).suggestion);
  };
  const accept = (mapping: SourceMapping) => {
    onAccept(mapping);
    reset();
    close();
  };

  return (
    <Slot label="Propose a mapping" triggerId={triggerId} ask={pasting ? { state: "idle" } : ask} onAsk={open}>
      {pasting && ask.state !== "done" ? (
        <div className="ai-slot__result">
          <Field
            label="What the connector printed"
            hint="Run npm run connector -- describe --source with your clinic's file, then paste what it prints. Only table and column names go to AI, never a row."
            error={unreadable ? "That isn't what the describe command prints. Paste all of it, from the first line." : undefined}
            htmlFor={fieldId}
          >
            <Textarea
              id={fieldId}
              name="describe"
              rows={6}
              autoComplete="off"
              spellCheck={false}
              translate="no"
              value={text}
              invalid={unreadable}
              aria-invalid={unreadable}
              onChange={(e: { target: { value: string } }) => setText(e.target.value)}
            />
          </Field>
          {ask.state === "failed" ? (
            <Alert tone="warning" role="alert" title={ask.failure.title}>
              {ask.failure.detail}
            </Alert>
          ) : null}
          <div className="ai-slot__actions">
            <Button type="button" variant="secondary" size="sm" disabled={ask.state === "busy"} onClick={propose}>
              Ask for a proposal
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <span className="ai-slot__status muted" aria-live="polite">
              {ask.state === "busy" ? "Asking AI…" : ""}
            </span>
          </div>
        </div>
      ) : null}
      {ask.state === "done" ? (
        <Suggestion
          note="Proposed by AI. Check each table before you accept, then save settings to keep it."
          actions={
            <>
              <Button type="button" variant="secondary" size="sm" onClick={() => accept(ask.value.mapping)}>
                Accept mapping
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  reset();
                  close();
                }}
              >
                Dismiss
              </Button>
            </>
          }
        >
          <ul className="ai-slot__tables" aria-label="Proposed tables">
            {ENTITIES.map(([what, table]) => {
              const name = table(ask.value.mapping);
              return (
                <li key={what}>
                  {`${what}: `}
                  {name ? (
                    <span className="literal" translate="no">
                      {name}
                    </span>
                  ) : (
                    <span className="muted">not held</span>
                  )}
                </li>
              );
            })}
            <li>{`Amounts: in ${ask.value.mapping.amountUnit}`}</li>
          </ul>
          {ask.value.notes ? <p className="ai-slot__text">{ask.value.notes}</p> : null}
        </Suggestion>
      ) : null}
    </Slot>
  );
}
