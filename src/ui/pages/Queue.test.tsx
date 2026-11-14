// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { jsonAnswer, stubNetwork, type Answer } from "../../../tests/helpers/network";
import type { ClaimListResponse, ClaimRow } from "../../api/claims";
import type { MeResponse } from "../../api/common";
import type { SyntheticImportPage } from "../../api/imports";
import type { SettingsResponse } from "../../api/settings";
import type { IsoDate } from "../../domain/dates";
import { finding } from "../../domain/claims/findings";
import { cents } from "../../domain/money";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { MeContext } from "../me";
import { Queue } from "./Queue";

const day = (s: string) => s as IsoDate;
const origin = window.location.origin;
const CLAIMS = `${origin}/api/claims`;
const SYNTHETIC = `${origin}/api/imports/synthetic`;
const BATCH = `${origin}/api/claims/actions`;
const SETTINGS = `${origin}/api/settings`;
const SETTINGS_BODY: SettingsResponse = { version: 0, settings: DEFAULT_SETTINGS, roles: { reviewers: [], officers: [] }, ruleSets: [], approvedByChannel: [] };

const officer = (demoMode: boolean): MeResponse => ({ email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode });
const REVIEWER: MeResponse = { email: "reviewer@clinic.test", roles: ["reviewer"], aiConfigured: false, demoMode: true };

/** A synthetic D01-like row: masked patient only, the deadline already worked out by the server. */
const d01: ClaimRow = {
  id: "c-d01",
  visitKey: "SC-D01",
  status: "ready",
  scheme: "chas",
  payerId: "CHAS",
  payerName: "CHAS Blue",
  branchId: "BR-EAST",
  branchName: "East branch",
  patientMask: "T••••567D",
  visitDate: day("2026-11-10"),
  feeCents: cents(9592),
  claimedCents: cents(5050),
  deadline: { deadline: day("2026-12-10"), daysLeft: 26, warning: false, windowDays: 30 },
  changedAfterSubmission: false,
  blockingCount: 0,
  findings: [],
  version: 1,
};

/** A claim row is the list item that holds its link; its findings are a list of their own. */
const rowOf = (link: HTMLElement): HTMLElement => {
  const row = link.closest("li");
  if (!row) throw new Error("a claim link outside a list item");
  return row;
};

const page = (items: ClaimRow[], next: string | null = null): ClaimListResponse => ({ items, next });

function openQueue({
  demoMode = true,
  search = "",
  me = officer(demoMode),
  routes,
}: {
  demoMode?: boolean;
  search?: string;
  me?: MeResponse;
  routes: Record<string, Answer>;
}) {
  window.history.replaceState(null, "", `/claims${search}`);
  const fetchStub = stubNetwork(routes);
  render(
    <MeContext.Provider value={me}>
      <Queue />
    </MeContext.Provider>,
  );
  return fetchStub;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("Queue", () => {
  it("shows a claim row with status, masked patient, visit date, payer, amount and deadline (AC-1.7, AC-1.8)", async () => {
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])) } });

    const row = rowOf(await screen.findByRole("link"));
    expect(within(row).getByText("Ready")).toBeTruthy();
    expect(within(row).getByText("T••••567D")).toBeTruthy();
    expect(within(row).getByText("10 Nov 2026")).toBeTruthy();
    expect(within(row).getByText("CHAS Blue")).toBeTruthy();
    expect(within(row).getByText("$50.50")).toBeTruthy();
    expect(within(row).getByText("Due in 26 days")).toBeTruthy();
    expect(within(row).getByRole("link").getAttribute("href")).toBe("/claims/c-d01");
  });

  it("names each claim's branch from settings, so D01 reads as East (UAT 3.3, QA D03)", async () => {
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])) } });

    const row = rowOf(await screen.findByRole("link"));
    expect(within(row).getByText("East branch")).toBeTruthy();
    expect(within(row).queryByText("BR-EAST")).toBeNull();
  });

  it("leads an approved claim to submission, and offers no submit on a claim that isn't approved", async () => {
    const approved: ClaimRow = { ...d01, id: "c-d02", visitKey: "SC-D02", status: "approved", patientMask: "T••••890B" };
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01, approved])) } });

    const submit = await screen.findByRole("link", { name: /^Submit/ });
    expect(submit.getAttribute("href")).toBe("/submit?claim=c-d02");
    expect(within(rowOf(submit)).getByText("T••••890B")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /^Submit/ })).toHaveLength(1);
  });

  it("says what to fix on a claim that needs attention, in the catalogue's words", async () => {
    const expired = finding("card_expired", { tier: "orange", expiry: "2026-10-02" });
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([{ ...d01, status: "needs_attention", blockingCount: 1, findings: [expired] }])) } });

    const row = rowOf(await screen.findByRole("link"));
    expect(within(row).getByText("Needs attention")).toBeTruthy();
    expect(within(row).getByText("1 thing to fix")).toBeTruthy();
    expect(within(row).getByText(/2 Oct 2026/)).toBeTruthy();
  });

  it("passes the page's filters on to the server", async () => {
    const asked: string[] = [];
    openQueue({
      search: "?status=ready&scheme=chas",
      routes: {
        [`${CLAIMS}?status=ready&scheme=chas`]: (request) => {
          asked.push(request.url);
          return jsonAnswer(page([d01]))(request);
        },
      },
    });

    await screen.findByRole("listitem");
    expect(asked).toHaveLength(1);
  });

  // QA defect D01 (qa-01.md, ticket 02): the queue filtered only through URL parameters, with no
  // control on the page (UAT 3.3 "filter ready"; technical.md §API: status, scheme, payer, branch, due).
  it("offers a control on the page to filter the claims by status", async () => {
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])) } });
    await screen.findByRole("listitem");

    const control =
      screen.queryByLabelText(/status/i) ?? screen.queryByRole("group", { name: /status/i }) ?? screen.queryByRole("navigation", { name: /filter/i });

    expect(control).not.toBeNull();
  });

  describe("filters (QA D01)", () => {
    /** The words a filter shows as chosen. */
    const chosen = (label: string) => within(screen.getByLabelText(label)).getByRole("option", { selected: true }).textContent;

    it("narrows the list when a status is chosen, keeps it in the address, and starts again from the first page", async () => {
      const ready = { ...d01, id: "c-ready", payerName: "CHAS Orange" };
      openQueue({
        search: "?scheme=chas&cursor=c2",
        routes: {
          [`${CLAIMS}?scheme=chas&cursor=c2`]: jsonAnswer(page([d01])),
          [`${CLAIMS}?scheme=chas&status=ready`]: jsonAnswer(page([ready])),
        },
      });
      await screen.findByText("CHAS Blue");

      fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ready" } });

      expect(await screen.findByText("CHAS Orange")).toBeTruthy();
      expect(window.location.pathname + window.location.search).toBe("/claims?scheme=chas&status=ready");
    });

    it("offers every filter the queue understands, payers and branches by name", async () => {
      openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])), [SETTINGS]: jsonAnswer(SETTINGS_BODY) } });
      await screen.findByText("CHAS Blue");

      expect(screen.getByLabelText("Scheme")).toBeTruthy();
      expect(screen.getByLabelText("Deadline")).toBeTruthy();
      expect(within(screen.getByLabelText("Changes")).getByRole("option", { name: "Changed after sending" })).toBeTruthy();
      const payer = screen.getByLabelText("Payer");
      expect(await within(payer).findByRole("option", { name: "Meridian Dental Plan" })).toBeTruthy();
      const branch = screen.getByLabelText("Branch");
      expect(within(branch).getByRole("option", { name: "East branch" })).toBeTruthy();
    });

    it("puts each filter in the address under the name the server reads", async () => {
      openQueue({
        routes: {
          [CLAIMS]: jsonAnswer(page([d01])),
          [SETTINGS]: jsonAnswer(SETTINGS_BODY),
          [`${CLAIMS}?branch=BR-EAST`]: jsonAnswer(page([d01])),
          [`${CLAIMS}?branch=BR-EAST&payer=MERIDIAN`]: jsonAnswer(page([d01])),
          [`${CLAIMS}?branch=BR-EAST&payer=MERIDIAN&due=5`]: jsonAnswer(page([d01])),
          [`${CLAIMS}?branch=BR-EAST&payer=MERIDIAN&due=5&changed=true`]: jsonAnswer(page([d01])),
          [`${CLAIMS}?branch=BR-EAST&due=5&changed=true`]: jsonAnswer(page([d01])),
        },
      });
      const branch = screen.getByLabelText("Branch");
      await within(branch).findByRole("option", { name: "East branch" });

      fireEvent.change(branch, { target: { value: "BR-EAST" } });
      fireEvent.change(screen.getByLabelText("Payer"), { target: { value: "MERIDIAN" } });
      fireEvent.change(screen.getByLabelText("Deadline"), { target: { value: "5" } });
      fireEvent.change(screen.getByLabelText("Changes"), { target: { value: "true" } });
      expect(window.location.search).toBe("?branch=BR-EAST&payer=MERIDIAN&due=5&changed=true");

      fireEvent.change(screen.getByLabelText("Payer"), { target: { value: "" } });
      expect(window.location.search).toBe("?branch=BR-EAST&due=5&changed=true");
      expect(await screen.findByText("CHAS Blue")).toBeTruthy();
    });

    it("shows the filters a link arrived with, and a way back to every claim", async () => {
      openQueue({
        search: "?status=needs_attention&scheme=chas&due=5&changed=true",
        routes: { [`${CLAIMS}?status=needs_attention&scheme=chas&due=5&changed=true`]: jsonAnswer(page([d01])) },
      });
      await screen.findByText("CHAS Blue");

      expect(chosen("Status")).toBe("Needs attention");
      expect(chosen("Scheme")).toBe("CHAS");
      expect(chosen("Deadline")).toBe("Due within 5 days");
      expect(chosen("Changes")).toBe("Changed after sending");
      expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/claims");
    });

    it("keeps a filter value it has no name for, rather than dropping it", async () => {
      openQueue({ search: "?due=9", routes: { [`${CLAIMS}?due=9`]: jsonAnswer(page([d01])) } });
      await screen.findByText("CHAS Blue");

      expect(chosen("Deadline")).toBe("9");
    });

    it("names the statuses a link from Today chose together, in words", async () => {
      const search = `?${new URLSearchParams({ status: "submitted,accepted" }).toString()}`;
      openQueue({ search, routes: { [`${CLAIMS}${search}`]: jsonAnswer(page([d01])) } });
      await screen.findByText("CHAS Blue");

      expect(chosen("Status")).toBe("Submitted or accepted");
    });

    it("reads changed=1 from a link as changed after sending", async () => {
      openQueue({ search: "?changed=1", routes: { [`${CLAIMS}?changed=1`]: jsonAnswer(page([d01])) } });
      await screen.findByText("CHAS Blue");

      expect(chosen("Changes")).toBe("Changed after sending");
    });

    it("offers no 'Clear filters' when nothing is filtered", async () => {
      openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])) } });
      await screen.findByText("CHAS Blue");

      expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
    });
  });

  it("marks the list busy while the claims load", async () => {
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01])) } });

    expect(screen.getByText("Loading claims…").getAttribute("aria-busy")).toBe("true");
    await screen.findByText("CHAS Blue");
  });

  it("loads the next page by its cursor and keeps the rows it has", async () => {
    const second = { ...d01, id: "c-2", visitKey: "SC-D02", payerName: "CHAS Orange" };
    openQueue({
      routes: {
        [CLAIMS]: jsonAnswer(page([d01], "cur 1")),
        [`${CLAIMS}?cursor=cur+1`]: jsonAnswer(page([second])),
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Show more claims" }));

    expect(await screen.findByText("CHAS Orange")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Show more claims" })).toBeNull();
  });

  it("shows an empty desk with 'Load the synthetic clinic' and no error (AC-1.6)", async () => {
    openQueue({ routes: { [CLAIMS]: jsonAnswer(page([])) } });

    expect(await screen.findByRole("button", { name: "Load the synthetic clinic" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/didn't work|went wrong|error/i)).toBeNull();
  });

  it("loads the synthetic clinic page by page, then shows its claims and one summary of every page", async () => {
    const pages: SyntheticImportPage[] = [
      { importId: "i1", received: 100, new: 100, changed: 0, unchanged: 0, flagged: 2, refused: 0, ignored: [], refusedVisits: [], next: 100 },
      { importId: "i2", received: 100, new: 98, changed: 0, unchanged: 0, flagged: 1, refused: 0, ignored: [{ visitKey: "V-1", reason: "older_than_current" }, { visitKey: "V-2", reason: "older_than_current" }], refusedVisits: [], next: null },
    ];
    let loaded = false;
    const bodies: unknown[] = [];
    openQueue({
      routes: {
        [CLAIMS]: (request) => jsonAnswer(page(loaded ? [d01] : []))(request),
        [SYNTHETIC]: async (request) => {
          const page = pages[bodies.length]!;
          bodies.push(await request.json());
          loaded = page.next === null;
          return jsonAnswer(page)(request);
        },
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Load the synthetic clinic" }));

    expect(await screen.findByText("CHAS Blue")).toBeTruthy();
    expect(bodies).toEqual([{ offset: 0 }, { offset: 100 }]);
    expect(screen.getByText("Loaded 200 visits from the synthetic clinic: 198 new, 0 changed, 0 unchanged, 2 ignored, 3 flagged.")).toBeTruthy();
  });

  it("offers no synthetic load outside demo mode, and still shows no error", async () => {
    openQueue({ demoMode: false, routes: { [CLAIMS]: jsonAnswer(page([])) } });

    expect(await screen.findByText("No claims waiting")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load the synthetic clinic" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a filter matched nothing and leads back to the open claims", async () => {
    openQueue({ search: "?scheme=chas", routes: { [`${CLAIMS}?scheme=chas`]: jsonAnswer(page([])) } });

    expect(await screen.findByText("No claims match these filters")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show all open claims" }).getAttribute("href")).toBe("/claims");
    expect(screen.queryByRole("button", { name: "Load the synthetic clinic" })).toBeNull();
  });

  it("says plainly when the queue didn't load, and can try again", async () => {
    let calls = 0;
    openQueue({
      routes: {
        [CLAIMS]: (request) => (++calls === 1 ? jsonAnswer({ error: "internal" }, 500)(request) : jsonAnswer(page([d01]))(request)),
      },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The claims didn't load.");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("CHAS Blue")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("batch approval (AC-3.4)", () => {
    const d02: ClaimRow = { ...d01, id: "c-d02", visitKey: "SC-D02", patientMask: "T••••891B", payerName: "CHAS Orange", version: 4 };

    it("approves the claims a reviewer selects, each at the version they saw, then shows the queue again", async () => {
      const bodies: unknown[] = [];
      let approved = false;
      openQueue({
        me: REVIEWER,
        routes: {
          [CLAIMS]: (request) => jsonAnswer(page(approved ? [] : [d01, d02]))(request),
          [BATCH]: async (request) => {
            expect(request.method).toBe("POST");
            bodies.push(await request.json());
            approved = true;
            return jsonAnswer({ done: [{ id: "c-d01", version: 2, warnings: 0 }, { id: "c-d02", version: 5, warnings: 0 }], failed: [] })(request);
          },
        },
      });

      fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select T••••891B CHAS Orange" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve 2 claims" }));

      expect(await screen.findByText("Approved 2 claims.")).toBeTruthy();
      expect(bodies).toEqual([{ action: "approve", items: [{ id: "c-d01", version: 1 }, { id: "c-d02", version: 4 }] }]);
      expect(await screen.findByText("No claims waiting")).toBeTruthy();
    });

    it("approves the rest and names the claim that changed since it was selected", async () => {
      openQueue({
        me: REVIEWER,
        routes: {
          [CLAIMS]: jsonAnswer(page([d01, d02])),
          [BATCH]: jsonAnswer({
            done: [{ id: "c-d01", version: 2, warnings: 0 }],
            failed: [{ id: "c-d02", status: 409, error: { error: "stale", version: 5 } }],
          }),
        },
      });

      fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select T••••891B CHAS Orange" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve 2 claims" }));

      expect(await screen.findByText("Approved 1 claim.")).toBeTruthy();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("1 claim wasn't approved");
      expect(within(alert).getByRole("listitem").textContent).toBe("T••••891B CHAS Orange changed since you selected it. Open it to check what changed.");
    });

    it("lists every warning on the selected claims before approving them, and says which went through with warnings (S17)", async () => {
      const soon = finding("deadline_approaching", { daysLeft: 2 });
      const bodies: unknown[] = [];
      openQueue({
        me: REVIEWER,
        routes: {
          [CLAIMS]: jsonAnswer(page([d01, { ...d02, findings: [soon] }])),
          [BATCH]: async (request) => {
            bodies.push(await request.json());
            return jsonAnswer({ done: [{ id: "c-d01", version: 2, warnings: 0 }, { id: "c-d02", version: 5, warnings: 1 }], failed: [] })(request);
          },
        },
      });

      fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select T••••891B CHAS Orange" }));
      fireEvent.click(screen.getByRole("button", { name: "Approve 2 claims" }));

      const dialog = screen.getByRole("dialog", { name: "Approve 2 claims with 1 warning?" });
      const flagged = within(dialog).getByRole("heading", { name: "T••••891B CHAS Orange" });
      expect(flagged.closest("li")?.textContent).toContain("Last 3 days to submit.");
      expect(within(dialog).queryByText("T••••567D CHAS Blue")).toBeNull();
      expect(bodies).toEqual([]);

      fireEvent.click(within(dialog).getByRole("button", { name: "Approve anyway" }));

      expect(await screen.findByText("Approved 2 claims, 1 with warnings.")).toBeTruthy();
      expect(bodies).toHaveLength(1);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("puts focus on the batch's result once the approval settles and the queue reloads (QA 03 D02a)", async () => {
      const soon = finding("deadline_approaching", { daysLeft: 2 });
      openQueue({
        me: REVIEWER,
        routes: {
          [CLAIMS]: jsonAnswer(page([d01, { ...d02, findings: [soon] }])),
          [BATCH]: jsonAnswer({ done: [{ id: "c-d01", version: 2, warnings: 0 }, { id: "c-d02", version: 5, warnings: 1 }], failed: [] }),
        },
      });

      fireEvent.click(await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select T••••891B CHAS Orange" }));
      const approve = screen.getByRole("button", { name: "Approve 2 claims" });
      approve.focus();
      fireEvent.click(approve);
      const anyway = within(screen.getByRole("dialog")).getByRole("button", { name: "Approve anyway" });
      anyway.focus();
      fireEvent.click(anyway);

      const result = await screen.findByText("Approved 2 claims, 1 with warnings.");
      await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" });
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(result);
    });

    it("says so when the batch didn't go through, and keeps the selection", async () => {
      openQueue({
        me: REVIEWER,
        routes: { [CLAIMS]: jsonAnswer(page([d01])), [BATCH]: jsonAnswer({ error: "internal" }, 500) },
      });

      const box = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Select T••••567D CHAS Blue" });
      fireEvent.click(box);
      fireEvent.click(screen.getByRole("button", { name: "Approve 1 claim" }));

      expect((await screen.findByRole("alert")).textContent).toContain("The approval didn't go through. Try again.");
      expect(box.checked).toBe(true);
    });

    it("offers officers no way to approve, and ready claims only to reviewers", async () => {
      const waiting: ClaimRow = { ...d02, status: "needs_attention", blockingCount: 1 };
      openQueue({ me: REVIEWER, routes: { [CLAIMS]: jsonAnswer(page([d01, waiting])) } });

      expect(await screen.findByRole("checkbox", { name: "Select T••••567D CHAS Blue" })).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: "Select T••••891B CHAS Orange" })).toBeNull();
    });

    it("shows an officer the queue without checkboxes", async () => {
      openQueue({ routes: { [CLAIMS]: jsonAnswer(page([d01, d02])) } });

      await screen.findByText("CHAS Orange");
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    });
  });
});
