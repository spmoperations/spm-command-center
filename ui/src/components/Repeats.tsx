"use client";

// Repeating tasks on the board: the same ticket made again on the same days each week, for the
// same person, at 6:00 CET, and they are told on Slack each time (see server/repeats.ts). Listed
// in a panel above the board, and set up or changed in a form like a ticket's.

import { useEffect, useState } from "react";
import { PRIORITIES, PRIORITY_NAME, TASK_LINE_NAME, TASK_LINES } from "@/core/config";
import { daysName, inRepeatZone, nextRepeatDay, REPEAT_TIME_NAME, WEEKDAY_SHORT, WEEKDAYS } from "@/core/repeats";
import { shortDate } from "@/core/dates";
import type { RepeatingTask, RepeatInput, TaskLine } from "@/core/types";
import { addRepeat, editRepeat, pauseRepeat, removeRepeat, type App } from "@/store/store";
import { assignable, ClientPicker, defaultNotify, LineChip, NotifyChoice, PersonPicker, StatusPill, ticketName, whose, type Assignable } from "./Tickets";

/** "Mon and Thu", "every day". */
const when = (days: number[]) => {
  const name = daysName(days);
  return name === "every day" || name === "weekdays" ? name : `every ${name}`;
};

/** When the next one comes, in words: "today", "tomorrow", "Thu, Nov 13". */
function nextName(r: RepeatingTask, now: Date): string | null {
  const next = nextRepeatDay(r, now);
  if (!next) return null;
  const { day, weekday } = inRepeatZone(now);
  const ahead = Math.round((Date.parse(next) - Date.parse(day)) / 86_400_000);
  if (ahead === 0) return "today";
  if (ahead === 1) return "tomorrow";
  return `${WEEKDAY_SHORT[((weekday - 1 + ahead) % 7) + 1]}, ${shortDate(next)}`;
}

function RepeatForm({ app, initial, heading, submit, onSubmit, onCancel }: { app: App; initial: RepeatInput; heading: string; submit: string; onSubmit(input: RepeatInput): Promise<boolean>; onCancel(): void }) {
  const people: Assignable[] = assignable(app.state);
  const [r, setR] = useState<RepeatInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<RepeatInput>) => {
    setR((x) => ({ ...x, ...patch }));
    setError(null);
  };
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  const flipDay = (d: number) => set({ days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort((a, b) => a - b) });
  return (
    <div className="cal-modal" role="presentation" onClick={onCancel}>
      <form
        className="panel tk-form"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!r.title.trim()) return;
          if (!r.assignee) return setError("Who is it for?");
          if (!r.days.length) return setError("Pick at least one day of the week.");
          setBusy(true);
          const saved = await onSubmit({ ...r, title: r.title.trim() });
          setBusy(false);
          if (saved) onCancel();
        }}
      >
        <h3>{heading}</h3>
        <label className="tk-field">
          <span className="label">Title</span>
          <input className="f" value={r.title} required autoFocus onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="tk-field">
          <span className="label">Description</span>
          <textarea className="f" rows={4} value={r.description} placeholder="Context, links, what done looks like." onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="tk-field">
          <span className="label">Every</span>
          <div className="rp-days" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" className={`rp-day ${r.days.includes(d) ? "on" : ""}`} aria-pressed={r.days.includes(d)} onClick={() => flipDay(d)}>
                {WEEKDAY_SHORT[d]}
              </button>
            ))}
          </div>
        </div>
        <div className="tk-grid">
          <label className="tk-field">
            <span className="label">Assigned to: whose task it is</span>
            <PersonPicker people={people} value={r.assignee || null} onChange={(assignee) => set({ assignee: assignee ?? "", notify: defaultNotify(people, assignee) })} />
          </label>
          <div className="tk-field">
            <span className="label">Client</span>
            <ClientPicker value={r.client} clients={app.state.clients} onChange={(client) => set({ client })} />
          </div>
          <label className="tk-field">
            <span className="label">Priority</span>
            <select className="f" value={r.pri} onChange={(e) => set({ pri: e.target.value as RepeatInput["pri"] })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_NAME[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="tk-field">
            <span className="label">Agency, Consulting or Sales</span>
            <select className="f" value={r.line ?? ""} onChange={(e) => set({ line: (e.target.value || null) as TaskLine | null })}>
              <option value="">Not set</option>
              {TASK_LINES.map((l) => (
                <option key={l} value={l}>
                  {TASK_LINE_NAME[l]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <NotifyChoice people={people} assignee={r.assignee || null} value={r.notify} onChange={(notify) => set({ notify })} />
        <p className="muted rp-help">
          A new task is made at {REPEAT_TIME_NAME} on each of these days, with no due date, whether or not the last one is done. They are told each time, as when you assign a task.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="tk-form-foot">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : submit}
          </button>
        </div>
      </form>
    </div>
  );
}

function RepeatRow({ r, app, onEdit, onOpenTask }: { r: RepeatingTask; app: App; onEdit(): void; onOpenTask(id: string): void }) {
  const people = assignable(app.state);
  const next = nextName(r, app.now);
  return (
    <li className={`rp-row ${r.active ? "" : "paused"}`}>
      <div className="rp-main">
        <button className="tk-title" onClick={onEdit}>
          {r.title}
        </button>
        <div className="rp-meta muted">
          {whose(people, r.assignee)} · {when(r.days)} at {REPEAT_TIME_NAME}
          {r.notify.length > 0 && ` · told on ${r.notify.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" and ")}`}
          {r.setBy.name && ` · set up by ${r.setBy.name}`}
        </div>
        <div className="rp-meta">
          {r.active ? <span>Next: {next ?? "none"}</span> : <span className="chip">Paused</span>}
          {r.client && <span className="chip">{r.client}</span>}
          {r.line && <LineChip line={r.line} />}
          {r.last && (
            <span className="rp-last">
              Last:{" "}
              <button className="linkbtn" onClick={() => onOpenTask(r.last!.id)}>
                {ticketName(r.last.number)}
              </button>{" "}
              <StatusPill status={r.last.status} />
            </span>
          )}
          {r.made > 1 && <span className="muted">{r.made} made</span>}
        </div>
        {r.problem && (
          <p className="rp-problem" role="status">
            {r.problem}
          </p>
        )}
      </div>
      <div className="rp-actions">
        <button className="linkbtn" onClick={onEdit}>
          Edit
        </button>
        <button className="linkbtn" onClick={() => void pauseRepeat(r.id, r.active)}>
          {r.active ? "Pause" : "Start again"}
        </button>
        <button
          className="linkbtn danger"
          onClick={() => {
            if (window.confirm(`Stop repeating "${r.title}"? The tasks it already made stay on the board.`)) void removeRepeat(r.id);
          }}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/** The panel of repeating tasks above the board, with the form to set one up or change one. */
export function RepeatsPanel({ app, onOpenTask, onClose }: { app: App; onOpenTask(id: string): void; onClose(): void }) {
  const [editing, setEditing] = useState<RepeatingTask | "new" | null>(null);
  const repeats = app.state.repeats;
  const asInput = (r: RepeatingTask): RepeatInput => ({ title: r.title, description: r.description, client: r.client, pri: r.pri, line: r.line, assignee: r.assignee, days: r.days, notify: r.notify });
  return (
    <section className="panel rp-panel" aria-label="Repeating tasks">
      <div className="rp-head">
        <div>
          <h3>Repeating tasks</h3>
          <p className="muted">Made again on the same days each week at {REPEAT_TIME_NAME}, for the same person, who is told each time.</p>
        </div>
        <div className="rp-head-actions">
          <button className="btn primary" onClick={() => setEditing("new")}>
            + New repeating task
          </button>
          <button className="linkbtn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {repeats.length === 0 ? (
        <p className="muted tk-empty">None yet. Set one up for a task someone does every week, such as a Monday and Thursday check-in.</p>
      ) : (
        <ul className="rp-list">
          {repeats.map((r) => (
            <RepeatRow key={r.id} r={r} app={app} onEdit={() => setEditing(r)} onOpenTask={onOpenTask} />
          ))}
        </ul>
      )}
      {editing && (
        <RepeatForm
          app={app}
          heading={editing === "new" ? "New repeating task" : "Repeating task"}
          submit={editing === "new" ? "Set up" : "Save"}
          initial={editing === "new" ? { title: "", description: "", client: "", pri: "mid", line: null, assignee: "", days: [], notify: [] } : asInput(editing)}
          onSubmit={(input) => (editing === "new" ? addRepeat(input) : editRepeat(editing.id, input))}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}
