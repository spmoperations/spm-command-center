"use client";

// One store for the whole dashboard. Today it keeps sample data in this browser (localStorage).
// When the database exists, `load`, `save` and the action bodies below are the only places
// that change: each action becomes a server call instead of a local edit.
import { useSyncExternalStore } from "react";
import { isoDay, monthKey } from "@/core/dates";
import { clampInterval } from "@/core/jobs";
import { applyRules } from "@/core/rules";
import type { AppState, Conversation, JobId, Person, Priority, Rule, Suggestion, Task } from "@/core/types";
import { sampleState } from "@/data/sample";

const KEY = "spm-command-center";
// Bump when the saved shape changes, so an older save is dropped instead of half-read.
const VERSION = 1;

export interface UiState {
  openConversation: string | null;
  openMeetings: string[];
  toast: string | null;
}

export interface App {
  state: AppState;
  ui: UiState;
  /** Fixed when the page loads, so everything on screen agrees on "now". */
  now: Date;
  today: string;
}

let app: App | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function load(): AppState | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return saved && saved.v === VERSION ? (saved.state as AppState) : null;
  } catch {
    return null;
  }
}

function save(state: AppState) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, state }));
  } catch {
    // Storage can be full or blocked; the page still works for this visit.
  }
}

function boot(): App {
  const now = new Date();
  const saved = load();
  // Target numbers are logged per month, so a save from an earlier month starts over.
  const state = saved && saved.month === monthKey(now) ? saved : sampleState(now);
  return { state, ui: { openConversation: null, openMeetings: [], toast: null }, now, today: isoDay(now) };
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
/** The live dashboard data. Outside React, call this only in the browser or in tests. */
export const getApp = () => (app ??= boot());
const getServerSnapshot = () => null;

/** The dashboard's data, or null while the page is still loading in the browser. */
export const useApp = (): App | null => useSyncExternalStore(subscribe, getApp, getServerSnapshot);

function update(edit: (draft: AppState) => void) {
  if (!app) return;
  const draft = structuredClone(app.state);
  edit(draft);
  app = { ...app, state: draft };
  save(draft);
  emit();
}

function setUi(patch: Partial<UiState>) {
  if (!app) return;
  app = { ...app, ui: { ...app.ui, ...patch } };
  emit();
}

let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  setUi({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setUi({ toast: null }), 2400);
}

export function resetSampleData() {
  if (!app) return;
  const state = sampleState(app.now);
  app = { ...app, state, ui: { openConversation: null, openMeetings: [], toast: null } };
  save(state);
  emit();
  toast("Sample data reset");
}

// ---------- Inbox ----------

export const openConversation = (id: string | null) => setUi({ openConversation: id });

export function setConversationPriority(id: string, pri: Priority) {
  update((s) => {
    const c = s.inbox.find((x) => x.id === id);
    if (c) Object.assign(c, { pri, manualPri: true });
  });
}

/** Adds the reply to the thread and queues it for sending from the owner's own account. */
export function sendReply(id: string, text: string, markDone: boolean) {
  let source = "";
  update((s) => {
    const c = s.inbox.find((x) => x.id === id);
    if (!c) return;
    const at = Date.now();
    c.thread.push({ me: true, text, at, status: "queued" });
    c.replied = true;
    if (markDone) c.done = true;
    s.outbox.push({ id: uid("o"), source: c.source, to: c.from, ctx: c.ctx, text, at, status: "queued", conversationId: id });
    source = c.source === "slack" ? "Slack" : "Telegram";
  });
  if (markDone) setUi({ openConversation: null });
  if (source) toast(`Reply queued for ${source}`);
}

export function markConversationDone(id: string) {
  update((s) => {
    const c = s.inbox.find((x) => x.id === id);
    if (c) c.done = true;
  });
  toast("Marked done");
}

export function restoreInbox() {
  update((s) => s.inbox.forEach((c) => (c.done = false)));
}

const taskTitleFrom = (c: Conversation) => `${c.from}: ${c.text.slice(0, 70)}${c.text.length > 70 ? "…" : ""}`;

export function conversationToTask(id: string, today: string) {
  update((s) => {
    const c = s.inbox.find((x) => x.id === id);
    if (!c) return;
    s.tasks.push({
      id: uid("t"), title: `Reply to ${taskTitleFrom(c)}`, dept: "Operations", project: c.project, pri: c.pri,
      due: today, done: false, doneAt: null, src: { type: "message", id }, delegable: true, delegatedTo: null,
    });
    c.done = true;
  });
  toast("Task added, due today");
}

// ---------- Tasks ----------

export function addTask(input: Pick<Task, "title" | "dept" | "project" | "pri" | "due">) {
  update((s) => {
    s.tasks.push({ ...input, id: uid("t"), done: false, doneAt: null, src: null, delegable: true, delegatedTo: null });
  });
  toast("Task added");
}

export function toggleTask(id: string, done: boolean) {
  update((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, { done, doneAt: done ? Date.now() : null });
  });
  if (done) toast("Task done");
}

export function setTaskPriority(id: string, pri: Priority) {
  update((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t) t.pri = pri;
  });
}

function delegate(s: AppState, task: Task, person: Person, note: string, due: string) {
  const at = Date.now();
  task.due = due;
  task.delegatedTo = { personId: person.id, name: person.name, role: person.role, note, at };
  // The teammate is told by a Slack direct message sent from the owner's account.
  s.outbox.push({
    id: uid("o"), source: "slack", to: person.name, ctx: "Direct message",
    text: `New task for you: ${task.title} (due ${due})\n\n${note}`, at, status: "queued", taskId: task.id,
  });
}

export function delegateTask(id: string, personId: string, note: string, due: string) {
  let name = "";
  update((s) => {
    const task = s.tasks.find((x) => x.id === id);
    const person = s.team.find((p) => p.id === personId);
    if (!task || !person) return;
    delegate(s, task, person, note, due);
    name = person.name;
  });
  if (name) toast(`Delegated to ${name.split(" ")[0]}. Slack message queued.`);
}

/** Turns a message into a task and hands it to a teammate in one step. */
export function delegateConversation(id: string, personId: string, note: string, due: string) {
  let name = "";
  update((s) => {
    const c = s.inbox.find((x) => x.id === id);
    const person = s.team.find((p) => p.id === personId);
    if (!c || !person) return;
    const task: Task = {
      id: uid("t"), title: `From ${taskTitleFrom(c)}`, dept: person.depts[0] ?? "Operations", project: c.project,
      pri: c.pri, due, done: false, doneAt: null, src: { type: "message", id }, delegable: true, delegatedTo: null,
    };
    delegate(s, task, person, note, due);
    s.tasks.push(task);
    c.done = true;
    name = person.name;
  });
  setUi({ openConversation: null });
  if (name) toast(`Delegated to ${name.split(" ")[0]}. Slack message queued.`);
}

export function undelegateTask(id: string) {
  update((s) => {
    const t = s.tasks.find((x) => x.id === id);
    if (t) t.delegatedTo = null;
  });
  toast("Task is back on your plate");
}

// ---------- Suggested tasks ----------

export function editSuggestion(id: string, patch: Partial<Pick<Suggestion, "pri" | "due">>) {
  update((s) => {
    const g = s.suggestions.find((x) => x.id === id);
    if (g) Object.assign(g, patch);
  });
}

export function acceptSuggestion(id: string) {
  update((s) => {
    const g = s.suggestions.find((x) => x.id === id);
    if (!g) return;
    s.tasks.push({
      id: uid("t"), title: g.title, dept: g.dept, project: g.project, pri: g.pri, due: g.due,
      done: false, doneAt: null, src: g.src, delegable: g.delegable, delegatedTo: null,
    });
    g.status = "accepted";
  });
  toast("Task added");
}

export function dismissSuggestion(id: string) {
  update((s) => {
    const g = s.suggestions.find((x) => x.id === id);
    if (g) g.status = "dismissed";
  });
  toast("Suggestion dismissed");
}

// ---------- Meetings ----------

export function toggleMeeting(id: string) {
  if (!app) return;
  const open = app.ui.openMeetings;
  setUi({ openMeetings: open.includes(id) ? open.filter((x) => x !== id) : [...open, id] });
}

export function showMeeting(id: string) {
  if (app && !app.ui.openMeetings.includes(id)) setUi({ openMeetings: [...app.ui.openMeetings, id] });
}

// ---------- Today ----------

export type FocusScope = "day" | "week";

export function addFocus(scope: FocusScope, key: string, text: string) {
  update((s) => {
    (s.focus[scope][key] ??= []).push({ id: uid("f"), text, done: false });
  });
}

export function toggleFocus(scope: FocusScope, key: string, id: string, done: boolean) {
  update((s) => {
    const item = s.focus[scope][key]?.find((f) => f.id === id);
    if (item) item.done = done;
  });
}

export function removeFocus(scope: FocusScope, key: string, id: string) {
  update((s) => {
    s.focus[scope][key] = (s.focus[scope][key] ?? []).filter((f) => f.id !== id);
  });
}

export function addLink(label: string, url: string) {
  update((s) => {
    s.links.push({ id: uid("l"), label, url });
  });
  toast("Link added");
}

export function removeLink(id: string) {
  update((s) => {
    s.links = s.links.filter((l) => l.id !== id);
  });
}

// ---------- Targets ----------

/** Saves the numbers typed in for one day. An empty field clears that day's value. */
export function saveLogs(day: number, values: Record<string, number | null>) {
  update((s) => {
    for (const [id, value] of Object.entries(values)) {
      s.logs[id] ??= {};
      if (value == null) delete s.logs[id][day];
      else s.logs[id][day] = Math.max(0, value);
    }
  });
  toast("Today's numbers saved");
}

export function saveTargets(values: Record<string, number>) {
  update((s) => {
    for (const m of s.metrics) {
      const v = values[m.id];
      if (Number.isFinite(v) && v > 0) m.target = v;
    }
    // A sum target is always the total of its parts.
    for (const m of s.metrics.filter((x) => x.sum)) {
      m.target = s.metrics.filter((k) => k.parent === m.id).reduce((a, k) => a + k.target, 0);
    }
  });
  toast("Targets saved");
}

// ---------- Settings: team ----------

export function togglePersonDept(personId: string, dept: string) {
  update((s) => {
    const p = s.team.find((x) => x.id === personId);
    if (p) p.depts = p.depts.includes(dept) ? p.depts.filter((d) => d !== dept) : [...p.depts, dept];
  });
}

export function addHandle(personId: string, handle: string) {
  update((s) => {
    const p = s.team.find((x) => x.id === personId);
    if (p && !p.handles.some((h) => h.toLowerCase() === handle.toLowerCase())) p.handles.push(handle);
  });
}

export function removeHandle(personId: string, index: number) {
  update((s) => {
    s.team.find((x) => x.id === personId)?.handles.splice(index, 1);
  });
}

export function addPerson(input: Omit<Person, "id">) {
  update((s) => {
    s.team.push({ ...input, id: uid("u") });
  });
  toast(`Added ${input.name}`);
}

export function removePerson(personId: string) {
  let name = "";
  update((s) => {
    name = s.team.find((p) => p.id === personId)?.name ?? "";
    s.team = s.team.filter((p) => p.id !== personId);
  });
  if (name) toast(`Removed ${name}`);
}

// ---------- Settings: sorting rules ----------

export type RuleKind = "labelRules" | "priorityRules";

const resort = (s: AppState) => {
  s.inbox = applyRules(s.inbox, s.labelRules, s.priorityRules);
};

export function addRule(kind: RuleKind, rule: Omit<Rule, "id">) {
  update((s) => {
    s[kind].push({ ...rule, id: uid("r") });
    resort(s);
  });
  toast("Rule added");
}

export function moveRule(kind: RuleKind, id: string, direction: -1 | 1) {
  update((s) => {
    const from = s[kind].findIndex((r) => r.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= s[kind].length) return;
    [s[kind][from], s[kind][to]] = [s[kind][to], s[kind][from]];
    resort(s);
  });
}

export function deleteRule(kind: RuleKind, id: string) {
  update((s) => {
    s[kind] = s[kind].filter((r) => r.id !== id);
    resort(s);
  });
  toast("Rule deleted");
}

/** Hands every hand-set priority back to the rules. */
export function clearManualPriorities() {
  update((s) => {
    s.inbox.forEach((c) => delete c.manualPri);
    resort(s);
  });
  toast("Messages re-sorted by your rules");
}

// ---------- Settings: timers ----------

export function setJobInterval(id: JobId, minutes: number) {
  update((s) => {
    const job = s.jobs.find((j) => j.id === id);
    if (job) job.intervalMin = clampInterval(id, minutes);
  });
}

export function setJobEnabled(id: JobId, enabled: boolean) {
  update((s) => {
    const job = s.jobs.find((j) => j.id === id);
    if (job) job.enabled = enabled;
  });
}
