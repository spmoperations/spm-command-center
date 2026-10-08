"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { daysInMonth } from "@/core/dates";
import { isMine } from "@/core/delegation";
import { evalMetric } from "@/core/targets";
import { resetSampleData, useApp, type App } from "@/store/store";

// Phase 1 tabs. Payments and the Personal side stay hidden until they work.
const TABS = [
  { href: "/", key: "today", label: "Today" },
  { href: "/departments", key: "departments", label: "Departments" },
  { href: "/inbox", key: "inbox", label: "Inbox" },
  { href: "/meetings", key: "meetings", label: "Meetings" },
  { href: "/tasks", key: "tasks", label: "Tasks" },
  { href: "/targets", key: "targets", label: "Targets" },
  { href: "/settings", key: "settings", label: "Settings" },
] as const;

type Count = { text: string | number; hot: boolean };

function navCounts({ state, now, today }: App): Record<string, Count> {
  const open = state.inbox.filter((c) => !c.done && !c.replied);
  const mine = state.tasks.filter(isMine);
  const clock = { day: now.getDate(), dim: daysInMonth(now) };
  const lagging = state.metrics
    .filter((m) => !m.parent)
    .filter((m) => evalMetric(m, state.metrics, state.logs, clock).status !== "ok").length;
  return {
    inbox: { text: open.length, hot: open.some((c) => c.pri === "high") },
    tasks: { text: mine.length, hot: mine.some((t) => t.due <= today) },
    targets: { text: lagging ? `${lagging} off` : "OK", hot: lagging > 0 },
  };
}

const Gear = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export function Shell({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const pathname = usePathname();
  const counts = app ? navCounts(app) : {};

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand-row">
            <div className="brand-left">
              <div>
                <h1>Command Center</h1>
                <div className="date">
                  {app ? app.now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : " "}
                </div>
              </div>
            </div>
            <div className="brand-meta">
              <span className="sample">Sample data</span>
              <button className="linkbtn" onClick={resetSampleData}>
                Reset sample data
              </button>
            </div>
          </div>
          <nav className="tabs" aria-label="Sections">
            {TABS.map((tab) => {
              const count = counts[tab.key];
              return (
                <Link key={tab.key} href={tab.href} data-tab={tab.key} aria-current={pathname === tab.href ? "page" : undefined}>
                  {tab.key === "settings" && <Gear />}
                  {tab.label}
                  {count && <span className={`count ${count.hot ? "hot" : ""}`}>{count.text}</span>}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="wrap">{app ? children : <p className="loading">Loading…</p>}</main>
      {app?.ui.toast && (
        <div className="toast" role="status">
          {app.ui.toast}
        </div>
      )}
    </>
  );
}
