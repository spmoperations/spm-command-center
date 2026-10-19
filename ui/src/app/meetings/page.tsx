"use client";

import Link from "next/link";
import { useState } from "react";
import { Markdown } from "@/components/Markdown";
import { SuggestionRow } from "@/components/SuggestionRow";
import { DueText, PriPill } from "@/components/bits";
import { clockWithZone, daysBetween, parseDay, upcomingDay } from "@/core/dates";
import type { CalendarItem, Meeting } from "@/core/types";
import { actionItemToTask, loadTranscript, openTask, toast, toggleMeeting, toggleTask, useApp, type App } from "@/store/store";

function dayText(m: Meeting, today: string) {
  const diff = daysBetween(today, m.date);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return parseDay(m.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

const ANSWER: Record<string, string> = { tentative: "Maybe", needsAction: "Not answered yet" };

/** A meeting on the calendar that has not ended yet: when, with whom, and the link to join. */
function UpcomingRow({ m, day }: { m: CalendarItem; day: string }) {
  // "8:30 – 9:00 PM", with the AM or PM once when both are the same, and the zone on its own line.
  const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const [from, to] = [clock(m.at), clock(m.end)];
  const range = from.slice(-2) === to.slice(-2) ? `${from.slice(0, -3)} – ${to}` : `${from} – ${to}`;
  const zone = clockWithZone(m.at).split(" ").pop();
  return (
    <div className={`mt up ${day === "Now" ? "now" : ""}`}>
      <div className="mt-head up-head">
        <div className="up-when">
          <span className="up-day">{day}</span>
          <span className="up-time">{range}</span>
          <span className="up-zone">{zone}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mt-title">{m.title}</div>
          <div className="mt-who">{[m.where, m.who ? `with ${m.who}` : "just you"].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="mt-chips">
          {m.response && ANSWER[m.response] && <span className="chip">{ANSWER[m.response]}</span>}
          {m.calendarLink && (
            <a className="srclink" href={m.calendarLink} target="_blank" rel="noopener noreferrer">
              In Calendar ↗
            </a>
          )}
          {m.link && (
            <a className={`btn ${day === "Now" ? "primary" : ""}`} href={m.link} target="_blank" rel="noopener noreferrer">
              Join ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
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
          {clockWithZone(m.at)}
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
                        <Link className="t-name task-link" href="/tasks" onClick={() => openTask(t.id)} title="Open this task">
                          {t.title}
                        </Link>
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
  const list = [...state.meetings].sort((a, b) => b.at - a.at);
  // Meetings with a time, not all-day events, focus time or days away.
  const coming = state.calendar
    .filter((m) => !m.allDay && m.kind === "meeting" && m.end > app.now.getTime())
    .map((m) => ({ m, day: upcomingDay(m, app.now) }))
    .filter((u): u is { m: CalendarItem; day: "Now" | "Today" | "Tomorrow" } => u.day !== null)
    .sort((a, b) => a.m.at - b.m.at);
  const google = state.connections.google;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Meetings</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {google.connected ? "What is on your calendar today and tomorrow, then every" : "Every"} recorded call with its notes, transcript and the tasks that came out of it. Click a call to open it.
          </div>
        </div>
      </div>

      {(google.connected || coming.length > 0) && (
        <div className="mt-group">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <span className="label">Coming up: today and tomorrow</span>
            <Link className="srclink" href="/calendar">
              Open the calendar
            </Link>
          </div>
          <div className="panel">
            {coming.map(({ m, day }) => (
              <UpcomingRow key={m.id} m={m} day={day} />
            ))}
            {coming.length === 0 && (
              <p className="empty" style={{ padding: 18 }}>
                {state.googleAllows.calendar ? "Nothing on your calendar for the rest of today or tomorrow." : "Calendar was not allowed when Google was connected. Connect Google again and tick Calendar to see your meetings here."}
              </p>
            )}
          </div>
        </div>
      )}
      {!google.connected && state.googleAvailable && (
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
          To see the meetings coming up on your calendar, <Link href="/connections#google">connect Google</Link>.
        </p>
      )}

      <div className="mt-group">
        <span className="label">Recorded calls</span>
        <div className="panel">
          {list.map((m) => (
            <MeetingRow key={m.id} m={m} app={app} />
          ))}
          {list.length === 0 && (
            <p className="empty" style={{ padding: 18 }}>
              {state.connections.fathom.connected ? "No calls yet. They appear here after the next check." : "Fathom is not connected yet, so there are no calls to show."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
