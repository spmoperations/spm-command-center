"use client";

import { useState } from "react";
import { Pill } from "@/components/bits";
import { daysInMonth } from "@/core/dates";
import { elapsedDays, evalMetric, formatValue, STATUS_TEXT, todayLogged, type MetricEval, type MonthClock } from "@/core/targets";
import type { Metric } from "@/core/types";
import { saveLogs, saveTargets, useApp, type App } from "@/store/store";

const COLOR = { ok: "var(--good)", risk: "var(--warn)", behind: "var(--bad)" };

/** Running total against the straight line to the target. */
function Spark({ e, dim }: { e: MetricEval; dim: number }) {
  const W = 300, H = 84, pl = 4, pr = 4, pt = 8, pb = 16;
  const last = e.series[e.series.length - 1] ?? 0;
  const max = Math.max(e.metric.target, last) * 1.05 || 1;
  const x = (d: number) => pl + (d / dim) * (W - pl - pr);
  const y = (v: number) => pt + (1 - v / max) * (H - pt - pb);
  const points = e.series.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`);
  const color = COLOR[e.status];
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative ${e.metric.name} versus target pace`}>
      <line x1={x(0)} y1={y(e.metric.target)} x2={x(dim)} y2={y(e.metric.target)} stroke="var(--line)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <line x1={x(0)} y1={y(0)} x2={x(dim)} y2={y(0)} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
      <line x1={x(0)} y1={y(0)} x2={x(dim)} y2={y(e.metric.target)} stroke="var(--muted)" strokeWidth="1.25" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      {points.length > 0 && (
        <>
          <path d={`M${x(0)},${y(0)} L${points.join(" L")} L${x(e.series.length)},${y(0)} Z`} fill={color} opacity="0.13" />
          <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          <circle cx={x(e.series.length)} cy={y(last)} r="3.5" fill={color} />
        </>
      )}
    </svg>
  );
}

function LogToday({ app, clock, parents }: { app: App; clock: MonthClock; parents: Metric[] }) {
  const { state, now } = app;
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(state.metrics.filter((m) => !m.sum).map((m) => [m.id, String(state.logs[m.id]?.[clock.day] ?? "")])),
  );
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        saveLogs(clock.day, Object.fromEntries(Object.entries(values).map(([id, v]) => [id, v === "" ? null : Number(v)])));
      }}
    >
      <div className="panel-head">
        <h3>Log today · {now.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</h3>
        <button className="btn primary" type="submit">
          Save today
        </button>
      </div>
      <div className="log-grid">
        {parents.map((p) => {
          const fields = [...(p.sum ? [] : [p]), ...state.metrics.filter((k) => k.parent === p.id && !k.sum)];
          return [
            <div className="grp label" key={p.id}>
              {p.name}
            </div>,
            ...fields.map((f) => (
              <label key={f.id} htmlFor={`log-${f.id}`}>
                {f.name}
                {f.unit === "$" ? " ($)" : ""}
                <input
                  className="f num"
                  type="number"
                  min={0}
                  step={f.unit === "$" ? 50 : 1}
                  id={`log-${f.id}`}
                  placeholder="0"
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                />
              </label>
            )),
          ];
        })}
      </div>
    </form>
  );
}

function EditTargets({ app }: { app: App }) {
  const editable = app.state.metrics.filter((m) => !m.sum);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((m) => [m.id, String(m.target)])));
  return (
    <form
      className="panel"
      style={{ marginTop: 16 }}
      onSubmit={(e) => {
        e.preventDefault();
        saveTargets(Object.fromEntries(Object.entries(values).map(([id, v]) => [id, Number(v)])));
      }}
    >
      <div className="panel-head">
        <h3>Monthly targets</h3>
        <button className="btn primary" type="submit">
          Save targets
        </button>
      </div>
      <p className="set-intro">The number each one should reach by the end of the month. A target made up of parts is the total of its parts.</p>
      <div className="tgt-edit">
        {editable.map((m) => (
          <label key={m.id} htmlFor={`target-${m.id}`}>
            {m.name}
            {m.unit === "$" ? " ($)" : ""}
            <input
              className="f num"
              type="number"
              min={1}
              id={`target-${m.id}`}
              value={values[m.id] ?? ""}
              onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
            />
          </label>
        ))}
      </div>
    </form>
  );
}

export default function TargetsPage() {
  const app = useApp();
  if (!app) return null;
  const { state, now } = app;
  const clock: MonthClock = { day: now.getDate(), dim: daysInMonth(now) };
  const all = state.metrics.map((m) => evalMetric(m, state.metrics, state.logs, clock));
  const parents = all.filter((e) => !e.metric.parent);
  const lagging = all.filter((e) => e.status !== "ok").sort((a, b) => a.ratio - b.ratio);
  const elapsed = elapsedDays(state.metrics, state.logs, clock);
  const monthName = now.toLocaleString("en-US", { month: "long" });

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>{monthName} targets</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Day {elapsed} of {clock.dim} counted
            {todayLogged(state.metrics, state.logs, clock) ? ", including today" : ". Log today's numbers below to include today"}. The marker and dashed line show where you should be by now.
          </div>
        </div>
      </div>

      <div className="tgt-grid">
        {parents.map((e) => {
          const diff = e.actual - e.expected;
          return (
            <div className="panel tgt" key={e.metric.id}>
              <div className="tgt-top">
                <div>
                  <div className="label">{monthName} target</div>
                  <h3>{e.metric.name}</h3>
                </div>
                <Pill tone={`s-${e.status}`}>{STATUS_TEXT[e.status]}</Pill>
              </div>
              <div className="big">
                {formatValue(e.actual, e.metric.unit)} <small>of {formatValue(e.metric.target, e.metric.unit)}</small>
              </div>
              <Spark e={e} dim={clock.dim} />
              <div className="tgt-stats">
                <div>
                  <div className="label">vs. pace</div>
                  <div className="v" style={{ color: diff >= 0 ? "var(--good)" : "var(--bad)" }}>
                    {diff >= 0 ? "+" : "−"}
                    {formatValue(Math.abs(diff), e.metric.unit)}
                  </div>
                </div>
                <div>
                  <div className="label">Projected</div>
                  <div className="v">{formatValue(e.projected, e.metric.unit)}</div>
                </div>
                <div>
                  <div className="label">Need / day</div>
                  <div className="v">{e.remaining ? formatValue(e.perDayNeeded, e.metric.unit) : "—"}</div>
                </div>
              </div>
              <ul className="drivers">
                {all
                  .filter((k) => k.metric.parent === e.metric.id)
                  .map((k) => (
                    <li key={k.metric.id}>
                      <span>{k.metric.name}</span>
                      <span className="num muted" style={{ fontSize: 12.5 }}>
                        {formatValue(k.actual, k.metric.unit)} / {formatValue(k.metric.target, k.metric.unit)}
                      </span>
                      <Pill tone={`s-${k.status}`}>{STATUS_TEXT[k.status]}</Pill>
                    </li>
                  ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="two-col">
        <div className="panel">
          <div className="panel-head">
            <h3>What is lagging</h3>
            <span className="muted" style={{ fontSize: 13 }}>
              Worst first
            </span>
          </div>
          {lagging.length > 0 ? (
            <ul className="lag">
              {lagging.map((e) => {
                const parent = state.metrics.find((p) => p.id === e.metric.parent)?.name ?? "Monthly target";
                return (
                  <li key={e.metric.id}>
                    <Pill tone={`s-${e.status}`}>{STATUS_TEXT[e.status]}</Pill>
                    <div style={{ minWidth: 0 }}>
                      <div className="what">
                        {e.metric.name}{" "}
                        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                          · {parent}
                        </span>
                      </div>
                      <div className="why">
                        {e.remaining > 0
                          ? `Running ${formatValue(e.perDayRun, e.metric.unit)}/day. Needs ${formatValue(e.perDayNeeded, e.metric.unit)}/day for the last ${e.remaining} ${e.remaining === 1 ? "day" : "days"}.`
                          : `Month closed at ${formatValue(e.actual, e.metric.unit)}.`}
                      </div>
                    </div>
                    <div className="gap" style={{ color: "var(--bad)" }}>
                      {Math.round((e.ratio - 1) * 100)}%
                      <div className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>
                        projected vs. target
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="empty">Every indicator is on pace.</p>
          )}
        </div>
        <LogToday app={app} clock={clock} parents={parents.map((e) => e.metric)} />
      </div>

      <EditTargets app={app} />
    </section>
  );
}
