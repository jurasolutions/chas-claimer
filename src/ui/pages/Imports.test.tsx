// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { MeResponse } from "../../api/common";
import type { ImportListItem, ImportListResponse, SyntheticImportPage } from "../../api/imports";
import { MeContext } from "../me";
import { Imports } from "./Imports";

const origin = window.location.origin;
const IMPORTS = `${origin}/api/imports`;
const SYNTHETIC = `${origin}/api/imports/synthetic`;

const officer = (demoMode: boolean): MeResponse => ({ email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode });

const synthetic: ImportListItem = {
  id: "imp-2",
  source: "synthetic",
  actor: "officer@clinic.test",
  startedAt: "2026-11-14T01:05:00.000Z",
  finishedAt: "2026-11-14T01:05:02.000Z",
  received: 214,
  new: 12,
  changed: 3,
  unchanged: 198,
  ignored: 1,
  flagged: 1,
  refused: 0,
};
const connector: ImportListItem = { ...synthetic, id: "imp-1", source: "connector", startedAt: "2026-11-13T09:30:00.000Z", received: 40, new: 38, changed: 0, unchanged: 0, ignored: 0, flagged: 0, refused: 2 };

function openImports({ demoMode = true, routes }: { demoMode?: boolean; routes: Record<string, Answer> }) {
  stubNetwork(routes);
  render(
    <MeContext.Provider value={officer(demoMode)}>
      <Imports />
    </MeContext.Provider>,
  );
}

/** The figure shown against a count's label within one import. */
function count(row: HTMLElement, label: string): string | null {
  return within(row).getByText(label).nextElementSibling?.textContent ?? null;
}

describe("Imports", () => {
  it("lists recent imports, newest first, with where they came from, when, and their counts", async () => {
    openImports({ routes: { [IMPORTS]: jsonAnswer({ items: [synthetic, connector] } satisfies ImportListResponse) } });

    const [first, second] = (await screen.findAllByRole("listitem")) as [HTMLElement, HTMLElement];
    expect(within(first).getByText("Synthetic clinic")).toBeTruthy();
    expect(within(first).getByText("14 Nov 2026, 9:05 am")).toBeTruthy();
    expect([count(first, "Received"), count(first, "New"), count(first, "Changed"), count(first, "Unchanged"), count(first, "Ignored"), count(first, "Flagged"), count(first, "Refused")]).toEqual([
      "214",
      "12",
      "3",
      "198",
      "1",
      "1",
      "0",
    ]);
    expect(within(second).getByText("Clinic records")).toBeTruthy();
    expect(within(second).getByText("13 Nov 2026, 5:30 pm")).toBeTruthy();
    expect(count(second, "Refused")).toBe("2");
  });

  it("shows an empty list with 'Load the synthetic clinic', then the import it made", async () => {
    let loaded = false;
    const summary: SyntheticImportPage = { importId: "imp-2", received: 214, new: 214, changed: 0, unchanged: 0, flagged: 0, refused: 0, ignored: [], refusedVisits: [], next: null };
    openImports({
      routes: {
        [IMPORTS]: (request) => jsonAnswer({ items: loaded ? [synthetic] : [] })(request),
        [SYNTHETIC]: (request) => {
          loaded = true;
          return jsonAnswer(summary)(request);
        },
      },
    });

    expect(await screen.findByText("No imports yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load the synthetic clinic" }));

    expect(await screen.findByText("Synthetic clinic")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loaded 214 visits from the synthetic clinic: 214 new, 0 changed, 0 unchanged, 0 ignored, 0 flagged.");
  });

  it("offers no synthetic load outside demo mode", async () => {
    openImports({ demoMode: false, routes: { [IMPORTS]: jsonAnswer({ items: [] }) } });

    expect(await screen.findByText("No imports yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load the synthetic clinic" })).toBeNull();
  });

  it("says plainly when the imports didn't load, and can try again", async () => {
    let calls = 0;
    openImports({ routes: { [IMPORTS]: (request) => (++calls === 1 ? jsonAnswer({ error: "internal" }, 500)(request) : jsonAnswer({ items: [synthetic] })(request)) } });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The imports didn't load.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Synthetic clinic")).toBeTruthy();
  });
});
