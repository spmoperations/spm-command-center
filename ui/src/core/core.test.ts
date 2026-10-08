import { describe, expect, it } from "vitest";
import { addDays, dueLabel, weekStart } from "./dates";
import { candidates, canDelegate, fitFor, taskStatus } from "./delegation";
import { clampInterval, describeInterval, isDue, JOBS, nextRunAt, waitUntil } from "./jobs";
import { applyRules, ruleHits, ruleMatches, sortConversation } from "./rules";
import { evalMetric } from "./targets";
import type { Conversation, JobSetting, Metric, Person, Rule, Task } from "./types";

const conv = (over: Partial<Conversation>): Conversation => ({
  id: "c1", source: "slack", from: "Maya Chen", ctx: "#harbor-realty-content", direct: false, tagged: false,
  text: "hi", at: 0, pri: "low", line: "agency", project: "Harbor Realty", done: false, replied: false, thread: [], ...over,
});

const rule = (over: Partial<Rule>): Rule => ({ id: "r", source: "any", when: "ctx", op: "is", value: "", ...over });

describe("sorting rules", () => {
  const labelRules = [rule({ id: "l1", source: "slack", op: "starts", value: "#consulting-", line: "consulting" })];
  const priorityRules = [
    rule({ id: "p1", when: "tagged", pri: "high" }),
    rule({ id: "p2", source: "slack", value: "#harbor-realty-content", pri: "high" }),
    rule({ id: "p3", when: "direct", pri: "mid" }),
  ];

  it("matches a channel prefix whatever the punctuation or case", () => {
    expect(ruleMatches(labelRules[0], conv({ ctx: "#Consulting-Cohort-3" }))).toBe(true);
    expect(ruleMatches(labelRules[0], conv({ ctx: "#ops" }))).toBe(false);
  });

  it("only applies a rule to its own app", () => {
    expect(ruleMatches(labelRules[0], conv({ source: "telegram", ctx: "#consulting-x" }))).toBe(false);
  });

  it("never lets a text rule with an empty value match everything", () => {
    expect(ruleMatches(rule({ when: "from", op: "contains", value: "  " }), conv({}))).toBe(false);
  });

  it("uses the first matching rule and falls back to Low and Agency", () => {
    expect(sortConversation(conv({ tagged: true, direct: true }), labelRules, priorityRules)).toEqual({ line: "agency", pri: "high" });
    expect(sortConversation(conv({ ctx: "Direct message", direct: true }), labelRules, priorityRules).pri).toBe("mid");
    expect(sortConversation(conv({ ctx: "#sales" }), labelRules, priorityRules)).toEqual({ line: "agency", pri: "low" });
    expect(sortConversation(conv({ ctx: "#consulting-omar" }), labelRules, priorityRules).line).toBe("consulting");
  });

  it("keeps a priority that was set by hand", () => {
    const [kept, resorted] = applyRules(
      [conv({ id: "a", ctx: "#sales", pri: "high", manualPri: true }), conv({ id: "b", ctx: "#sales", pri: "high" })],
      labelRules,
      priorityRules,
    );
    expect(kept.pri).toBe("high");
    expect(resorted.pri).toBe("low");
  });

  it("counts each conversation against the first rule it matches", () => {
    const inbox = [conv({ id: "a", tagged: true }), conv({ id: "b" }), conv({ id: "c", ctx: "x", direct: true })];
    expect(ruleHits(priorityRules, inbox)).toEqual({ p1: 1, p2: 1, p3: 1 });
  });
});

describe("delegation", () => {
  const team: Person[] = [
    { id: "u1", name: "Luis Ramos", role: "Lead editor", depts: ["Client Sales"], handles: ["Editing", "Hooks", "Harbor Realty"] },
    { id: "u2", name: "Kai Brooks", role: "Editor", depts: ["Client Sales"], handles: ["Captions"] },
    { id: "u3", name: "Rene Park", role: "Bookkeeper", depts: ["Finances"], handles: ["Invoices"] },
  ];
  const task = (over: Partial<Task>): Task => ({
    id: "t", title: "Swap hook on Harbor clip #4", dept: "Client Sales", project: "Harbor Realty", pri: "high",
    due: "2026-10-09", done: false, delegable: true, ...over,
  });

  it("finds responsibilities named in the title or project, singular or plural", () => {
    expect(fitFor(team[0], task({}))).toEqual(["Hooks", "Harbor Realty"]);
    expect(fitFor(team[2], task({ title: "Resend Apex invoice link", project: "Apex" }))).toEqual(["Invoices"]);
  });

  it("offers the department and any matching person, best fit first", () => {
    expect(candidates(team, task({}), false).map((p) => p.name)).toEqual(["Luis Ramos", "Kai Brooks"]);
    expect(candidates(team, task({ dept: "Operations", title: "Chase unpaid invoices", project: "Internal Ops" }), false).map((p) => p.name)).toEqual(["Rene Park"]);
    expect(candidates(team, task({}), true)).toHaveLength(3);
  });

  it("does not offer delegation for owner-only, done or already delegated tasks", () => {
    expect(canDelegate(team, task({}))).toBe(true);
    expect(canDelegate(team, task({ delegable: false }))).toBe(false);
    expect(canDelegate(team, task({ done: true }))).toBe(false);
    expect(canDelegate(team, task({ delegatedTo: { personId: "u1", name: "Luis Ramos", role: "", note: "", at: 0 } }))).toBe(false);
    expect(canDelegate([], task({}))).toBe(false);
  });

  it("marks a task overdue only before its due day", () => {
    expect(taskStatus(task({ due: "2026-10-08" }), "2026-10-08")).toBe("ontrack");
    expect(taskStatus(task({ due: "2026-10-07" }), "2026-10-08")).toBe("overdue");
    expect(taskStatus(task({ due: "2026-10-07", done: true }), "2026-10-08")).toBe("done");
  });
});

describe("timers", () => {
  const setting = (over: Partial<JobSetting> = {}): JobSetting => ({ id: "slack-pull", intervalMin: 60, enabled: true, ...over });
  const HOUR = 3_600_000;

  it("defines every job once, with a default no faster than its floor", () => {
    expect(new Set(JOBS.map((j) => j.id)).size).toBe(JOBS.length);
    for (const job of JOBS) expect(job.defaultMin).toBeGreaterThanOrEqual(job.minMin);
    expect(JOBS.filter((j) => j.usesAI).map((j) => j.id)).toEqual(["task-suggest"]);
  });

  it("keeps a timer at or above the fastest allowed", () => {
    expect(clampInterval("slack-pull", 1)).toBe(5);
    expect(clampInterval("telegram-pull", 10)).toBe(30);
    expect(clampInterval("fathom-pull", 90)).toBe(90);
    expect(clampInterval("slack-pull", Number.NaN)).toBe(60);
  });

  it("runs a job that has never run, then waits out the timer", () => {
    expect(isDue(setting(), null, 1000)).toBe(true);
    expect(isDue(setting(), 1000, 1000 + HOUR - 1)).toBe(false);
    expect(isDue(setting(), 1000, 1000 + HOUR)).toBe(true);
  });

  it("never runs a job that is switched off", () => {
    expect(nextRunAt(setting({ enabled: false }), null)).toBeNull();
    expect(isDue(setting({ enabled: false }), null, 10 * HOUR)).toBe(false);
  });

  it("holds a job back while a service asks it to wait", () => {
    const now = 5 * HOUR;
    const notBefore = waitUntil(now, 120);
    expect(notBefore).toBe(now + 120_000);
    expect(isDue(setting(), 0, now, notBefore)).toBe(false);
    expect(isDue(setting(), 0, notBefore, notBefore)).toBe(true);
  });

  it("describes timers in plain words", () => {
    expect([1, 30, 60, 120, 1440].map(describeInterval)).toEqual(["Every minute", "Every 30 minutes", "Every hour", "Every 2 hours", "Once a day"]);
  });
});

describe("targets", () => {
  const metrics: Metric[] = [
    { id: "calls", name: "Calls Booked", target: 60, unit: "n" },
    { id: "content", name: "Content Output", target: 120, unit: "n", sum: true },
    { id: "a", parent: "content", name: "A", target: 60, unit: "n" },
    { id: "b", parent: "content", name: "B", target: 60, unit: "n" },
  ];
  const clock = { day: 11, dim: 30 };
  const tenDays = (perDay: number) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, perDay]));

  it("is on track when the daily rate reaches the target by month end", () => {
    const e = evalMetric(metrics[0], metrics, { calls: tenDays(2) }, clock);
    expect(e).toMatchObject({ actual: 20, expected: 20, projected: 60, status: "ok", elapsed: 10, remaining: 20, perDayNeeded: 2 });
  });

  it("is at risk within 10% of the target and behind below that", () => {
    expect(evalMetric(metrics[0], metrics, { calls: tenDays(1.9) }, clock).status).toBe("risk");
    expect(evalMetric(metrics[0], metrics, { calls: tenDays(1) }, clock).status).toBe("behind");
  });

  it("counts today only once today's numbers are logged", () => {
    const logs = { calls: { ...tenDays(2), 11: 2 } };
    expect(evalMetric(metrics[0], metrics, logs, clock)).toMatchObject({ elapsed: 11, actual: 22 });
  });

  it("adds up the parts of a sum target", () => {
    const e = evalMetric(metrics[1], metrics, { a: tenDays(2), b: tenDays(1) }, clock);
    expect(e.actual).toBe(30);
    expect(e.series[e.series.length - 1]).toBe(30);
  });
});

describe("dates", () => {
  const now = new Date(2026, 9, 8, 15, 30); // Thursday 8 October 2026

  it("moves by whole calendar days", () => {
    expect(addDays(now, 0)).toBe("2026-10-08");
    expect(addDays(now, -8)).toBe("2026-09-30");
    expect(weekStart(now)).toBe("2026-10-05");
  });

  it("labels a due date relative to today", () => {
    const today = "2026-10-08";
    expect(dueLabel("2026-10-08", today)).toEqual({ text: "Today", tone: "today" });
    expect(dueLabel("2026-10-09", today)).toEqual({ text: "Tomorrow", tone: "" });
    expect(dueLabel("2026-10-06", today)).toEqual({ text: "2d overdue", tone: "over" });
    expect(dueLabel("2026-10-12", today).text).toBe("Mon");
    expect(dueLabel("2026-10-20", today).text).toBe("Oct 20");
  });
});
