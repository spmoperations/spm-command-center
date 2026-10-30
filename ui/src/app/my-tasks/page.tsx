"use client";

// The page of someone on the team list who signs in to see their own tasks (see
// server/task-logins.ts): the tickets given to them, and nothing else of the dashboard. Like the
// board, in four columns by status or as a list, with filters. It reads only /api/my-tasks, never
// the dashboard's data, and stands alone without its tabs (Shell.tsx).

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Seg } from "@/components/bits";
import { ThemeToggle } from "@/components/Shell";
import { StatusPill } from "@/components/Tickets";
import { PRIORITIES, PRIORITY_NAME, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import { addDays, dueLabel, isOverdue, isoDay, parseDay, soonestDue } from "@/core/dates";
import type { MyTask, Priority, TicketStatus } from "@/core/types";

interface Mine {
  name: string;
  tasks: MyTask[];
}

/** Which way the page was last looked at, kept in this browser only. */
const VIEW_KEY = "cc-my-tasks-view";
type View = "board" | "list";

type DueWhen = "all" | "overdue" | "today" | "week";
const DUE_NAME: Record<DueWhen, string> = { all: "Any due date", overdue: "Overdue", today: "Due today", week: "Due in the next 7 days" };

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
const soonestFirst = (a: MyTask, b: MyTask) => soonestDue(a.due, b.due) || a.ticket.localeCompare(b.ticket, undefined, { numeric: true });
const newestDoneFirst = (a: MyTask, b: MyTask) => (b.doneAt ?? 0) - (a.doneAt ?? 0);

function StatusSelect({ t, onStatus }: { t: MyTask; onStatus(status: TicketStatus): void }) {
  return (
    <select className={`f tk-status-select tk-${t.status}`} value={t.status} aria-label={`Status of ${t.title}`} onChange={(e) => onStatus(e.target.value as TicketStatus)}>
      {TICKET_STATUSES.map((s) => (
        <option key={s} value={s}>
          {TICKET_STATUS_NAME[s]}
        </option>
      ))}
    </select>
  );
}

const PriorityChip = ({ pri }: { pri: Priority }) => <span className={`chip my-pri p-${pri}`}>{PRIORITY_NAME[pri]}</span>;

function Due({ t, today }: { t: MyTask; today: string }) {
  const due = dueLabel(t.due, today);
  return <span className={`due ${t.status === "done" ? "" : due.tone}`}>{t.status === "done" ? "Done" : due.text}</span>;
}

/** One ticket in a column of the board. It can be dragged to another column. */
function Card({ t, today, onOpen, onStatus }: { t: MyTask; today: string; onOpen(): void; onStatus(status: TicketStatus): void }) {
  return (
    <article
      className={`tk-card ${t.status === "done" ? "done" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="tk-card-top">
        <button className="tk-title" onClick={onOpen}>
          {t.title}
        </button>
      </div>
      {t.client && <span className="chip">{t.client}</span>}
      <div className="tk-meta">
        <StatusSelect t={t} onStatus={onStatus} />
        <Due t={t} today={today} />
      </div>
      <div className="tk-foot">
        <PriorityChip pri={t.pri} />
        <span className="tk-num">{t.ticket}</span>
      </div>
    </article>
  );
}

/** One ticket as a row, in the list. */
function Line({ t, today, onOpen, onStatus }: { t: MyTask; today: string; onOpen(): void; onStatus(status: TicketStatus): void }) {
  return (
    <li className={`tk-line ${t.status === "done" ? "done" : ""}`}>
      <span className="tk-num">{t.ticket}</span>
      <button className="tk-title" onClick={onOpen}>
        {t.title}
      </button>
      {t.client && <span className="chip">{t.client}</span>}
      <PriorityChip pri={t.pri} />
      <StatusSelect t={t} onStatus={onStatus} />
      <Due t={t} today={today} />
    </li>
  );
}

/** A ticket opened: everything there is to know about it, and its status to change. */
function Detail({ t, today, onClose, onStatus }: { t: MyTask; today: string; onClose(): void; onStatus(status: TicketStatus): void }) {
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const day = t.due ? parseDay(t.due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "No due date";
  return (
    <div className="cal-modal" role="presentation" onClick={onClose}>
      <div className="panel tk-form" role="dialog" aria-modal="true" aria-label={t.title} onClick={(e) => e.stopPropagation()}>
        <h3>
          {t.ticket && <span className="tk-num">{t.ticket} </span>}
          {t.title}
        </h3>
        <dl className="my-facts">
          <div>
            <dt>Status</dt>
            <dd>
              <StatusSelect t={t} onStatus={onStatus} />
            </dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>
              {day} {t.status !== "done" && dueLabel(t.due, today).tone === "over" && <Due t={t} today={today} />}
            </dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>
              <PriorityChip pri={t.pri} />
            </dd>
          </div>
          {t.client && (
            <div>
              <dt>Client</dt>
              <dd>{t.client}</dd>
            </div>
          )}
          {t.from && (
            <div>
              <dt>From</dt>
              <dd>{t.from}</dd>
            </div>
          )}
        </dl>
        {t.description ? <p className="my-desc">{t.description}</p> : <p className="my-desc muted">No description.</p>}
        <div className="tk-form-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MyTasksPage() {
  const [mine, setMine] = useState<Mine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewNow] = useState<View>(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const [words, setWords] = useState("");
  const [client, setClient] = useState("all");
  const [pri, setPri] = useState<"all" | Priority>("all");
  const [due, setDue] = useState<DueWhen>("all");
  const [showDone, setShowDone] = useState(false);
  const [over, setOver] = useState<TicketStatus | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // The ticket a Slack message linked to, such as ?task=SPM-12, opens once, until it is closed.
  const [linkSeen, setLinkSeen] = useState(false);
  const query = useSyncExternalStore(never, () => window.location.search, () => "");
  const picked = new URLSearchParams(query).get("task");

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

  const setView = (v: View) => {
    setViewNow(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not kept: it starts as the board next time.
    }
  };

  async function setStatus(id: string, status: TicketStatus) {
    if (!mine || mine.tasks.find((t) => t.id === id)?.status === status) return;
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

  const open = (id: string) => {
    setOpenId(id);
    setLinkSeen(true);
  };
  const close = useCallback(() => {
    setOpenId(null);
    setLinkSeen(true);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // In the browser only, once the tasks are in: the server never draws them, nor the date.
  const today = mine ? isoDay(new Date()) : "";
  const tasks = mine?.tasks ?? [];
  const clients = [...new Set(tasks.map((t) => t.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const typed = words.trim().toLowerCase();
  const weekEnd = mine ? addDays(new Date(), 7) : "";
  const shown = tasks.filter(
    (t) =>
      (!typed || `${t.ticket} ${t.title} ${t.description} ${t.client}`.toLowerCase().includes(typed)) &&
      (client === "all" || t.client === client) &&
      (pri === "all" || t.pri === pri) &&
      (due === "all" || (due === "overdue" ? t.status !== "done" && isOverdue(t.due, today) : due === "today" ? t.due === today : t.due !== "" && t.due >= today && t.due <= weekEnd)),
  );
  const filtering = Boolean(typed) || client !== "all" || pri !== "all" || due !== "all";
  const openOnes = tasks.filter((t) => t.status !== "done");
  const overdue = openOnes.filter((t) => isOverdue(t.due, today)).length;
  const opened = tasks.find((t) => t.id === openId) ?? (!linkSeen && picked ? tasks.find((t) => t.ticket === picked) : undefined) ?? null;
  const column = (s: TicketStatus) => shown.filter((t) => t.status === s).sort(s === "done" ? newestDoneFirst : soonestFirst);
  const listOpen = shown.filter((t) => t.status !== "done").sort(soonestFirst);
  const listDone = shown.filter((t) => t.status === "done").sort(newestDoneFirst);

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
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        {!mine && !error && <p className="loading">Loading…</p>}
        {mine && (
          <>
            <div className="view-head">
              <div className="muted my-intro">
                {openOnes.length} open {openOnes.length === 1 ? "task" : "tasks"}
                {overdue > 0 && <strong className="due over"> · {overdue} overdue</strong>}. Change a task&apos;s status as you work on it: the team sees it on their board straight away.
              </div>
              <div className="tk-filters">
                <Seg
                  value={view}
                  label="Show your tasks"
                  onChange={setView}
                  options={[
                    ["board", "Board"],
                    ["list", "List"],
                  ]}
                />
                <input className="f my-search" type="search" value={words} onChange={(e) => setWords(e.target.value)} placeholder="Search" aria-label="Search your tasks" />
                <select className="f" value={due} aria-label="Due" onChange={(e) => setDue(e.target.value as DueWhen)}>
                  {(Object.keys(DUE_NAME) as DueWhen[]).map((d) => (
                    <option key={d} value={d}>
                      {DUE_NAME[d]}
                    </option>
                  ))}
                </select>
                <select className="f" value={pri} aria-label="Priority" onChange={(e) => setPri(e.target.value as "all" | Priority)}>
                  <option value="all">Any priority</option>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_NAME[p]} priority
                    </option>
                  ))}
                </select>
                {clients.length > 0 && (
                  <select className="f" value={client} aria-label="Client" onChange={(e) => setClient(e.target.value)}>
                    <option value="all">All clients</option>
                    {clients.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                )}
                {filtering && (
                  <button
                    className="linkbtn"
                    onClick={() => {
                      setWords("");
                      setClient("all");
                      setPri("all");
                      setDue("all");
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {view === "board" ? (
              <div className="tk-board">
                {TICKET_STATUSES.map((s) => {
                  const list = column(s);
                  return (
                    <div
                      key={s}
                      className={`panel tk-col ${over === s ? "over" : ""}`}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOver(s);
                      }}
                      onDragLeave={() => setOver(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setOver(null);
                        void setStatus(e.dataTransfer.getData("text/plain"), s);
                      }}
                    >
                      <div className="tk-col-head">
                        <StatusPill status={s} />
                        <span className="num muted">{list.length}</span>
                      </div>
                      {list.map((t) => (
                        <Card key={t.id} t={t} today={today} onOpen={() => open(t.id)} onStatus={(st) => void setStatus(t.id, st)} />
                      ))}
                      {list.length === 0 && <p className="muted tk-empty">{s === "done" ? "Nothing done in the last two weeks." : "Nothing here."}</p>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="panel tk-person">
                {listOpen.length > 0 ? (
                  <ul className="tk-lines">
                    {listOpen.map((t) => (
                      <Line key={t.id} t={t} today={today} onOpen={() => open(t.id)} onStatus={(st) => void setStatus(t.id, st)} />
                    ))}
                  </ul>
                ) : (
                  <p className="muted tk-empty">{filtering ? "Nothing open matches." : "Nothing on your plate right now."}</p>
                )}
                {listDone.length > 0 && (
                  <button className="sg-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
                    {showDone ? "Hide what is done" : `Show the ${listDone.length} done in the last two weeks`}
                  </button>
                )}
                {showDone && (
                  <ul className="tk-lines">
                    {listDone.map((t) => (
                      <Line key={t.id} t={t} today={today} onOpen={() => open(t.id)} onStatus={(st) => void setStatus(t.id, st)} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        {opened && <Detail key={opened.id} t={opened} today={today} onClose={close} onStatus={(st) => void setStatus(opened.id, st)} />}
      </main>
    </>
  );
}
