"use client";

import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PriPill } from "@/components/bits";
import { daysBetween, parseDay } from "@/core/dates";
import type { Meeting } from "@/core/types";
import { actionItemToTask, loadTranscript, toast, toggleMeeting, toggleTask, useApp, type App } from "@/store/store";

function dayText(m: Meeting, today: string) {
  const diff = daysBetween(today, m.date);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return parseDay(m.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** The transcript is fetched the first time it is opened: it runs to hundreds of lines. */
function Transcript({ m, ownerName }: { m: Meeting; ownerName: string }) {
  const [lines, setLines] = useState<[string, string][] | null>(null);
  const [loading, setLoading] = useState(false);
  if (!m.transcriptLines) return null;
  if (!lines) {
    return (
      <div>
        <button
          className="btn"
          disabled={loading}
          onClick={async () => {
            setLoading(true);
            try {
              setLines(await loadTranscript(m.id));
            } catch (error) {
              toast((error as Error).message);
            }
            setLoading(false);
          }}
        >
          {loading ? "Loading…" : `Show transcript · ${m.transcriptLines} lines`}
        </button>
      </div>
    );
  }
  return (
    <div className="mt-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 className="label">Transcript</h4>
        <button className="btn" onClick={() => setLines(null)}>
          Hide
        </button>
      </div>
      <div className="transcript">
        {lines.map(([who, text], k) => (
          <div className="line" key={k}>
            <span className={`spk ${who === ownerName ? "me" : ""}`}>{who}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MeetingRow({ m, app }: { m: Meeting; app: App }) {
  const { state, ui, today } = app;
  const open = ui.openMeetings.includes(m.id);
  const fromThisCall = (src?: { type: string; id: string } | null) => src?.type === "meeting" && src.id === m.id;
  const tasks = state.tasks.filter((t) => fromThisCall(t.src)).sort((a, b) => Number(a.done) - Number(b.done));
  const suggestions = state.suggestions.filter((g) => g.status === "new" && fromThisCall(g.src));
  const openTasks = tasks.filter((t) => !t.done).length;
  // Kept with their place in the list, which is how the server finds one again.
  const others = m.actionItems.map((item, index) => ({ item, index })).filter(({ item }) => !item.mine);
  const followUp = (who: string, text: string) => `Follow up with ${who}: ${text}`.slice(0, 160);

  return (
    <div className={`mt ${open ? "open" : ""}`}>
      <button className="mt-head" aria-expanded={open} onClick={() => toggleMeeting(m.id)}>
        <div className="mt-when">
          {m.time}
          <small>{dayText(m, today)}</small>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mt-title">{m.title}</div>
          <div className="mt-who">{[m.who, m.where, `${m.dur}m`].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="mt-chips">
          {m.project && <span className="chip">{m.project}</span>}
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
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <h4 className="label">Notes</h4>
                {m.url && (
                  <a className="srclink" href={m.url} target="_blank" rel="noopener noreferrer">
                    Open the recording ↗
                  </a>
                )}
              </div>
              {m.summary ? <Markdown text={m.summary} /> : <p className="muted">No notes for this call yet.</p>}
            </div>
            <div className="mt-card">
              <h4 className="label">Your tasks from this call</h4>
              {tasks.length > 0 && (
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
              )}
              {tasks.length === 0 && suggestions.length === 0 && (
                <p className="muted" style={{ fontSize: 14 }}>
                  Nothing was assigned to you on this call.
                </p>
              )}
              {suggestions.map((g) => (
                <SuggestionRow key={g.id} g={g} app={app} />
              ))}
              {others.length > 0 && (
                <>
                  <h4 className="label">Assigned to others</h4>
                  <ul className="action-items">
                    {others.map(({ item, index }) => (
                      <li key={index}>
                        <span style={item.done ? { textDecoration: "line-through", opacity: 0.55 } : undefined}>
                          <strong>{item.who}:</strong> {item.text}
                        </span>
                        {tasks.some((t) => t.title === followUp(item.who, item.text)) ? (
                          <span className="added">Following up</span>
                        ) : (
                          !item.done && (
                            <button className="btn" title="Adds a task for you to follow up on this" onClick={() => actionItemToTask(m.id, index)}>
                              Follow up
                            </button>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
          <Transcript m={m} ownerName={state.owner.name} />
        </div>
      )}
    </div>
  );
}

export default function MeetingsPage() {
  const app = useApp();
  if (!app) return null;
  const { state } = app;
  const list = [...state.meetings].sort((a, b) => b.date.localeCompare(a.date) || b.time.localeCompare(a.time));

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Meetings</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Every recorded call with its notes, transcript and the tasks that came out of it. Click a call to open it.
          </div>
        </div>
      </div>

      <div className="mt-group">
        <span className="label">Recorded calls</span>
        <div className="panel">
          {list.map((m) => (
            <MeetingRow key={m.id} m={m} app={app} />
          ))}
          {list.length === 0 && (
            <p className="empty" style={{ padding: 18 }}>
              {state.connections.fathom.connected ? "No calls yet. They appear here after the next check." : "Connect Fathom on the Connections tab to see your calls here."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
