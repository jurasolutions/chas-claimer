// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessRedirect, jsonAnswer, stubNetwork, type Answer } from "../../tests/helpers/network";
import type { MeResponse } from "../api/common";
import { App } from "./App";
import { navigate } from "./router";

const ME_URL = `${window.location.origin}/api/me`;
const officer: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: true };

const ROUTES: Array<[path: string, heading: string]> = [
  ["/", "Today"],
  ["/claims", "Claims"],
  ["/claims/c1", "Claim"],
  ["/imports", "Import visits"],
  ["/submit", "Submit claims"],
  ["/payments", "Payments"],
  ["/payments/r1", "Payment statement"],
  ["/settings", "Settings"],
  ["/simulator", "Payer simulator"],
];

const desktopWidth = window.innerWidth;
function atWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

async function openAt(path: string, me = jsonAnswer(officer)) {
  window.history.replaceState(null, "", path);
  stubNetwork({ [ME_URL]: me });
  const view = render(<App />);
  await screen.findByRole("main");
  return view;
}

afterEach(() => {
  atWidth(desktopWidth);
  window.history.replaceState(null, "", "/");
});

describe("App frame", () => {
  it.each(ROUTES)("renders the placeholder for %s", async (path, heading) => {
    atWidth(1280);
    await openAt(path);

    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("says plainly when a page doesn't exist and leads back to today", async () => {
    await openAt("/no-such-page");

    expect(screen.getByRole("heading", { level: 1, name: "We can't find that page" })).toBeTruthy();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Go to today" }).getAttribute("href")).toBe("/");
  });

  it.each(["/claims/%E0", "/claims/%"])("shows the not-found page for a malformed address like %s", async (path) => {
    await openAt(path);

    expect(screen.getByRole("heading", { level: 1, name: "We can't find that page" })).toBeTruthy();
  });

  it("shows the left rail on a desktop, with the payer simulator set apart", async () => {
    atWidth(1280);
    await openAt("/claims");

    const rail = screen.getByRole("navigation", { name: "Claims desk" });
    const links = within(rail).getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["Today", "Claims", "Submit", "Payments", "Settings", "Payer simulator"]);
    expect(within(rail).getByRole("link", { name: "Claims" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("leaves the payer simulator out of the rail and the phone menu when the simulator is off", async () => {
    atWidth(1280);
    const view = await openAt("/claims", jsonAnswer({ ...officer, demoMode: false }));
    const rail = screen.getByRole("navigation", { name: "Claims desk" });
    expect(within(rail).getAllByRole("link").map((a) => a.textContent)).toEqual(["Today", "Claims", "Submit", "Payments", "Settings"]);
    view.unmount();

    atWidth(360);
    await openAt("/claims", jsonAnswer({ ...officer, demoMode: false }));
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const menu = screen.getByRole("navigation", { name: "Claims desk" });
    expect(within(menu).queryByRole("link", { name: "Payer simulator" })).toBeNull();
  });

  it("shows a top bar with the current section and a menu on a phone", async () => {
    atWidth(360);
    await openAt("/payments");

    const bar = screen.getByRole("banner");
    expect(within(bar).getByText("Payments")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Claims desk" })).toBeNull();

    fireEvent.click(within(bar).getByRole("button", { name: "Open menu" }));
    const menu = screen.getByRole("navigation", { name: "Claims desk" });
    expect(within(menu).getByRole("link", { name: "Payments" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(menu).getByRole("link", { name: "Settings" }));
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Claims desk" })).toBeNull();
  });

  it("switches between rail and top bar when the window is resized", async () => {
    atWidth(1280);
    await openAt("/");
    expect(screen.getByRole("navigation", { name: "Claims desk" })).toBeTruthy();

    act(() => atWidth(360));

    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });

  it("moves focus to the page after following a link, so a screen reader hears the new page", async () => {
    atWidth(1280);
    await openAt("/");

    fireEvent.click(within(screen.getByRole("navigation", { name: "Claims desk" })).getByRole("link", { name: "Claims" }));

    expect(document.activeElement).toBe(screen.getByRole("main"));
    expect(document.title).toBe("Claims · Claims desk");
  });

  it("QA N1: moves focus to the page when a move that keeps the path takes away what had focus", async () => {
    atWidth(1280);
    await openAt("/submit");

    // The send results' checklist link goes from /submit to /submit?claim=…, and unmounts itself.
    act(() => navigate("/submit?claim=c1"));

    expect(document.activeElement).toBe(screen.getByRole("main"));
  });

  it("QA N1: leaves focus where it is when a move that keeps the path doesn't take it away", async () => {
    atWidth(1280);
    await openAt("/claims");
    const claims = within(screen.getByRole("navigation", { name: "Claims desk" })).getByRole("link", { name: "Claims" });
    claims.focus();

    act(() => navigate("/claims?status=ready"));

    expect(document.activeElement).toBe(claims);
  });

  it("keeps the simulator's banner on screen so nobody mistakes it for a payer", async () => {
    await openAt("/simulator");

    expect(screen.getByRole("note").textContent).toBe("Payer simulator. Nothing here reaches a real payer.");
  });
});

describe("access", () => {
  it.each([...ROUTES, ["/no-such-page", ""]])("tells someone outside both role lists they have no access on %s", async (path) => {
    await openAt(path, jsonAnswer({ error: "forbidden" }, 403));

    expect(screen.getByRole("heading", { level: 1, name: "You don't have access to the claims desk" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("says when the person is signed out", async () => {
    await openAt("/claims", jsonAnswer({ error: "unauthenticated" }, 401));

    expect(screen.getByRole("heading", { level: 1, name: "You're signed out" })).toBeTruthy();
  });

  it("offers another try when the desk can't be reached", async () => {
    let calls = 0;
    await openAt("/claims", () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: "internal" }), { status: 500 })
        : new Response(JSON.stringify(officer), { status: 200 });
    });

    expect(screen.getByRole("heading", { level: 1, name: "The claims desk didn't load" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Claims" })).toBeTruthy();
    expect(calls).toBe(2);
  });
});

describe("when the session ends (infra I4, review S-4)", () => {
  /** After /api/me, every call gets `answer`: Access's sign-in redirect unless a test says otherwise. */
  function sessionEndsAfterMe(answer: Answer = accessRedirect) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url === ME_URL) return jsonAnswer(officer)(request);
        return answer(request);
      }),
    );
  }

  async function sessionAlert() {
    const main = await screen.findByRole("main");
    // The page's own failure may be an alert too; the session notice is the one with this title.
    const alerts = await within(main).findAllByRole("alert");
    const alert = alerts.find((each) => each.textContent?.includes("Your session ended."));
    if (!alert) throw new Error("No session-ended alert");
    return { main, alert };
  }

  it("says the session ended above the page, keeps the page, and puts focus on the reload button", async () => {
    atWidth(1280);
    window.history.replaceState(null, "", "/claims");
    sessionEndsAfterMe();
    render(<App />);

    const { main, alert } = await sessionAlert();
    expect(alert.textContent).toContain("Reload the page to sign in again.");
    const reload = within(alert).getByRole("button", { name: "Reload the page" });
    expect(document.activeElement).toBe(reload);
    expect(within(main).getByRole("heading", { level: 1, name: "Claims" })).toBeTruthy();
    // The page's own failure stays below it; the notice comes first, so it is read first.
    const pageFailure = within(main).getByText(/Check your connection/);
    expect(alert.compareDocumentPosition(pageFailure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Claims desk" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("!");
  });

  it("says so too when the desk itself answers that no one is signed in", async () => {
    atWidth(1280);
    window.history.replaceState(null, "", "/claims");
    sessionEndsAfterMe(jsonAnswer({ error: "unauthenticated" }, 401));
    render(<App />);

    await sessionAlert();
  });

  it("leaves a dropped connection to the page's own message, with no session notice", async () => {
    atWidth(1280);
    window.history.replaceState(null, "", "/claims");
    sessionEndsAfterMe(() => {
      throw new TypeError("Failed to fetch");
    });
    render(<App />);

    const main = await screen.findByRole("main");
    expect(await within(main).findByText(/Check your connection/)).toBeTruthy();
    expect(main.textContent).not.toContain("Your session ended.");
  });

  it("keeps saying so on the next page, where every call would be refused the same way", async () => {
    atWidth(1280);
    window.history.replaceState(null, "", "/claims");
    sessionEndsAfterMe();
    render(<App />);
    await sessionAlert();

    fireEvent.click(within(screen.getByRole("navigation", { name: "Claims desk" })).getByRole("link", { name: "Payments" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Payments" })).toBeTruthy();
    expect(screen.getByRole("main").textContent).toContain("Your session ended.");
  });

  it("still says the desk didn't load when /api/me itself can't be reached, before anyone is signed in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "The claims desk didn't load" })).toBeTruthy();
  });
});

describe("screen copy", () => {
  it.each([...ROUTES, ["/no-such-page", ""]])("never raises its voice on %s", async (path) => {
    atWidth(360);
    await openAt(path);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(document.body.textContent).not.toContain("!");
  });

  it("never raises its voice on the access, signed-out and error pages", async () => {
    for (const [body, status] of [
      [{ error: "forbidden" }, 403],
      [{ error: "unauthenticated" }, 401],
      [{ error: "internal" }, 500],
    ] as const) {
      const view = await openAt("/", jsonAnswer(body, status));
      expect(document.body.textContent).not.toContain("!");
      view.unmount();
    }
  });
});
