"use client";

// The board: the team's tickets in four columns, Open, In progress, Waiting and Done. Shared by
// everyone with a login. A ticket comes from the review, from a chat or a call, or is made here.

import Link from "next/link";
import { useState } from "react";
import { SourceBox, sourceApp, StatusPill, ticketName, TicketForm, Who } from "@/components/Tickets";
import { conversationPage, PERSONAL_SIDE, MODE_NAME, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import { dueLabel, stamp } from "@/core/dates";
import type { Task, TicketInput, TicketStatus } from "@/core/types";
import { createTicket, openConversation, openTask, showMeeting, toggleTask, updateTicket, useApp, type App } from "@/store/store";

/** Done tickets shown before "Show all": the newest. */
const DONE_SHOWN = 20;

const asInput = (t: Task): TicketInput => ({
  title: t.title,
  description: t.description,
  assignee: t.assignee,
  client: t.project,
  due: t.due,
  status: t.status,
  pri: t.pri,
  notify: [],
});

/** Only what was changed goes to the server, so the history says just that. */
function changes(before: TicketInput, after: TicketInput): Partial<TicketInput> {
  const patch: Partial<TicketInput> = {};
  for (const key of ["title", "description", "client", "due", "status", "pri"] as const) if (after[key] !== before[key]) Object.assign(patch, { [key]: after[key] });
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
      {t.project && <span className="chip">{t.project}</span>}
      <div className="tk-meta">
        <select
          className={`f tk-status-select tk-${t.status}`}
          value={t.status}
          aria-label={`Status of ${t.title}`}
          onChange={(e) => void updateTicket(t.id, { status: e.target.value as TicketStatus })}
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_NAME[s]}
            </option>
          ))}
        </select>
        <Who name={t.assigneeName ?? (t.delegatedTo?.name || null)} />
        <span className={`due ${t.done ? "" : due.tone}`}>{t.done ? "Done" : due.text}</span>
      </div>
      <div className="tk-foot">
        <span className="muted">{sourceApp(t.source)}</span>
        <span className="tk-num">{ticketName(t.number)}</span>
      </div>
    </article>
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
      people={state.people}
      clients={state.projects}
      submit="Save"
      assigned
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
  const [adding, setAdding] = useState(false);
  const [allDone, setAllDone] = useState(false);
  const [over, setOver] = useState<TicketStatus | null>(null);
  if (!app) return null;
  const { state, ui, today } = app;
  const me = `user:${state.me.id}`;
  const opened = state.tasks.find((t) => t.id === ui.openTask) ?? null;

  const inMode = state.tasks.filter((t) => t.mode === ui.mode);
  const shown = inMode.filter((t) => (who === "all" || (who === "none" ? !t.assignee : t.assignee === who)) && (client === "all" || t.project === client));
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
            {overdue > 0 && ` · ${overdue} overdue`} · <Link href="/review">{state.review.length} to review</Link>
          </div>
        </div>
        <div className="tk-filters">
          <select className="f" value={who} aria-label="Whose tickets" onChange={(e) => setWho(e.target.value)}>
            <option value="all">Everyone</option>
            <option value={me}>Mine</option>
            {state.people
              .filter((p) => p.id !== me)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            <option value="none">Nobody yet</option>
          </select>
          <select className="f" value={client} aria-label="Client" onChange={(e) => setClient(e.target.value)}>
            <option value="all">All clients</option>
            {clients.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <button className="btn primary" onClick={() => setAdding(true)}>
            + New task
          </button>
        </div>
      </div>

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
          }}
          people={state.people}
          clients={state.projects}
          submit="Add"
          onSubmit={(input) => createTicket(input)}
          onCancel={() => setAdding(false)}
        />
      )}
      {opened && <TicketDetail key={opened.id} t={opened} app={app} onClose={() => openTask(null)} />}
    </section>
  );
}
