// Monthly target math: where each number stands against the pace needed to hit its target.
import type { Metric } from "./types";

export type Logs = Record<string, Record<number, number>>;
export type PaceStatus = "ok" | "risk" | "behind";

export const STATUS_TEXT: Record<PaceStatus, string> = { ok: "On track", risk: "At risk", behind: "Behind" };

export interface MonthClock {
  /** Day of the month today. */
  day: number;
  /** Days in this month. */
  dim: number;
}

/** Value per day for a metric. A sum metric adds up its children. */
export function daily(metric: Metric, metrics: Metric[], logs: Logs, clock: MonthClock): Record<number, number> {
  if (!metric.sum) return logs[metric.id] ?? {};
  const kids = metrics.filter((k) => k.parent === metric.id);
  const out: Record<number, number> = {};
  for (let d = 1; d <= clock.day; d++) {
    const values = kids.map((k) => logs[k.id]?.[d]);
    if (values.some((v) => v != null)) out[d] = values.reduce<number>((a, v) => a + (v ?? 0), 0);
  }
  return out;
}

export const todayLogged = (metrics: Metric[], logs: Logs, clock: MonthClock) =>
  metrics.some((m) => !m.sum && logs[m.id]?.[clock.day] != null);

/** Today counts only once today's numbers are logged. */
export const elapsedDays = (metrics: Metric[], logs: Logs, clock: MonthClock) =>
  todayLogged(metrics, logs, clock) ? clock.day : clock.day - 1;

export interface MetricEval {
  metric: Metric;
  actual: number;
  /** Where the number should be by now to hit the target. */
  expected: number;
  /** Month-end value at the current daily rate. */
  projected: number;
  ratio: number;
  status: PaceStatus;
  remaining: number;
  perDayNeeded: number;
  perDayRun: number;
  /** Running total per elapsed day. */
  series: number[];
  elapsed: number;
}

export function evalMetric(metric: Metric, metrics: Metric[], logs: Logs, clock: MonthClock): MetricEval {
  const perDay = daily(metric, metrics, logs, clock);
  const elapsed = elapsedDays(metrics, logs, clock);
  let actual = 0;
  const series: number[] = [];
  for (let d = 1; d <= elapsed; d++) {
    actual += perDay[d] ?? 0;
    series.push(actual);
  }
  const expected = (metric.target * elapsed) / clock.dim;
  const projected = elapsed > 0 ? (actual / elapsed) * clock.dim : 0;
  const ratio = elapsed > 0 && metric.target > 0 ? projected / metric.target : 1;
  const status: PaceStatus = ratio >= 1 ? "ok" : ratio >= 0.9 ? "risk" : "behind";
  const remaining = clock.dim - elapsed;
  return {
    metric,
    actual,
    expected,
    projected,
    ratio,
    status,
    remaining,
    perDayNeeded: remaining > 0 ? Math.max(0, (metric.target - actual) / remaining) : 0,
    perDayRun: elapsed > 0 ? actual / elapsed : 0,
    series,
    elapsed,
  };
}

export function formatValue(v: number, unit: Metric["unit"]): string {
  if (unit !== "$") return Math.round(v).toLocaleString("en-US");
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k`;
  return `$${Math.round(v)}`;
}
