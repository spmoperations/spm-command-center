"use client";

import { useState } from "react";
import { DEPTS, LINE_NAME, PRIORITY_NAME, SOURCE_NAME, SOURCES } from "@/core/config";
import { describeInterval, JOBS, jobById, type Connection } from "@/core/jobs";
import { ruleHits } from "@/core/rules";
import type { JobSetting, Line, Person, Priority, Rule, Source } from "@/core/types";
import {
  addHandle, addPerson, addRule, clearManualPriorities, deleteRule, moveRule, removeHandle, removePerson,
  setJobEnabled, setJobInterval, toast, togglePersonDept, useApp, type App, type RuleKind,
} from "@/store/store";

// Nothing is connected yet. Each of these switches on when its key or login arrives.
const CONNECTIONS: { id: Connection; name: string; what: string; waiting: string }[] = [
  { id: "slack", name: "Slack", what: "Reads your messages and sends your replies from your own account.", waiting: "Waiting for Jeremy's Slack token" },
  { id: "telegram", name: "Telegram", what: "Reads the chats you choose.", waiting: "Jeremy logs in once the dashboard is live" },
  { id: "fathom", name: "Fathom", what: "Your recorded calls with notes, transcript and action items.", waiting: "Waiting for the Fathom API key" },
  { id: "ai", name: "AI", what: "Finds the tasks in new messages. Nothing else uses AI.", waiting: "Waiting for an AI API key" },
];
const CONNECTION_NAME = Object.fromEntries(CONNECTIONS.map((c) => [c.id, c.name])) as Record<Connection, string>;

function Connections() {
  return (
    <div className="panel set-sec" id="connections">
      <div className="panel-head">
        <h3>Connections</h3>
      </div>
      <p className="set-intro">Where your messages and calls come from. Until these are connected, the dashboard shows sample data.</p>
      <ul className="conn">
        {CONNECTIONS.map((c) => (
          <li key={c.id}>
            <div>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              <div className="what">{c.what}</div>
            </div>
            <span className="chip" title={c.waiting}>
              Not connected
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntervalInput({ setting }: { setting: JobSetting }) {
  const job = jobById(setting.id);
  const [value, setValue] = useState(String(setting.intervalMin));
  const commit = () => {
    const minutes = Number(value);
    if (value.trim() === "" || !Number.isFinite(minutes)) return setValue(String(setting.intervalMin));
    if (minutes < job.minMin) toast(`${job.name}: the fastest allowed is every ${job.minMin} minutes`);
    setJobInterval(setting.id, minutes);
  };
  return (
    <span className="interval">
      Every
      <input className="f num" type="number" min={job.minMin} value={value} aria-label={`Minutes between runs: ${job.name}`} onChange={(e) => setValue(e.target.value)} onBlur={commit} />
      min
    </span>
  );
}

function Timers({ app }: { app: App }) {
  return (
    <div className="panel set-sec" id="timers">
      <div className="panel-head">
        <h3>Timers</h3>
      </div>
      <p className="set-intro">
        Each check is its own small program with its own timer. Change how often it runs, or switch it off. Every timer has a fastest allowed value, so a check can never run often enough to get blocked by Slack, Telegram or Fathom.
      </p>
      <div className="table-scroll">
        <table className="set">
          <thead>
            <tr>
              <th>What it does</th>
              <th>Shows up in</th>
              <th>How often</th>
              <th>Fastest</th>
              <th>Uses AI</th>
              <th>On</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {JOBS.map((job) => {
              const setting = app.state.jobs.find((j) => j.id === job.id) ?? { id: job.id, intervalMin: job.defaultMin, enabled: true };
              return (
                <tr key={job.id}>
                  <td style={{ fontWeight: 600 }}>{job.name}</td>
                  <td>{job.tab}</td>
                  {/* Keyed by the saved value, so the field shows the clamped number after a save. */}
                  <td>{job.follows ? <span className="waiting">After each message check</span> : <IntervalInput key={setting.intervalMin} setting={setting} />}</td>
                  <td className="num">{job.follows ? "–" : describeInterval(job.minMin)}</td>
                  <td>{job.usesAI ? <strong>Yes</strong> : "No"}</td>
                  <td>
                    <input type="checkbox" checked={setting.enabled} aria-label={`${job.name}: on`} onChange={(e) => setJobEnabled(job.id, e.target.checked)} />
                  </td>
                  <td>
                    <span className="waiting">{!setting.enabled ? "Switched off" : job.needs ? `Waiting for ${CONNECTION_NAME[job.needs]}` : "Ready"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PersonRow({ p }: { p: Person }) {
  const [handle, setHandle] = useState("");
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{p.name}</div>
        <div className="muted" style={{ fontSize: 13 }}>
          {p.role}
        </div>
      </td>
      <td>
        <div className="tagset">
          {DEPTS.map((d) => (
            <button key={d} className="deptchip" aria-pressed={p.depts.includes(d)} onClick={() => togglePersonDept(p.id, d)}>
              {d}
            </button>
          ))}
        </div>
      </td>
      <td>
        <div className="tagset">
          {p.handles.map((h, k) => (
            <span className="tag" key={h}>
              {h}
              <button aria-label={`Remove ${h}`} onClick={() => removeHandle(p.id, k)}>
                ×
              </button>
            </span>
          ))}
          <form
            className="tagadd"
            onSubmit={(e) => {
              e.preventDefault();
              if (!handle.trim()) return;
              addHandle(p.id, handle.trim());
              setHandle("");
            }}
          >
            <input className="f" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="Add responsibility" aria-label={`Add responsibility for ${p.name}`} maxLength={40} />
            <button className="btn" type="submit">
              Add
            </button>
          </form>
        </div>
      </td>
      <td style={{ textAlign: "right" }}>
        <button className="iconbtn del" aria-label={`Remove ${p.name}`} onClick={() => removePerson(p.id)}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function Team({ app }: { app: App }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [dept, setDept] = useState<string>("Operations");
  const [handles, setHandles] = useState("");
  return (
    <div className="panel set-sec" id="team">
      <div className="panel-head">
        <h3>Team and responsibilities</h3>
      </div>
      <p className="set-intro">
        Who could own which work. When you delegate a task, people in its department are offered first, and anyone whose responsibilities match the task is marked as the best fit.
      </p>
      <div className="table-scroll">
        <table className="set">
          <thead>
            <tr>
              <th>Person</th>
              <th>Departments</th>
              <th>Can be responsible for</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {app.state.team.map((p) => (
              <PersonRow key={p.id} p={p} />
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="set-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          addPerson({ name: name.trim(), role: role.trim() || "Team member", depts: [dept], handles: handles.split(",").map((x) => x.trim()).filter(Boolean) });
          setName("");
          setRole("");
          setHandles("");
        }}
      >
        <input className="f" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required aria-label="Name" maxLength={60} />
        <input className="f" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" aria-label="Role" maxLength={60} />
        <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
          {DEPTS.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <input className="f" value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="Responsibilities, comma separated" aria-label="Responsibilities" maxLength={200} />
        <button className="btn primary" type="submit">
          Add person
        </button>
      </form>
    </div>
  );
}

const SOURCE_LABEL: Record<Source | "any", string> = { any: "Any app", ...SOURCE_NAME };
const WHEN_LABEL: Record<Rule["when"], string> = {
  tagged: "You are tagged",
  direct: "Direct message",
  ctx: "Channel or chat",
  from: "Person",
  any: "Anything",
};
const OP_LABEL: Record<Rule["op"], string> = { is: "is", starts: "starts with", contains: "contains" };

function Condition({ r }: { r: Rule }) {
  if (r.when === "tagged") return <>you are tagged</>;
  if (r.when === "direct") return <>a direct message</>;
  if (r.when === "any") return <>any message</>;
  return (
    <>
      {WHEN_LABEL[r.when].toLowerCase()} {OP_LABEL[r.op]} <code>{r.value}</code>
    </>
  );
}

function RuleList<T extends string>({ app, kind, id, title, intro, outcomes, outcomeOf, makeOutcome, footer }: {
  app: App;
  kind: RuleKind;
  id: string;
  title: string;
  intro: string;
  /** What a rule can set, as [value, label]. */
  outcomes: [T, string][];
  outcomeOf(r: Rule): string;
  makeOutcome(value: T): Partial<Rule>;
  footer?: React.ReactNode;
}) {
  const rules = app.state[kind];
  const hits = ruleHits(rules, app.state.inbox);
  const [source, setSource] = useState<Source | "any">("slack");
  const [when, setWhen] = useState<Rule["when"]>("ctx");
  const [op, setOp] = useState<Rule["op"]>("starts");
  const [value, setValue] = useState("");
  const [outcome, setOutcome] = useState<T>(outcomes[0][0]);
  const needsText = when === "ctx" || when === "from";

  return (
    <div className="panel set-sec" id={id}>
      <div className="panel-head">
        <h3>{title}</h3>
        {footer}
      </div>
      <p className="set-intro">{intro}</p>
      <ol className="rules">
        {rules.map((r, k) => (
          <li key={r.id}>
            <div className="when">
              {SOURCE_LABEL[r.source]}: <Condition r={r} />
              <span className="arrow">→</span>
              <strong>{outcomeOf(r)}</strong>
            </div>
            <span className="hits">
              {hits[r.id]} {hits[r.id] === 1 ? "chat" : "chats"}
            </span>
            <span style={{ display: "flex", gap: 4 }}>
              <button className="iconbtn" disabled={k === 0} aria-label="Move up" onClick={() => moveRule(kind, r.id, -1)}>
                ↑
              </button>
              <button className="iconbtn" disabled={k === rules.length - 1} aria-label="Move down" onClick={() => moveRule(kind, r.id, 1)}>
                ↓
              </button>
            </span>
            <button className="iconbtn del" aria-label="Delete rule" onClick={() => deleteRule(kind, r.id)}>
              Delete
            </button>
          </li>
        ))}
      </ol>
      <form
        className="rule-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (needsText && !value.trim()) return toast("Add what the rule should match");
          addRule(kind, { source, when, op, value: needsText ? value.trim() : "", ...makeOutcome(outcome) });
          setValue("");
        }}
      >
        <select className="f" value={source} aria-label="App" onChange={(e) => setSource(e.target.value as Source | "any")}>
          {(["any", ...SOURCES] as const).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <select className="f" value={when} aria-label="Match on" onChange={(e) => setWhen(e.target.value as Rule["when"])}>
          {(Object.keys(WHEN_LABEL) as Rule["when"][]).map((w) => (
            <option key={w} value={w}>
              {WHEN_LABEL[w]}
            </option>
          ))}
        </select>
        <select className="f" value={op} aria-label="How to match" disabled={!needsText} onChange={(e) => setOp(e.target.value as Rule["op"])}>
          {(Object.keys(OP_LABEL) as Rule["op"][]).map((o) => (
            <option key={o} value={o}>
              {OP_LABEL[o]}
            </option>
          ))}
        </select>
        <input className="f" value={value} disabled={!needsText} onChange={(e) => setValue(e.target.value)} placeholder="e.g. #client- or a name" aria-label="Value" maxLength={80} />
        <select className="f" value={outcome} aria-label="Set to" onChange={(e) => setOutcome(e.target.value as T)}>
          {outcomes.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <button className="btn primary" type="submit">
          Add rule
        </button>
      </form>
    </div>
  );
}

export default function SettingsPage() {
  const app = useApp();
  if (!app) return null;
  const manual = app.state.inbox.filter((c) => c.manualPri).length;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Settings</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            What is connected, how often it checks, and the rules the dashboard follows.
          </div>
        </div>
      </div>
      <nav className="set-nav" aria-label="Settings sections">
        <a href="#connections">Connections</a>
        <a href="#timers">Timers</a>
        <a href="#team">Team</a>
        <a href="#urgent">What is urgent</a>
        <a href="#labels">Agency or Consulting</a>
      </nav>

      <Connections />
      <Timers app={app} />
      <Team app={app} />

      <RuleList<Priority>
        app={app}
        kind="priorityRules"
        id="urgent"
        title="What is urgent"
        intro="Rules that decide how urgent a message is. They run top to bottom and the first match wins. A message that matches no rule is Low. A priority you set by hand in the inbox keeps your choice."
        outcomes={[["high", "High"], ["mid", "Mid"], ["low", "Low"]]}
        outcomeOf={(r) => PRIORITY_NAME[r.pri ?? "low"]}
        makeOutcome={(pri) => ({ pri })}
        footer={
          manual > 0 ? (
            <button className="linkbtn" onClick={clearManualPriorities}>
              Reset {manual} hand-set {manual === 1 ? "priority" : "priorities"} to the rules
            </button>
          ) : null
        }
      />

      <RuleList<Line>
        app={app}
        kind="labelRules"
        id="labels"
        title="Agency or Consulting"
        intro="Rules that label a chat as Agency or Consulting. They run top to bottom and the first match wins. A chat that matches no rule is Agency."
        outcomes={[["consulting", "Consulting"], ["agency", "Agency"]]}
        outcomeOf={(r) => LINE_NAME[r.line ?? "agency"]}
        makeOutcome={(line) => ({ line })}
      />
    </section>
  );
}
