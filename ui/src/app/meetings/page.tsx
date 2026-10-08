"use client";

import { useState } from "react";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PriPill } from "@/components/bits";
import { daysBetween, parseDay } from "@/core/dates";
import type { Meeting } from "@/core/types";
import { toggleMeeting, toggleTask, useApp, type App } from "@/store/store";

function dayText(m: Meeting, today: string) {
  const diff = daysBetween(today, m.date);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return parseDay(m.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function MeetingRow({ m, app }: { m: Meeting; app: App }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const { state, ui, today } = app;
  const open = ui.openMeetings.includes(m.id);
  const fromThisCall = (src?: { type: string; id: string } | null) => src?.type === "meeting" && src.id === m.id;
  const tasks = state.tasks.filter((t) => fromThisCall(t.src)).sort((a, b) => Number(a.done) - Number(b.done));
  const suggestions = state.suggestions.filter((g) => g.status === "new" && fromThisCall(g.src));
  const openTasks = tasks.filter((t) => !t.done).length;

  return (
    <div className={`mt ${open ? "open" : ""}`}>
      <button className="mt-head" aria-expanded={open} onClick={() => toggleMeeting(m.id)}>
        <div className="mt-when">
          {m.time}
          <small>{dayText(m, today)}</small>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mt-title">{m.title}</div>
          <div className="mt-who">
            {m.who} · {m.where} · {m.dur}m
          </div>
        </div>
        <div className="mt-chips">
          <span className="chip">{m.project}</span>
          {tasks.length > 0 && (
            <span className="chip">
              {openTasks} open {openTasks === 1 ? "task" : "tasks"}
            </span>
          )}
          {suggestions.length > 0 && <span className="chip biz">{suggestions.length} suggested</span>}
        </div>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="mt-body">
          <div className="mt-cols">
            <div className="mt-card">
              <h4 className="label">Notes</h4>
              <p>{m.notes.summary}</p>
              <ul>
                {m.notes.points.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <h4 className="label">Decisions</h4>
              <ul className="decided">
                {m.notes.decisions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div className="mt-card">
              <h4 className="label">Tasks from this call</h4>
              {tasks.length > 0 ? (
                <ul className="mt-tasks">
                  {tasks.map((t) => (
                    <li key={t.id} className={t.done ? "done" : ""}>
                      <input type="checkbox" checked={t.done} aria-label={`Done: ${t.title}`} onChange={(e) => toggleTask(t.id, e.target.checked)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="t-name">{t.title}</div>
                      </div>
                      <PriPill p={t.pri} />
                      <DueText task={t} today={today} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" style={{ fontSize: 14 }}>
                  No tasks linked to this call yet.
                </p>
              )}
              {suggestions.map((g) => (
                <SuggestionRow key={g.id} g={g} app={app} />
              ))}
            </div>
          </div>
          {showTranscript ? (
            <div className="mt-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h4 className="label">Transcript</h4>
                <button className="btn" onClick={() => setShowTranscript(false)}>
                  Hide
                </button>
              </div>
              <div className="transcript">
                {m.transcript.map(([who, text], k) => (
                  <div className="line" key={k}>
                    <span className={`spk ${who === "Jeremy" ? "me" : ""}`}>{who}</span>
                    <span>{text}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <button className="btn" onClick={() => setShowTranscript(true)}>
                Show transcript · {m.transcript.length} lines
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function MeetingsPage() {
  const app = useApp();
  const [project, setProject] = useState("all");
  if (!app) return null;
  const { state } = app;

  const projects = [...new Set(state.meetings.map((m) => m.project))];
  const list = state.meetings
    .filter((m) => project === "all" || m.project === project)
    .sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Meetings</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Every recorded call with its notes, transcript and the tasks that came out of it. Click a call to open it.
          </div>
        </div>
        <select className="f" value={project} aria-label="Project" onChange={(e) => setProject(e.target.value)}>
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-group">
        <span className="label">Recorded calls</span>
        <div className="panel">
          {list.map((m) => (
            <MeetingRow key={m.id} m={m} app={app} />
          ))}
          {list.length === 0 && (
            <p className="empty" style={{ padding: 18 }}>
              No calls for this project.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
