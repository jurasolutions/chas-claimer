// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Link, matchPath, navigate, useLocation } from "./router";

function Where() {
  const { pathname, search } = useLocation();
  return (
    <p>
      at {pathname}
      {search}
    </p>
  );
}

afterEach(() => window.history.replaceState(null, "", "/"));

describe("router", () => {
  it("follows a link without reloading the page", () => {
    render(
      <>
        <Where />
        <Link href="/claims?status=ready">Claims</Link>
      </>,
    );
    expect(screen.getByText("at /")).toBeTruthy();

    const followed = fireEvent.click(screen.getByRole("link", { name: "Claims" }));

    expect(followed).toBe(false); // the browser's own navigation was prevented
    expect(window.location.pathname).toBe("/claims");
    expect(screen.getByText("at /claims?status=ready")).toBeTruthy();
  });

  it("leaves a modified click to the browser, so a new tab still works", () => {
    render(<Link href="/claims">Claims</Link>);
    let leftToBrowser: boolean | undefined;
    // Read the outcome last, then stop jsdom from attempting a real navigation it can't do.
    window.addEventListener(
      "click",
      (event) => {
        leftToBrowser = !event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(screen.getByRole("link", { name: "Claims" }), { metaKey: true });

    expect(leftToBrowser).toBe(true);
    expect(window.location.pathname).toBe("/");
  });

  it("answers back and forward", () => {
    render(<Where />);
    act(() => navigate("/payments"));
    expect(screen.getByText("at /payments")).toBeTruthy();

    act(() => {
      window.history.replaceState(null, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("at /settings")).toBeTruthy();
  });

  it("matches a pattern and decodes its parameters", () => {
    expect(matchPath("/claims/:id", "/claims/c%2F1")).toEqual({ id: "c/1" });
    expect(matchPath("/claims", "/claims/")).toEqual({});
    expect(matchPath("/claims/:id", "/claims")).toBeNull();
    expect(matchPath("/claims/:id", "/claims/a/b")).toBeNull();
  });

  it("treats a path with a malformed escape as no match instead of throwing", () => {
    expect(matchPath("/claims/:id", "/claims/%E0")).toBeNull();
    expect(matchPath("/claims/:id", "/claims/%")).toBeNull();
  });
});
