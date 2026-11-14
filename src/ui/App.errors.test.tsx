// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonAnswer, stubNetwork } from "../../tests/helpers/network";
import type { MeResponse } from "../api/common";
import { App } from "./App";

// A page that breaks while rendering, standing in for any bug a later ticket might ship.
vi.mock("./pages/Settings", () => ({
  Settings: () => {
    throw new Error("A page broke while rendering");
  },
}));

const ME_URL = `${window.location.origin}/api/me`;
const officer: MeResponse = { email: "officer@clinic.test", roles: ["officer"], aiConfigured: false, demoMode: true };

async function openAt(path: string) {
  window.history.replaceState(null, "", path);
  stubNetwork({ [ME_URL]: jsonAnswer(officer) });
  render(<App />);
  await screen.findByRole("main");
}

// React (in development) and jsdom both report a caught render error; keep the test output readable.
const quiet = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  window.addEventListener("error", quiet);
});

afterEach(() => {
  window.removeEventListener("error", quiet);
  window.history.replaceState(null, "", "/");
});

describe("App when a page breaks", () => {
  it("says plainly that the page didn't load, inside the desk, instead of going blank", async () => {
    await openAt("/settings");

    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: "This page didn't load" })).toBeTruthy();
    expect(within(main).getByRole("link", { name: "Go to today" }).getAttribute("href")).toBe("/");
    expect(within(main).getByRole("button", { name: "Reload the page" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Claims desk" })).toBeTruthy();
  });

  it("recovers when you move to another page", async () => {
    await openAt("/settings");
    await screen.findByRole("heading", { level: 1, name: "This page didn't load" });

    fireEvent.click(within(screen.getByRole("navigation", { name: "Claims desk" })).getByRole("link", { name: "Claims" }));

    // The Claims page renders after the click settles; wait for it rather than racing a loaded machine.
    expect(await screen.findByRole("heading", { level: 1, name: "Claims" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "This page didn't load" })).toBeNull();
  });
});
