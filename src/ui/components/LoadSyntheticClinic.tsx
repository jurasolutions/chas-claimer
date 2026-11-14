import { useState } from "react";
import type { ImportSummary, SyntheticImportPage, SyntheticImportRequest } from "../../api/imports";
import { Button, Icon } from "../../ds";
import { api } from "../api";

/** One import's result as a sentence the desk can read aloud. */
export function describeImport(summary: ImportSummary): string {
  const visits = summary.received === 1 ? "1 visit" : `${summary.received} visits`;
  const refused = summary.refused > 0 ? ` ${summary.refused} refused.` : "";
  return `Loaded ${visits} from the synthetic clinic: ${summary.new} new, ${summary.changed} changed, ${summary.unchanged} unchanged, ${summary.ignored.length} ignored, ${summary.flagged} flagged.${refused}`;
}

/** Two imports' results as one: the counts added up, the lists joined, the first import's ID kept. */
export function addPage(a: ImportSummary, b: ImportSummary): ImportSummary {
  return {
    importId: a.importId,
    received: a.received + b.received,
    new: a.new + b.new,
    changed: a.changed + b.changed,
    unchanged: a.unchanged + b.unchanged,
    flagged: a.flagged + b.flagged,
    refused: a.refused + b.refused,
    ignored: [...a.ignored, ...b.ignored],
    refusedVisits: [...a.refusedVisits, ...b.refusedVisits],
  };
}

/**
 * The demo-mode way to fill an empty desk: posts to `/api/imports/synthetic` page after page until
 * the server says there is no next one, and hands back one summary of them all. The parent decides
 * where the summary goes, because the button leaves once claims arrive. Only render it when
 * `me.demoMode` is on; the route answers 404 otherwise.
 */
export function LoadSyntheticClinic({ onLoaded }: { onLoaded: (summary: ImportSummary) => void }) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  async function load() {
    setState("loading");
    try {
      let summary: ImportSummary | null = null;
      let offset: number | null = 0;
      while (offset !== null) {
        const body: SyntheticImportRequest = { offset };
        const { next, ...page }: SyntheticImportPage = await api.post<SyntheticImportPage>("/api/imports/synthetic", body);
        summary = summary ? addPage(summary, page) : page;
        offset = next;
      }
      setState("idle");
      if (summary) onLoaded(summary);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="load-synthetic">
      <Button variant="primary" onClick={load} disabled={state === "loading"} aria-busy={state === "loading"} iconLeft={<Icon name="file-up" size={18} aria-hidden="true" />}>
        {state === "loading" ? "Loading the synthetic clinic…" : "Load the synthetic clinic"}
      </Button>
      {state === "failed" ? (
        <p className="load-synthetic__failed" role="alert">
          The synthetic clinic didn't load. Try again in a moment.
        </p>
      ) : null}
    </div>
  );
}
