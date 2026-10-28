"use client";

// The page of someone on the team list who signs in to see their own tasks (see
// server/task-logins.ts): the tickets given to them, and nothing else of the dashboard. It reads
// only /api/my-tasks, never the dashboard's data, and stands alone without its tabs (Shell.tsx).

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ThemeToggle } from "@/components/Shell";
import { PRIORITY_NAME, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import { dueLabel, isoDay } from "@/core/dates";
import type { MyTask, TicketStatus } from "@/core/types";

interface Mine {
  name: string;
  tasks: MyTask[];
}

async function ask(init?: RequestInit): Promise<Mine> {
  const res = await fetch("/api/my-tasks", { cache: "no-store", ...init });
  const data = await res.json().catch(() => ({}));
  // Signed out, or the login was changed or taken away: back to the login page.
  if (res.status === 401) {
    // A full page load on purpose, as in the store's signOut.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
    throw new Error("Please sign in.");
  }
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
  return data as Mine;
}

async function signOut() {
  try {
    await fetch("/api/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } finally {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
}

const never = () => () => {};

function TaskCard({ t, today, picked, onStatus }: { t: MyTask; today: string; picked: boolean; onStatus(status: TicketStatus): void }) {
  const due = dueLabel(t.due, today);
  const done = t.status === "done";
  return (
    <article className={`panel my-card ${done ? "done" : ""} ${picked ? "picked" : ""}`} id={t.ticket || t.id}>
      <div className="my-card-top">
        {t.ticket && <span className="tk-num">{t.ticket}</span>}
        <h3 className="my-title">{t.title}</h3>
      </div>
      <div className="tk-meta">
        <select className={`f tk-status-select tk-${t.status}`} value={t.status} aria-label={`Status: ${t.title}`} onChange={(e) => onStatus(e.target.value as TicketStatus)}>
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_NAME[s]}
            </option>
          ))}
        </select>
        <span className={`due ${done ? "" : due.tone}`}>{done ? "Done" : `Due ${due.text}`}</span>
        <span className={`chip my-pri p-${t.pri}`}>{PRIORITY_NAME[t.pri]} priority</span>
        {t.client && <span className="chip">{t.client}</span>}
      </div>
      {t.description && <p className="my-desc">{t.description}</p>}
      {t.from && <p className="my-from muted">From {t.from}</p>}
    </article>
  );
}

export default function MyTasksPage() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const query = useSyncExternalStore(never, () => window.location.search, () => "");
  // The ticket a Slack message linked to, such as ?task=SPM-12.
  const picked = new URLSearchParams(query).get("task");
  // In the browser only, once the tasks are in: the server never draws them, nor the date.
  const today = mine ? isoDay(new Date()) : "";

  const load = useCallback(
    () =>
      ask().then(
        (answer) => {
          setMine(answer);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );

  useEffect(() => {
    void load();
    // Back on the page: read again, in case the team changed something meanwhile.
    const back = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [load]);

  // Once the tasks are on screen, the linked one is scrolled to.
  useEffect(() => {
    if (mine && picked) document.getElementById(picked)?.scrollIntoView({ block: "center" });
  }, [mine, picked]);

  async function setStatus(id: string, status: TicketStatus) {
    if (!mine) return;
    const before = mine;
    // Shown at once; the server's answer replaces it.
    setMine({ ...mine, tasks: mine.tasks.map((t) => (t.id === id ? { ...t, status } : t)) });
    try {
      setMine(await ask({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) }));
      setError(null);
    } catch (e) {
      setMine(before);
      setError((e as Error).message);
    }
  }

  const open = mine?.tasks.filter((t) => t.status !== "done") ?? [];
  const done = mine?.tasks.filter((t) => t.status === "done") ?? [];
  // The linked ticket shows even when it is done.
  const doneShown = showDone || done.some((t) => t.ticket === picked);

  return (
    <>
      <header className="top">
        <div className="top-inner">
          <div className="brand-row">
            <div className="brand-left">
              <div>
                <h1>Your tasks</h1>
                {/* Written in the browser, in its own timezone, once the tasks are in. */}
                <div className="date">{mine ? new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) : " "}</div>
              </div>
            </div>
            <div className="brand-meta">
              {mine && <span className="signed-in">{mine.name}</span>}
              <ThemeToggle />
              <button className="linkbtn" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="wrap my-tasks">
        <p className="muted my-intro">The tasks the team gave you. Change a task&apos;s status as you work on it: the team sees it on their board straight away.</p>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        {!mine && !error && <p className="loading">Loading…</p>}
        {mine && (
          <>
            {open.length === 0 && <p className="panel my-empty">Nothing on your plate right now.</p>}
            <div className="my-list">
              {open.map((t) => (
                <TaskCard key={t.id} t={t} today={today} picked={t.ticket === picked} onStatus={(s) => void setStatus(t.id, s)} />
              ))}
            </div>
            {done.length > 0 && (
              <section className="my-done">
                <button className="linkbtn" aria-expanded={doneShown} onClick={() => setShowDone(!doneShown)}>
                  {doneShown ? "Hide" : "Show"} done in the last two weeks ({done.length})
                </button>
                {doneShown && (
                  <div className="my-list">
                    {done.map((t) => (
                      <TaskCard key={t.id} t={t} today={today} picked={t.ticket === picked} onStatus={(s) => void setStatus(t.id, s)} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
