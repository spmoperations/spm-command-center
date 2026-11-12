// Repeating tasks: the same ticket made again on the same days each week, for the same person
// (see server/repeats.ts). The rules for when, shared by the server, which makes them, and the
// page, which says when the next one comes. Plain code: no AI.

/** Each one is made at 6:00 in the morning, Central European time: CET, and CEST in summer. */
export const REPEAT_ZONE = "Europe/Berlin";
export const REPEAT_HOUR = 6;
export const REPEAT_TIME_NAME = "6:00 CET";

/** The days of the week, Monday 1 to Sunday 7, as ISO counts them. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const WEEKDAY_SHORT: Record<number, string> = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };
const WEEKDAY_OF: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

const zoned = new Intl.DateTimeFormat("en-US", { timeZone: REPEAT_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });

/** The day (YYYY-MM-DD), the day of the week and the minutes since midnight at `now`, in Central European time. */
export function inRepeatZone(now: Date): { day: string; weekday: number; minutes: number } {
  const part = Object.fromEntries(zoned.formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${part.year}-${part.month}-${part.day}`, weekday: WEEKDAY_OF[part.weekday], minutes: Number(part.hour) * 60 + Number(part.minute) };
}

/** The day `n` days after `day`, both YYYY-MM-DD. */
export function dayAfter(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Only the days of the week there are, each once, in order. */
export const cleanDays = (days: unknown): number[] => (Array.isArray(days) ? [...new Set(days.map(Number))].filter((d) => WEEKDAYS.includes(d as (typeof WEEKDAYS)[number])).sort((a, b) => a - b) : []);

/** "Mon and Thu", "Mon, Wed and Fri", "weekdays", "every day". */
export function daysName(days: number[]): string {
  const list = cleanDays(days);
  if (list.length === 7) return "every day";
  if (list.join() === "1,2,3,4,5") return "weekdays";
  const names = list.map((d) => WEEKDAY_SHORT[d]);
  return names.length <= 1 ? (names[0] ?? "no day") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Whether one is to be made now: a day it is on, 6:00 has come, and none was made today. */
export function repeatIsDue(r: { days: number[]; lastDay: string | null; active: boolean }, now: Date): { due: boolean; day: string } {
  const { day, weekday, minutes } = inRepeatZone(now);
  return { due: r.active && cleanDays(r.days).includes(weekday) && minutes >= REPEAT_HOUR * 60 && (r.lastDay === null || r.lastDay < day), day };
}

/**
 * The last day to count as done when one is set up, changed or started again: today once 6:00 has
 * passed, so the first one comes on the next day it is on, at 6:00, and not straight away.
 */
export function heldBackTo(lastDay: string | null, now: Date): string | null {
  const { day, minutes } = inRepeatZone(now);
  if (minutes < REPEAT_HOUR * 60) return lastDay;
  return lastDay !== null && lastDay > day ? lastDay : day;
}

/** The day the next one is made (YYYY-MM-DD, Central European time), or null while it is paused. */
export function nextRepeatDay(r: { days: number[]; lastDay: string | null; active: boolean }, now: Date): string | null {
  const days = cleanDays(r.days);
  if (!r.active || !days.length) return null;
  const { day, weekday } = inRepeatZone(now);
  for (let k = 0; k <= 7; k++) {
    const d = dayAfter(day, k);
    if (days.includes(((weekday - 1 + k) % 7) + 1) && (r.lastDay === null || r.lastDay < d)) return d;
  }
  return null;
}
