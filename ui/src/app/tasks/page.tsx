"use client";

import { Fragment, useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PrioritySelect, SourceLink, VisuallyHidden } from "@/components/bits";
import { DEPTS, MODE_NAME, MODES, PRIORITY_RANK } from "@/core/config";
import { addDays } from "@/core/dates";
import { canAssign, canAssignInChat, isMine, SLACK_PICK } from "@/core/delegation";
import type { Mode, Priority, Task } from "@/core/types";
import { addTask, delegateTask, setTaskPriority, toggleTask, undelegateTask, useApp, type App } from "@/store/store";

const SECTIONS: { key: Priority; title: string; sub: string }[] = [
  { key: "high", title: "High priority", sub: "Do these first" },
  { key: "mid", title: "Medium priority", sub: "Next 48 hours" },
  { key: "low", title: "Low priority", sub: "Next 48 hours" },
];

const COLUMNS = 7;
/** Suggestions shown before "Show all": enough to act on without pushing the tasks off screen. */
const SUGGESTIONS_SHOWN = 5;

/** `plain` leaves out department and project: personal tasks have neither. */
function TaskRow({ t, app, delegating, onDelegating, plain }: { t: Task; app: App; delegating: boolean; onDelegating(id: string | null): void; plain?: boolean }) {
  const { state, today } = app;
  const rowClass = t.done ? "done" : t.delegatedTo ? "delegated" : "";
  const columns = plain ? COLUMNS - 2 : COLUMNS;
  // A task that came from a channel or a group message can be assigned right there.
  const source = t.src?.type === "message" ? state.inbox.find((c) => c.id === t.src!.id) : undefined;
  const chat = source && canAssignInChat(source) ? (source.ctx.startsWith("#") ? source.ctx : "the group message") : null;
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
              <span className="chip dg-chip">Assigned · {t.delegatedTo.name}</span> {t.delegatedTo.note}
            </div>
          )}
        </td>
        {!plain && <td>{t.dept}</td>}
        {!plain && <td>{t.project}</td>}
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
          {canAssign(t) && (
            <button className="btn dg" aria-expanded={delegating} title="Hand this task to someone else" onClick={() => onDelegating(delegating ? null : t.id)}>
              Assign
            </button>
          )}
        </td>
      </tr>
      {delegating && (
        <tr className="dg-row">
          <td />
          <td colSpan={columns - 1}>
            <DelegateForm
              team={state.team}
              slackPeople={state.slackPeople}
              today={today}
              subject={t}
              chat={chat}
              onCancel={() => onDelegating(null)}
              onDelegate={(personId, note, due, where) => {
                delegateTask(t.id, personId, note, due, where);
                onDelegating(null);
              }}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** The form starts on the side that is showing. Its key is the mode, so switching sides resets it. */
function AddTask({ app }: { app: App }) {
  const [title, setTitle] = useState("");
  const [mode, setTaskMode] = useState<Mode>(app.ui.mode);
  const [dept, setDept] = useState("Operations");
  const [project, setProject] = useState("");
  const [pri, setPri] = useState<Priority>("mid");
  const [due, setDue] = useState(app.today);
  const [assignTo, setAssignTo] = useState("");
  const personal = mode === "personal";
  const { team, slackPeople } = app.state;
  const others = slackPeople.filter((p) => !team.some((t) => t.slackUserId === p.id));
  return (
    <form
      className="panel addtask"
      style={{ gridTemplateColumns: `minmax(0, 2.4fr) repeat(${personal ? 3 : 6}, minmax(0, 1fr)) auto` }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        addTask({ title: title.trim(), mode, dept, project: project.trim(), pri, due: due || app.today, assignTo: personal ? undefined : assignTo || undefined });
        setTitle("");
        setAssignTo("");
      }}
    >
      <input className="f" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" required aria-label="Task" />
      <select className="f" value={mode} aria-label="Personal or Professional" onChange={(e) => setTaskMode(e.target.value as Mode)}>
        {MODES.map((m) => (
          <option key={m} value={m}>
            {MODE_NAME[m]}
          </option>
        ))}
      </select>
      {!personal && (
        <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
          {DEPTS.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      )}
      {!personal && <input className="f" value={project} list="known-projects" placeholder="Project or client" aria-label="Project" onChange={(e) => setProject(e.target.value)} />}
      <datalist id="known-projects">
        {app.state.projects.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <PrioritySelect value={pri} onChange={setPri} />
      <input className="f" type="date" value={due} aria-label="Due date" onChange={(e) => setDue(e.target.value)} />
      {!personal && (
        <select className="f" value={assignTo} aria-label="Who does it" onChange={(e) => setAssignTo(e.target.value)}>
          <option value="">For me</option>
          {team.length > 0 && (
            <optgroup label="Your team">
              {team.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label={team.length > 0 ? "Others on Slack" : "People on Slack"}>
              {others.map((p) => (
                <option key={p.id} value={`${SLACK_PICK}${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
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
  const [allSuggestions, setAllSuggestions] = useState(false);
  if (!app) return null;
  const { state, ui, now, today } = app;
  const personal = ui.mode === "personal";

  const inMode = state.tasks.filter((t) => t.mode === ui.mode);
  const list = inMode.filter(
    (t) =>
      (personal || ((dept === "all" || t.dept === dept) && (project === "all" || t.project === project))) &&
      (status === "all" || (status === "open" ? isMine(t) : status === "delegated" ? !t.done && !!t.delegatedTo : t.done)),
  );
  const soonCut = addDays(now, 2);
  const byDue = (a: Task, b: Task) => a.due.localeCompare(b.due);
  const suggestions = state.suggestions
    .filter((g) => g.status === "new" && g.mode === ui.mode)
    .sort((a, b) => PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri] || a.due.localeCompare(b.due));
  const mine = inMode.filter(isMine);
  const delegatedCount = inMode.filter((t) => !t.done && t.delegatedTo).length;
  const toggle = (list: Priority[], key: Priority) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const row = (t: Task) => <TaskRow key={t.id} t={t} app={app} plain={personal} delegating={delegating === t.id} onDelegating={setDelegating} />;
  // Personal: one list, soonest due first, then highest priority; done at the bottom.
  const flat = [...list].sort(
    (a, b) => Number(a.done) - Number(b.done) || (a.done ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : a.due.localeCompare(b.due) || PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri]),
  );

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Tasks</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {MODE_NAME[ui.mode]}: {mine.length} on your plate · {mine.filter((t) => t.due < today).length} overdue
            {delegatedCount > 0 && ` · ${delegatedCount} assigned to others`}
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
          Found for you: your action items from recorded calls, and messages that ask you for something and are still waiting for a reply. Change the priority or due date if you like. Nothing becomes a task until you click Add task.
        </p>
        {suggestions.length > 0 ? (
          <div className="sg-list">
            {(allSuggestions ? suggestions : suggestions.slice(0, SUGGESTIONS_SHOWN)).map((g) => (
              <SuggestionRow key={g.id} g={g} app={app} />
            ))}
            {suggestions.length > SUGGESTIONS_SHOWN && (
              <button className="sg-more" aria-expanded={allSuggestions} onClick={() => setAllSuggestions(!allSuggestions)}>
                {allSuggestions ? "Show fewer" : `Show all ${suggestions.length} suggestions`}
              </button>
            )}
          </div>
        ) : (
          <p className="empty">No suggestions right now.</p>
        )}
      </div>

      <AddTask key={ui.mode} app={app} />

      {inMode.length === 0 && (
        <div className="panel hint-panel">
          <strong>No {personal ? "personal " : ""}tasks yet.</strong> Type one in the box above{suggestions.length > 0 ? ", or click Add task on a suggestion." : "."}
        </div>
      )}

      {inMode.length > 0 && (
        <div className="filters">
          <select className="f" value={status} aria-label="Status" onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Status: All</option>
            <option value="open">On my plate</option>
            {!personal && <option value="delegated">Assigned to others</option>}
            <option value="done">Done</option>
          </select>
          {!personal && (
            <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
              <option value="all">Department: All</option>
              {DEPTS.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          )}
          {!personal && (
            <select className="f" value={project} aria-label="Project" onChange={(e) => setProject(e.target.value)}>
              <option value="all">Project: All</option>
              {state.projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {personal && inMode.length > 0 && (
        <div className="panel table-scroll">
          <table className="tasks">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <VisuallyHidden>Done</VisuallyHidden>
                </th>
                <th>Task</th>
                <th>Priority</th>
                <th>Due</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {flat.map(row)}
              {flat.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS - 2} className="muted" style={{ padding: 16 }}>
                    No tasks match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!personal && inMode.length > 0 && SECTIONS.map((sec) => {
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
