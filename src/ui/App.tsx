/**
 * The frame every screen sits in: who is signed in, the navigation, and which page the path
 * names. Each screen's own content lives in its file under `pages/`.
 *
 * Desktop (1024px and up) gets the left rail from docs/design.md. Anything narrower gets the top
 * bar (mark, current section, menu), so a tablet in portrait reads like a large phone.
 */
import { Component, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { MeResponse } from "../api/common";
import { Alert, Button, Icon, IconButton, Logo } from "../ds";
import { ApiError, api, onSessionEnded } from "./api";
import { MeContext } from "./me";
import { Link, matchPath, useLocation } from "./router";
import { PageHeader } from "./components/PageHeader";
import { AssistedSubmit } from "./pages/AssistedSubmit";
import { ClaimDetail } from "./pages/ClaimDetail";
import { Imports } from "./pages/Imports";
import { Overview } from "./pages/Overview";
import { Queue } from "./pages/Queue";
import { Remittances } from "./pages/Remittances";
import { Settings } from "./pages/Settings";
import { Simulator } from "./pages/Simulator";

type Section = "today" | "claims" | "submit" | "payments" | "settings" | "simulator";

interface Route {
  path: string;
  /** The page's name in the browser tab: "Claims · Claims desk". */
  title: string;
  section: Section;
  render: (params: Record<string, string>) => ReactNode;
}

const ROUTES: Route[] = [
  { path: "/", title: "Today", section: "today", render: () => <Overview /> },
  { path: "/imports", title: "Import visits", section: "today", render: () => <Imports /> },
  { path: "/claims", title: "Claims", section: "claims", render: () => <Queue /> },
  { path: "/claims/:id", title: "Claim", section: "claims", render: ({ id }) => <ClaimDetail claimId={id!} /> },
  { path: "/submit", title: "Submit claims", section: "submit", render: () => <AssistedSubmit /> },
  { path: "/payments", title: "Payments", section: "payments", render: () => <Remittances /> },
  { path: "/payments/:id", title: "Remittance", section: "payments", render: ({ id }) => <Remittances remittanceId={id!} /> },
  { path: "/settings", title: "Settings", section: "settings", render: () => <Settings /> },
  { path: "/simulator", title: "Payer simulator", section: "simulator", render: () => <Simulator /> },
];

interface NavItem {
  section: Section;
  href: string;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { section: "today", href: "/", label: "Today", icon: "house" },
  { section: "claims", href: "/claims", label: "Claims", icon: "list-checks" },
  { section: "submit", href: "/submit", label: "Submit", icon: "send" },
  { section: "payments", href: "/payments", label: "Payments", icon: "banknote" },
  { section: "settings", href: "/settings", label: "Settings", icon: "settings" },
];

/** Set apart from the work, so nobody takes it for a payer. */
const SIMULATOR_NAV: NavItem = { section: "simulator", href: "/simulator", label: "Payer simulator", icon: "flask-conical" };

const SIMULATOR_BANNER = "Payer simulator. Nothing here reaches a real payer.";

function resolve(pathname: string) {
  for (const route of ROUTES) {
    const params = matchPath(route.path, pathname);
    if (params) return { title: route.title, section: route.section as Section | null, page: route.render(params) };
  }
  return { title: "We can't find that page", section: null, page: <NotFound /> };
}

const WIDE = 1024;

function subscribeToResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function useWideScreen() {
  return useSyncExternalStore(subscribeToResize, () => window.innerWidth >= WIDE, () => true);
}

type MeState = { kind: "loading" } | { kind: "ready"; me: MeResponse } | { kind: "failed"; status: number | null };

function useMeRequest() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<MeState>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    api.get<MeResponse>("/api/me").then(
      (me) => current && setState({ kind: "ready", me }),
      (error: unknown) => current && setState({ kind: "failed", status: error instanceof ApiError ? error.status : null }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  };
  return { state, retry };
}

export function App() {
  const { state, retry } = useMeRequest();

  if (state.kind === "loading") {
    return (
      <p className="desk-loading muted" role="status">
        Opening the claims desk…
      </p>
    );
  }
  if (state.kind === "failed") return <CannotOpen status={state.status} onRetry={retry} />;

  return (
    <MeContext.Provider value={state.me}>
      <Frame me={state.me} />
    </MeContext.Provider>
  );
}

function Frame({ me }: { me: MeResponse }) {
  const { pathname, search } = useLocation();
  const wide = useWideScreen();
  const { title, section, page } = resolve(pathname);
  const main = useRef<HTMLElement>(null);
  const shownPath = useRef(pathname);
  const shownSearch = useRef(search);
  // Once Access asks for a sign-in, every later request is refused the same way until a reload.
  const [ended, setEnded] = useState(false);

  useEffect(() => onSessionEnded(() => setEnded(true)), []);

  useEffect(() => {
    document.title = `${title} · Claims desk`;
  }, [title]);

  // After a move within the desk, start reading from the new page, as a full page load would.
  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    main.current?.focus();
  }, [pathname]);

  // A move that keeps the path (the send results' checklist link, /submit to /submit?claim=…) can
  // still take away what had focus; start from the page then too. A filter that keeps its focus
  // stays where it is (QA N1).
  useEffect(() => {
    if (shownSearch.current === search) return;
    shownSearch.current = search;
    if (!document.activeElement || document.activeElement === document.body) main.current?.focus();
  }, [search]);

  return (
    <div className="desk" data-layout={wide ? "rail" : "bar"}>
      <a className="skip-link" href="#main">
        Skip to the page
      </a>
      {wide ? (
        <Rail me={me} section={section} pathname={pathname} />
      ) : (
        <TopBar simulator={me.demoMode} section={section} pathname={pathname} />
      )}
      <main id="main" ref={main} tabIndex={-1} className="desk__main">
        {section === "simulator" ? (
          <p role="note" className="simulator-banner">
            {SIMULATOR_BANNER}
          </p>
        ) : null}
        {/* Above the page, not instead of it, so what the person typed is still there to copy. */}
        {ended ? <SessionEnded /> : null}
        <PageBoundary key={pathname}>{page}</PageBoundary>
      </main>
    </div>
  );
}

interface NavProps {
  section: Section | null;
  pathname: string;
  /** Whether the payer simulator is on here (`MeResponse.demoMode`); its link shows only then. */
  simulator: boolean;
  id?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}

function DeskNav({ section, pathname, simulator, id, onKeyDown }: NavProps) {
  const item = (entry: NavItem) => (
    <li key={entry.href}>
      <Link
        href={entry.href}
        className="desk-nav__link"
        aria-current={pathname === entry.href ? "page" : section === entry.section ? "true" : undefined}
      >
        <Icon name={entry.icon} size={20} />
        <span>{entry.label}</span>
      </Link>
    </li>
  );
  return (
    <nav aria-label="Claims desk" id={id} className="desk-nav" onKeyDown={onKeyDown}>
      <ul className="desk-nav__list">{NAV.map(item)}</ul>
      {simulator ? <ul className="desk-nav__list desk-nav__list--apart">{item(SIMULATOR_NAV)}</ul> : null}
    </nav>
  );
}

function Rail({ me, section, pathname }: { me: MeResponse; section: Section | null; pathname: string }) {
  return (
    <div className="rail">
      <div className="rail__brand">
        <Logo variant="mark" size={28} aria-hidden="true" />
        <span className="rail__name">Claims desk</span>
      </div>
      <DeskNav simulator={me.demoMode} section={section} pathname={pathname} />
      <p className="rail__who muted">{me.email}</p>
    </div>
  );
}

function sectionLabel(section: Section | null) {
  if (section === "simulator") return SIMULATOR_NAV.label;
  return NAV.find((entry) => entry.section === section)?.label ?? "Claims desk";
}

const MENU_BUTTON = "desk-menu-button";

function TopBar({ simulator, section, pathname }: { simulator: boolean; section: Section | null; pathname: string }) {
  // Open for one path only, so following a link in the menu closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;

  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    setOpenOn(null);
    // The design system's IconButton takes no ref (React 18), so find it by id.
    document.getElementById(MENU_BUTTON)?.focus();
  };

  return (
    <header className="topbar" onKeyDown={closeOnEscape}>
      <div className="topbar__row">
        <Logo variant="mark" size={28} aria-hidden="true" />
        <span className="topbar__section">{sectionLabel(section)}</span>
        <IconButton
          id={MENU_BUTTON}
          variant="ghost"
          size="lg"
          icon={<Icon name={open ? "x" : "menu"} size={20} />}
          label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="desk-menu"
          onClick={() => setOpenOn(open ? null : pathname)}
        />
      </div>
      {open ? <DeskNav id="desk-menu" simulator={simulator} section={section} pathname={pathname} /> : null}
    </header>
  );
}

function NotFound() {
  return (
    <>
      <PageHeader title="We can't find that page" />
      <p>
        The address may be mistyped, or the page has moved. <Link href="/">Go to today</Link>
      </p>
    </>
  );
}

/**
 * Catches a page that breaks while rendering, so the desk keeps its navigation and says what to do
 * instead of going blank. Keyed by path in `Frame`, so moving to another page starts afresh.
 */
class PageBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  override render() {
    if (!this.state.broken) return this.props.children;
    return (
      <>
        <PageHeader title="This page didn't load" />
        <p>Something on it stopped working. Reload the page to try again, or go to today.</p>
        <p className="page-broken__actions">
          <ReloadButton />
          <Link href="/">Go to today</Link>
        </p>
      </>
    );
  }
}

function ReloadButton() {
  return (
    <Button iconLeft={<Icon name="refresh-cw" size={18} />} onClick={() => window.location.reload()}>
      Reload the page
    </Button>
  );
}

/**
 * What a signed-in page says once Access asks for a sign-in again, or the desk no longer sees a
 * signed-in person (infra I4, review S-4). It sits above the page, which stays, and takes focus on
 * its reload button so a keyboard or screen reader user lands on the way out. A reload goes through
 * Access again.
 */
function SessionEnded() {
  const wrapper = useRef<HTMLDivElement>(null);

  // The design system's Button takes no ref (React 18), so find it inside the wrapper.
  useEffect(() => {
    wrapper.current?.querySelector("button")?.focus();
  }, []);

  return (
    <div ref={wrapper} className="session-ended">
      <Alert tone="warning" role="alert" title="Your session ended.">
        <span className="retry-line">
          <span>Reload the page to sign in again. Anything you haven't saved is lost on reload, so copy it first.</span>
          <ReloadButton />
        </span>
      </Alert>
    </div>
  );
}

/** What the desk says when `/api/me` refuses or fails. No navigation: there is nothing to reach. */
function CannotOpen({ status, onRetry }: { status: number | null; onRetry: () => void }) {
  const [heading, sentence, action] =
    status === 403
      ? [
          "You don't have access to the claims desk",
          "Ask the person who runs the desk at your clinic to add your email to the officer or reviewer list.",
          null,
        ]
      : status === 401
        ? [
            "You're signed out",
            "Sign in again to keep working on claims.",
            <Button key="sign-in" onClick={() => window.location.reload()}>
              Sign in again
            </Button>,
          ]
        : [
            "The claims desk didn't load",
            "Check your connection, then try again.",
            <Button key="retry" iconLeft={<Icon name="refresh-cw" size={18} />} onClick={onRetry}>
              Try again
            </Button>,
          ];

  return (
    <main id="main" className="desk-closed">
      <div className="desk-closed__body">
        <Icon name={status === 403 || status === 401 ? "lock" : "circle-alert"} size={24} className="desk-closed__icon" />
        <h1>{heading}</h1>
        <p>{sentence}</p>
        {action}
      </div>
    </main>
  );
}
