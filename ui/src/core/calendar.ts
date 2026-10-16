// The week view of the Calendar tab: which days a week holds, and where each event sits in
// it. Plain logic, in the timezone of whoever is looking.
import type { CalendarItem } from "./types";

/** Weeks start on Sunday, as Google Calendar's do in the US. */
export const WEEK_STARTS_ON = 0;
/** How far the Calendar tab goes: last week, this week and the next three. */
export const WEEKS_BACK = 1;
export const WEEKS_AHEAD = 3;

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/** Midnight that starts the day `n` days after `day`, local time. Daylight saving changes are allowed for. */
export const dayAfter = (day: Date, n: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);

/** Midnight that starts the week holding `day`. */
export function weekStart(day: Date): Date {
  const back = (day.getDay() - WEEK_STARTS_ON + 7) % 7;
  return dayAfter(day, -back);
}

/** The seven days of the week that starts `start`. */
export const weekDays = (start: Date) => Array.from({ length: 7 }, (_, i) => dayAfter(start, i));

export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "2026-10-15" for a local day. */
const localKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** "2026-10-15" for an all-day event's bound, which is kept as midnight UTC. */
const utcKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The all-day events on a day. */
export const allDayOn = (items: CalendarItem[], day: Date) =>
  items.filter((e) => e.allDay && utcKey(e.at) <= localKey(day) && localKey(day) < utcKey(e.end));

/** "Oct 11 – 17, 2026", "Sep 27 – Oct 3, 2026" or "Dec 27, 2026 – Jan 2, 2027". */
export function weekTitle(start: Date): string {
  const end = dayAfter(start, 6);
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  if (start.getFullYear() !== end.getFullYear()) {
    const full = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${full(start)} – ${full(end)}`;
  }
  const to = start.getMonth() === end.getMonth() ? `${end.getDate()}` : `${month(end)} ${end.getDate()}`;
  return `${month(start)} ${start.getDate()} – ${to}, ${end.getFullYear()}`;
}

/** An event's place on one day: minutes from midnight, and its column among the events it overlaps. */
export interface Placed {
  item: CalendarItem;
  top: number;
  height: number;
  col: number;
  cols: number;
  /** It began before this day, or goes on after it. */
  fromBefore: boolean;
  goesOn: boolean;
}

/** A meeting with no length still gets a line to click. */
const SHORTEST = 15;

/**
 * The timed events on a day, placed for the grid. Events that overlap share the width side by
 * side, as Google Calendar does: each group of overlapping events gets as many columns as it
 * needs, and each event takes the first column that is free when it starts.
 */
export function layDay(items: CalendarItem[], day: Date): Placed[] {
  const from = day.getTime();
  const to = dayAfter(day, 1).getTime();
  const parts = items
    .filter((e) => !e.allDay && e.at < to && (e.end > from || (e.end === e.at && e.at >= from)))
    .map((e) => {
      const top = Math.max(0, Math.round((Math.max(e.at, from) - from) / MINUTE));
      const bottom = Math.min(DAY_MINUTES, Math.round((Math.min(e.end, to) - from) / MINUTE));
      return { item: e, top, height: Math.max(SHORTEST, bottom - top), col: 0, cols: 1, fromBefore: e.at < from, goesOn: e.end > to };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  let group: Placed[] = [];
  let groupEnd = -1;
  const columnsEnd: number[] = [];
  const close = () => {
    for (const p of group) p.cols = columnsEnd.length;
    group = [];
    columnsEnd.length = 0;
  };
  for (const p of parts) {
    if (p.top >= groupEnd) close();
    let col = columnsEnd.findIndex((end) => end <= p.top);
    if (col === -1) col = columnsEnd.push(0) - 1;
    columnsEnd[col] = p.top + p.height;
    p.col = col;
    group.push(p);
    groupEnd = Math.max(groupEnd, p.top + p.height);
  }
  close();
  return parts;
}
