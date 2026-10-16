"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Seg } from "@/components/bits";
import {
  allDayOn,
  dayAfter,
  layDay,
  sameDay,
  weekDays,
  weekStart,
  weekTitle,
  WEEKS_AHEAD,
  WEEKS_BACK,
  type Placed,
} from "@/core/calendar";
import { ago } from "@/core/dates";
import type { CalendarItem } from "@/core/types";
import { runJobNow, useApp, type App } from "@/store/store";

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
const zoneName = () =>
  new Date()
    .toLocaleTimeString("en-US", { timeZoneName: "short" })
    .split(" ")
    .pop() ?? "";

/** Each connected account has its own color, in the order the accounts were connected. */
const colorOf = (app: App, item: CalendarItem) => {
  const index = app.state.googleAccounts.findIndex((a) =>
    item.accounts.includes(a.email),
  );
  return `var(--cal-${(Math.max(0, index) % 4) + 1})`;
};

function EventBlock({
  p,
  app,
  onOpen,
}: {
  p: Placed;
  app: App;
  onOpen(item: CalendarItem): void;
}) {
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
      onClick={() => onOpen(e)}
      title={`${e.title}, ${clock(e.at)} – ${clock(e.end)}`}
    >
      <span className="cal-ev-title">{e.title}</span>
      <span className="cal-ev-time">
        {small
          ? `, ${short(e.at)}`
          : `${p.fromBefore ? "…" : clock(e.at)} – ${p.goesOn ? "…" : clock(e.end)}`}
      </span>
    </button>
  );
}

/** The details of one event, over the page. Esc or a click outside closes it. */
function EventDetails({
  item,
  app,
  onClose,
}: {
  item: CalendarItem;
  app: App;
  onClose(): void;
}) {
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
        return lastMs > item.at
          ? `${first} – ${new Date(lastMs).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}, all day`
          : `${first}, all day`;
      })()
    : `${day(item.at)} · ${clock(item.at)} – ${new Date(item.end).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })}${sameDay(new Date(item.at), new Date(item.end)) ? "" : ` (${day(item.end)})`}`;
  return (
    <div className="cal-modal" role="presentation" onClick={onClose}>
      <div
        className="cal-card panel"
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        onClick={(e) => e.stopPropagation()}
        style={{ ["--ev" as string]: colorOf(app, item) }}
      >
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
          {item.response && item.kind === "meeting" && (
            <div>
              <span className="label">Your answer</span>{" "}
              {ANSWER[item.response] ?? item.response}
            </div>
          )}
          {app.state.googleAccounts.length > 1 && (
            <div className="muted" style={{ fontSize: 13 }}>
              On {item.accounts.join(" and ")}
            </div>
          )}
        </div>
        <div className="cal-card-foot">
          {item.calendarLink && (
            <a
              className="btn"
              href={item.calendarLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Google Calendar ↗
            </a>
          )}
          {item.link && (
            <a
              className="btn primary"
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              Join{" "}
              {item.where && !/^online$/i.test(item.where)
                ? item.where
                : "the call"}{" "}
              ↗
            </a>
          )}
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
  // The week's one scrolling box: down through the hours, and sideways on a narrow screen.
  const box = useRef<HTMLDivElement>(null);
  const thisWeek = app ? weekStart(app.now).getTime() : 0;

  // Opens at the current time on this week, and at the start of the working day on another.
  useEffect(() => {
    const x = box.current;
    if (!x || !app) return;
    const hour =
      offset === 0 ? Math.max(0, app.now.getHours() - 1) : OPEN_AT_HOUR;
    x.scrollTop = hour * HOUR;
    // On a narrow screen the week scrolls sideways: bring today, or the start of the week, into view.
    const today = x.querySelector<HTMLElement>(".cal-dayname.today");
    x.scrollLeft =
      offset === 0 && today ? Math.max(0, today.offsetLeft - 58) : 0;
    // Only when the week changes, not on every refresh of the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, thisWeek, Boolean(app)]);

  if (!app) return null;
  const { state } = app;
  const ready =
    state.googleAvailable &&
    state.connections.google.connected &&
    state.googleAllows.calendar;
  const start = dayAfter(new Date(thisWeek), offset * 7);
  const days = weekDays(start);
  const accounts = state.googleAccounts.filter((a) => a.calendar);
  const items = state.calendar.filter((e) =>
    e.accounts.some((a) => !hidden.includes(a)),
  );
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
            <span className="muted" style={{ fontSize: 13 }}>
              {status?.lastRunAt
                ? `Updated ${ago(status.lastRunAt, now)} ago`
                : "Not read yet"}
            </span>
            <button
              className="btn"
              disabled={app.ui.running.includes("calendar-pull")}
              onClick={() => void runJobNow("calendar-pull")}
            >
              {app.ui.running.includes("calendar-pull")
                ? "Reading…"
                : "Refresh"}
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
              <button
                className="btn"
                disabled={offset === 0}
                onClick={() => setOffset(0)}
              >
                Today
              </button>
              <button
                className="btn"
                aria-label="Previous week"
                disabled={offset <= -WEEKS_BACK}
                onClick={() => setOffset(offset - 1)}
              >
                ‹
              </button>
              <button
                className="btn"
                aria-label="Next week"
                disabled={offset >= WEEKS_AHEAD}
                onClick={() => setOffset(offset + 1)}
              >
                ›
              </button>
              <h3 className="cal-title">{weekTitle(start)}</h3>
            </div>
            <Seg
              label="Week"
              value={String(offset)}
              onChange={(v) => setOffset(Number(v))}
              options={Array.from(
                { length: WEEKS_BACK + WEEKS_AHEAD + 1 },
                (_, i): [string, string] => [
                  String(i - WEEKS_BACK),
                  WEEK_NAMES[String(i - WEEKS_BACK)],
                ],
              )}
            />
          </div>

          {accounts.length > 1 && (
            <div className="cal-accounts" role="group" aria-label="Calendars">
              {accounts.map((a, i) => (
                <label
                  key={a.email}
                  style={{ ["--ev" as string]: `var(--cal-${(i % 4) + 1})` }}
                >
                  <input
                    type="checkbox"
                    checked={!hidden.includes(a.email)}
                    onChange={(e) =>
                      setHidden(
                        e.target.checked
                          ? hidden.filter((h) => h !== a.email)
                          : [...hidden, a.email],
                      )
                    }
                  />
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
                    <div
                      key={d.getTime()}
                      className={`cal-dayname ${sameDay(d, app.now) ? "today" : ""}`}
                    >
                      <span>
                        {d.toLocaleDateString("en-US", { weekday: "short" })}
                      </span>
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
                          <button
                            key={e.id}
                            className={`cal-chip k-${e.kind}`}
                            style={{ ["--ev" as string]: colorOf(app, e) }}
                            onClick={() => setOpen(e)}
                            title={e.title}
                          >
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
                    >
                      {layDay(items, d).map((p) => (
                        <EventBlock
                          key={p.item.id}
                          p={p}
                          app={app}
                          onOpen={setOpen}
                        />
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
          {items.filter(
            (e) =>
              e.at < dayAfter(start, 7).getTime() && e.end > start.getTime(),
          ).length === 0 && (
            <p className="muted" style={{ fontSize: 13.5 }}>
              Nothing on{" "}
              {accounts.length > 1 ? "these calendars" : "your calendar"} this
              week.
            </p>
          )}
        </>
      )}
      {open && (
        <EventDetails item={open} app={app} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}
