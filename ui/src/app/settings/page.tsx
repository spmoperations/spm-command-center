"use client";

import Link from "next/link";
import { useState } from "react";
import { Combo } from "@/components/Combo";
import { DEPARTMENTS, DEPTS, LINE_NAME, LIVE_SOURCES, PERSONAL_SIDE, PRIORITY_NAME, SOURCE_NAME } from "@/core/config";
import { ago } from "@/core/dates";
import { describeInterval, jobById, LIVE_JOBS, type Connection } from "@/core/jobs";
import { PROVIDER_NAME } from "@/core/providers";
import { ruleHits } from "@/core/rules";
import type { JobSetting, Line, Person, Priority, Rule, Source } from "@/core/types";
import {
  addHandle, addPerson, addRule, clearManualPriorities, deleteRule, moveRule, removeHandle, removePerson, runJobNow,
  setChannelSelected, setJobEnabled, setJobInterval, syncNow, toast, togglePersonDept, useApp, type App, type RuleKind,
} from "@/store/store";

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
  /** What a job is still waiting for, or null when it can run. */
  const waitingFor = (needs: Connection | null): string | null => {
    if (!needs) return null;
    if (needs === "ai") return app.state.aiConfigured ? null : "Waiting for the AI key";
    return app.state.connections[needs].connected ? null : `Waiting for ${PROVIDER_NAME[needs]}`;
  };
  // Only the checks that work today. The one that sends has nothing to do while sending is off.
  const jobs = LIVE_JOBS.filter((job) => job.id !== "outbox-retry" || app.state.sendingEnabled);
  const anyAI = jobs.some((job) => job.usesAI);
  return (
    <div className="panel set-sec" id="timers">
      <div className="panel-head">
        <h3>Sync</h3>
        <button className="btn primary" disabled={app.ui.syncing} onClick={() => void syncNow()}>
          {app.ui.syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
      <p className="set-intro">
        New messages and calls come in by themselves, each check on its own timer. <strong>Sync now</strong> runs all of them straight away; <strong>Run now</strong> runs just one. Change how often a check runs, or switch it off. Every timer has a fastest allowed value, so a check can never run often enough to get blocked by Slack or Fathom. A check waits until its source is connected on the <Link href="/connections">Connections</Link> page.
      </p>
      <div className="table-scroll">
        <table className="set">
          <thead>
            <tr>
              <th>What it does</th>
              <th>Shows up in</th>
              <th>How often</th>
              <th>Fastest</th>
              {anyAI && <th>Uses AI</th>}
              <th>On</th>
              <th>Last run</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const setting = app.state.jobs.find((j) => j.id === job.id) ?? { id: job.id, intervalMin: job.defaultMin, enabled: true };
              const status = app.state.jobStatus[job.id];
              const waiting = waitingFor(job.needs);
              return (
                <tr key={job.id}>
                  <td style={{ fontWeight: 600 }}>{job.name}</td>
                  <td>{job.tab}</td>
                  {/* Keyed by the saved value, so the field shows the clamped number after a save. */}
                  <td>{job.follows ? <span className="waiting">After each message check</span> : <IntervalInput key={setting.intervalMin} setting={setting} />}</td>
                  <td className="num">{job.follows ? "–" : describeInterval(job.minMin)}</td>
                  {anyAI && <td>{job.usesAI ? <strong>Yes</strong> : "No"}</td>}
                  <td>
                    <input type="checkbox" checked={setting.enabled} aria-label={`${job.name}: on`} onChange={(e) => setJobEnabled(job.id, e.target.checked)} />
                  </td>
                  <td>
                    <span className="waiting" style={status?.ok === false && !waiting ? { color: "var(--bad)" } : undefined}>
                      {!setting.enabled
                        ? "Switched off"
                        : (waiting ?? (status?.lastRunAt ? `${ago(status.lastRunAt, app.now.getTime())} ago: ${status.message ?? (status.ok ? "done" : "failed")}` : "Not run yet"))}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn" disabled={Boolean(waiting) || app.ui.syncing || app.ui.running.includes(job.id)} onClick={() => void runJobNow(job.id)}>
                      {app.ui.running.includes(job.id) ? "Running…" : "Run now"}
                    </button>
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

function Channels({ app }: { app: App }) {
  const [filter, setFilter] = useState("");
  const { channels } = app.state;
  const shown = channels.filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const selected = channels.filter((c) => c.selected).length;
  return (
    <div className="panel set-sec" id="channels">
      <div className="panel-head">
        <h3>Slack channels</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {selected} of {channels.length} read
        </span>
      </div>
      <p className="set-intro">
        Direct and group messages are always read, and so is any message that tags you, wherever it is. Tick the channels you also want read in full. A change applies from the next check.
      </p>
      {channels.length === 0 ? (
        <p className="empty">Your channels appear here once Slack is connected and the channel list has been read.</p>
      ) : (
        <>
          <div style={{ padding: "0 16px 10px" }}>
            <input className="f" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a channel" aria-label="Find a channel" style={{ width: "min(100%, 320px)" }} />
          </div>
          <ul className="channel-list">
            {shown.map((c) => (
              <li key={c.id}>
                <label>
                  <input type="checkbox" checked={c.selected} onChange={(e) => setChannelSelected(c.id, e.target.checked)} />
                  <span>#{c.name}</span>
                  {c.kind === "private" && <span className="chip">Private</span>}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
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
          {!p.slackUserId && " · no Slack account linked"}
        </div>
      </td>
      {DEPARTMENTS && (
        <td>
          <div className="tagset">
            {DEPTS.map((d) => (
              <button key={d} className="deptchip" aria-pressed={p.depts.includes(d)} onClick={() => togglePersonDept(p.id, d)}>
                {d}
              </button>
            ))}
          </div>
        </td>
      )}
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
  const [slackUserId, setSlackUserId] = useState("");
  return (
    <div className="panel set-sec" id="team">
      <div className="panel-head">
        <h3>Team and responsibilities</h3>
      </div>
      <p className="set-intro">
        The people you assign work to. {DEPARTMENTS ? "When you assign a task, people in its department are offered first, and anyone" : "When you assign a task, anyone"} whose responsibilities match the task is marked as the best fit. You can also assign to anyone on Slack; they are added here the first time. Pick each person&apos;s Slack account so an assigned task can reach them.
      </p>
      <div className="table-scroll">
        <table className="set">
          <thead>
            <tr>
              <th>Person</th>
              {DEPARTMENTS && <th>Departments</th>}
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
          addPerson({ name: name.trim(), role: role.trim() || "Team member", depts: DEPARTMENTS ? [dept] : [], handles: handles.split(",").map((x) => x.trim()).filter(Boolean), slackUserId: slackUserId || null });
          setName("");
          setRole("");
          setHandles("");
          setSlackUserId("");
        }}
      >
        <Combo
          value={slackUserId}
          label="Their Slack account"
          placeholder="Slack account: type or pick…"
          none="No Slack account"
          choices={app.state.slackPeople.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => {
            setSlackUserId(id);
            // Picking the Slack account fills in the name.
            const person = app.state.slackPeople.find((p) => p.id === id);
            if (person) setName(person.name);
          }}
        />
        <input className="f" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required aria-label="Name" maxLength={60} />
        <input className="f" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" aria-label="Role" maxLength={60} />
        {DEPARTMENTS && (
          <select className="f" value={dept} aria-label="Department" onChange={(e) => setDept(e.target.value)}>
            {DEPTS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        )}
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
              {/* With one app connected there is nothing to tell apart, so the app is not named. */}
              {LIVE_SOURCES.length > 1 && <>{SOURCE_LABEL[r.source]}: </>}
              <Condition r={r} />
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
        {LIVE_SOURCES.length > 1 && (
          <select className="f" value={source} aria-label="App" onChange={(e) => setSource(e.target.value as Source | "any")}>
            {(["any", ...LIVE_SOURCES] as const).map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
        )}
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
  const manual = app.state.inbox.filter((c) => c.manualPri || c.manualMode).length;

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Settings</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            How often it checks, who is on the team, and the rules the dashboard follows.
          </div>
        </div>
      </div>
      <nav className="set-nav" aria-label="Settings sections">
        <a href="#timers">Sync</a>
        <a href="#channels">Channels</a>
        <a href="#team">Team</a>
        <a href="#urgent">What is urgent</a>
        <a href="#labels">{PERSONAL_SIDE ? "Personal or Professional" : "Agency or Consulting"}</a>
      </nav>

      <Timers app={app} />
      <Channels app={app} />
      <Team app={app} />

      <RuleList<Priority>
        app={app}
        kind="priorityRules"
        id="urgent"
        title="What is urgent"
        intro="Rules that decide how urgent a message is. They run top to bottom and the first match wins. A message that matches no rule is Low. A priority you set by hand in the inbox keeps your choice."
        outcomes={[["high", PRIORITY_NAME.high], ["mid", PRIORITY_NAME.mid], ["low", PRIORITY_NAME.low]]}
        outcomeOf={(r) => PRIORITY_NAME[r.pri ?? "low"]}
        makeOutcome={(pri) => ({ pri })}
        footer={
          manual > 0 ? (
            <button className="linkbtn" onClick={clearManualPriorities}>
              Reset {manual} hand-sorted {manual === 1 ? "chat" : "chats"} to the rules
            </button>
          ) : null
        }
      />

      {!PERSONAL_SIDE && (
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
      )}
      {PERSONAL_SIDE && (
        <RuleList<"personal" | "agency" | "consulting">
          app={app}
          kind="labelRules"
          id="labels"
          title="Personal or Professional"
          intro="Rules that decide which side of the dashboard a chat belongs to, and whether a professional chat is Agency or Consulting. They run top to bottom and the first match wins. A chat that matches no rule is Professional, Agency. A chat you move by hand in the inbox keeps your choice."
          outcomes={[["personal", "Personal"], ["consulting", "Professional · Consulting"], ["agency", "Professional · Agency"]]}
          outcomeOf={(r) => (r.mode === "personal" ? "Personal" : `Professional · ${LINE_NAME[r.line ?? "agency"]}`)}
          makeOutcome={(to) => (to === "personal" ? { mode: "personal" } : { mode: "professional", line: to })}
        />
      )}
    </section>
  );
}
