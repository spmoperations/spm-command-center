"use client";

// The board: the team's tickets in four columns, Open, In progress, Waiting and Done, or person by
// person, to follow up with whoever has them. Shared by everyone with a login. A ticket comes from
// the review, from a chat or a call, or is made here.

import Link from "next/link";
import { useEffect, useState } from "react";
import { Seg } from "@/components/bits";
import { reviewWaiting } from "@/core/review";
import { assignable, LineChip, SourceBox, sourceApp, StatusPill, ticketName, TicketForm, Who } from "@/components/Tickets";
import { conversationPage, PERSONAL_SIDE, MODE_NAME, TASK_LINE_NAME, TASK_LINES, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import { dueLabel, stamp } from "@/core/dates";
import { lineOf } from "@/core/delegation";
import type { Task, TaskLine, TicketInput, TicketStatus } from "@/core/types";
import { createTicket, openConversation, openTask, showMeeting, toggleTask, updateTicket, useApp, type App } from "@/store/store";

/** Done tickets shown before "Show all": the newest. */
const DONE_SHOWN = 20;
/** Which way the board was last looked at, kept in this browser only. */
const VIEW_KEY = "cc-board-view";
type View = "status" | "person";

/** Whose a ticket is, as a name: a person, a whole Slack channel, or nobody yet. */
const holderOf = (t: Task) => t.assigneeName ?? (t.delegatedTo?.name || null);

function StatusSelect({ t }: { t: Task }) {
  return (
    <select className={`f tk-status-select tk-${t.status}`} value={t.status} aria-label={`Status of ${t.title}`} onChange={(e) => void updateTicket(t.id, { status: e.target.value as TicketStatus })}>
      {TICKET_STATUSES.map((s) => (
        <option key={s} value={s}>
          {TICKET_STATUS_NAME[s]}
        </option>
      ))}
    </select>
  );
}

const asInput = (t: Task): TicketInput => ({
  title: t.title,
  description: t.description,
  assignee: t.assignee,
  client: t.project,
  due: t.due,
  status: t.status,
  pri: t.pri,
  notify: [],
  line: t.line ?? null,
});

/** Only what was changed goes to the server, so the history says just that. */
function changes(before: TicketInput, after: TicketInput): Partial<TicketInput> {
  const patch: Partial<TicketInput> = {};
  for (const key of ["title", "description", "client", "due", "status", "pri", "line"] as const) if (after[key] !== before[key]) Object.assign(patch, { [key]: after[key] });
  if (after.assignee !== before.assignee)
    Object.assign(patch, {
      assignee: after.assignee,
      notify: after.notify ?? [],
    });
  return patch;
}

function TicketCard({ t, app, onOpen }: { t: Task; app: App; onOpen(): void }) {
  const due = dueLabel(t.due, app.today);
  return (
    <article
      className={`tk-card ${t.done ? "done" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="tk-card-top">
        <input type="checkbox" className="tk-tick" checked={t.done} aria-label={`Done: ${t.title}`} onChange={(e) => toggleTask(t.id, e.target.checked)} />
        <button className="tk-title" onClick={onOpen}>
          {t.title}
        </button>
      </div>
      {(t.project || lineOf(t)) && (
        <div className="tk-chips">
          {lineOf(t) && <LineChip line={lineOf(t)!} />}
          {t.project && <span className="chip">{t.project}</span>}
        </div>
      )}
      <div className="tk-meta">
        <StatusSelect t={t} />
        <span className={`due ${t.done ? "" : due.tone}`}>{t.done ? "Done" : due.text}</span>
      </div>
      <div className="tk-for">
        <span className="muted">Assigned to</span> <Who name={holderOf(t)} />
      </div>
      <div className="tk-foot">
        <span className="muted">{sourceApp(t.source)}</span>
        <span className="tk-num">{ticketName(t.number)}</span>
      </div>
    </article>
  );
}

/** One ticket as a line, in a person's list. */
function TicketLine({ t, app, onOpen }: { t: Task; app: App; onOpen(): void }) {
  const due = dueLabel(t.due, app.today);
  return (
    <li className={`tk-line ${t.done ? "done" : ""}`}>
      <input type="checkbox" className="tk-tick" checked={t.done} aria-label={`Done: ${t.title}`} onChange={(e) => toggleTask(t.id, e.target.checked)} />
      <span className="tk-num">{ticketName(t.number)}</span>
      <button className="tk-title" onClick={onOpen}>
        {t.title}
      </button>
      {lineOf(t) && <LineChip line={lineOf(t)!} />}
      {t.project && <span className="chip">{t.project}</span>}
      <StatusSelect t={t} />
      <span className={`due ${t.done ? "" : due.tone}`}>{t.done ? "Done" : due.text}</span>
      <span className="muted tk-from">{sourceApp(t.source)}</span>
    </li>
  );
}

/** Everything one person has: what is open, soonest due first, and what they have done. */
function PersonTickets({ name, list, app, onOpen }: { name: string | null; list: Task[]; app: App; onOpen(id: string): void }) {
  const [showDone, setShowDone] = useState(false);
  const open = list.filter((t) => !t.done).sort((a, b) => a.due.localeCompare(b.due) || (a.number ?? 0) - (b.number ?? 0));
  const done = list.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  const overdue = open.filter((t) => t.due < app.today).length;
  const waiting = open.filter((t) => t.status === "waiting").length;
  return (
    <div className="panel tk-person">
      <div className="tk-person-head">
        <Who name={name} />
        <span className="muted">
          {open.length} open
          {overdue > 0 && <strong className="due overdue"> · {overdue} overdue</strong>}
          {waiting > 0 && ` · ${waiting} waiting on someone`}
          {done.length > 0 && ` · ${done.length} done`}
        </span>
      </div>
      {open.length > 0 ? (
        <ul className="tk-lines">
          {open.map((t) => (
            <TicketLine key={t.id} t={t} app={app} onOpen={() => onOpen(t.id)} />
          ))}
        </ul>
      ) : (
        <p className="muted tk-empty">Nothing open.</p>
      )}
      {done.length > 0 && (
        <button className="sg-more" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide what is done" : `Show the ${done.length} done`}
        </button>
      )}
      {showDone && (
        <ul className="tk-lines">
          {done.map((t) => (
            <TicketLine key={t.id} t={t} app={app} onOpen={() => onOpen(t.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The board person by person: Jeremy first, then everyone with a login, the team list, and what is nobody's yet. */
function ByPerson({ tickets, app, onOpen }: { tickets: Task[]; app: App; onOpen(id: string): void }) {
  const rank = new Map(app.state.people.map((p, k) => [p.id, k]));
  const groups = new Map<string, { name: string | null; list: Task[] }>();
  for (const t of tickets) {
    const key = t.assignee ?? (t.delegatedTo ? `channel:${t.delegatedTo.personId}` : "none");
    const group = groups.get(key) ?? { name: holderOf(t), list: [] };
    group.list.push(t);
    groups.set(key, group);
  }
  const order = (key: string) => (key === "none" ? 2_000 : (rank.get(key) ?? 1_000));
  return (
    <div className="tk-people">
      {[...groups]
        .sort(([a], [b]) => order(a) - order(b))
        .map(([key, g]) => (
          <PersonTickets key={key} name={g.name} list={g.list} app={app} onOpen={onOpen} />
        ))}
      {groups.size === 0 && <p className="muted">No tickets yet.</p>}
    </div>
  );
}

/** A ticket opened: everything about it can be changed, with where it came from and what happened to it. */
function TicketDetail({ t, app, onClose }: { t: Task; app: App; onClose(): void }) {
  const { state, now } = app;
  const told = state.outbox.filter((o) => o.taskId === t.id);
  const before = asInput(t);
  return (
    <TicketForm
      heading={`${ticketName(t.number)} · ${t.title}`}
      initial={before}
      people={assignable(state)}
      clients={state.clients}
      submit="Save"
      assigned
      fromChat={t.chatLine ?? null}
      onSubmit={async (after) => {
        const patch = changes(before, after);
        return Object.keys(patch).length ? updateTicket(t.id, patch, "Saved") : true;
      }}
      onCancel={onClose}
    >
      {t.source && (
        <SourceBox
          note={t.source}
          extra={
            !t.theirs && t.src ? (
              t.src.type === "message" ? (
                <Link href={conversationPage(t.src.id)} onClick={() => openConversation(t.src!.id)}>
                  Open the conversation
                </Link>
              ) : (
                <Link href="/meetings" onClick={() => showMeeting(t.src!.id)}>
                  Open the call&apos;s notes
                </Link>
              )
            ) : null
          }
        />
      )}
      {told.length > 0 && (
        <p className="muted tk-told">
          {told
            .map(
              (o) =>
                `${o.source === "telegram" ? "Telegram" : "Slack"} message to ${o.to}: ${o.status === "sent" ? "sent" : o.status === "failed" ? "could not be sent" : state.sendingEnabled ? "waiting to send" : "waiting in the outbox, because sending is off"}`,
            )
            .join(". ")}
          .
        </p>
      )}
      {t.history && t.history.length > 0 && (
        <details className="tk-history">
          <summary>History · {t.history.length}</summary>
          <ol>
            {t.history.map((e, k) => (
              <li key={k}>
                <span className="muted">{stamp(e.at, now)}</span> {e.by ? `${e.by}: ` : ""}
                {e.what}
              </li>
            ))}
          </ol>
        </details>
      )}
    </TicketForm>
  );
}

export default function TasksPage() {
  const app = useApp();
  const [who, setWho] = useState("all");
  const [client, setClient] = useState("all");
  const [line, setLine] = useState<"all" | "none" | TaskLine>("all");
  const [adding, setAdding] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [over, setOver] = useState<TicketStatus | null>(null);
  const [view, setViewNow] = useState<View>(() => {
    try {
      return window.localStorage.getItem(VIEW_KEY) === "person" ? "person" : "status";
    } catch {
      return "status";
    }
  });
  // Arriving from the link in a Slack message (?task=SPM-23): that ticket opens.
  const count = app?.state.tasks.length ?? 0;
  useEffect(() => {
    const wanted = Number(/(\d+)$/.exec(new URLSearchParams(window.location.search).get("task") ?? "")?.[1]);
    const ticket = wanted ? app?.state.tasks.find((t) => t.number === wanted) : undefined;
    if (!ticket) return;
    openTask(ticket.id);
    window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  const setView = (v: View) => {
    setViewNow(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not kept: it starts by status next time.
    }
  };
  if (!app) return null;
  const { state, ui, today } = app;
  const me = `user:${state.me.id}`;
  const opened = state.tasks.find((t) => t.id === ui.openTask) ?? null;

  const inMode = state.tasks.filter((t) => t.mode === ui.mode);
  const shown = inMode.filter(
    (t) =>
      (who === "all" || (who === "none" ? !t.assignee : t.assignee === who)) &&
      (client === "all" || t.project === client) &&
      (line === "all" || (lineOf(t) ?? "none") === line),
  );
  const open = shown.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due < today).length;
  const column = (s: TicketStatus) => {
    const list = shown.filter((t) => t.status === s);
    // Soonest due first; what is done, newest first.
    return s === "done" ? list.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)) : list.sort((a, b) => a.due.localeCompare(b.due) || (a.number ?? 0) - (b.number ?? 0));
  };
  const clients = [...new Set(inMode.map((t) => t.project).filter(Boolean))].sort();

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Tasks</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {PERSONAL_SIDE && `${MODE_NAME[ui.mode]}: `}
            {open.length} open {open.length === 1 ? "ticket" : "tickets"}
            {overdue > 0 && ` · ${overdue} overdue`} · <Link href="/review">{reviewWaiting(state.review).length} to review</Link>
          </div>
        </div>
        <div className="tk-filters">
          <Seg
            value={view}
            label="Show the board"
            onChange={setView}
            options={[
              ["status", "By status"],
              ["person", "By person"],
            ]}
          />
          <select className="f" value={who} aria-label="Whose tasks" onChange={(e) => setWho(e.target.value)}>
            <option value="all">Everyone&apos;s tasks</option>
            <option value={me}>My tasks</option>
            {state.people
              .filter((p) => p.id !== me)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}&apos;s tasks
                </option>
              ))}
            <option value="none">Nobody&apos;s yet</option>
          </select>
          <select className="f" value={client} aria-label="Client" onChange={(e) => setClient(e.target.value)}>
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select className="f" value={line} aria-label="Agency, Consulting or Sales" onChange={(e) => setLine(e.target.value as typeof line)}>
            <option value="all">Agency, Consulting and Sales</option>
            {TASK_LINES.map((l) => (
              <option key={l} value={l}>
                {TASK_LINE_NAME[l]}
              </option>
            ))}
            <option value="none">Not sorted yet</option>
          </select>
          <button className="btn primary" onClick={() => setAdding(true)}>
            + New task
          </button>
        </div>
      </div>

      {view === "person" ? (
        <ByPerson tickets={shown} app={app} onOpen={(id) => openTask(id)} />
      ) : (
        <div className="tk-board">
          {TICKET_STATUSES.map((s) => {
            const list = column(s);
            const visible = s === "done" && !allDone ? list.slice(0, DONE_SHOWN) : list;
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
                  const id = e.dataTransfer.getData("text/plain");
                  const t = state.tasks.find((x) => x.id === id);
                  if (t && t.status !== s) void updateTicket(id, { status: s });
                }}
              >
                <div className="tk-col-head">
                  <StatusPill status={s} />
                  <span className="num muted">{list.length}</span>
                </div>
                {visible.map((t) => (
                  <TicketCard key={t.id} t={t} app={app} onOpen={() => openTask(t.id)} />
                ))}
                {list.length === 0 && <p className="muted tk-empty">{s === "open" ? "Nothing open." : "Nothing here."}</p>}
                {s === "done" && list.length > DONE_SHOWN && (
                  <button className="sg-more" onClick={() => setAllDone(!allDone)}>
                    {allDone ? "Show fewer" : `Show all ${list.length}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {adding && (
        <TicketForm
          heading="New task"
          initial={{
            title: "",
            description: "",
            assignee: me,
            client: client === "all" ? "" : client,
            due: today,
            status: "open",
            pri: "mid",
            line: line === "all" || line === "none" ? null : line,
          }}
          people={assignable(state)}
          clients={state.clients}
          submit="Add"
          onSubmit={(input) => createTicket(input)}
          onCancel={() => setAdding(false)}
        />
      )}
      {opened && <TicketDetail key={opened.id} t={opened} app={app} onClose={() => openTask(null)} />}
    </section>
  );
}
