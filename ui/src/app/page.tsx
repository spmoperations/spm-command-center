"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/MessageText";
import { DueText, Pill, PriPill } from "@/components/bits";
import { DEPARTMENTS, PRIORITY_RANK, TARGETS } from "@/core/config";
import { ago, daysInMonth, isoDay, parseDay, weekStart } from "@/core/dates";
import { plainPreview } from "@/core/message-format";
import { isMine } from "@/core/delegation";
import { evalMetric, formatValue, STATUS_TEXT, type MetricEval } from "@/core/targets";
import type { Task } from "@/core/types";
import {
  addFocus, addLink, openConversation, openTask, removeFocus, removeLink, toast, toggleFocus, toggleTask, useApp,
  type App, type FocusScope,
} from "@/store/store";

function FocusColumn({ app, scope, title, when, placeholder }: { app: App; scope: FocusScope; title: string; when: string; placeholder: string }) {
  const [text, setText] = useState("");
  const key = scope === "day" ? app.today : weekStart(app.now);
  const items = app.state.focus[app.ui.mode][scope][key] ?? [];
  return (
    <div className="focus-col">
      <div className="focus-head">
        <h4>{title}</h4>
        <span className="muted">{when}</span>
      </div>
      {items.length > 0 ? (
        <ol className="focus-list">
          {items.map((f) => (
            <li key={f.id} className={f.done ? "done" : ""}>
              <input type="checkbox" checked={f.done} aria-label={`Done: ${f.text}`} onChange={(e) => toggleFocus(scope, key, f.id, e.target.checked)} />
              <span className="ft">{f.text}</span>
              <button className="x" aria-label={`Remove ${f.text}`} onClick={() => removeFocus(scope, key, f.id)}>
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="focus-empty">Nothing set yet. What has to happen {scope === "day" ? "today" : "this week"}?</p>
      )}
      <form
        className="focus-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          addFocus(scope, key, text.trim());
          setText("");
        }}
      >
        <input className="f" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder} maxLength={120} />
        <button className="btn" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}

/** Accepts "example.com" or a full address. Only web links are allowed. */
function cleanUrl(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

const host = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function LinksPanel({ app }: { app: App }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const links = app.state.links.filter((k) => k.mode === app.ui.mode);
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Quick links</h3>
        <span className="muted num" style={{ fontSize: 13 }}>
          {links.length}
        </span>
      </div>
      {links.length > 0 ? (
        <ul className="links">
          {links.map((k) => (
            <li key={k.id}>
              <div style={{ minWidth: 0 }}>
                <a href={k.url} target="_blank" rel="noopener noreferrer">
                  {k.label}
                </a>
                <span className="dom">{host(k.url)}</span>
              </div>
              <button className="x" aria-label={`Remove ${k.label}`} onClick={() => removeLink(k.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No links yet. Add the pages you open every day.</p>
      )}
      <form
        className="link-add"
        onSubmit={(e) => {
          e.preventDefault();
          const clean = cleanUrl(url);
          if (!label.trim()) return toast("Add the text to show");
          if (!clean) return toast("That does not look like a web address");
          addLink(label.trim(), clean);
          setLabel("");
          setUrl("");
        }}
      >
        <input className="f" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Text to show" aria-label="Link text" maxLength={60} required />
        <input className="f" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL, e.g. notion.so/team" aria-label="Link URL" maxLength={500} required />
        <button className="btn" type="submit">
          Add
        </button>
      </form>
    </div>
  );
}

function PaceRow({ e }: { e: MetricEval }) {
  const pct = Math.min(100, (e.actual / e.metric.target) * 100);
  const pacePct = Math.min(100, (e.expected / e.metric.target) * 100);
  return (
    <div className="pace-row">
      <div>
        <span className="name">{e.metric.name}</span>{" "}
        <span className="fig num">
          {formatValue(e.actual, e.metric.unit)} / {formatValue(e.metric.target, e.metric.unit)}
        </span>
      </div>
      <Pill tone={`s-${e.status}`}>{STATUS_TEXT[e.status]}</Pill>
      <div className="bar" title="Marker shows where you should be today">
        <div className={`fill ${e.status}`} style={{ width: `${pct}%` }} />
        <div className="pace" style={{ left: `calc(${pacePct}% - 1px)` }} />
      </div>
    </div>
  );
}

function TodayTask({ task, today }: { task: Task; today: string }) {
  const handedOff = task.delegatedTo && !task.done;
  return (
    <li className={task.done ? "done" : ""} style={handedOff ? { opacity: 0.6 } : undefined}>
      <input type="checkbox" checked={task.done} aria-label={`Mark done: ${task.title}`} onChange={(e) => toggleTask(task.id, e.target.checked)} />
      <div className="grow">
        <Link className="who task-link" href="/tasks" onClick={() => openTask(task.id)} title="Open this task">
          {task.title}
        </Link>
        {task.mode === "professional" && <div className="txt">{[task.project, DEPARTMENTS ? task.dept : ""].filter(Boolean).join(" · ")}</div>}
      </div>
      <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
        <PriPill p={task.pri} />
        {handedOff ? <span className="due">{task.delegatedTo!.name.split(" ")[0]}</span> : <DueText task={task} today={today} />}
      </div>
    </li>
  );
}

export default function TodayPage() {
  const app = useApp();
  if (!app) return null;
  const { state, ui, now, today } = app;
  const personal = ui.mode === "personal";

  // Professional shows what is urgent; Personal has fewer messages, so it shows them all.
  const unanswered = state.inbox.filter((c) => c.mode === ui.mode && !c.done && !c.replied);
  const waiting = personal
    ? [...unanswered].sort((a, b) => PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri] || b.at - a.at)
    : unanswered.filter((c) => c.pri === "high").sort((a, b) => b.at - a.at);
  const tasks = state.tasks.filter((t) => t.mode === ui.mode);
  const due = tasks.filter((t) => isMine(t) && t.due <= today);
  const handedOff = tasks.filter((t) => !t.done && t.delegatedTo && t.due <= today);
  // Tasks finished today stay in the list, ticked off, below the open ones.
  const doneToday = tasks.filter((t) => t.done && (t.doneAt ? isoDay(new Date(t.doneAt)) === today : t.due === today));
  const list = [...due, ...handedOff, ...doneToday].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      Number(!!a.delegatedTo) - Number(!!b.delegatedTo) ||
      (a.done ? (b.doneAt ?? 0) - (a.doneAt ?? 0) : a.due.localeCompare(b.due) || PRIORITY_RANK[a.pri] - PRIORITY_RANK[b.pri]),
  );

  const clock = { day: now.getDate(), dim: daysInMonth(now) };
  const pace = state.metrics.filter((m) => !m.parent).map((m) => evalMetric(m, state.metrics, state.logs, clock));
  const suggested = state.suggestions.filter((g) => g.status === "new" && g.mode === ui.mode).length;
  const monthName = now.toLocaleString("en-US", { month: "long" });

  return (
    <section className="view">
      <div className="panel focus-panel">
        <div className="panel-head">
          <h3>Focus</h3>
        </div>
        <div className="focus-cols">
          <FocusColumn app={app} scope="day" title="Today's focus" when={now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} placeholder="Add a focus for today" />
          <FocusColumn app={app} scope="week" title="This week's focus" when={`Week of ${parseDay(weekStart(now)).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`} placeholder="Add a focus for this week" />
        </div>
      </div>

      {!personal && TARGETS && (
        <div className="split-row">
          <div className="panel pace-panel">
            <div className="panel-head">
              <h3>{monthName} pace</h3>
              <Link href="/targets">Targets</Link>
            </div>
            <div className="wt-grid">
              {pace.map((e) => (
                <PaceRow key={e.metric.id} e={e} />
              ))}
            </div>
          </div>
          <LinksPanel app={app} />
        </div>
      )}

      <div className="today-grid">
        <div className="panel">
          <div className="panel-head">
            <h3>{personal ? "Messages" : "Needs a reply"}</h3>
            <Link href="/inbox">Open inbox</Link>
          </div>
          {waiting.length > 0 ? (
            <ul className="mini-list">
              {waiting.slice(0, 4).map((c) => (
                <li key={c.id}>
                  <Avatar name={c.from} src={state.avatars[c.from]} small />
                  <div className="grow">
                    <div className="who">
                      {c.from} {personal && <PriPill p={c.pri} />}
                    </div>
                    <div className="txt">{plainPreview(c.text)}</div>
                  </div>
                  <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
                    <span className="num muted" style={{ fontSize: 12 }}>
                      {ago(c.at, now.getTime())}
                    </span>
                    <Link className="reply-link" href="/inbox" onClick={() => openConversation(c.id)}>
                      Reply
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{personal ? "No personal messages waiting." : "No high-priority messages waiting."}</p>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h3>{personal ? "Personal tasks due" : "Tasks due today"}</h3>
            <span className="muted" style={{ fontSize: 13 }}>
              {doneToday.length} of {due.length + doneToday.length} done · <Link href="/tasks">All tasks</Link>
            </span>
          </div>
          {list.length > 0 ? (
            <ul className="mini-list">
              {list.map((t) => (
                <TodayTask key={t.id} task={t} today={today} />
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing due today.</p>
          )}
          {suggested > 0 && (
            <div className="sg-foot">
              {suggested} suggested {suggested === 1 ? "task" : "tasks"} from your inbox and calls. <Link href="/tasks">Review</Link>
            </div>
          )}
        </div>
      </div>

      {/* Quick links sit beside the month's pace when that is showing, and below otherwise. */}
      {(personal || !TARGETS) && (
        <div style={{ marginTop: 18 }}>
          <LinksPanel app={app} />
        </div>
      )}
    </section>
  );
}
