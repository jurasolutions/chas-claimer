import { useEffect, useState } from "react";
import type { SettingsResponse } from "../../api/settings";
import { CLAIM_STATUSES, type ClaimStatus, SCHEME_NAMES, SCHEMES } from "../../domain/types";
import { Field, Select } from "../../ds";
import { api } from "../api";
import { Link, navigate } from "../router";
import { statusWords } from "./StatusBadge";

type Option = { value: string; label: string };
type Named = { id: string; name: string };

const STATUS_OPTIONS: Option[] = CLAIM_STATUSES.map((status) => ({ value: status, label: statusWords(status) }));
const SCHEME_OPTIONS: Option[] = SCHEMES.map((scheme) => ({ value: scheme, label: SCHEME_NAMES[scheme] }));
const DUE_OPTIONS: Option[] = [5, 14, 30].map((days) => ({ value: String(days), label: `Due within ${days} days` }));
const CHANGED_OPTIONS: Option[] = [
  { value: "true", label: "Changed after sending" },
  { value: "false", label: "Not changed after sending" },
];
/** The server also reads `changed=1` and `changed=0`; show those as the words they mean. */
const CHANGED_ALIASES: Record<string, string> = { "1": "true", "0": "false" };

/** The keys these controls own; anything else in the address (paging aside) is left alone. */
const FILTERS = ["status", "scheme", "payer", "branch", "due", "changed"] as const;
const PAGING = ["cursor", "limit"];

/**
 * A value from a shared link that the list doesn't name (a payer before settings load, `due=9`)
 * stays selectable, so the control never claims the queue is unfiltered when it isn't.
 */
function withCurrent(options: readonly Option[], current: string, name: (value: string) => string = (v) => v): Option[] {
  if (!current || options.some((o) => o.value === current)) return [...options];
  return [...options, { value: current, label: name(current) }];
}

const isStatus = (value: string): value is ClaimStatus => (CLAIM_STATUSES as readonly string[]).includes(value);

/** Today links statuses together (`submitted,accepted`); say them as words: "Submitted or accepted". */
function statusesInWords(value: string): string {
  const parts = value.split(",").filter(Boolean);
  if (!parts.every(isStatus)) return value;
  const words = parts.map((status, i) => (i === 0 ? statusWords(status) : statusWords(status).toLowerCase()));
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

const named = (list: readonly Named[]): Option[] => list.map(({ id, name }) => ({ value: id, label: name }));

/** Payers and branches by name. Without settings the controls still work on the ids in the address. */
function useDeskNames(): { payers: Option[]; branches: Option[] } {
  const [names, setNames] = useState<{ payers: Option[]; branches: Option[] }>({ payers: [], branches: [] });
  useEffect(() => {
    let current = true;
    api.get<SettingsResponse>("/api/settings").then(
      ({ settings }) => current && setNames({ payers: named(settings.payers), branches: named(settings.branches) }),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  return names;
}

/**
 * The queue's filters (QA D01). Each one lives in the address, so a link or Today's counts land on
 * the same view; changing one starts the list again from its first page.
 */
export function QueueFilters({ query }: { query: URLSearchParams }) {
  const { payers, branches } = useDeskNames();
  const value = (key: (typeof FILTERS)[number]) => {
    const raw = query.get(key) ?? "";
    return key === "changed" ? (CHANGED_ALIASES[raw] ?? raw) : raw;
  };
  const filtered = FILTERS.some((key) => query.has(key));

  function set(key: (typeof FILTERS)[number], next: string) {
    const params = new URLSearchParams(query);
    for (const paging of PAGING) params.delete(paging);
    if (next) params.set(key, next);
    else params.delete(key);
    const search = params.toString();
    navigate(search ? `/claims?${search}` : "/claims", { replace: true });
  }

  const select = (key: (typeof FILTERS)[number], label: string, placeholder: string, options: readonly Option[]) => (
    <Field className="queue-filters__field" label={label} htmlFor={`queue-filter-${key}`}>
      <Select
        id={`queue-filter-${key}`}
        name={key}
        placeholder={placeholder}
        options={withCurrent(options, value(key), key === "status" ? statusesInWords : undefined)}
        value={value(key)}
        onChange={(event: { target: { value: string } }) => set(key, event.target.value)}
      />
    </Field>
  );

  return (
    <div className="queue-filters" role="group" aria-label="Filter claims">
      {select("status", "Status", "Any status", STATUS_OPTIONS)}
      {select("scheme", "Scheme", "Any scheme", SCHEME_OPTIONS)}
      {select("payer", "Payer", "Any payer", payers)}
      {select("branch", "Branch", "Any branch", branches)}
      {select("due", "Deadline", "Any deadline", DUE_OPTIONS)}
      {select("changed", "Changes", "Any claim", CHANGED_OPTIONS)}
      {filtered ? (
        <Link className="queue-filters__clear" href="/claims">
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}
