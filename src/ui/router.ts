/**
 * A small history router with no dependency. The location lives in `window.location`; components
 * read it through `useLocation` and move it with `navigate` or `<Link>`.
 */
import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const CHANGE = "desk:navigate";

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

/** The current path and query string ("?status=ready", or "" when there is none). */
export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot, () => "/");
  const url = new URL(href, "http://desk.invalid");
  return { pathname: url.pathname, search: url.search, query: url.searchParams };
}

export function navigate(to: string, { replace = false } = {}) {
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new Event(CHANGE));
}

/**
 * The click handler behind `Link`, for an anchor drawn by someone else (a design-system `Button`
 * with `href`): a plain left click stays in the app, any modified click is the browser's.
 */
export function followLink(event: MouseEvent<HTMLElement>) {
  const anchor = event.currentTarget;
  const href = anchor.getAttribute("href");
  const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  if (!href || event.defaultPrevented || event.button !== 0 || modified || anchor.getAttribute("target")) return;
  event.preventDefault();
  navigate(href);
}

/** A real anchor that moves within the app on a plain click. */
export function Link({ onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    followLink(event);
  };
  return createElement("a", { ...rest, onClick: follow });
}

/** `decodeURIComponent`, but a malformed escape ("%E0", a lone "%") gives null instead of throwing. */
function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * `matchPath("/claims/:id", "/claims/c1")` gives `{ id: "c1" }`; no match gives null. So does a
 * parameter with a malformed escape, which then falls through to the not-found page.
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);
  if (want.length !== have.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const value = have[i]!;
    if (!part.startsWith(":")) {
      if (part !== value) return null;
      continue;
    }
    const decoded = decodeSegment(value);
    if (decoded === null) return null;
    params[part.slice(1)] = decoded;
  }
  return params;
}
