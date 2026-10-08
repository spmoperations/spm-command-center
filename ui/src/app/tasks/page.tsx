"use client";

import { Fragment, useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PrioritySelect, SourceLink, VisuallyHidden } from "@/components/bits";
import { DEPTS, PRIORITY_RANK } from "@/core/config";
import { addDays } from "@/core/dates";
import { canDelegate, isMine } from "@/core/delegation";
import type { Priority, Task } from "@/core/types";
import { addTask, delegateTask, setTaskPriority, toggleTask, undelegateTask, useApp, type App } from "@/store/store";

const SECTIONS: { key: Priority; title: string; sub: string }[] = [
  { key: "high", title: "High priority", sub: "Do these first" },
  { key: "mid", title: "Medium priority", sub: "Next 48 hours" },
  { key: "low", title: "Low priority", sub: "Next 48 hours" },
];

const COLUMNS = 7;

function TaskRow({ t, app, delegating, onDelegating }: { t: Task; app: App; delegating: boolean; onDelegating(id: string | null): void }) {
  const { state, today } = app;
  const rowClass = t.done ? "done" : t.delegatedTo ? "delegated" : "";
  return (
    <Fragment>
      <tr className={rowClass}>
        <td>
          <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`} onChange={(e) => toggleTask(t.id, e.target.checked)} />
        </td>
        <td>
          <div className="t-title">{t.title}</div>
          {t.src && (
            <div className="t-src">
              <SourceLink src={t.src} app={app} />
            </div>
          )}
          {t.delegatedTo && (
            <div className="dg-note">
              <span className="chip dg-chip">Delegated · {t.delegatedTo.name}</span> {t.delegatedTo.note}
            </div>
          )}
        </td>
        <td>{t.dept}</td>
        <td>{t.project}</td>
        <td>
          <PrioritySelect value={t.pri} onChange={(p) => setTaskPriority(t.id, p)} />
        </td>
        <td>
          <DueText task={t} today={today} />
        </td>
        <td style={{ textAlign: "right" }}>
          {!t.done && t.delegatedTo && (
            <button className="linkbtn inline" onClick={() => undelegateTask(t.id)}>
              Take back
            </button>
          )}
          {canDelegate(state.team, t) && (
            <button className="btn dg" aria-expanded={delegating} title={`Someone in ${t.dept} can own this`} onClick={() => onDelegating(delegating ? null : t.id)}>
              Delegate
            </button>
          )}
        </td>
      </tr>
      {delegating && (
        <tr className="dg-row">
          <td />
          <td colSpan={COLUMNS - 1}>
            <DelegateForm
              team={state.team}
              today={today}
              subject={t}
              onCancel={() => onDelegating(null)}
              onDelegate={(personId, note, due) => {
                delegateTask(t.id, personId, note, due);
                onDelegating(null);
              }}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function AddTask({ app }: { app: App }) {
  const [title, setTitle] = useState("");
  const [dept, setDept] = useState("Operations");
  const [project, setProject] = useState(app.state.projects.includes("Internal Ops") ? "Internal Ops" : (app.state.projects[0] ?? ""));
  const [pri, setPri] = useState<Priority>("mid");
  const [due, setDue] = useState(app.today);
  return (
    <form
      className="panel addtask"
      style={{ gridTemplateColumns: "minmax(0, 2.4fr) repeat(4, minmax(0, 1fr)) auto" }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        addTask({ title: title.trim(), dept, project, pri, due: due || app.today });
        setTitle("");
      }}
    >
      <input className="f" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" required aria-label="Task" />
      <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
        {DEPTS.map((d) => (
          <option key={d}>{d}</option>
        ))}
      </select>
      <select className="f" value={project} aria-label="Project" onChange={(e) => setProject(e.target.value)}>
        {app.state.projects.map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      <PrioritySelect value={pri} onChange={setPri} />
      <input className="f" type="date" value={due} aria-label="Due date" onChange={(e) => setDue(e.target.value)} />
      <button className="btn primary" type="submit">
        Add task
      </button>
    </form>
  );
}

export default function TasksPage() {
  const app = useApp();
  const [status, setStatus] = useState("all");
  const [dept, setDept] = useState("all");
  const [project, setProject] = useState("all");
  const [closed, setClosed] = useState<Priority[]>([]);
  const [showLater, setShowLater] = useState<Priority[]>([]);
  const [delegating, setDelegating] = useState<string | null>(null);
  if (!app) return null;
  const { state, now, today } = app;

  const list = state.tasks.filter(
    (t) =>
      (dept === "all" || t.dept === dept) &&
      (project === "all" || t.project === project) &&
      (status === "all" || (status === "open" ? isMine(t) : status === "delegated" ? !t.done && !!t.delegatedTo : t.done)),
  );
  const soonCut = addDays(now, 2);
  const byDue = (a: Task, b: Task) => a.due.localeCompare(b.due);
  const suggestions = state.suggestions
    .filter((g) => g.status === "new")
    .sort((a, b) => PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri] || a.due.localeCompare(b.due));
  const mine = state.tasks.filter(isMine);
  const delegatedCount = state.tasks.filter((t) => !t.done && t.delegatedTo).length;
  const toggle = (list: Priority[], key: Priority) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const row = (t: Task) => <TaskRow key={t.id} t={t} app={app} delegating={delegating === t.id} onDelegating={setDelegating} />;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Tasks</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {mine.length} on your plate · {mine.filter((t) => t.due < today).length} overdue
            {delegatedCount > 0 && ` · ${delegatedCount} delegated`}
          </div>
        </div>
      </div>

      <div className="panel sg-panel">
        <div className="panel-head">
          <h3>
            Suggested tasks{" "}
            {suggestions.length > 0 && (
              <span className="muted num" style={{ fontWeight: 400, fontSize: 14 }}>
                {suggestions.length}
              </span>
            )}
          </h3>
        </div>
        <p className="sg-intro">
          Tasks pulled from your conversations and call transcripts, each with a suggested priority and due date. Adjust either before adding. Nothing becomes a task until you click Add task.
        </p>
        {suggestions.length > 0 ? (
          <div className="sg-list">
            {suggestions.map((g) => (
              <SuggestionRow key={g.id} g={g} app={app} />
            ))}
          </div>
        ) : (
          <p className="empty">No suggestions right now.</p>
        )}
      </div>

      <AddTask app={app} />

      <div className="filters">
        <select className="f" value={status} aria-label="Status" onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Status: All</option>
          <option value="open">On my plate</option>
          <option value="delegated">Delegated</option>
          <option value="done">Done</option>
        </select>
        <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
          <option value="all">Department: All</option>
          {DEPTS.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select className="f" value={project} aria-label="Project" onChange={(e) => setProject(e.target.value)}>
          <option value="all">Project: All</option>
          {state.projects.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>

      {SECTIONS.map((sec) => {
        const inSection = list.filter((t) => t.pri === sec.key);
        const open = inSection.filter(isMine).sort(byDue);
        // High priority shows everything; the others show the next 48 hours and fold the rest away.
        const soon = sec.key === "high" ? open : open.filter((t) => t.due <= soonCut);
        const later = sec.key === "high" ? [] : open.filter((t) => t.due > soonCut);
        const delegated = inSection.filter((t) => !t.done && t.delegatedTo).sort(byDue);
        const done = inSection.filter((t) => t.done).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
        const isOpen = !closed.includes(sec.key);
        const laterOpen = showLater.includes(sec.key);
        const overdue = open.filter((t) => t.due < today).length;
        const empty = soon.length + later.length + delegated.length + done.length === 0;
        return (
          <div className={`panel sec sec-${sec.key}`} key={sec.key}>
            <button className="sec-head" aria-expanded={isOpen} onClick={() => setClosed(toggle(closed, sec.key))}>
              <span className="chev" aria-hidden="true">
                ▾
              </span>
              <h3>{sec.title}</h3>
              <span className="sub">{sec.sub}</span>
              <span className="n">
                {soon.length} open
                {overdue > 0 && ` · ${overdue} overdue`}
                {later.length > 0 && ` · ${later.length} later`}
              </span>
            </button>
            {isOpen && (
              <div className="table-scroll">
                <table className="tasks">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <VisuallyHidden>Done</VisuallyHidden>
                      </th>
                      <th>Task</th>
                      <th>Department</th>
                      <th>Project</th>
                      <th>Priority</th>
                      <th>Due</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {soon.map(row)}
                    {later.length > 0 && (
                      <tr className="later-row">
                        <td />
                        <td colSpan={COLUMNS - 1}>
                          <button aria-expanded={laterOpen} onClick={() => setShowLater(toggle(showLater, sec.key))}>
                            {laterOpen ? "Hide" : "Show"} {later.length} due after the next 48 hours
                          </button>
                        </td>
                      </tr>
                    )}
                    {laterOpen && later.map(row)}
                    {delegated.map(row)}
                    {done.map(row)}
                    {empty && (
                      <tr>
                        <td colSpan={COLUMNS} className="muted" style={{ padding: 16 }}>
                          {sec.key === "high" ? "No high-priority tasks." : "Nothing here."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
