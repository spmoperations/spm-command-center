"use client";

import { useState } from "react";
import { Pill, PriPill, Seg, SourceLink, VisuallyHidden } from "@/components/bits";
import Link from "next/link";
import { DEPARTMENTS, DEPT_ABOUT, DEPTS, PRIORITY_RANK } from "@/core/config";
import { dueLabel, isOverdue, shortDate, soonestDue } from "@/core/dates";
import { taskStatus, type TaskStatus } from "@/core/delegation";
import { toggleTask, useApp, type App } from "@/store/store";

const STATUS_PILL: Record<TaskStatus, [string, string]> = {
  ontrack: ["s-ok", "On track"],
  overdue: ["s-behind", "Overdue"],
  done: ["p-low", "Done"],
};
const STATUS_ORDER: Record<TaskStatus, number> = { overdue: 0, ontrack: 1, done: 2 };

function Department({ dept, app, onBack }: { dept: string; app: App; onBack(): void }) {
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const { state, today } = app;
  const tasks = state.tasks.filter((t) => t.dept === dept);
  const count = (s: TaskStatus) => tasks.filter((t) => taskStatus(t, today) === s).length;
  const people = state.team.filter((p) => p.depts.includes(dept));
  const list = tasks
    .filter((t) => filter === "all" || taskStatus(t, today) === filter)
    .sort(
      (a, b) =>
        STATUS_ORDER[taskStatus(a, today)] - STATUS_ORDER[taskStatus(b, today)] ||
        (a.done ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : soonestDue(a.due, b.due) || PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri]),
    );

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <button className="crumb" onClick={onBack}>
            ← All departments
          </button>
          <h2 style={{ marginTop: 6 }}>{dept}</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {DEPT_ABOUT[dept]}
          </div>
        </div>
      </div>
      <div className="filters">
        <Seg
          label="Status"
          value={filter}
          onChange={(v) => setFilter(v)}
          options={[["all", `All ${tasks.length}`], ["ontrack", `On track ${count("ontrack")}`], ["overdue", `Overdue ${count("overdue")}`], ["done", `Done ${count("done")}`]]}
        />
        <span className="muted" style={{ fontSize: 13 }}>
          {people.length > 0 ? `Team: ${people.map((p) => `${p.name} (${p.role})`).join(", ")}` : "No team members in this department yet."}
        </span>
      </div>
      <div className="panel table-scroll">
        <table className="tasks">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <VisuallyHidden>Done</VisuallyHidden>
              </th>
              <th>Task</th>
              <th>Project</th>
              <th>Responsible</th>
              <th>Priority</th>
              <th>Due</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const status = taskStatus(t, today);
              const [tone, label] = STATUS_PILL[status];
              const due = dueLabel(t.due, today);
              return (
                <tr key={t.id} className={t.done ? "done" : ""}>
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
                  </td>
                  <td>{t.project}</td>
                  <td className="who-cell">{t.delegatedTo ? t.delegatedTo.name : <span className="you">You</span>}</td>
                  <td>
                    <PriPill p={t.pri} />
                  </td>
                  <td>
                    <span className="due num">{t.due ? shortDate(t.due) : "—"}</span>{" "}
                    {!t.done && (
                      <span className={`due ${due.tone}`} style={{ fontSize: 11.5 }}>
                        {due.text}
                      </span>
                    )}
                  </td>
                  <td>
                    <Pill tone={tone}>{label}</Pill>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ padding: 16 }}>
                  No tasks here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function DepartmentsPage() {
  const app = useApp();
  const [dept, setDept] = useState<string | null>(null);
  if (!app) return null;
  if (!DEPARTMENTS) {
    return (
      <section className="view">
        <div className="panel hint-panel">
          <strong>Departments are switched off for now.</strong> Every task is on the <Link href="/tasks">Tasks</Link> tab.
        </div>
      </section>
    );
  }
  const { state, today } = app;
  if (dept) return <Department key={dept} dept={dept} app={app} onBack={() => setDept(null)} />;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Departments</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Every department&apos;s tasks, who owns them and whether they are on track. Click one to open it.
          </div>
        </div>
      </div>
      <div className="dept-grid">
        {DEPTS.map((d) => {
          const tasks = state.tasks.filter((t) => t.dept === d);
          const open = tasks.filter((t) => !t.done);
          const overdue = open.filter((t) => isOverdue(t.due, today));
          const next = [...open].sort((a, b) => soonestDue(a.due, b.due))[0];
          const nextDue = next && dueLabel(next.due, today);
          const people = state.team.filter((p) => p.depts.includes(d)).map((p) => p.name.split(" ")[0]);
          return (
            <button className="panel dept-card" key={d} onClick={() => setDept(d)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <h3>{d}</h3>
                {overdue.length > 0 ? <Pill tone="s-behind">{overdue.length} overdue</Pill> : open.length > 0 ? <Pill tone="s-ok">On track</Pill> : <Pill tone="p-low">Clear</Pill>}
              </div>
              <p className="about">{DEPT_ABOUT[d]}</p>
              <div className="dept-stats">
                <span>
                  <strong>{open.length}</strong>open
                </span>
                <span className={overdue.length > 0 ? "over" : ""}>
                  <strong>{overdue.length}</strong>overdue
                </span>
                <span>
                  <strong>{tasks.length - open.length}</strong>done
                </span>
              </div>
              <div className="dept-next">
                {next && nextDue ? (
                  <>
                    <span className="muted">
                      Next due · <span className={`due ${nextDue.tone}`}>{nextDue.text}</span>
                    </span>
                    <span>{next.title}</span>
                  </>
                ) : (
                  <span className="muted">Nothing open</span>
                )}
              </div>
              <div className="dept-people">{people.length > 0 ? `Team: ${people.join(", ")}` : "No one assigned yet. Add people in Settings."}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
