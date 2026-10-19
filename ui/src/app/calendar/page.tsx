"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Seg } from "@/components/bits";
import { allDayOn, dayAfter, layDay, sameDay, weekDays, weekStart, weekTitle, WEEKS_AHEAD, WEEKS_BACK, type Placed } from "@/core/calendar";
import { ago } from "@/core/dates";
import type { CalendarItem } from "@/core/types";
import { addCalendarEvent, deleteCalendarEvent, respondToEvent, runJobNow, updateCalendarEvent, useApp, type App } from "@/store/store";

/** Height of one hour in the grid. */
const HOUR = 48;
/** Where the grid opens when the week is not this one: the start of a working day. */
const OPEN_AT_HOUR = 7;

const WEEK_NAMES: Record<string, string> = {
  "-1": "Last week",
  "0": "This week",
  "1": "Next week",
  "2": "In 2 weeks",
  "3": "In 3 weeks",
};
const ANSWER: Record<string, string> = {
  accepted: "Going",
  tentative: "Maybe",
  needsAction: "Not answered yet",
};

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
/** "3 PM", "3:30 PM": the hour labels and short times on small events. */
const short = (ms: number) => {
  const d = new Date(ms);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    ...(d.getMinutes() ? { minute: "2-digit" } : {}),
  });
};
/** The viewer's timezone, shown in the grid's corner: "EDT", "GMT+5:30". */
const zoneName = () => new Date().toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() ?? "";

/** Each connected account has its own color, in the order the accounts were connected. */
const colorOf = (app: App, item: CalendarItem) => {
  const index = app.state.googleAccounts.findIndex((a) => item.accounts.includes(a.email));
  return `var(--cal-${(Math.max(0, index) % 4) + 1})`;
};

function EventBlock({ p, app, onOpen }: { p: Placed; app: App; onOpen(item: CalendarItem): void }) {
  const e = p.item;
  const small = p.height < 50;
  const unanswered = e.response === "needsAction" || e.response === "tentative";
  return (
    <button
      className={`cal-ev k-${e.kind} ${unanswered ? "unanswered" : ""} ${small ? "small" : ""}`}
      style={{
        top: (p.top / 60) * HOUR,
        height: Math.max(18, (p.height / 60) * HOUR - 2),
        left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
        width: `calc(${100 / p.cols}% - 4px)`,
        ["--ev" as string]: colorOf(app, e),
      }}
      onClick={(event) => {
        // Not a click on the empty slot behind it.
        event.stopPropagation();
        onOpen(e);
      }}
      title={`${e.title}, ${clock(e.at)} – ${clock(e.end)}`}
    >
      <span className="cal-ev-title">{e.title}</span>
      <span className="cal-ev-time">{small ? `, ${short(e.at)}` : `${p.fromBefore ? "…" : clock(e.at)} – ${p.goesOn ? "…" : clock(e.end)}`}</span>
    </button>
  );
}

/** The details of one event, over the page. Esc or a click outside closes it. */
/**
 * What can be done with an event: change or delete one the owner made (its guests are told), or
 * answer an invitation from someone else (the organizer is told).
 */
function EventActions({ item, app, onEdit, onClose }: { item: CalendarItem; app: App; onEdit(): void; onClose(): void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const account = item.accounts[0];
  if (!app.state.googleAccounts.find((a) => a.email === account)?.addEvents) {
    return <p className="st-help">To change or answer events from here, connect {account} again on the Connections tab and allow it.</p>;
  }
  const run = async (work: () => Promise<string | null>, close: boolean) => {
    setBusy(true);
    setError(null);
    const failed = await work();
    setBusy(false);
    if (failed) setError(failed);
    else if (close) onClose();
  };
  const once = item.recurring ? " This is one occurrence of a repeating event: only this one changes." : "";
  return (
    <div className="cal-actions">
      {item.mine ? (
        deleting ? (
          <div className="cal-confirm">
            <span>
              Delete this event?{item.guests.length ? " Its guests are told it is cancelled." : ""}
              {once}
            </span>
            <button className="btn danger" disabled={busy} onClick={() => void run(() => deleteCalendarEvent(account, item.eventId), true)}>
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button className="btn" onClick={() => setDeleting(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <div className="cal-actions-row">
            {!item.allDay && item.kind === "meeting" && (
              <button className="btn" onClick={onEdit}>
                Edit
              </button>
            )}
            <button className="btn" onClick={() => setDeleting(true)}>
              Delete
            </button>
            {item.recurring && (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Changes are for this occurrence only.
              </span>
            )}
          </div>
        )
      ) : item.kind === "meeting" ? (
        <div className="cal-actions-row" role="group" aria-label="Your answer">
          <span className="label">Going?</span>
          {(
            [
              ["accepted", "Yes"],
              ["tentative", "Maybe"],
              ["declined", "No"],
            ] as const
          ).map(([answer, label]) => (
            <button
              key={answer}
              className={`btn ${item.response === answer ? "primary" : ""}`}
              aria-pressed={item.response === answer}
              disabled={busy}
              onClick={() => void run(() => respondToEvent(account, item.eventId, answer), answer === "declined")}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function EventDetails({ item, app, onClose, onEdit }: { item: CalendarItem; app: App; onClose(): void; onEdit(): void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  const when = item.allDay
    ? (() => {
        const first = new Date(item.at).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone: "UTC",
        });
        const lastMs = item.end - 86_400_000;
        return lastMs > item.at ? `${first} – ${new Date(lastMs).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}, all day` : `${first}, all day`;
      })()
    : `${day(item.at)} · ${clock(item.at)} – ${new Date(item.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}${sameDay(new Date(item.at), new Date(item.end)) ? "" : ` (${day(item.end)})`}`;
  return (
    <div className="cal-modal" role="presentation" onClick={onClose}>
      <div className="cal-card panel" role="dialog" aria-modal="true" aria-label={item.title} onClick={(e) => e.stopPropagation()} style={{ ["--ev" as string]: colorOf(app, item) }}>
        <div className="cal-card-head">
          <span className="cal-dot" aria-hidden="true" />
          <h3>{item.title}</h3>
          <button className="linkbtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="cal-card-body">
          <div>{when}</div>
          {item.where && <div className="muted">{item.where}</div>}
          {item.who && (
            <div>
              <span className="label">With</span> {item.who}
            </div>
          )}
          {item.organizer && (
            <div>
              <span className="label">Invited by</span> {item.organizer}
            </div>
          )}
          {item.response && item.kind === "meeting" && !item.mine && (
            <div>
              <span className="label">Your answer</span> {ANSWER[item.response] ?? item.response}
            </div>
          )}
          {app.state.googleAccounts.length > 1 && (
            <div className="muted" style={{ fontSize: 13 }}>
              On {item.accounts.join(" and ")}
            </div>
          )}
          {item.description && <div className="cal-notes">{item.description}</div>}
          <EventActions item={item} app={app} onEdit={onEdit} onClose={onClose} />
        </div>
        <div className="cal-card-foot">
          {item.calendarLink && (
            <a className="btn" href={item.calendarLink} target="_blank" rel="noopener noreferrer">
              Open in Google Calendar ↗
            </a>
          )}
          {item.link && (
            <a className="btn primary" href={item.link} target="_blank" rel="noopener noreferrer">
              Join {item.where && !/^online$/i.test(item.where) ? item.where : "the call"} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const LENGTHS: [number, string][] = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [45, "45 minutes"],
  [60, "1 hour"],
  [90, "1½ hours"],
  [120, "2 hours"],
  [180, "3 hours"],
];

/**
 * New event: what, when, how long and who, on one of the calendars that may be added to. The
 * guests get Google's own invitation, and a Google Meet link is added unless it is unticked.
 */
function NewEventForm({ app, start, editing, onClose }: { app: App; start: number; editing?: CalendarItem | null; onClose(): void }) {
  const calendars = app.state.googleAccounts.filter((a) => a.addEvents);
  const first = new Date(start);
  const length = editing ? Math.round((editing.end - editing.at) / 60_000) : 30;
  const [account, setAccount] = useState(editing?.accounts[0] ?? calendars[0]?.email ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [date, setDate] = useState(dateValue(first));
  const [time, setTime] = useState(timeValue(first));
  const [minutes, setMinutes] = useState(length);
  const [guests, setGuests] = useState(editing?.guests.join(", ") ?? "");
  const [meet, setMeet] = useState(editing ? Boolean(editing.link) : true);
  const [description, setDescription] = useState(editing?.description ?? "");
  // A length that is not in the list, from an event made in Google Calendar, is offered too.
  const lengths = LENGTHS.some(([m]) => m === length)
    ? LENGTHS
    : [...LENGTHS, [length, `${Math.floor(length / 60) ? `${Math.floor(length / 60)} h ` : ""}${length % 60 ? `${length % 60} min` : ""}`.trim()] as [number, string]].sort((a, b) => a[0] - b[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const save = async () => {
    // The date and time are read in the timezone of whoever is filling it in.
    const at = new Date(`${date}T${time}`).getTime();
    if (!Number.isFinite(at)) return setError("Pick a date and a time.");
    setBusy(true);
    const form = { account, title, start: at, end: at + minutes * 60_000, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, guests, meet, description };
    const failed = editing ? await updateCalendarEvent(editing.eventId, form) : await addCalendarEvent(form);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  return (
    <div className="cal-modal" role="presentation" onClick={onClose}>
      <div className="cal-card panel" role="dialog" aria-modal="true" aria-label={editing ? "Change event" : "New event"} onClick={(e) => e.stopPropagation()}>
        <div className="cal-card-head">
          <h3>{editing ? "Change event" : "New event"}</h3>
          <button className="linkbtn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="cal-form">
          <input className="f cal-form-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a title" aria-label="Title" autoFocus />
          <div className="cal-form-when">
            <input className="f" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            <input className="f" type="time" value={time} step={300} onChange={(e) => setTime(e.target.value)} aria-label="Start time" />
            <select className="f" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="How long">
              {lengths.map(([m, label]) => (
                <option key={m} value={m}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <input className="f" value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="Guests: name@example.com, another@example.com" aria-label="Guests" />
          <label className="inline-check">
            {editing?.link ? (
              <>
                <input type="checkbox" checked disabled /> Has a Google Meet link
              </>
            ) : (
              <>
                <input type="checkbox" checked={meet} onChange={(e) => setMeet(e.target.checked)} /> Add a Google Meet link
              </>
            )}
          </label>
          <textarea className="f" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" aria-label="Description" />
          {calendars.length > 1 && !editing && (
            <select className="f" value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Calendar">
              {calendars.map((a) => (
                <option key={a.email} value={a.email}>
                  On {a.email}
                </option>
              ))}
            </select>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="cal-card-foot">
          <span className="muted" style={{ fontSize: 12.5, marginRight: "auto" }}>
            {guests.trim() ? (editing ? "Guests are told of the change." : "Guests get an invitation from Google.") : `On ${account}`}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !account} onClick={() => void save()}>
            {busy ? (editing ? "Saving…" : "Adding…") : editing ? "Save changes" : "Add to calendar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why there is nothing to show yet, and what to do about it. */
function NotYet({ app }: { app: App }) {
  const { state } = app;
  const text = !state.googleAvailable
    ? "Google is not switched on for this site yet. Once it is, connect a Google account on the Connections page."
    : !state.connections.google.connected
      ? "Connect a Google account on the Connections page to see its calendar here."
      : "Calendar was not allowed when the Google account was connected. Connect it again and tick Calendar.";
  return (
    <div className="panel">
      <p className="empty" style={{ padding: 18 }}>
        {text} <Link href="/connections#google">Go to Connections</Link>
      </p>
    </div>
  );
}

export default function CalendarPage() {
  const app = useApp();
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<CalendarItem | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  /** The New event form is open, starting at this time. */
  const [making, setMaking] = useState<number | null>(null);
  /** The event whose Change form is open. */
  const [editing, setEditing] = useState<CalendarItem | null>(null);
  // The week's one scrolling box: down through the hours, and sideways on a narrow screen.
  const box = useRef<HTMLDivElement>(null);
  const thisWeek = app ? weekStart(app.now).getTime() : 0;

  // Opens at the current time on this week, and at the start of the working day on another.
  useEffect(() => {
    const x = box.current;
    if (!x || !app) return;
    const hour = offset === 0 ? Math.max(0, app.now.getHours() - 1) : OPEN_AT_HOUR;
    x.scrollTop = hour * HOUR;
    // On a narrow screen the week scrolls sideways: bring today, or the start of the week, into view.
    const today = x.querySelector<HTMLElement>(".cal-dayname.today");
    x.scrollLeft = offset === 0 && today ? Math.max(0, today.offsetLeft - 58) : 0;
    // Only when the week changes, not on every refresh of the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, thisWeek, Boolean(app)]);

  if (!app) return null;
  const { state } = app;
  const ready = state.googleAvailable && state.connections.google.connected && state.googleAllows.calendar;
  const start = dayAfter(new Date(thisWeek), offset * 7);
  const days = weekDays(start);
  const accounts = state.googleAccounts.filter((a) => a.calendar);
  const items = state.calendar.filter((e) => e.accounts.some((a) => !hidden.includes(a)));
  const status = state.jobStatus["calendar-pull"];
  const now = app.now.getTime();
  const allDays = days.map((d) => allDayOn(items, d));
  const anyAllDay = allDays.some((list) => list.length > 0);
  const zone = zoneName();

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Calendar</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {ready
              ? `Your Google ${accounts.length > 1 ? "calendars" : "calendar"}, from last week to three weeks ahead. Times are in your timezone (${zone}). Click an event to see who is in it and the link to join.`
              : "Your Google calendar, week by week, from last week to three weeks ahead."}
          </div>
        </div>
        {ready && (
          <div className="brand-meta">
            {state.googleAllows.addEvents && (
              <button
                className="btn primary"
                onClick={() => {
                  // The next half hour, as Google Calendar does.
                  const next = new Date(now);
                  next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);
                  setMaking(next.getTime());
                }}
              >
                New event
              </button>
            )}
            <span className="muted" style={{ fontSize: 13 }}>
              {status?.lastRunAt ? `Updated ${ago(status.lastRunAt, now)} ago` : "Not read yet"}
            </span>
            <button className="btn" disabled={app.ui.running.includes("calendar-pull")} onClick={() => void runJobNow("calendar-pull")}>
              {app.ui.running.includes("calendar-pull") ? "Reading…" : "Refresh"}
            </button>
          </div>
        )}
      </div>

      {!ready ? (
        <NotYet app={app} />
      ) : (
        <>
          <div className="cal-bar">
            <div className="cal-nav">
              <button className="btn" disabled={offset === 0} onClick={() => setOffset(0)}>
                Today
              </button>
              <button className="btn" aria-label="Previous week" disabled={offset <= -WEEKS_BACK} onClick={() => setOffset(offset - 1)}>
                ‹
              </button>
              <button className="btn" aria-label="Next week" disabled={offset >= WEEKS_AHEAD} onClick={() => setOffset(offset + 1)}>
                ›
              </button>
              <h3 className="cal-title">{weekTitle(start)}</h3>
            </div>
            <Seg
              label="Week"
              value={String(offset)}
              onChange={(v) => setOffset(Number(v))}
              options={Array.from({ length: WEEKS_BACK + WEEKS_AHEAD + 1 }, (_, i): [string, string] => [String(i - WEEKS_BACK), WEEK_NAMES[String(i - WEEKS_BACK)]])}
            />
          </div>

          {accounts.length > 1 && (
            <div className="cal-accounts" role="group" aria-label="Calendars">
              {accounts.map((a, i) => (
                <label key={a.email} style={{ ["--ev" as string]: `var(--cal-${(i % 4) + 1})` }}>
                  <input type="checkbox" checked={!hidden.includes(a.email)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== a.email) : [...hidden, a.email])} />
                  <span className="cal-dot" aria-hidden="true" />
                  {a.email}
                </label>
              ))}
            </div>
          )}

          <div className="cal panel">
            <div className="cal-x" ref={box}>
              <div className="cal-top">
                <div className="cal-row cal-days">
                  <div className="cal-zone">{zone}</div>
                  {days.map((d) => (
                    <div key={d.getTime()} className={`cal-dayname ${sameDay(d, app.now) ? "today" : ""}`}>
                      <span>{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
                      <b>{d.getDate()}</b>
                    </div>
                  ))}
                </div>
                {anyAllDay && (
                  <div className="cal-row cal-allday">
                    <div className="cal-zone">All day</div>
                    {allDays.map((list, i) => (
                      <div key={i} className="cal-allday-cell">
                        {list.map((e) => (
                          <button key={e.id} className={`cal-chip k-${e.kind}`} style={{ ["--ev" as string]: colorOf(app, e) }} onClick={() => setOpen(e)} title={e.title}>
                            {e.title}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="cal-body">
                <div className="cal-row cal-grid" style={{ height: 24 * HOUR }}>
                  <div className="cal-hours">
                    {Array.from({ length: 23 }, (_, h) => (
                      <span key={h} style={{ top: (h + 1) * HOUR }}>
                        {short(new Date(2026, 0, 1, h + 1).getTime())}
                      </span>
                    ))}
                  </div>
                  {days.map((d) => (
                    <div
                      key={d.getTime()}
                      className={`cal-day ${sameDay(d, app.now) ? "today" : ""} ${d.getTime() + 86_400_000 <= now ? "past" : ""}`}
                      style={{ backgroundSize: `100% ${HOUR}px` }}
                      title={state.googleAllows.addEvents ? "Click an empty time to add an event" : undefined}
                      onClick={(e) => {
                        if (!state.googleAllows.addEvents) return;
                        // The half hour that was clicked.
                        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
                        const half = Math.max(0, Math.min(47, Math.floor((y / HOUR) * 2)));
                        setMaking(d.getTime() + half * 30 * 60_000);
                      }}
                    >
                      {layDay(items, d).map((p) => (
                        <EventBlock key={p.item.id} p={p} app={app} onOpen={setOpen} />
                      ))}
                      {sameDay(d, app.now) && (
                        <div
                          className="cal-now"
                          style={{
                            top: ((now - d.getTime()) / 3_600_000) * HOUR,
                          }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          {items.filter((e) => e.at < dayAfter(start, 7).getTime() && e.end > start.getTime()).length === 0 && (
            <p className="muted" style={{ fontSize: 13.5 }}>
              Nothing on {accounts.length > 1 ? "these calendars" : "your calendar"} this week.
            </p>
          )}
        </>
      )}
      {open && (
        <EventDetails
          item={open}
          app={app}
          onClose={() => setOpen(null)}
          onEdit={() => {
            setEditing(open);
            setOpen(null);
          }}
        />
      )}
      {making !== null && <NewEventForm app={app} start={making} onClose={() => setMaking(null)} />}
      {editing && <NewEventForm app={app} start={editing.at} editing={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}
