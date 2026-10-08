export const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as YYYY-MM-DD. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseDay = (iso: string) => new Date(iso + "T00:00");

export const monthKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const daysInMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

export function addDays(from: Date, n: number): string {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

/** Monday of the week `d` falls in. */
export function weekStart(d: Date): string {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return isoDay(s);
}

export const daysBetween = (a: string, b: string) =>
  Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);

export type DueTone = "" | "today" | "over";

export function dueLabel(iso: string, today: string): { text: string; tone: DueTone } {
  const diff = daysBetween(today, iso);
  if (diff === 0) return { text: "Today", tone: "today" };
  if (diff === 1) return { text: "Tomorrow", tone: "" };
  if (diff < 0) return { text: `${-diff}d overdue`, tone: "over" };
  if (diff < 7) return { text: parseDay(iso).toLocaleDateString("en-US", { weekday: "short" }), tone: "" };
  return { text: shortDate(iso), tone: "" };
}

export const shortDate = (iso: string) =>
  parseDay(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "22m", "3h", "2d" since `ts`. */
export function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function stamp(ts: number, now: Date): string {
  const d = new Date(ts);
  const t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const days = daysBetween(isoDay(d), isoDay(now));
  if (days <= 0) return t;
  if (days === 1) return `Yesterday ${t}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${t}`;
}
