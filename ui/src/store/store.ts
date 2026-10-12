"use client";

// The browser's copy of the dashboard. The server owns the data: this file reads it from
// /api/state, and every action below is one request to the server, which answers with the
// fresh state. Nothing but small screen preferences lives only in the browser.
import { useSyncExternalStore } from "react";
import { PERSONAL_SIDE } from "@/core/config";
import { isoDay } from "@/core/dates";
import { jobById } from "@/core/jobs";
import { PROVIDER_NAME } from "@/core/providers";
import type { AssignWhere } from "@/core/delegation";
import type { AppState, JobId, Mode, Person, Priority, Provider, Rule, Suggestion, Task } from "@/core/types";

export interface UiState {
  /** Which side of the dashboard is showing. Remembered in this browser. */
  mode: Mode;
  openConversation: string | null;
  /** The task whose details are showing on the Tasks tab. */
  openTask: string | null;
  openMeetings: string[];
  toast: string | null;
  /** Checks that are running because the person pressed "Run now". */
  running: JobId[];
  /** Changes on their way to the server. The header says "Saving…" while this is above zero. */
  saving: number;
  /** True while "Sync now" is reading everything. */
  syncing: boolean;
}

export interface App {
  state: AppState;
  ui: UiState;
  /** Set each time the data is read, so everything on screen agrees on "now". */
  now: Date;
  today: string;
}

const REFRESH_MS = 60_000;

let app: App | null = null;
let ui: UiState = { mode: "professional", openConversation: null, openTask: null, openMeetings: [], toast: null, running: [], saving: 0, syncing: false };
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * While the Personal side is switched off, everything shows as Professional, so a chat or
 * task that was moved to Personal earlier does not vanish from the screens.
 */
function oneSide(state: AppState): AppState {
  const work = <T extends { mode: Mode }>(item: T): T => (item.mode === "professional" ? item : { ...item, mode: "professional" });
  return { ...state, inbox: state.inbox.map(work), tasks: state.tasks.map(work), suggestions: state.suggestions.map(work), links: state.links.map(work) };
}

function setState(state: AppState) {
  const now = new Date();
  app = { state: PERSONAL_SIDE ? state : oneSide(state), ui, now, today: isoDay(now) };
  emit();
}

function setUi(patch: Partial<UiState>) {
  ui = { ...ui, ...patch };
  if (app) app = { ...app, ui };
  emit();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  setUi({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setUi({ toast: null }), 3200);
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status}` }));
  // The session ran out, or was never there: back to the login page. A full page load on
  // purpose, so nothing that was read while signed in stays in memory.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  if (res.status === 401 && window.location.pathname !== "/login") window.location.assign("/login");
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}`);
  return data as T;
}

/** Reads the latest data from the server. */
export async function refresh(): Promise<void> {
  try {
    setState(await request<AppState>("/api/state"));
  } catch (error) {
    toast(`Could not load the dashboard: ${(error as Error).message}`);
  }
}

const MODE_KEY = "command-center-mode";
/** Pages that exist only on the Professional side. */
export const PROFESSIONAL_ONLY = ["/departments", "/meetings", "/targets"];

function rememberedMode(): Mode {
  // A link straight to a professional page wins over what was last picked.
  if (!PERSONAL_SIDE || PROFESSIONAL_ONLY.includes(window.location.pathname)) return "professional";
  try {
    return window.localStorage.getItem(MODE_KEY) === "personal" ? "personal" : "professional";
  } catch {
    return "professional";
  }
}

function start() {
  if (started) return;
  started = true;
  ui = { ...ui, mode: rememberedMode() };
  void refresh();
  // New messages and calls arrive on the server's timers; this picks them up.
  setInterval(() => void refresh(), REFRESH_MS);
  window.addEventListener("focus", () => void refresh());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  start();
  return () => {
    listeners.delete(l);
  };
};

const NO_TOAST = () => null;
/** The current toast message. Works even before the first read, so load errors can show. */
export const useToast = (): string | null => useSyncExternalStore(subscribe, () => ui.toast, NO_TOAST);

/** The dashboard's data, or null until the first read from the server has arrived. */
export const useApp = (): App | null => useSyncExternalStore(subscribe, () => app, () => null);

const PROFESSIONAL = (): Mode => "professional";
/** Personal or Professional. Works before the first read, so the header can show the switch. */
export const useMode = (): Mode => useSyncExternalStore(subscribe, () => ui.mode, PROFESSIONAL);

export function setMode(mode: Mode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private windows may refuse storage; the switch still works for this visit.
  }
  setUi({ mode, openConversation: null });
}

export async function signOut() {
  try {
    await request("/api/logout", {});
  } finally {
    // A full page load on purpose: it clears the messages and tasks held in memory.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }
}

// Changes already on their way. A second click on the same button while the first is still
// travelling is ignored: without this, six impatient clicks made six tasks.
const inFlight = new Set<string>();

/**
 * Sends one change to the server and shows the result. Resolves to false if it was refused.
 * `show` changes the screen straight away, before the server has answered; if the server
 * refuses, the screen is read again from the server.
 */
async function act(type: string, args: unknown[], done?: string, show?: (state: AppState) => AppState): Promise<boolean> {
  const key = `${type}:${JSON.stringify(args)}`;
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  setUi({ saving: ui.saving + 1 });
  if (show && app) {
    app = { ...app, state: show(app.state) };
    emit();
  }
  try {
    setState(await request<AppState>("/api/action", { type, args }));
    if (done) toast(done);
    return true;
  } catch (error) {
    toast((error as Error).message);
    if (show) void refresh();
    return false;
  } finally {
    inFlight.delete(key);
    setUi({ saving: Math.max(0, ui.saving - 1) });
  }
}

// What the screen shows at once, while the change travels.
const inInbox = (id: string, patch: Partial<AppState["inbox"][number]>) => (s: AppState): AppState => ({ ...s, inbox: s.inbox.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
const inTasks = (id: string, patch: Partial<Task>) => (s: AppState): AppState => ({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
const inSuggestions = (id: string, patch: Partial<Suggestion>) => (s: AppState): AppState => ({ ...s, suggestions: s.suggestions.map((g) => (g.id === id ? { ...g, ...patch } : g)) });

// ---------- Inbox ----------

export const openConversation = (id: string | null) => setUi({ openConversation: id });

export const setConversationPriority = (id: string, pri: Priority) => void act("setConversationPriority", [id, pri], undefined, inInbox(id, { pri }));
export const setConversationMode = (id: string, mode: Mode) => void act("setConversationMode", [id, mode], mode === "personal" ? "Moved to Personal" : "Moved to Professional", inInbox(id, { mode }));

/**
 * Adds the reply to the conversation. It goes out from the owner's own account, if sending is
 * on. `thread` puts it in that Slack thread; without it, it is a new message in the chat.
 */
export function sendReply(id: string, text: string, markDone: boolean, thread: string | null = null) {
  if (markDone) setUi({ openConversation: null });
  void act("sendReply", [id, text, markDone, thread], app?.state.sendingEnabled ? "Reply sent" : "Reply saved. Sending is switched off, so it waits in the outbox.");
}

export const markConversationDone = (id: string) => void act("markConversationDone", [id], "Marked done", inInbox(id, { done: true }));
export const restoreInbox = () => void act("restoreInbox", []);
export const conversationToTask = (id: string, today: string) => void act("conversationToTask", [id, today], "Task added, due today", inInbox(id, { done: true }));

const delegated = () => (app?.state.sendingEnabled ? "Assigned. They have been told on Slack." : "Assigned. Their Slack message waits in the outbox, because sending is off.");

const delegatedIn = (where: AssignWhere) => (where === "chat" ? (app?.state.sendingEnabled ? "Assigned. They have been told in the chat." : "Assigned. The message for the chat waits in the outbox, because sending is off.") : delegated());

export function delegateConversation(id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
  setUi({ openConversation: null });
  void act("delegateConversation", [id, personId, note, due, where], delegatedIn(where), inInbox(id, { done: true }));
}

// ---------- Tasks ----------

export const openTask = (id: string | null) => setUi({ openTask: id });

/** `assignTo` is a team member's id, or "slack:<id>" for someone picked straight from Slack. */
export const addTask = (input: Pick<Task, "title" | "dept" | "project" | "pri" | "due" | "mode"> & { assignTo?: string }) =>
  void act("addTask", [input], input.assignTo ? `Task added. ${delegated()}` : "Task added");
export const actionItemToTask = (meetingId: string, index: number) => void act("actionItemToTask", [meetingId, index], "Task added");
export const toggleTask = (id: string, done: boolean) => void act("toggleTask", [id, done], done ? "Task done" : undefined, inTasks(id, { done, doneAt: done ? Date.now() : null }));
export const setTaskPriority = (id: string, pri: Priority) => void act("setTaskPriority", [id, pri], undefined, inTasks(id, { pri }));
export const delegateTask = (id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") => void act("delegateTask", [id, personId, note, due, where], delegatedIn(where));
export const undelegateTask = (id: string) => void act("undelegateTask", [id], "Task is back on your plate");

// ---------- Suggested tasks ----------

export const editSuggestion = (id: string, patch: Partial<Pick<Suggestion, "pri" | "due">>) => void act("editSuggestion", [id, patch]);
export const acceptSuggestion = (id: string) => void act("acceptSuggestion", [id], "Task added", inSuggestions(id, { status: "accepted" }));
export const dismissSuggestion = (id: string) => void act("dismissSuggestion", [id], "Suggestion dismissed", inSuggestions(id, { status: "dismissed" }));

// ---------- Meetings ----------

export const toggleMeeting = (id: string) => setUi({ openMeetings: ui.openMeetings.includes(id) ? ui.openMeetings.filter((x) => x !== id) : [...ui.openMeetings, id] });
export const showMeeting = (id: string) => {
  if (!ui.openMeetings.includes(id)) setUi({ openMeetings: [...ui.openMeetings, id] });
};
export const loadTranscript = async (id: string) => (await request<{ transcript: [string, string][] }>(`/api/meetings/${encodeURIComponent(id)}/transcript`)).transcript;

// ---------- Today ----------

export type FocusScope = "day" | "week";
export const addFocus = (scope: FocusScope, key: string, text: string) => void act("addFocus", [scope, key, text, ui.mode]);
export const toggleFocus = (scope: FocusScope, key: string, id: string, done: boolean) => void act("toggleFocus", [scope, key, id, done]);
export const removeFocus = (scope: FocusScope, key: string, id: string) => void act("removeFocus", [scope, key, id]);
export const addLink = (label: string, url: string) => void act("addLink", [label, url, ui.mode], "Link added");
export const removeLink = (id: string) => void act("removeLink", [id]);

// ---------- Targets ----------

/** Saves the numbers typed in for one day. An empty field clears that day's value. */
export const saveLogs = (day: number, values: Record<string, number | null>) => void act("saveLogs", [day, values], "Today's numbers saved");
export const saveTargets = (values: Record<string, number>) => void act("saveTargets", [values], "Targets saved");

// ---------- Settings ----------

export const togglePersonDept = (personId: string, dept: string) => void act("togglePersonDept", [personId, dept]);
export const addHandle = (personId: string, handle: string) => void act("addHandle", [personId, handle]);
export const removeHandle = (personId: string, index: number) => void act("removeHandle", [personId, index]);
export const addPerson = (input: Omit<Person, "id">) => void act("addPerson", [input], `Added ${input.name}`);
export const removePerson = (personId: string) => void act("removePerson", [personId], "Removed");

export type RuleKind = "labelRules" | "priorityRules";
export const addRule = (kind: RuleKind, rule: Omit<Rule, "id">) => void act("addRule", [kind, rule], "Rule added");
export const moveRule = (kind: RuleKind, id: string, direction: -1 | 1) => void act("moveRule", [kind, id, direction]);
export const deleteRule = (kind: RuleKind, id: string) => void act("deleteRule", [kind, id], "Rule deleted");
export const clearManualPriorities = () => void act("clearManualPriorities", [], "Chats re-sorted by your rules");

export const setJobInterval = (id: JobId, minutes: number) => void act("setJobInterval", [id, minutes]);
export const setJobEnabled = (id: JobId, enabled: boolean) => void act("setJobEnabled", [id, enabled]);
export const setChannelSelected = (id: string, selected: boolean) => void act("setChannelSelected", [id, selected]);

/** "Run now": runs one check straight away and says what it found. */
export async function runJobNow(id: JobId) {
  if (ui.running.includes(id)) return;
  setUi({ running: [...ui.running, id] });
  try {
    const { runs, state } = await request<{ runs: { ok: boolean; message: string }[]; state: AppState }>("/api/jobs", { id });
    setState(state);
    toast(`${jobById(id).name}: ${runs[0]?.message ?? "done"}`);
  } catch (error) {
    toast((error as Error).message);
  } finally {
    setUi({ running: ui.running.filter((j) => j !== id) });
  }
}

/** "Sync now": runs every working check straight away, whatever its timer says. */
export async function syncNow() {
  if (ui.syncing) return;
  setUi({ syncing: true });
  try {
    const { runs, state } = await request<{ runs: { ok: boolean; message: string }[]; state: AppState }>("/api/jobs", { id: "sync" });
    setState(state);
    const failed = runs.filter((r) => !r.ok).length;
    toast(runs.length === 0 ? "Nothing to sync yet. Connect Slack or Fathom first." : failed ? `Sync finished, but ${failed} ${failed === 1 ? "check" : "checks"} had a problem. See the list below.` : "Everything is up to date.");
  } catch (error) {
    toast((error as Error).message);
  } finally {
    setUi({ syncing: false });
  }
}

// ---------- Connections ----------

/**
 * Connects a service. The key goes straight to the server, which checks it with the service
 * and stores it encrypted. It is never kept in the browser. Resolves to an error message, or
 * null when it worked.
 */
export async function connectProvider(provider: Provider, secret: string): Promise<string | null> {
  try {
    const { state, label } = await request<{ state: AppState; label: string }>("/api/connections", { provider, secret });
    setState(state);
    toast(`${PROVIDER_NAME[provider]} connected: ${label}. Reading it now.`);
    // The first read runs in the background on the server; look again once it has had time.
    setTimeout(() => void refresh(), 15_000);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export const disconnectProvider = (provider: Provider) => void act("disconnectProvider", [provider], `${PROVIDER_NAME[provider]} disconnected`);
