"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { MessageText } from "@/components/MessageText";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PriPill, PrioritySelect, SourceLink, VisuallyHidden } from "@/components/bits";
import { conversationPage, DEPARTMENTS, DEPTS, MODE_NAME, MODES, PERSONAL_SIDE, PRIORITY_RANK, SOURCE_NAME } from "@/core/config";
import { clockWithZone, dueLabel, parseDay, stamp } from "@/core/dates";
import { canAssign, canAssignInChat, isMine } from "@/core/delegation";
import type { Mode, Priority, Task } from "@/core/types";
import { addTask, delegateTask, openConversation, openTask, setTaskDescription, setTaskPriority, showMeeting, toggleTask, undelegateTask, useApp, type App } from "@/store/store";

/** Columns in the task table: tick box, priority, task, due and buttons, plus project and department where they show. */
const columnCount = (plain: boolean) => 5 + (plain ? 0 : 1 + (DEPARTMENTS ? 1 : 0));
/** Suggestions shown before "Show all": enough to act on without pushing the tasks off screen. */
const SUGGESTIONS_SHOWN = 5;

const longDay = (iso: string) => parseDay(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const dayAndTime = (ts: number) => new Date(ts).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Everything known about one task: its dates, who has it, and the message or call it came from. */
/** A task's description, written or changed where the task is opened. Saved when the button is clicked. */
function Description({ t }: { t: Task }) {
  const [text, setText] = useState(t.description);
  const changed = text.trim() !== t.description;
  return (
    <div className="td-block">
      <label className="label" htmlFor={`desc-${t.id}`}>
        Description
      </label>
      <textarea
        className="f td-desc"
        id={`desc-${t.id}`}
        value={text}
        rows={3}
        placeholder="Context, links, what done looks like. Optional."
        onChange={(e) => setText(e.target.value)}
      />
      {changed && (
        <div className="td-links">
          <button className="btn primary" onClick={() => setTaskDescription(t.id, text)}>
            Save description
          </button>
          <button className="btn" onClick={() => setText(t.description)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function TaskDetail({ t, app }: { t: Task; app: App }) {
  const { state, now, today } = app;
  const chat = t.src?.type === "message" ? state.inbox.find((c) => c.id === t.src!.id) : undefined;
  const call = t.src?.type === "meeting" ? state.meetings.find((m) => m.id === t.src!.id) : undefined;
  const told = state.outbox.filter((o) => o.taskId === t.id);
  const due = dueLabel(t.due, today);
  return (
    <div className="task-detail">
      <dl className="facts">
        <div>
          <dt>Status</dt>
          <dd>{t.done ? `Done${t.doneAt ? ` · ${dayAndTime(t.doneAt)}` : ""}` : t.delegatedTo ? `Assigned to ${t.delegatedTo.name}` : "On your plate"}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>
            <PriPill p={t.pri} />
          </dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            {longDay(t.due)}
            {!t.done && due.tone !== "" && <span className={`due ${due.tone}`}> · {due.text}</span>}
          </dd>
        </div>
        {t.mode === "professional" && t.project && (
          <div>
            <dt>Project</dt>
            <dd>{t.project}</dd>
          </div>
        )}
        {DEPARTMENTS && t.mode === "professional" && (
          <div>
            <dt>Department</dt>
            <dd>{t.dept}</dd>
          </div>
        )}
        <div>
          <dt>Added</dt>
          <dd>{dayAndTime(t.createdAt)}</dd>
        </div>
      </dl>

      <Description key={t.id} t={t} />

      {t.delegatedTo && (
        <div className="td-block">
          <h4 className="label">Assigned</h4>
          <p>
            To {t.delegatedTo.name}
            {t.delegatedTo.role && t.delegatedTo.role !== "Slack channel" ? ` (${t.delegatedTo.role})` : ""} on {dayAndTime(t.delegatedTo.at)}.
          </p>
          {t.delegatedTo.note && <p className="td-quote">{t.delegatedTo.note}</p>}
          {told.map((o) => (
            <p className="muted" key={o.id}>
              {o.inThread ? "The description, as a reply under it" : `Slack message ${o.ctx === "Direct message" ? "to them directly" : `in ${o.ctx}`}`}:{" "}
              {o.status === "sent" ? "sent." : o.status === "failed" ? "could not be sent." : state.sendingEnabled ? "waiting to send." : "waiting in the outbox, because sending is off."}
            </p>
          ))}
        </div>
      )}

      <div className="td-block">
        <h4 className="label">Where it came from</h4>
        {!t.src && <p className="muted">You added this task yourself.</p>}
        {t.src && !chat && !call && <p className="muted">It came from a {t.src.type === "message" ? "conversation" : "call"} that is no longer on the dashboard.</p>}
        {chat && (
          <>
            <p>
              {SOURCE_NAME[chat.source]} · {chat.from} · {chat.ctx}
            </p>
            <div className="td-thread">
              {chat.thread.slice(-3).map((m, k) => (
                <div className={`td-msg ${m.me ? "me" : ""}`} key={k}>
                  <div className="bmeta">
                    {m.me ? "You" : (m.from ?? chat.from)} · {stamp(m.at, now)}
                  </div>
                  <MessageText text={m.text} />
                </div>
              ))}
            </div>
            <div className="td-links">
              {chat.done ? (
                <span className="muted">This conversation has been cleared from the inbox.</span>
              ) : (
                <Link className="srclink" href={conversationPage(chat.id)} onClick={() => openConversation(chat.id)}>
                  Open the conversation
                </Link>
              )}
            </div>
          </>
        )}
        {call && (
          <>
            <p>
              Call · {call.title} · {longDay(call.date)}, {clockWithZone(call.at)}
            </p>
            <div className="td-links">
              <Link className="srclink" href="/meetings" onClick={() => showMeeting(call.id)}>
                Open the call&apos;s notes
              </Link>
              {call.url && (
                <a className="srclink" href={call.url} target="_blank" rel="noopener noreferrer">
                  Open the recording ↗
                </a>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** `plain` leaves out department and project: personal tasks have neither. */
function TaskRow({ t, app, delegating, onDelegating, plain }: { t: Task; app: App; delegating: boolean; onDelegating(id: string | null): void; plain?: boolean }) {
  const { state, today } = app;
  const rowClass = t.done ? "done" : t.delegatedTo ? "delegated" : "";
  const columns = columnCount(Boolean(plain));
  const opened = app.ui.openTask === t.id;
  const detail = useRef<HTMLTableRowElement>(null);
  // Arriving from another tab: bring the opened task into view.
  useEffect(() => {
    if (opened) detail.current?.scrollIntoView({ block: "nearest" });
  }, [opened]);
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
          <PrioritySelect tag value={t.pri} onChange={(p) => setTaskPriority(t.id, p)} />
        </td>
        <td>
          <button className="t-title" aria-expanded={opened} title={opened ? "Close" : "Open this task"} onClick={() => openTask(opened ? null : t.id)}>
            {t.title}
          </button>
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
        {!plain && DEPARTMENTS && <td>{t.dept}</td>}
        {!plain && <td>{t.project}</td>}
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
              channels={state.channels}
              today={today}
              // Without departments there is no "people in this department" to suggest first.
              subject={DEPARTMENTS ? t : { ...t, dept: "" }}
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
      {opened && (
        <tr className="dg-row" ref={detail}>
          <td />
          <td colSpan={columns - 1}>
            <TaskDetail t={t} app={app} />
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
  const [description, setDescription] = useState("");
  const personal = mode === "personal";
  // One column each for what shows between the title and the button: the side, department
  // and project (work tasks only), then priority and due. A task is made first and assigned
  // afterwards, from its row, where the whole message can be read before it goes.
  const middle = (PERSONAL_SIDE ? 1 : 0) + (personal ? 0 : (DEPARTMENTS ? 1 : 0) + 1) + 2;
  return (
    <form
      className="panel addtask"
      style={{ gridTemplateColumns: `minmax(0, 2.4fr) repeat(${middle}, minmax(0, 1fr)) auto` }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        addTask({ title: title.trim(), description: description.trim(), mode, dept, project: project.trim(), pri, due: due || app.today });
        setTitle("");
        setDescription("");
      }}
    >
      <input className="f" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New task" required aria-label="Task" />
      {PERSONAL_SIDE && (
        <select className="f" value={mode} aria-label="Personal or Professional" onChange={(e) => setTaskMode(e.target.value as Mode)}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_NAME[m]}
            </option>
          ))}
        </select>
      )}
      {!personal && DEPARTMENTS && (
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
      <button className="btn primary" type="submit">
        Add task
      </button>
      <textarea
        className="f addtask-desc"
        value={description}
        rows={2}
        placeholder={`Description (optional): context, links, what done looks like.${personal ? "" : " It goes in the Slack message when you assign the task."}`}
        aria-label="Description"
        onChange={(e) => setDescription(e.target.value)}
      />
    </form>
  );
}

export default function TasksPage() {
  const app = useApp();
  const [status, setStatus] = useState("all");
  const [dept, setDept] = useState("all");
  const [project, setProject] = useState("all");
  const [delegating, setDelegating] = useState<string | null>(null);
  const [allSuggestions, setAllSuggestions] = useState(false);
  if (!app) return null;
  const { state, ui, today } = app;
  const personal = ui.mode === "personal";

  const inMode = state.tasks.filter((t) => t.mode === ui.mode);
  const list = inMode.filter(
    (t) =>
      (personal || ((dept === "all" || t.dept === dept) && (project === "all" || t.project === project))) &&
      // A task that is done leaves the table. It is still there under "Done".
      (status === "all" ? !t.done : status === "open" ? isMine(t) : status === "delegated" ? !t.done && !!t.delegatedTo : t.done),
  );
  const suggestions = state.suggestions
    .filter((g) => g.status === "new" && g.mode === ui.mode)
    .sort((a, b) => PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri] || a.due.localeCompare(b.due));
  const mine = inMode.filter(isMine);
  const delegatedCount = inMode.filter((t) => !t.done && t.delegatedTo).length;
  const row = (t: Task) => <TaskRow key={t.id} t={t} app={app} plain={personal} delegating={delegating === t.id} onDelegating={setDelegating} />;
  // One list: highest priority first, then soonest due. What is done goes to the bottom, newest first.
  const sorted = [...list].sort(
    (a, b) => Number(a.done) - Number(b.done) || (a.done ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri] || a.due.localeCompare(b.due)),
  );

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Tasks</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {PERSONAL_SIDE && `${MODE_NAME[ui.mode]}: `}
            {mine.length} on your plate · {mine.filter((t) => t.due < today).length} overdue
            {delegatedCount > 0 && ` · ${delegatedCount} assigned to others`}
          </div>
        </div>
      </div>

      <AddTask key={ui.mode} app={app} />

      {inMode.length === 0 && (
        <div className="panel hint-panel">
          <strong>No {personal ? "personal " : ""}tasks yet.</strong> Type one in the box above{suggestions.length > 0 ? ", or click Add task on a suggestion below." : "."}
        </div>
      )}

      {inMode.length > 0 && (
        <div className="filters">
          <select className="f" value={status} aria-label="Status" onChange={(e) => setStatus(e.target.value)}>
            <option value="all">Status: To do</option>
            <option value="open">On my plate</option>
            {!personal && <option value="delegated">Assigned to others</option>}
            <option value="done">Done</option>
          </select>
          {!personal && DEPARTMENTS && (
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

      {inMode.length > 0 && (
        <div className="panel table-scroll">
          <table className="tasks">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <VisuallyHidden>Done</VisuallyHidden>
                </th>
                <th style={{ width: 110 }}>Priority</th>
                <th>Task</th>
                {!personal && DEPARTMENTS && <th>Department</th>}
                {!personal && <th>Project</th>}
                <th>Due</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map(row)}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={columnCount(personal)} className="muted" style={{ padding: 16 }}>
                    {status === "done" ? "Nothing is done yet." : status === "all" && inMode.some((t) => t.done) ? "Nothing left to do. What is finished is under Status: Done." : "No tasks match."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Below the tasks: what was found for the owner and is not a task until they say so. */}
      <div className="panel sg-panel" id="suggested">
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
    </section>
  );
}
