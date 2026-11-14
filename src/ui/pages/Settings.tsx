import { type ComponentProps, type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { InvalidBody, ProblemBody } from "../../api/common";
import {
  type CodeMapDeleteResponse,
  type CodeMapResponse,
  type CodeMapSaveRequest,
  type CodeMapSaveResponse,
  codeMapPath,
  type RebuildProgress,
  type ResealLeft,
  type ResealProgress,
  type ResealStatus,
  type SettingsResponse,
  type SettingsSaveRequest,
  type SettingsSaveResponse,
  type UnmappedCode,
} from "../../api/settings";
import type { IsoDate } from "../../domain/dates";
import { formatDecimal, parseDollars } from "../../domain/money";
import type { ValidationIssue } from "../../domain/validation";
import type { SourceMapping } from "../../domain/source-mapping";
import { type BranchSettings, type DentistSettings, type DeskSettings, type PayerSettings, parseDeskSettings, type WaterfallLevel } from "../../domain/settings";
import { type Channel, type CodeMapEntry, type CodeMapOrigin, type CodeMapTarget, SCHEME_NAMES } from "../../domain/types";
import { Alert, Button, Card, Checkbox, Field, Input, Select } from "../../ds";
import { CodeSuggestion, MappingProposal } from "../ai";
import { ApiError, api } from "../api";
import { PageHeader } from "../components/PageHeader";
import { useFocusOnSettle } from "../focus";
import { formatDate } from "../format";
import { useMe } from "../me";

type Loaded = { state: "loading" } | { state: "failed" } | { state: "ready"; response: SettingsResponse };

/** A benchmark override as typed: the fees stay text until the save parses them. */
interface OverrideDraft {
  procedureCode: string;
  min: string;
  max: string;
  sourceUrl: string;
  asOf: string;
}

/** A payer's typed-as-text fields: lists stay comma-separated text until the save splits them. */
interface PayerText {
  deadlineDays: string;
  preAuthBenefitCodes: string;
  templateFields: string;
}

interface Draft {
  settings: DeskSettings;
  overrides: OverrideDraft[];
  payers: PayerText[];
}

/** Field errors keyed by settings path, for example `benchmarkOverrides.0.sourceUrl`. */
type Errors = Record<string, string>;

type Saving =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "rebuilding"; remaining: number }
  | { state: "stopped"; at: Rebuilt }
  | { state: "saved"; rebuilt: number; flagged: number };

/** Why the server kept a save from landing, when it is not a field the reviewer can fix. */
type Refusal = "stale" | "forbidden" | "connection";

function draftOf(settings: DeskSettings): Draft {
  return {
    settings,
    overrides: settings.benchmarkOverrides.map((o) => ({
      procedureCode: o.procedureCode,
      min: formatDecimal(o.minCents),
      max: formatDecimal(o.maxCents),
      sourceUrl: o.sourceUrl,
      asOf: o.asOf,
    })),
    payers: settings.payers.map((p) => ({
      deadlineDays: p.deadlineDays === null ? "" : String(p.deadlineDays),
      preAuthBenefitCodes: p.preAuthBenefitCodes.join(", "),
      templateFields: p.templateFields.join(", "),
    })),
  };
}

const NO_TEXT: PayerText = { deadlineDays: "", preAuthBenefitCodes: "", templateFields: "" };

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** Turns the draft back into a settings document, or the field errors that stop it. */
function settingsOf(draft: Draft): { ok: true; settings: DeskSettings } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const benchmarkOverrides = draft.overrides.map((o, i) => {
    const min = parseDollars(o.min);
    const max = parseDollars(o.max);
    if (!min.ok) errors[`benchmarkOverrides.${i}.minCents`] = "Enter an amount in dollars, like 21.00.";
    if (!max.ok) errors[`benchmarkOverrides.${i}.maxCents`] = "Enter an amount in dollars, like 31.00.";
    if (o.sourceUrl.trim() === "") errors[`benchmarkOverrides.${i}.sourceUrl`] = "Add the page this range comes from.";
    return {
      procedureCode: o.procedureCode.trim(),
      minCents: min.ok ? min.value : 0,
      maxCents: max.ok ? max.value : 0,
      sourceUrl: o.sourceUrl.trim(),
      asOf: o.asOf,
    };
  });
  const payers = draft.settings.payers.map((p, i) => {
    const text = draft.payers[i] ?? NO_TEXT;
    const days = text.deadlineDays.trim();
    const whole = /^\d+$/.test(days);
    if (days !== "" && !whole) errors[`payers.${i}.deadlineDays`] = "Enter a whole number of days, or leave it blank for no deadline.";
    return { ...p, deadlineDays: whole ? Number(days) : null, preAuthBenefitCodes: list(text.preAuthBenefitCodes), templateFields: list(text.templateFields) };
  });
  const parsed = parseDeskSettings({ ...draft.settings, payers, benchmarkOverrides });
  if (!parsed.ok) for (const issue of parsed.error) errors[issue.path] ??= sentence(issue.message);
  if (Object.keys(errors).length > 0 || !parsed.ok) return { ok: false, errors };
  return { ok: true, settings: parsed.value };
}

/** The server's issue paths start at the request body; the form's start inside `settings`. */
function issueErrors(body: ProblemBody): Errors {
  const errors: Errors = {};
  const issues: unknown = body.issues;
  if (!Array.isArray(issues)) return errors;
  for (const issue of issues as Partial<ValidationIssue>[]) {
    if (typeof issue.path !== "string" || typeof issue.message !== "string") continue;
    errors[issue.path.replace(/^settings\./, "")] ??= sentence(issue.message);
  }
  return errors;
}

/** Schema messages are lower-case fragments ("must use https"); the page shows sentences. */
const sentence = (message: string) => `${message.charAt(0).toUpperCase()}${message.slice(1)}${/[.?]$/.test(message) ? "" : "."}`;

/** A labelled input whose error is announced with it, not just shown below it. */
function TextField({ label, error, hint, ...input }: { label: string; error?: string | undefined; hint?: string | undefined } & ComponentProps<typeof Input>) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <Input id={id} invalid={Boolean(error)} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-note` : undefined} {...input} />
      {error || hint ? (
        <span id={`${id}-note`} className={error ? "settings-field__error" : "settings-field__hint"}>
          {error ?? hint}
        </span>
      ) : null}
    </Field>
  );
}

/** A labelled select whose error or hint is announced with it. */
function SelectField({ label, error, hint, ...select }: { label: string; error?: string | undefined; hint?: string | undefined } & ComponentProps<typeof Select>) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} placeholder="" invalid={Boolean(error)} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-note` : undefined} {...select} />
      {error || hint ? (
        <span id={`${id}-note`} className={error ? "settings-field__error" : "settings-field__hint"}>
          {error ?? hint}
        </span>
      ) : null}
    </Field>
  );
}

/** One settings area: an h2 and a card. Regions so a screen reader can jump between them. */
function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings__section" aria-labelledby={`settings-${id}`}>
      <h2 id={`settings-${id}`} className="settings__heading">
        {title}
      </h2>
      {lede ? <p className="settings__lede muted">{lede}</p> : null}
      <Card>{children}</Card>
    </section>
  );
}

function People({ roles }: { roles: SettingsResponse["roles"] }) {
  return (
    <Section id="people" title="People" lede="Reviewers and officers are set in the deployment, not here. Ask whoever runs the desk to change them.">
      <div className="settings-people">
        <div>
          <h3 className="settings__subheading">Reviewers</h3>
          <ul className="settings-people__list">
            {roles.reviewers.map((email) => (
              <li key={email}>{email}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="settings__subheading">Officers</h3>
          <ul className="settings-people__list">
            {roles.officers.map((email) => (
              <li key={email}>{email}</li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

function applies(rs: SettingsResponse["ruleSets"][number]): string {
  const from = formatDate(rs.effectiveFrom as IsoDate);
  return rs.effectiveTo === null ? `From ${from}` : `${from} to ${formatDate(rs.effectiveTo as IsoDate)}`;
}

/** Rule sets ship with the desk and change only with a release, so they are shown, never edited. */
function RuleSets({ ruleSets }: { ruleSets: SettingsResponse["ruleSets"] }) {
  return (
    <Section id="rule-sets" title="Rule sets" lede="The scheme rules the desk checks claims against. They change with a release of the desk, not here.">
      <div className="settings-rules">
        {ruleSets.map((rs) => (
          <article key={rs.id} className="settings-rules__set" aria-labelledby={`rule-set-${rs.id}`}>
            <h3 id={`rule-set-${rs.id}`} className="settings__subheading">
              {SCHEME_NAMES[rs.scheme]}
            </h3>
            <p className="settings-rules__dates">{applies(rs)}</p>
            {rs.note ? <p className="settings-rules__note">{rs.note}</p> : null}
            <ul className="settings-rules__sources">
              {rs.sources.map((source) => (
                <li key={source.url}>
                  <a href={source.url} target="_blank" rel="noreferrer" className="settings-rules__link" translate="no">
                    {source.url}
                  </a>{" "}
                  <span className="muted">as of {formatDate(source.retrieved as IsoDate)}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </Section>
  );
}

function Branches({ branches, onChange }: { branches: BranchSettings[]; onChange: (next: BranchSettings[]) => void }) {
  const flip = (i: number, key: "gstRegistered" | "chasRegistered" | "medisaveRegistered") =>
    onChange(branches.map((b, j) => (j === i ? { ...b, [key]: !b[key] } : b)));
  return (
    <Section id="branches" title="Branches" lede="GST decides whether claims carry GST. A branch claims a scheme only if it is registered for it.">
      {branches.map((b, i) => (
        <fieldset key={b.id} className="settings-row settings-row--choices">
          <legend className="settings-row__legend" translate="no">
            {b.name}
          </legend>
          <Checkbox label="GST registered" checked={b.gstRegistered} onChange={() => flip(i, "gstRegistered")} />
          <Checkbox label="CHAS registered" checked={b.chasRegistered} onChange={() => flip(i, "chasRegistered")} />
          <Checkbox label="MediSave registered" checked={b.medisaveRegistered} onChange={() => flip(i, "medisaveRegistered")} />
        </fieldset>
      ))}
    </Section>
  );
}

function Dentists({ dentists, onChange }: { dentists: DentistSettings[]; onChange: (next: DentistSettings[]) => void }) {
  return (
    <Section
      id="dentists"
      title="Dentists"
      lede="Only an accredited dentist's visits can be claimed from MediSave. Switching one off sends their unsent MediSave claims back for attention."
    >
      {dentists.length === 0 ? <p className="muted">No dentists yet. They arrive with the first import.</p> : null}
      <ul className="settings-choices">
        {dentists.map((d, i) => (
          <li key={d.id}>
            <Checkbox
              label={`${d.name} is MediSave accredited`}
              checked={d.medisaveAccredited}
              onChange={() => onChange(dentists.map((x, j) => (j === i ? { ...x, medisaveAccredited: !x.medisaveAccredited } : x)))}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

const LEVEL_WORDS: Record<WaterfallLevel, string> = { chas: "CHAS", medisave: "MediSave", insurance: "Insurance" };

function Waterfall({ order, onChange }: { order: WaterfallLevel[]; onChange: (next: WaterfallLevel[]) => void }) {
  const move = (i: number, by: -1 | 1) => {
    const next = [...order];
    const [level] = next.splice(i, 1);
    if (level) next.splice(i + by, 0, level);
    onChange(next);
  };
  return (
    <Section id="waterfall" title="Payer waterfall" lede="The order payers are asked within one visit. Each claims from what the payer above it left; the patient pays the rest.">
      <ol className="settings-waterfall">
        {order.map((level, i) => (
          <li key={level} className="settings-waterfall__row">
            <span className="settings-waterfall__name">{LEVEL_WORDS[level]}</span>
            <span className="settings-waterfall__moves">
              <Button type="button" variant="secondary" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                Move <span className="visually-hidden">{LEVEL_WORDS[level]}</span> up
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={i === order.length - 1} onClick={() => move(i, 1)}>
                Move <span className="visually-hidden">{LEVEL_WORDS[level]}</span> down
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <p className="settings__note muted">
        Changing the order rebuilds unsent claims. A claim the new order no longer builds is withdrawn, and you can't bring it back from the desk yet.
      </p>
    </Section>
  );
}

const CHANNEL_WORDS: Record<Channel, string> = {
  assisted: "Assisted: you key each claim into the payer's portal",
  file: "File: a batch file in the payer's layout",
  api: "API: the desk sends each claim",
  simulator: "Simulator: practice only, nothing is sent",
};
const CHANNEL_OPTIONS = (Object.keys(CHANNEL_WORDS) as Channel[]).map((value) => ({ value, label: CHANNEL_WORDS[value] }));

/** S15: approved claims keep the channel stamped when they were approved, whatever this says now. */
function keptChannelHint(payer: PayerSettings, approved: SettingsResponse["approvedByChannel"]): string | undefined {
  const kept = approved.filter((a) => a.payerId === payer.id && a.channel !== payer.channel);
  if (kept.length === 0) return undefined;
  return kept.map((a) => `${a.count} approved ${a.count === 1 ? "claim" : "claims"} will still use the ${a.channel} channel.`).join(" ");
}

function Payers({
  payers,
  text,
  approved,
  errors,
  onChange,
}: {
  payers: PayerSettings[];
  text: PayerText[];
  approved: SettingsResponse["approvedByChannel"];
  errors: Errors;
  onChange: (payers: PayerSettings[], text: PayerText[]) => void;
}) {
  const set = (i: number, patch: Partial<PayerSettings>) => onChange(payers.map((p, j) => (j === i ? { ...p, ...patch } : p)), text);
  const setText = (i: number, patch: Partial<PayerText>) => onChange(payers, text.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Section id="payers" title="Payers" lede="How each payer receives claims, and what it needs on them.">
      {payers.map((p, i) => {
        const at = (field: string) => errors[`payers.${i}.${field}`];
        const t = text[i] ?? NO_TEXT;
        return (
          <fieldset key={p.id} className="settings-row">
            <legend className="settings-row__legend" translate="no">
              {p.name}
            </legend>
            <TextField label="Name" autoComplete="off" value={p.name} error={at("name")} onChange={(e) => set(i, { name: e.target.value })} />
            <SelectField
              label="Channel"
              options={CHANNEL_OPTIONS}
              value={p.channel}
              error={at("channel")}
              hint={keptChannelHint(p, approved)}
              onChange={(e: { target: { value: string } }) => set(i, { channel: e.target.value as Channel })}
            />
            {p.channel === "api" ? (
              <TextField
                label="API URL"
                type="url"
                spellCheck={false}
                autoComplete="off"
                value={p.apiUrl ?? ""}
                error={at("apiUrl")}
                onChange={(e) => set(i, { apiUrl: e.target.value === "" ? null : e.target.value })}
              />
            ) : null}
            {p.scheme === "insurance" ? <Checkbox label="The clinic is on this insurer's panel" checked={p.panel} onChange={() => set(i, { panel: !p.panel })} /> : null}
            <TextField
              label="Days to submit after the visit"
              inputMode="numeric"
              autoComplete="off"
              value={t.deadlineDays}
              error={at("deadlineDays")}
              hint="Leave blank if this payer sets no deadline."
              onChange={(e) => setText(i, { deadlineDays: e.target.value })}
            />
            <TextField
              label="Codes that need pre-authorisation"
              className="literal"
              spellCheck={false}
              autoComplete="off"
              value={t.preAuthBenefitCodes}
              error={at("preAuthBenefitCodes")}
              hint="Separate codes with commas."
              onChange={(e) => setText(i, { preAuthBenefitCodes: e.target.value })}
            />
            <TextField
              label="Template fields"
              spellCheck={false}
              autoComplete="off"
              value={t.templateFields}
              error={at("templateFields")}
              hint="In the order the payer's template lists them, separated by commas."
              onChange={(e) => setText(i, { templateFields: e.target.value })}
            />
          </fieldset>
        );
      })}
    </Section>
  );
}

const EMPTY_OVERRIDE: OverrideDraft = { procedureCode: "", min: "", max: "", sourceUrl: "", asOf: "" };
const ADD_OVERRIDE = "settings-add-override";

function BenchmarkOverrides({ overrides, errors, onChange }: { overrides: OverrideDraft[]; errors: Errors; onChange: (next: OverrideDraft[]) => void }) {
  const set = (i: number, patch: Partial<OverrideDraft>) => onChange(overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const [removed, setRemoved] = useState(0);
  // The removed row's button is gone, so the focus moves to the button that adds one back.
  useEffect(() => {
    if (removed > 0) document.getElementById(ADD_OVERRIDE)?.focus();
  }, [removed]);
  function remove(i: number) {
    onChange(overrides.filter((_, j) => j !== i));
    setRemoved((n) => n + 1);
  }
  return (
    <Section
      id="benchmarks"
      title="Benchmark overrides"
      lede="A fee range you can evidence, used in place of the rule set's. Every range needs its source and the date it was true."
    >
      {overrides.length === 0 ? <p className="muted">No overrides. The rule sets' published ranges apply.</p> : null}
      {overrides.map((o, i) => {
        const at = (field: string) => errors[`benchmarkOverrides.${i}.${field}`];
        return (
          <fieldset key={i} className="settings-row">
            <legend className="settings-row__legend">{`Override ${i + 1}`}</legend>
            <TextField label="CHAS procedure" className="literal" spellCheck={false} autoComplete="off" value={o.procedureCode} error={at("procedureCode")} onChange={(e) => set(i, { procedureCode: e.target.value })} />
            <TextField label="Lowest fee" inputMode="decimal" autoComplete="off" value={o.min} error={at("minCents")} onChange={(e) => set(i, { min: e.target.value })} />
            <TextField label="Highest fee" inputMode="decimal" autoComplete="off" value={o.max} error={at("maxCents")} onChange={(e) => set(i, { max: e.target.value })} />
            <TextField label="Source" type="url" spellCheck={false} autoComplete="off" value={o.sourceUrl} error={at("sourceUrl")} onChange={(e) => set(i, { sourceUrl: e.target.value })} />
            <TextField label="As of" type="date" value={o.asOf} error={at("asOf")} onChange={(e) => set(i, { asOf: e.target.value })} />
            <Button type="button" variant="ghost" size="sm" className="settings-row__remove" aria-label={`Remove override ${i + 1}`} onClick={() => remove(i)}>
              Remove
            </Button>
          </fieldset>
        );
      })}
      <Button id={ADD_OVERRIDE} type="button" variant="secondary" size="sm" onClick={() => onChange([...overrides, EMPTY_OVERRIDE])}>
        Add an override
      </Button>
    </Section>
  );
}

/** How far a rebuild has got: the last batch's answer, and the totals so far. */
interface Rebuilt {
  progress: RebuildProgress;
  rebuilt: number;
  flagged: number;
}

const rebuiltFrom = (progress: RebuildProgress): Rebuilt => ({ progress, rebuilt: progress.rebuilt, flagged: progress.flagged });

/** A batch failed after the save landed. `at` is the last batch that did land, so it can carry on. */
class RebuildStopped extends Error {
  constructor(readonly at: Rebuilt) {
    super("The rebuild stopped part way.");
  }
}

/**
 * Rebuilds the batches after the ones already done, at most 100 visits a request. Throws
 * `RebuildStopped` when a batch fails, since the save itself has already landed by then.
 */
async function rebuildRest(from: Rebuilt, onRemaining: (remaining: number) => void): Promise<Rebuilt> {
  let at = from;
  while (at.progress.next) {
    onRemaining(at.progress.remaining);
    let progress: RebuildProgress;
    try {
      progress = await api.post<RebuildProgress>("/api/settings/rebuild", at.progress.next);
    } catch {
      throw new RebuildStopped(at);
    }
    at = { progress, rebuilt: at.rebuilt + progress.rebuilt, flagged: at.flagged + progress.flagged };
  }
  return at;
}

const visits = (n: number) => `${n} ${n === 1 ? "visit" : "visits"}`;
const stillToGo = (remaining: number) => `Rebuilding claims: ${visits(remaining)} still to go…`;
const stoppedWords = (remaining: number) => `Rebuilding claims stopped with ${visits(remaining)} still to go.`;

function rebuiltWords(rebuilt: number, flagged: number): string {
  if (rebuilt === 0) return "No claims needed rebuilding.";
  const marked = flagged === 0 ? "" : `; ${flagged} sent ${flagged === 1 ? "claim is" : "claims are"} marked changed after submission`;
  return `Claims rebuilt for ${visits(rebuilt)}${marked}.`;
}

function SaveStatus({ saving, onCarryOn }: { saving: Saving; onCarryOn: (at: Rebuilt) => void }) {
  let words = "";
  if (saving.state === "saving") words = "Saving settings…";
  if (saving.state === "rebuilding") words = `Settings saved. ${stillToGo(saving.remaining)}`;
  if (saving.state === "stopped") words = `Settings saved. ${stoppedWords(saving.at.progress.remaining)}`;
  if (saving.state === "saved") words = `Settings saved. ${rebuiltWords(saving.rebuilt, saving.flagged)}`;
  // The Save button is disabled while the save runs, which drops focus; the outcome takes it (QA 03 D02f).
  const statusRef = useFocusOnSettle<HTMLParagraphElement>(saving.state === "saved" || saving.state === "stopped" ? saving : null);
  return (
    <>
      <p ref={statusRef} tabIndex={-1} className="settings__status muted settled-focus" role="status">
        {words}
      </p>
      {saving.state === "stopped" ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => onCarryOn(saving.at)}>
          Carry on rebuilding
        </Button>
      ) : null}
    </>
  );
}

function RefusalAlert({ refusal, onReload }: { refusal: Refusal; onReload: () => void }) {
  return (
    <Alert tone="danger" role="alert" title="Nothing was saved.">
      {refusal === "stale" ? (
        <span className="retry-line">
          Someone else saved settings after you opened this page. Load theirs, then make your change again.
          <Button type="button" variant="secondary" size="sm" onClick={onReload}>
            Load the latest settings
          </Button>
        </span>
      ) : null}
      {refusal === "forbidden" ? "Only reviewers change settings." : null}
      {refusal === "connection" ? "Check your connection, then try again." : null}
    </Alert>
  );
}

/** Hands the browser a file to save; nothing leaves the page. */
function downloadJson(fileName: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function ClinicDatabase({
  mapping,
  accepted,
  canEdit,
  onAccept,
}: {
  mapping: SourceMapping | null;
  accepted: boolean;
  canEdit: boolean;
  onAccept: (mapping: SourceMapping) => void;
}) {
  const tables: Array<[string, string | null]> = mapping
    ? [
        ["Visits", mapping.visits.table],
        ["Patients", mapping.patients.table],
        ["Treatment lines", mapping.treatments.table],
        ["CHAS cards", mapping.chasCards?.table ?? null],
        ["Insurance policies", mapping.policies?.table ?? null],
        ["MediSave details", mapping.medisave?.table ?? null],
      ]
    : [];
  return (
    <Section id="clinic-database" title="Clinic database" lede="Which of your clinic's tables the desk reads each visit, patient and treatment line from.">
      {mapping ? (
        <ul className="settings-tables" aria-label="Mapped tables">
          {tables.map(([what, table]) => (
            <li key={what}>
              {`${what}: `}
              {table === null ? (
                <span className="muted">not held</span>
              ) : (
                <span className="literal" translate="no">
                  {table}
                </span>
              )}
            </li>
          ))}
          <li>{`Amounts: in ${mapping.amountUnit === "cents" ? "cents" : "dollars"}`}</li>
        </ul>
      ) : (
        <p className="muted">No mapping is saved yet.</p>
      )}
      {accepted ? <p className="settings-field__hint">Mapping accepted. Save settings to keep it.</p> : null}
      <div className="settings-tables__actions">
        {canEdit ? <MappingProposal onAccept={onAccept} /> : null}
        {mapping ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => downloadJson("clinic-database-mapping.json", mapping)}>
            Download mapping file
          </Button>
        ) : null}
      </div>
    </Section>
  );
}

function SettingsForm({ response, onReload }: { response: SettingsResponse; onReload: () => void }) {
  const canEdit = useMe().roles.includes("reviewer");
  const [draft, setDraft] = useState<Draft>(() => draftOf(response.settings));
  const [version, setVersion] = useState(response.version);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const [mappingAccepted, setMappingAccepted] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // A refused save takes the reader to the first field it marked.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const checked = settingsOf(draft);
    setRefusal(null);
    // Only this attempt's outcome shows, never an earlier "Settings saved" beside "Nothing was saved" (QA D08).
    setSaving({ state: "idle" });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setSaving({ state: "saving" });
    const body: SettingsSaveRequest = { settings: checked.settings, expectedVersion: version };
    let saved: SettingsSaveResponse;
    try {
      saved = await api.put<SettingsSaveResponse>("/api/settings", body);
    } catch (error) {
      setSaving({ state: "idle" });
      if (error instanceof ApiError && error.code === "invalid") setErrors(issueErrors(error.body));
      else if (error instanceof ApiError && error.code === "stale") setRefusal("stale");
      else if (error instanceof ApiError && error.code === "forbidden") setRefusal("forbidden");
      else setRefusal("connection");
      return;
    }
    setVersion(saved.version);
    await rebuild(rebuiltFrom(saved.rebuild));
  }

  async function rebuild(from: Rebuilt) {
    try {
      const done = await rebuildRest(from, (remaining) => setSaving({ state: "rebuilding", remaining }));
      setSaving({ state: "saved", rebuilt: done.rebuilt, flagged: done.flagged });
    } catch (error) {
      if (!(error instanceof RebuildStopped)) throw error;
      setSaving({ state: "stopped", at: error.at });
    }
  }

  return (
    <form ref={formRef} className="settings" onSubmit={save} noValidate>
      {canEdit ? null : <p className="settings__note muted">Only reviewers change settings. You can read them here.</p>}
      <People roles={response.roles} />
      <RuleSets ruleSets={response.ruleSets} />
      <ClinicDatabase
        mapping={draft.settings.sourceMapping}
        accepted={mappingAccepted}
        canEdit={canEdit}
        onAccept={(sourceMapping) => {
          setDraft({ ...draft, settings: { ...draft.settings, sourceMapping } });
          setMappingAccepted(true);
        }}
      />
      <fieldset className="settings__fields" disabled={!canEdit}>
        <Branches branches={draft.settings.branches} onChange={(branches) => setDraft({ ...draft, settings: { ...draft.settings, branches } })} />
        <Dentists dentists={draft.settings.dentists} onChange={(dentists) => setDraft({ ...draft, settings: { ...draft.settings, dentists } })} />
        <Payers
          payers={draft.settings.payers}
          text={draft.payers}
          approved={response.approvedByChannel}
          errors={errors}
          onChange={(payers, text) => setDraft({ ...draft, settings: { ...draft.settings, payers }, payers: text })}
        />
        <Waterfall order={draft.settings.waterfall} onChange={(waterfall) => setDraft({ ...draft, settings: { ...draft.settings, waterfall } })} />
        <BenchmarkOverrides overrides={draft.overrides} errors={errors} onChange={(overrides) => setDraft({ ...draft, overrides })} />
      </fieldset>
      {canEdit ? (
        <div className="settings__actions">
          {Object.keys(errors).length > 0 ? (
            <Alert tone="danger" role="alert" title="Nothing was saved.">
              {Object.keys(errors).length === 1 ? "Fix the field marked above, then save again." : `Fix the ${Object.keys(errors).length} fields marked above, then save again.`}
            </Alert>
          ) : null}
          {refusal ? <RefusalAlert refusal={refusal} onReload={onReload} /> : null}
          <Button type="submit" disabled={saving.state === "saving" || saving.state === "rebuilding"}>
            Save settings
          </Button>
          <SaveStatus saving={saving} onCarryOn={(at) => void rebuild(at)} />
        </div>
      ) : null}
    </form>
  );
}

const TARGET_WORDS: Record<CodeMapTarget, string> = { chas: "CHAS procedure", tosp: "TOSP code", benefit: "Insurer benefit code" };

type MapLoad = { state: "loading" } | { state: "failed" } | { state: "ready"; map: CodeMapResponse };

/** One mapping to save: where it points, and whether a person or an accepted AI suggestion chose it. */
interface Mapping {
  target: CodeMapTarget;
  payerId: string;
  targetCode: string | null;
  origin: CodeMapOrigin;
}

/** Where a mapping points, without its code: the target, and the insurer when it is a benefit code. */
type MapKey = Pick<Mapping, "target" | "payerId">;

const keyOf = (k: MapKey) => `${k.target} ${k.payerId}`;

/** The targets, and the insurers for a benefit code, a clinic code has no mapping under yet. */
function openTargets(payers: PayerSettings[], taken: MapKey[]) {
  const used = new Set(taken.map(keyOf));
  const insurers = payers.filter((p) => p.scheme === "insurance" && !used.has(keyOf({ target: "benefit", payerId: p.id })));
  const targets = (Object.keys(TARGET_WORDS) as CodeMapTarget[])
    .filter((t) => (t === "benefit" ? insurers.length > 0 : !used.has(keyOf({ target: t, payerId: "" }))))
    .map((value) => ({ value, label: TARGET_WORDS[value] }));
  return { targets, insurers };
}

function targetWords(payers: PayerSettings[], key: MapKey): string {
  if (key.target !== "benefit") return TARGET_WORDS[key.target];
  return `${TARGET_WORDS.benefit}, ${payers.find((p) => p.id === key.payerId)?.name ?? key.payerId}`;
}

/**
 * Focuses the control marked `data-action` inside `container` after the next render, once the
 * control is back on screen (a form or a confirmation has closed over it).
 */
function useFocusAfterRender(container: { current: HTMLElement | null }) {
  const [action, setAction] = useState<string | null>(null);
  useEffect(() => {
    if (action === null) return;
    container.current?.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus();
    setAction(null);
  }, [action, container]);
  return setAction;
}

type Failure = { code?: string; form?: string };

/** Why a mapping wasn't saved, in words; a refused code goes on the Code field. */
function saveFailure(error: unknown): Failure {
  if (error instanceof ApiError && error.code === "forbidden") return { form: "Only reviewers map codes." };
  if (error instanceof ApiError && error.code === "invalid") {
    const issue = (error.body as unknown as InvalidBody).issues?.find((i) => i.path === "targetCode");
    if (issue) return { code: sentence(issue.message) };
  }
  return { form: "The mapping wasn't saved. Check your connection, then try again." };
}

/**
 * One mapping's fields. With `fixed`, the target and insurer are the entry's own and only the code
 * changes; without it, the reader picks a target the clinic code has no mapping under yet.
 */
function MappingForm({
  payers,
  fixed,
  taken = [],
  label,
  labelledBy,
  header,
  submitLabel,
  canEdit,
  autoFocus = false,
  onSave,
  onCancel,
  after,
}: {
  payers: PayerSettings[];
  fixed?: MapKey & { targetCode: string | null };
  taken?: MapKey[];
  label?: string;
  labelledBy?: string;
  header?: ReactNode;
  submitLabel: string;
  canEdit: boolean;
  autoFocus?: boolean;
  onSave: (mapping: Mapping) => Promise<void>;
  onCancel?: () => void;
  /** Rendered after the form, with the same save, so its failures show on this form. */
  after?: (submit: (mapping: Mapping) => void) => ReactNode;
}) {
  const open = openTargets(payers, taken);
  const [target, setTarget] = useState<CodeMapTarget>(fixed?.target ?? open.targets[0]?.value ?? "chas");
  const [payerId, setPayerId] = useState(fixed?.payerId ?? open.insurers[0]?.id ?? "");
  const [targetCode, setTargetCode] = useState(fixed?.targetCode ?? "");
  const [notClaimable, setNotClaimable] = useState(fixed ? fixed.targetCode === null : false);
  const [failure, setFailure] = useState<Failure>({});
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (autoFocus) formRef.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled)")?.focus();
  }, [autoFocus]);

  // A refused code takes the reader back to the Code field.
  useEffect(() => {
    if (failure.code) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [failure]);

  async function submit(mapping: Mapping) {
    setFailure({});
    setBusy(true);
    try {
      await onSave(mapping);
    } catch (error) {
      setFailure(saveFailure(error));
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const typed = targetCode.trim();
    if (!notClaimable && typed === "") {
      setFailure({ code: "Enter the code, or mark it not claimable." });
      return;
    }
    void submit({ target, payerId: target === "benefit" ? payerId : "", targetCode: notClaimable ? null : typed, origin: "manual" });
  }

  return (
    <>
      <form ref={formRef} className="code-map__form" aria-label={label} aria-labelledby={labelledBy} onSubmit={save} noValidate>
        {header}
        <fieldset className="code-map__fields" disabled={!canEdit || busy}>
          {fixed ? null : (
            <>
              <SelectField label="Map to" options={open.targets} value={target} onChange={(e: { target: { value: string } }) => setTarget(e.target.value as CodeMapTarget)} />
              {target === "benefit" ? (
                <SelectField
                  label="Insurer"
                  options={open.insurers.map((p) => ({ value: p.id, label: p.name }))}
                  value={payerId}
                  onChange={(e: { target: { value: string } }) => setPayerId(e.target.value)}
                />
              ) : null}
            </>
          )}
          <TextField
            label="Code"
            className="literal"
            spellCheck={false}
            autoComplete="off"
            value={targetCode}
            disabled={notClaimable}
            error={failure.code}
            onChange={(e) => setTargetCode(e.target.value)}
          />
          <Checkbox label="Not claimable" checked={notClaimable} onChange={() => setNotClaimable(!notClaimable)} />
          <span className="code-map__buttons">
            <Button type="submit" variant="secondary">
              {submitLabel}
            </Button>
            {onCancel ? (
              <Button type="button" variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </span>
        </fieldset>
        {failure.form ? (
          <Alert tone="danger" role="alert" title="Nothing was saved.">
            {failure.form}
          </Alert>
        ) : null}
      </form>
      {after?.((mapping) => void submit(mapping))}
    </>
  );
}

/** Why a mapping wasn't removed, in words. */
function removeFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === "forbidden") return "Only reviewers map codes.";
  return "Check your connection, then try again.";
}

/** One mapping on file. A reviewer can change its code or remove it; an officer only reads it. */
function MappedEntry({
  entry,
  payers,
  canEdit,
  onSave,
  onRemove,
}: {
  entry: CodeMapEntry;
  payers: PayerSettings[];
  canEdit: boolean;
  onSave: (clinicCode: string, mapping: Mapping) => Promise<void>;
  onRemove: (entry: CodeMapEntry) => Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "change" | "confirm" | "removing">("view");
  const [failure, setFailure] = useState<string | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const focusAfterRender = useFocusAfterRender(rowRef);
  const target = targetWords(payers, entry);
  const name = `${entry.clinicCode}, ${target}`;

  function show(next: "view" | "confirm", focus: string) {
    setMode(next);
    focusAfterRender(focus);
  }

  async function remove() {
    setFailure(null);
    setMode("removing");
    try {
      await onRemove(entry);
    } catch (error) {
      setFailure(removeFailure(error));
      show("view", "remove");
    }
  }

  return (
    <li ref={rowRef} className="code-map__row">
      <span className="code-map__target">
        {target}
        {entry.origin === "ai_accepted" ? <span className="muted"> (from an accepted AI suggestion)</span> : null}
      </span>
      {entry.targetCode === null ? (
        <span className="code-map__to muted">Not claimable</span>
      ) : (
        <span className="code-map__to literal" translate="no">
          {entry.targetCode}
        </span>
      )}
      {canEdit && mode === "view" ? (
        <span className="code-map__buttons">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="change"
            aria-label={`Change ${name}`}
            onClick={() => {
              setFailure(null);
              setMode("change");
            }}
          >
            Change
          </Button>
          <Button type="button" variant="ghost" size="sm" data-action="remove" aria-label={`Remove ${name}`} onClick={() => show("confirm", "keep")}>
            Remove
          </Button>
        </span>
      ) : null}
      {mode === "change" ? (
        <MappingForm
          payers={payers}
          fixed={entry}
          label={`Change ${name}`}
          submitLabel="Save change"
          canEdit={canEdit}
          autoFocus
          onSave={async (mapping) => {
            await onSave(entry.clinicCode, mapping);
            show("view", "change");
          }}
          onCancel={() => show("view", "change")}
        />
      ) : null}
      {mode === "confirm" || mode === "removing" ? (
        <span className="code-map__confirm">
          <span>{`Remove this mapping? Visits carrying ${entry.clinicCode} rebuild without it.`}</span>
          <span className="code-map__buttons">
            <Button type="button" variant="secondary" size="sm" disabled={mode === "removing"} onClick={() => void remove()}>
              Yes, remove it
            </Button>
            <Button type="button" variant="ghost" size="sm" data-action="keep" disabled={mode === "removing"} onClick={() => show("view", "remove")}>
              Keep it
            </Button>
          </span>
        </span>
      ) : null}
      {failure ? (
        <Alert tone="danger" role="alert" title="Nothing was removed.">
          {failure}
        </Alert>
      ) : null}
    </li>
  );
}

/** Every mapping one clinic code has, and, for a reviewer, a way to add one under another target. */
function MappedGroup({
  clinicCode,
  entries,
  payers,
  canEdit,
  onSave,
  onRemove,
}: {
  clinicCode: string;
  entries: CodeMapEntry[];
  payers: PayerSettings[];
  canEdit: boolean;
  onSave: (clinicCode: string, mapping: Mapping) => Promise<void>;
  onRemove: (entry: CodeMapEntry) => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const headingId = useId();
  const groupRef = useRef<HTMLLIElement>(null);
  const focusAfterRender = useFocusAfterRender(groupRef);
  const canAdd = canEdit && openTargets(payers, entries).targets.length > 0;
  const name = `Add a mapping for ${clinicCode}`;

  return (
    <li ref={groupRef} className="code-map__group">
      <h4 id={headingId} className="code-map__heading literal" translate="no">
        {clinicCode}
      </h4>
      <ul className="code-map__entries" aria-labelledby={headingId}>
        {entries.map((e) => (
          <MappedEntry key={keyOf(e)} entry={e} payers={payers} canEdit={canEdit} onSave={onSave} onRemove={onRemove} />
        ))}
      </ul>
      {adding && canAdd ? (
        <MappingForm
          payers={payers}
          taken={entries}
          label={name}
          submitLabel="Save mapping"
          canEdit={canEdit}
          autoFocus
          onSave={async (mapping) => {
            await onSave(clinicCode, mapping);
            setAdding(false);
            focusAfterRender("add");
          }}
          onCancel={() => {
            setAdding(false);
            focusAfterRender("add");
          }}
        />
      ) : null}
      {canAdd && !adding ? (
        <Button type="button" variant="ghost" size="sm" data-action="add" aria-label={name} onClick={() => setAdding(true)}>
          Add a mapping
        </Button>
      ) : null}
    </li>
  );
}

/** The entries on file, one group per clinic code, in the order the server sends them. */
function MappedList({
  items,
  ...rest
}: {
  items: CodeMapEntry[];
  payers: PayerSettings[];
  canEdit: boolean;
  onSave: (clinicCode: string, mapping: Mapping) => Promise<void>;
  onRemove: (entry: CodeMapEntry) => Promise<void>;
}) {
  if (items.length === 0) return <p className="muted">Nothing is mapped yet.</p>;
  const groups = new Map<string, CodeMapEntry[]>();
  for (const e of items) groups.set(e.clinicCode, [...(groups.get(e.clinicCode) ?? []), e]);
  return (
    <ul className="code-map__list">
      {[...groups].map(([clinicCode, entries]) => (
        <MappedGroup key={clinicCode} clinicCode={clinicCode} entries={entries} {...rest} />
      ))}
    </ul>
  );
}

function UnmappedRow({
  code,
  payers,
  canEdit,
  onSave,
}: {
  code: UnmappedCode;
  payers: PayerSettings[];
  canEdit: boolean;
  onSave: (clinicCode: string, mapping: Mapping) => Promise<void>;
}) {
  const headingId = useId();
  return (
    <li className="code-map__unmapped">
      <MappingForm
        payers={payers}
        labelledBy={headingId}
        header={
          <>
            <h4 id={headingId} className="code-map__heading literal" translate="no">
              {code.clinicCode}
            </h4>
            <p className="code-map__description muted">{`${code.description}, on ${visits(code.visits)}`}</p>
          </>
        }
        submitLabel="Save mapping"
        canEdit={canEdit}
        onSave={(mapping) => onSave(code.clinicCode, mapping)}
        after={
          canEdit
            ? (submit) => (
                <CodeSuggestion
                  clinicCode={code.clinicCode}
                  description={code.description}
                  onAccept={(e) => submit({ target: e.target, payerId: e.payerId, targetCode: e.targetCode, origin: "ai_accepted" })}
                />
              )
            : undefined
        }
      />
    </li>
  );
}

/**
 * The code map: the CHAS procedure, TOSP code or insurer benefit code each of the clinic's own
 * codes claims as. Saved one entry at a time, outside the settings form, and each save rebuilds
 * only the visits carrying that code.
 */
function CodeMap({ payers }: { payers: PayerSettings[] }) {
  const canEdit = useMe().roles.includes("reviewer");
  const [loaded, setLoaded] = useState<MapLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("");
  const [stopped, setStopped] = useState<{ said: string; at: Rebuilt } | null>(null);
  // Goes up each time a save or remove settles. The form or row that ran it may be gone by then,
  // so the status line takes focus. A row or group still on screen then hands focus back to its
  // own control once onSave resolves, a render later (QA 03 D02b).
  const [settled, setSettled] = useState(0);
  const statusRef = useFocusOnSettle<HTMLParagraphElement>(settled);

  useEffect(() => {
    let current = true;
    api.get<CodeMapResponse>("/api/code-map").then(
      (map) => current && setLoaded({ state: "ready", map }),
      () => current && setLoaded({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  async function save(clinicCode: string, mapping: Mapping) {
    const body: CodeMapSaveRequest = { targetCode: mapping.targetCode, origin: mapping.origin };
    const saved = await api.put<CodeMapSaveResponse>(codeMapPath(clinicCode, mapping.target, mapping.payerId), body);
    setAttempt((n) => n + 1);
    await rebuild(`${clinicCode} mapped.`, rebuiltFrom(saved.rebuild));
  }

  async function remove(entry: CodeMapEntry) {
    let removed: CodeMapDeleteResponse;
    try {
      removed = await api.delete<CodeMapDeleteResponse>(codeMapPath(entry.clinicCode, entry.target, entry.payerId));
    } catch (error) {
      // Someone else removed it first: the map catches up and there is nothing to rebuild here.
      if (error instanceof ApiError && error.code === "not_found") {
        setAttempt((n) => n + 1);
        return;
      }
      throw error;
    }
    setAttempt((n) => n + 1);
    await rebuild(`${entry.clinicCode} mapping removed.`, rebuiltFrom(removed.rebuild));
  }

  /**
   * The change has landed by now, so a failed batch stops the rebuild without unsaying it. `said`
   * opens every status line: what changed.
   */
  async function rebuild(said: string, from: Rebuilt) {
    setStopped(null);
    try {
      const done = await rebuildRest(from, (remaining) => setStatus(`${said} ${stillToGo(remaining)}`));
      setStatus(`${said} ${rebuiltWords(done.rebuilt, done.flagged)}`);
    } catch (error) {
      if (!(error instanceof RebuildStopped)) throw error;
      setStatus(`${said} ${stoppedWords(error.at.progress.remaining)}`);
      setStopped({ said, at: error.at });
    }
    setSettled((n) => n + 1);
  }

  return (
    <Section id="code-map" title="Code map" lede="The payer code each of the clinic's own procedure codes claims as.">
      {loaded.state === "loading" ? <p className="muted">Loading the code map…</p> : null}
      {loaded.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The code map didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setLoaded({ state: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}
      {loaded.state === "ready" ? (
        <>
          <p className="settings__note muted">
            Each change rebuilds unsent claims for visits carrying that code. A claim the change no longer builds is withdrawn, and you can't bring it back
            from the desk yet.
          </p>
          <h3 className="settings__subheading">Mapped</h3>
          <MappedList items={loaded.map.items} payers={payers} canEdit={canEdit} onSave={save} onRemove={remove} />
          <h3 className="settings__subheading">Not mapped yet</h3>
          {loaded.map.unmapped.length === 0 ? (
            <p className="muted">Every clinic code on a current visit is mapped.</p>
          ) : (
            <>
              <p className="muted">Clinic codes on current visits with no mapping. Map each one, or mark it not claimable.</p>
              <ul className="code-map__unmapped-list">
                {loaded.map.unmapped.map((code) => (
                  <UnmappedRow key={code.clinicCode} code={code} payers={payers} canEdit={canEdit} onSave={save} />
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
      <p ref={statusRef} tabIndex={-1} className="settings__status muted settled-focus" role="status">
        {status}
      </p>
      {stopped ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => void rebuild(stopped.said, stopped.at)}>
          Carry on rebuilding
        </Button>
      ) : null}
    </Section>
  );
}

/** How far a reseal has got across its batches, so a stopped one can carry on from the last batch that landed. */
interface Moved {
  after: string;
  moved: number;
  failures: ResealProgress["failures"];
  left: ResealLeft;
}

/** A reseal batch failed. `at` is where the batches that did land got to. */
class ResealStopped extends Error {
  constructor(readonly at: Moved) {
    super("Moving stopped part way.");
  }
}

/** Posts the cursor back batch by batch until the reseal has looked at every revision. */
async function moveRest(from: Moved, onRemaining: (remaining: number) => void): Promise<Moved> {
  let at = from;
  for (;;) {
    onRemaining(at.left.remaining);
    let progress: ResealProgress;
    try {
      progress = await api.post<ResealProgress>("/api/settings/reseal", { after: at.after });
    } catch {
      throw new ResealStopped(at);
    }
    at = { after: progress.next?.after ?? "", moved: at.moved + progress.moved, failures: [...at.failures, ...progress.failures], left: progress };
    if (progress.next === null) return at;
  }
}

const revisions = (n: number) => `${n} ${n === 1 ? "revision" : "revisions"}`;
const storedRevisions = (n: number) => `${n} stored ${n === 1 ? "revision" : "revisions"}`;
/** The failed revisions listed by name; past this many the rest are counted. */
const FAILURES_SHOWN = 20;

function movedWords(moved: number, failed: number): string {
  if (failed === 0) return `Moved ${revisions(moved)}.`;
  return `Moved ${revisions(moved)}. ${failed} couldn't be opened and ${failed === 1 ? "was" : "were"} left as ${failed === 1 ? "it was" : "they were"}.`;
}

function stuckWords({ remittanceFiles, remittanceLines }: ResealLeft["cantMove"]): string {
  const parts = [
    remittanceFiles > 0 ? `${remittanceFiles} payment ${remittanceFiles === 1 ? "statement" : "statements"}` : "",
    remittanceLines > 0 ? `${remittanceLines} statement ${remittanceLines === 1 ? "line" : "lines"}` : "",
  ].filter(Boolean);
  const one = parts.length === 1 && remittanceFiles + remittanceLines === 1;
  return `${parts.join(" and ")} ${one ? "stays" : "stay"} under the previous key.`;
}

/** The rotation fields alone, off a batch answer. */
const pickLeft = ({ remaining, previousKeyMissing, cantMove }: ResealLeft): ResealLeft => ({ remaining, previousKeyMissing, cantMove });

type KeyLoad = { state: "loading" } | { state: "failed" } | { state: "ready"; status: ResealStatus };
type Moving = { state: "idle" } | { state: "moving"; remaining: number } | { state: "stopped"; at: Moved } | { state: "done"; moved: Moved };

/**
 * Where the identifier key stands, and the button that moves stored identities to the current key
 * after a rotation (infra I1, review B1). Reviewers only: an officer neither sees it nor asks. It also
 * says what can't move, so whoever unsets the previous key knows what that leaves behind.
 */
function IdentifierKey() {
  const [loaded, setLoaded] = useState<KeyLoad>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [moving, setMoving] = useState<Moving>({ state: "idle" });
  const said = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let current = true;
    api.get<ResealStatus>("/api/settings/reseal").then(
      (status) => current && setLoaded({ state: "ready", status }),
      () => current && setLoaded({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  async function move(from: Moved) {
    try {
      const done = await moveRest(from, (remaining) => setMoving({ state: "moving", remaining }));
      setMoving({ state: "done", moved: done });
      setLoaded((was) => (was.state === "ready" ? { state: "ready", status: { ...was.status, ...pickLeft(done.left) } } : was));
    } catch (error) {
      if (!(error instanceof ResealStopped)) throw error;
      setMoving({ state: "stopped", at: error.at });
    }
    // The button that started this may be gone now; the result line takes the focus.
    said.current?.focus();
  }

  let words = "";
  if (moving.state === "moving") words = `Moving stored identities: ${revisions(moving.remaining)} still to go…`;
  if (moving.state === "stopped") words = `Moving stopped with ${revisions(moving.at.left.remaining)} still to go. Check your connection, then carry on.`;
  if (moving.state === "done") words = movedWords(moving.moved.moved, moving.moved.failures.length);
  const failures = moving.state === "done" ? moving.moved.failures : [];

  return (
    <Section id="identifier-key" title="Identifier key" lede="The key the desk seals patient identifiers with. Whoever runs the desk sets it in the deployment.">
      {loaded.state === "loading" ? <p className="muted">Loading the identifier key…</p> : null}
      {loaded.state === "failed" ? (
        <Alert tone="danger" role="alert" title="The identifier key didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setLoaded({ state: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}
      {loaded.state === "ready" ? (
        <div className="identifier-key">
          <p>The desk seals identifiers with key version {loaded.status.version}.</p>
          {loaded.status.previousKeyMissing ? (
            <Alert tone="warning" role="alert" title="The previous key isn't set.">
              {storedRevisions(loaded.status.remaining)} can't be opened until it is. Ask whoever runs the desk to set{" "}
              <span className="literal" translate="no">
                IDENTIFIER_KEY_PREVIOUS
              </span>{" "}
              to the key this one replaced, then move them here.
            </Alert>
          ) : null}
          {!loaded.status.previousKeyMissing && loaded.status.remaining > 0 ? (
            <>
              <p>{storedRevisions(loaded.status.remaining)} {loaded.status.remaining === 1 ? "is" : "are"} still under the previous key.</p>
              {loaded.status.previousKeySet ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={moving.state === "moving"}
                  onClick={() => void move({ after: "", moved: 0, failures: [], left: loaded.status })}
                >
                  Move stored identities
                </Button>
              ) : null}
            </>
          ) : null}
          {loaded.status.remaining === 0 ? <p>Every stored identity is under the current key.</p> : null}
          {loaded.status.cantMove.remittanceFiles + loaded.status.cantMove.remittanceLines > 0 ? (
            <Alert tone="info" role="note" title="Some payment records can't move.">
              {stuckWords(loaded.status.cantMove)} Their lines can still be matched by reference or by hand. If the same statement is
              imported again, the desk stops it as a possible duplicate until a reviewer confirms it. Read this before you unset the previous key.
            </Alert>
          ) : null}
        </div>
      ) : null}
      <p ref={said} className="settings__status muted" role="status" tabIndex={-1}>
        {words}
      </p>
      {failures.length > 0 ? (
        <>
          <ul className="identifier-key__failures" aria-label="Revisions left as they were">
            {failures.slice(0, FAILURES_SHOWN).map((f) => (
              <li key={`${f.visitKey}:${f.revision}`}>
                <span translate="no">{f.visitKey}</span>, revision {f.revision}
              </li>
            ))}
          </ul>
          {failures.length > FAILURES_SHOWN ? <p className="muted">and {failures.length - FAILURES_SHOWN} more.</p> : null}
        </>
      ) : null}
      {moving.state === "stopped" ? (
        <Button type="button" variant="secondary" size="sm" onClick={() => void move(moving.at)}>
          Carry on moving
        </Button>
      ) : null}
    </Section>
  );
}

/**
 * Settings (functional block 8): the clinic, its payers, benchmark overrides, the waterfall, the
 * code map, the clinic database mapping and, for reviewers, the identifier key. Reviewers edit;
 * officers read (AC-8.4). Roles and rule
 * sets are shown, never edited here (AC-8.5).
 */
export function Settings() {
  const isReviewer = useMe().roles.includes("reviewer");
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setLoaded({ state: "loading" });
    api.get<SettingsResponse>("/api/settings").then(
      (response) => current && setLoaded({ state: "ready", response }),
      () => current && setLoaded({ state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <>
      <PageHeader title="Settings" />

      {loaded.state === "loading" ? <p className="muted">Loading settings…</p> : null}

      {loaded.state === "failed" ? (
        <Alert tone="danger" role="alert" title="Settings didn't load.">
          <span className="retry-line">
            Check your connection, then try again.
            <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        </Alert>
      ) : null}

      {loaded.state === "ready" ? (
        <>
          <SettingsForm response={loaded.response} onReload={() => setAttempt((n) => n + 1)} />
          <CodeMap payers={loaded.response.settings.payers} />
          {isReviewer ? <IdentifierKey /> : null}
        </>
      ) : null}
    </>
  );
}
