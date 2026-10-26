"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { CONNECTIONS_TAB, DEPARTMENTS, MODE_NAME, MODES, PERSONAL_SIDE, TARGETS } from "@/core/config";
import { daysInMonth } from "@/core/dates";
import { isMine } from "@/core/delegation";
import { PROVIDERS } from "@/core/providers";
import { evalMetric } from "@/core/targets";
import type { Mode } from "@/core/types";
import { HelpButton } from "@/components/Help";
import { reviewWaiting } from "@/core/review";
import { PROFESSIONAL_ONLY, refresh, setMode, signOut, useApp, useMode, useToast, type App } from "@/store/store";

// Phase 1 tabs. The Personal side shows the tabs that work for it; Payments, Goals and
// Health from the prototype stay hidden until they are built.
const TABS = [
  { href: "/", key: "today", label: "Today" },
  { href: "/departments", key: "departments", label: "Departments" },
  { href: "/inbox", key: "inbox", label: "Inbox" },
  { href: "/emails", key: "emails", label: "Emails" },
  { href: "/meetings", key: "meetings", label: "Meetings" },
  { href: "/calendar", key: "calendar", label: "Calendar" },
  { href: "/review", key: "review", label: "Review" },
  { href: "/tasks", key: "tasks", label: "Tasks" },
  { href: "/targets", key: "targets", label: "Targets" },
  { href: "/connections", key: "connections", label: "Connections" },
  { href: "/settings", key: "settings", label: "Settings" },
] as const;

type Count = { text: string | number; hot: boolean; title: string };

function navCounts({ state, now, today }: App, mode: Mode): Record<string, Count> {
  const open = state.inbox.filter((c) => c.mode === mode && !c.done && !c.replied && c.source !== "gmail");
  const emails = state.inbox.filter((c) => c.source === "gmail" && !c.done && !c.replied);
  const mine = state.tasks.filter((t) => t.mode === mode && isMine(t, state.me.id));
  const toReview = reviewWaiting(state.review).length;
  const clock = { day: now.getDate(), dim: daysInMonth(now) };
  const lagging = state.metrics
    .filter((m) => !m.parent)
    .filter((m) => evalMetric(m, state.metrics, state.logs, clock).status !== "ok").length;
  // Every app the Connections tab shows is counted, Telegram too while it is not switched on yet.
  const providers = PROVIDERS;
  const connected = providers.filter((p) => state.connections[p].connected).length;
  return {
    inbox: { text: open.length, hot: open.some((c) => c.pri === "high"), title: `${open.length} waiting for a reply` },
    emails: { text: emails.length, hot: false, title: `${emails.length} ${emails.length === 1 ? "email" : "emails"} not answered or done` },
    review: { text: toReview, hot: false, title: `${toReview} waiting to be made tickets or turned down` },
    tasks: { text: mine.length, hot: mine.some((t) => t.due <= today), title: `${mine.length} on your plate` },
    targets: { text: lagging ? `${lagging} off` : "OK", hot: lagging > 0, title: lagging ? `${lagging} behind pace` : "All on pace" },
    connections: { text: `${connected} of ${providers.length}`, hot: false, title: `${connected} of ${providers.length} apps connected` },
  };
}

const Gear = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

const Sun = () => (
  <svg className="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const Moon = () => (
  <svg className="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

/** Where the chosen theme is kept, in this browser only. The page reads it before it draws (see layout.tsx). */
export const THEME_KEY = "cc-theme";

/**
 * Light or dark. Until it is pressed, the dashboard follows the computer's own setting; after
 * that it keeps the choice, in this browser.
 */
function ThemeToggle() {
  return (
    <button
      className="theme-btn"
      aria-label="Switch between the light and dark theme"
      title="Light or dark"
      onClick={() => {
        const root = document.documentElement;
        const now = root.dataset.theme ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const next = now === "dark" ? "light" : "dark";
        root.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // A private window: the choice lasts until the page is closed.
        }
      }}
    >
      {/* The stylesheet shows the one for the theme that is on: the moon in light, the sun in dark. */}
      <Moon />
      <Sun />
    </button>
  );
}

function Chrome({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const mode = useMode();
  const toast = useToast();
  const pathname = usePathname();
  const router = useRouter();
  const counts = app ? navCounts(app, mode) : {};
  // Tabs that are switched off for now are left out (see core/config).
  // The Connections tab comes back where Telegram can be connected, since that is done there.
  const off: string[] = [...(DEPARTMENTS ? [] : ["departments"]), ...(TARGETS ? [] : ["targets"]), ...(CONNECTIONS_TAB || app?.state.telegramAvailable ? [] : ["connections"])];
  const tabs = TABS.filter((tab) => (mode === "professional" || !PROFESSIONAL_ONLY.includes(tab.href)) && !off.includes(tab.key));

  // The Personal side has its own accent color, as in the prototype.
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  const pick = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    // A page that only exists on the Professional side has nothing to show for Personal.
    if (next === "personal" && PROFESSIONAL_ONLY.includes(pathname)) router.push("/");
  };

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand-row">
            <div className="brand-left">
              <div>
                <h1>Command Center</h1>
                <div className="date">
                  {app ? app.now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : " "}
                </div>
              </div>
              {PERSONAL_SIDE && (
                <div className="seg mode-seg" role="group" aria-label="Which side of the dashboard to show">
                  {MODES.map((m) => (
                    <button key={m} aria-pressed={mode === m} onClick={() => pick(m)}>
                      {MODE_NAME[m]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="brand-meta">
              {app?.state.localData && (
                <span className="sample" title="You are looking at the copy of the data on this machine, not the hosted database. Nothing here reaches the live site.">
                  Local data
                </span>
              )}
              {app && !app.state.sendingEnabled && (
                <span className="sample" title="Replies, and the messages that tell someone a task is theirs, are saved in the outbox and not sent. Set SENDING_ENABLED=true on the server to send them.">
                  Sending is off
                </span>
              )}
              {app && app.ui.saving > 0 && (
                <span className="saving" role="status">
                  Saving…
                </span>
              )}
              {app && app.ui.saving === 0 && (
                <button className="linkbtn" onClick={() => void refresh()} title="Read the latest from the server">
                  Updated {app.now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </button>
              )}
              <HelpButton pathname={pathname} />
              <ThemeToggle />
              {/* A team member sees whose Command Center this is. The owner's header stays as it was. */}
              {app && !app.state.me.isOwner && <span className="signed-in">{app.state.owner.name}</span>}
              <button className="linkbtn" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {tabs.map((tab) => {
              const count = counts[tab.key];
              return (
                <Link key={tab.key} href={tab.href} data-tab={tab.key} aria-current={pathname === tab.href ? "page" : undefined}>
                  {tab.key === "settings" && <Gear />}
                  {tab.label}
                  {count && (
                    <span className={`count ${count.hot ? "hot" : ""}`} title={count.title}>
                      {count.text}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      {/* The page is always rendered, even before the data has loaded in the browser: each page
          shows nothing until then. Leaving it out would hide the page from Next's checks. */}
      <main className="wrap">
        {!app && <p className="loading">Loading…</p>}
        {children}
      </main>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
}

/** The header, tabs and toast around every page. The login page stands alone. */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;
  return <Chrome>{children}</Chrome>;
}
