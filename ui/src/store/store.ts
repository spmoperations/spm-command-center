"use client";

// The browser's copy of the dashboard. The server owns the data: this file reads it from
// /api/state, and every action below is one request to the server, which answers with the
// fresh state. Nothing but small screen preferences lives only in the browser.
import { useSyncExternalStore } from "react";
import { MODE_NAME, PERSONAL_SIDE, PRIORITY_NAME, TASK_LINE_NAME } from "@/core/config";
import { isoDay, pad } from "@/core/dates";
import { jobById } from "@/core/jobs";
import { PROVIDER_NAME } from "@/core/providers";
import type { AssignWhere } from "@/core/delegation";
import type { AddedPicture, AppState, Conversation, ConversationChange, JobId, Mode, Person, Priority, Provider, Rule, Stamps, StateAnswer, Suggestion, Task, TaskLine, TicketInput } from "@/core/types";
import type { RejectReason } from "@/core/config";

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
  /** Conversations whose threads are being read from Slack right now. */
  checking: string[];
}

export interface App {
  state: AppState;
  ui: UiState;
  /** Set each time the data is read, so everything on screen agrees on "now". */
  now: Date;
  today: string;
}

/**
 * While someone is using the page, it asks this often whether anything changed. The question
 * and its answer are a few bytes; only what changed is read, so a quiet inbox costs next to
 * nothing. A page in a tab or window nobody is looking at asks nothing.
 */
const CHECK_MS = 60_000;
/** After this long with no click, key or scroll, the page may just be left open on a screen: it asks less often. */
const IDLE_AFTER_MS = 10 * 60_000;
const IDLE_CHECK_MS = 5 * 60_000;
/** Everything is read again this often while someone is using the page, in case a check missed something. */
const FULL_MS = 30 * 60_000;
/** Pages showing when each timer last ran, which the check leaves out (it changes every few minutes): they read it each time. */
const TIMER_PAGES = ["/settings", "/connections"];

/** The data as the server last sent it, before the screen's own changes (see `act`). */
let raw: AppState | null = null;
/** What `raw` was read with, so the server can say what changed since. */
let stamps: Stamps | null = null;
let lastRead = 0;
let lastFull = 0;
let lastActive = Date.now();

let app: App | null = null;
let ui: UiState = { mode: "professional", openConversation: null, openTask: null, openMeetings: [], toast: null, running: [], saving: 0, syncing: false, checking: [] };
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

/**
 * A call's day and time, in the timezone of this browser. The server sends the moment it
 * started. Its own clock may be in another timezone (a host runs on UTC), and a call at
 * 9 in the evening must not show up under the next day.
 */
function inMyTimezone(state: AppState): AppState {
  return {
    ...state,
    meetings: state.meetings.map((m) => {
      const start = new Date(m.at);
      return { ...m, date: isoDay(start), time: `${pad(start.getHours())}:${pad(start.getMinutes())}` };
    }),
  };
}

/** Shows the data in `raw`, as of now. Changes the screen made on its own, ahead of the server, are dropped. */
function render() {
  if (!raw) return;
  const now = new Date();
  const mine = inMyTimezone(raw);
  app = { state: PERSONAL_SIDE ? mine : oneSide(mine), ui, now, today: isoDay(now) };
  emit();
}

/**
 * Takes in what the server sent: everything, or only the parts that changed (the others stay as
 * they are), or word that nothing did.
 */
function setState(answer: StateAnswer) {
  if ("unchanged" in answer) {
    stamps = answer.stamps;
    // A change on its way keeps what the screen shows meanwhile. Otherwise the time moves on.
    if (ui.saving === 0) render();
    return;
  }
  if (!raw && !(answer.inbox && answer.calendar && answer.meetings)) return void refresh(true);
  raw = { ...raw, ...answer } as AppState;
  stamps = answer.stamps ?? null;
  render();
  // The open conversation came with only its newest messages (an answer that did not know it was open): fetch the rest.
  if (ui.openConversation) void loadWhole(ui.openConversation);
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

/** What the page has, for the server to answer with what changed since; and the conversation open on it, which comes whole. */
const known = (): { have?: Stamps; open?: string } => ({ have: raw && stamps ? stamps : undefined, open: ui.openConversation ?? undefined });

/** Reads what changed on the server since the last read. `whole` reads everything again. */
export async function refresh(whole = false): Promise<void> {
  const now = Date.now();
  lastRead = now;
  const all = whole || !raw || !stamps || (now - lastFull > FULL_MS && now - lastActive < IDLE_AFTER_MS);
  const { have, open } = known();
  const query = new URLSearchParams();
  // The timers' last runs are not in the check: on the pages that show them, the small part is always read.
  if (!all && have) query.set("have", JSON.stringify(TIMER_PAGES.some((p) => window.location.pathname.startsWith(p)) ? { ...have, rest: "" } : have));
  if (open) query.set("open", open);
  try {
    const answer = await request<StateAnswer>(`/api/state${query.size ? `?${query}` : ""}`);
    if (all) lastFull = Date.now();
    setState(answer);
  } catch (error) {
    toast(`Could not load the dashboard: ${(error as Error).message}`);
  }
}

// Conversations being fetched whole right now.
const fetching = new Set<string>();

/** Fetches the rest of a conversation that came with only its newest messages, once it is opened. */
async function loadWhole(id: string) {
  if (!raw?.inbox.find((c) => c.id === id)?.partial || fetching.has(id)) return;
  fetching.add(id);
  try {
    const { conversation } = await request<{ conversation: Conversation | null }>(`/api/conversation?id=${encodeURIComponent(id)}`);
    // Only over the short copy it was fetched for: a newer read may have brought it whole meanwhile.
    if (!conversation || !raw?.inbox.some((c) => c.id === id && c.partial)) return;
    raw = { ...raw, inbox: raw.inbox.map((c) => (c.id === id ? conversation : c)) };
    render();
  } catch {
    // The newest messages stay on screen; the next read brings the rest.
  } finally {
    fetching.delete(id);
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
  void refresh(true);
  // New messages and calls arrive on the server's timers; this picks them up, but only while
  // the page is on screen (see CHECK_MS).
  const idle = () => Date.now() - lastActive > IDLE_AFTER_MS;
  setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - lastRead >= (idle() ? IDLE_CHECK_MS : CHECK_MS)) void refresh();
  }, 15_000);
  // Back on the page after a while away: look at once.
  const back = () => {
    if (document.visibilityState === "visible" && Date.now() - lastRead > 30_000) void refresh();
  };
  document.addEventListener("visibilitychange", back);
  const active = () => {
    const wasIdle = idle();
    lastActive = Date.now();
    if (wasIdle) back();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(type, active, { passive: true });
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
    setState(await request<StateAnswer>("/api/action", { type, args, ...known() }));
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

export function openConversation(id: string | null) {
  setUi({ openConversation: id });
  if (id) void loadWhole(id);
}

// When each conversation's threads were last read, so opening and closing it does not ask Slack every time.
const threadsRead = new Map<string, number>();
const THREADS_EVERY_MS = 2 * 60_000;

/**
 * Reads the threads under an open conversation's messages from Slack. The hourly check only
 * brings in threads the owner is part of; this fills in the rest for the one being looked at.
 */
export async function readThreads(id: string) {
  if (!(id.startsWith("slack:") || id.startsWith("telegram:")) || Date.now() - (threadsRead.get(id) ?? 0) < THREADS_EVERY_MS) return;
  threadsRead.set(id, Date.now());
  setUi({ checking: [...ui.checking, id] });
  try {
    const { state } = await request<{ added: number; state?: StateAnswer }>("/api/threads", { id, have: known().have });
    if (state) setState(state);
  } catch {
    // Not worth interrupting the person: what is already on screen stays, and it is tried again later.
    threadsRead.delete(id);
  } finally {
    setUi({ checking: ui.checking.filter((x) => x !== id) });
  }
}

export const setConversationPriority = (id: string, pri: Priority) => void act("setConversationPriority", [id, pri], undefined, inInbox(id, { pri }));
export const setConversationMode = (id: string, mode: Mode) => void act("setConversationMode", [id, mode], mode === "personal" ? "Moved to Personal" : "Moved to Professional", inInbox(id, { mode }));

/**
 * Adds the reply to the conversation. It goes out from the owner's own account, if sending is
 * on. `thread` puts it in that Slack thread; without it, it is a new message in the chat.
 */
/** Answers an email row by email, to whoever wrote last, or with `replyAll` to everyone on it. */
export function replyEmail(id: string, text: string, markDone: boolean, replyAll: boolean) {
  if (markDone) setUi({ openConversation: null });
  void act("replyEmail", [id, text, markDone, replyAll], app?.state.sendingEnabled ? "Email sent" : "Email saved. Sending is switched off, so it waits in the outbox.");
}

/** A new email from one of the connected Google accounts. Resolves to an error message, or null once it is on its way. */
export async function composeEmail(account: string, to: string, cc: string, subject: string, body: string): Promise<string | null> {
  try {
    setState(await request<StateAnswer>("/api/action", { type: "composeEmail", args: [account, to, cc, subject, body], ...known() }));
    toast(app?.state.sendingEnabled ? "Email sent" : "Email saved. Sending is switched off, so it waits in the outbox.");
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

type EventFields = { account: string; title: string; start: number; end: number; timeZone: string; guests: string; meet: boolean; description: string };

/** Changes an event you made. Resolves to an error message, or null once it is changed. */
export async function updateCalendarEvent(eventId: string, form: EventFields): Promise<string | null> {
  try {
    const { state, title } = await request<{ state: AppState; title: string }>("/api/google/event", { action: "update", eventId, ...form });
    setState(state);
    toast(`Changed: ${title}${form.guests.trim() ? ". Guests are told." : ""}`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Deletes an event you made. Resolves to an error message, or null once it is gone. */
export async function deleteCalendarEvent(account: string, eventId: string): Promise<string | null> {
  try {
    const { state, title } = await request<{ state: AppState; title: string }>("/api/google/event", { action: "delete", account, eventId });
    setState(state);
    toast(`Deleted: ${title}`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

const ANSWERED: Record<string, string> = { accepted: "Going", tentative: "Maybe", declined: "Not going" };

/** Answers an invitation. Resolves to an error message, or null once the organizer has the answer. */
export async function respondToEvent(account: string, eventId: string, answer: "accepted" | "tentative" | "declined"): Promise<string | null> {
  try {
    const { state, title } = await request<{ state: AppState; title: string }>("/api/google/event", { action: "respond", account, eventId, answer });
    setState(state);
    toast(`${ANSWERED[answer]}: ${title}. The organizer is told.`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** New event on the Calendar tab. Resolves to an error message, or null once it is on the calendar. */
export async function addCalendarEvent(form: { account: string; title: string; start: number; end: number; timeZone: string; guests: string; meet: boolean; description: string }): Promise<string | null> {
  try {
    const { state, title } = await request<{ state: AppState; title: string }>("/api/google/event", form);
    setState(state);
    toast(`Added to your calendar: ${title}${form.guests.trim() ? ". Guests get an invitation from Google." : ""}`);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** Answers true once the reply is in the outbox. `pictures` were added to it with `addPicture`. */
export function sendReply(id: string, text: string, markDone: boolean, thread: string | null = null, pictures: AddedPicture[] = []): Promise<boolean> {
  if (markDone) setUi({ openConversation: null });
  return act("sendReply", pictures.length ? [id, text, markDone, thread, pictures] : [id, text, markDone, thread], app?.state.sendingEnabled ? "Reply sent" : "Reply saved. Sending is switched off, so it waits in the outbox.");
}

/** Keeps a picture for a reply until the reply is sent. Answers where it is kept, or why it could not be. */
export async function addPicture(picture: Blob): Promise<{ key: string } | { error: string }> {
  try {
    const res = await fetch("/api/media", { method: "POST", headers: { "Content-Type": picture.type }, body: picture });
    const data = (await res.json().catch(() => ({ error: `The server answered ${res.status}` }))) as { key?: string; error?: string };
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (res.status === 401) window.location.assign("/login");
    return res.ok && data.key ? { key: data.key } : { error: data.error ?? `The server answered ${res.status}` };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export const markConversationDone = (id: string) => void act("markConversationDone", [id], "Marked done", inInbox(id, { done: true }));
export const restoreConversation = (id: string) => void act("restoreConversation", [id], "Back in the inbox", inInbox(id, { done: false }));
/** The same change to every conversation picked on screen. */
export function editConversations(ids: string[], change: ConversationChange) {
  if (!ids.length) return;
  const n = ids.length === 1 ? "1 conversation" : `${ids.length} conversations`;
  const said =
    change.done === true ? `${n} marked done` : change.done === false ? `${n} back in the inbox` : change.pri ? `${n} set to ${PRIORITY_NAME[change.pri]}` : `${n} moved to ${MODE_NAME[change.mode ?? "professional"]}`;
  const patch = { ...(change.done !== undefined && { done: change.done }), ...(change.pri && { pri: change.pri, manualPri: true }), ...(change.mode && { mode: change.mode }) };
  const picked = new Set(ids);
  void act("editConversations", [ids, change], said, (s) => ({ ...s, inbox: s.inbox.map((c) => (picked.has(c.id) ? { ...c, ...patch } : c)) }));
}
export const conversationToTask = (id: string, today: string) => void act("conversationToTask", [id, today], "Task added, due today", inInbox(id, { done: true }));

const delegated = () => (app?.state.sendingEnabled ? "Assigned. They have been told on Slack." : "Assigned. Their Slack message waits in the outbox, because sending is off.");

const delegatedIn = (where: AssignWhere) => (where === "chat" ? (app?.state.sendingEnabled ? "Assigned. They have been told in the chat." : "Assigned. The message for the chat waits in the outbox, because sending is off.") : delegated());

export function delegateConversation(id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
  setUi({ openConversation: null });
  void act("delegateConversation", [id, personId, note, due, where], delegatedIn(where), inInbox(id, { done: true }));
}

// ---------- Tasks ----------

export const openTask = (id: string | null) => setUi({ openTask: id });

export const addTask = (input: Pick<Task, "title" | "description" | "dept" | "project" | "pri" | "due" | "mode">) => void act("addTask", [input], "Task added");
export const actionItemToTask = (meetingId: string, index: number) => void act("actionItemToTask", [meetingId, index], "Task added");
export const toggleTask = (id: string, done: boolean) => void act("toggleTask", [id, done], done ? "Task done" : undefined, inTasks(id, { done, doneAt: done ? Date.now() : null, status: done ? "done" : "open" }));

// The board, shared by the team. Each answers true once the change is saved.
export const createTicket = (input: TicketInput) => act("createTicket", [input], "Ticket added");
export const updateTicket = (id: string, patch: Partial<TicketInput>, said?: string) =>
  act("updateTicket", [id, patch], said, inTasks(id, { ...(patch.status && { status: patch.status, done: patch.status === "done" }), ...(patch.title !== undefined && { title: patch.title }), ...(patch.due && { due: patch.due }) }));

// The review, shared by the team.
const outOfReview = (ids: string[]) => (s: AppState): AppState => ({ ...s, review: s.review.filter((g) => !ids.includes(g.id)) });
export const acceptReview = (id: string, input?: Partial<TicketInput>) => act("acceptSuggestion", input ? [id, input] : [id], "Ticket made", outOfReview([id]));
export const rejectReview = (id: string, reason: RejectReason) => act("rejectSuggestion", [id, reason], "Turned down", outOfReview([id]));
export const mergeReview = (id: string, ticketId: string) => act("mergeSuggestion", [id, ticketId], "Merged into the ticket", outOfReview([id]));
/** Keeps a client name for the team, so it can be picked next time. */
export const addClient = (name: string) => act("addClient", [name], `Client added: ${name.trim()}`, (s) => ({ ...s, clients: [...new Set([...s.clients, name.trim()])].sort((a, b) => a.localeCompare(b)) }));
/** Puts back what the AI set aside as not a task. */
export const restoreReview = (id: string) => act("restoreSuggestion", [id], "Put back for review", (s) => ({ ...s, setAside: s.setAside.filter((g) => g.id !== id) }));
export const reviewMany = (ids: string[], decision: "accept" | RejectReason) =>
  act("reviewMany", [ids, decision], decision === "accept" ? `${ids.length} ${ids.length === 1 ? "ticket" : "tickets"} made` : `${ids.length} turned down`, outOfReview(ids));
export const setTaskPriority = (id: string, pri: Priority) => void act("setTaskPriority", [id, pri], undefined, inTasks(id, { pri }));
export const setTaskDescription = (id: string, description: string) => void act("setTaskDescription", [id, description], "Description saved", inTasks(id, { description: description.trim() }));
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
/** One period's focus items changed at once, on both sides of the dashboard. */
const inFocus = (scope: FocusScope, key: string, change: (items: AppState["focus"]["professional"]["day"][string]) => AppState["focus"]["professional"]["day"][string]) => (s: AppState): AppState => ({
  ...s,
  focus: Object.fromEntries(Object.entries(s.focus).map(([mode, board]) => [mode, { ...board, [scope]: { ...board[scope], [key]: change(board[scope][key] ?? []) } }])) as AppState["focus"],
});
export const toggleFocus = (scope: FocusScope, key: string, id: string, done: boolean) =>
  void act("toggleFocus", [scope, key, id, done], undefined, inFocus(scope, key, (items) => items.map((f) => (f.id === id ? { ...f, done } : f))));
export const removeFocus = (scope: FocusScope, key: string, id: string) => void act("removeFocus", [scope, key, id], undefined, inFocus(scope, key, (items) => items.filter((f) => f.id !== id)));
export const addLink = (label: string, url: string) => void act("addLink", [label, url, ui.mode], "Link added");
export const removeLink = (id: string) => void act("removeLink", [id], undefined, (s) => ({ ...s, links: s.links.filter((l) => l.id !== id) }));

// ---------- Targets ----------

/** Saves the numbers typed in for one day. An empty field clears that day's value. */
export const saveLogs = (day: number, values: Record<string, number | null>) => void act("saveLogs", [day, values], "Today's numbers saved");
export const saveTargets = (values: Record<string, number>) => void act("saveTargets", [values], "Targets saved");

// ---------- App keys ----------

/**
 * Saves this person's own app keys for Google, Telegram or the AI, after the server has checked
 * them, or with `keys` null stops using their own. Resolves to an error message, or null when done.
 */
export async function saveAppKeys(provider: "google" | "telegram" | "anthropic" | "slack", keys: Record<string, string> | null): Promise<string | null> {
  try {
    const { state } = await request<{ state: AppState }>("/api/keys", keys ? { step: "save", provider, keys } : { step: "stop", provider });
    setState(state);
    toast(keys ? "Keys saved. New connections use them; accounts already connected keep theirs." : "Back to the team's keys for new connections.");
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------- Settings ----------

// Team logins, the owner's alone. Each resolves to true once it is saved.
export const addTeamLogin = (name: string, email: string, password: string) => act("addTeamLogin", [name, email, password], `${name.trim()} can sign in now`);
export const setTeamPassword = (id: string, name: string, password: string) => act("setTeamPassword", [id, password], `New password saved. ${name} signs in with it from now on`);
export const turnOffTeamLogin = (id: string, name: string) => void act("turnOffTeamLogin", [id], `${name} can no longer sign in`);
export const removeTeamLogin = (id: string, name: string) => void act("removeTeamLogin", [id], `${name}'s login and everything of theirs are removed`);

// Task logins, the owner's alone: someone on the team list signs in to see only their own tasks.
// An empty password means Google only. Resolves to true once it is saved.
export const setTaskLogin = (personId: string, name: string, email: string, password: string) =>
  act("setTaskLogin", [personId, email, password], `${name} can sign in to see their tasks${password ? "" : " with Google"}`);
/** One person on the team list changed at once. */
const inTeam = (personId: string, change: (p: Person) => Person | null) => (s: AppState): AppState => ({
  ...s,
  team: s.team.flatMap((p) => (p.id === personId ? (change(p) ?? []) : [p])),
});
export const removeTaskLogin = (personId: string, name: string) =>
  void act("removeTaskLogin", [personId], `${name} can no longer sign in`, inTeam(personId, (p) => ({ ...p, taskLogin: undefined })));

export const togglePersonDept = (personId: string, dept: string) =>
  void act("togglePersonDept", [personId, dept], undefined, inTeam(personId, (p) => ({ ...p, depts: p.depts.includes(dept) ? p.depts.filter((d) => d !== dept) : [...p.depts, dept] })));
export const addHandle = (personId: string, handle: string) => void act("addHandle", [personId, handle]);
export const removeHandle = (personId: string, index: number) => void act("removeHandle", [personId, index], undefined, inTeam(personId, (p) => ({ ...p, handles: p.handles.filter((_, k) => k !== index) })));
export const addPerson = (input: Omit<Person, "id">) => void act("addPerson", [input], `Added ${input.name}`);
export const removePerson = (personId: string) => void act("removePerson", [personId], "Removed", inTeam(personId, () => null));
export const setPersonTelegram = (personId: string, telegramId: string) =>
  void act("setPersonTelegram", [personId, telegramId], telegramId ? "Telegram linked" : "Telegram taken away", inTeam(personId, (p) => ({ ...p, telegramId: telegramId || null })));

export type RuleKind = "labelRules" | "priorityRules";
export const addRule = (kind: RuleKind, rule: Omit<Rule, "id">) => void act("addRule", [kind, rule], "Rule added");
export const moveRule = (kind: RuleKind, id: string, direction: -1 | 1) => void act("moveRule", [kind, id, direction]);
export const deleteRule = (kind: RuleKind, id: string) => void act("deleteRule", [kind, id], "Rule deleted");
export const clearManualPriorities = () => void act("clearManualPriorities", [], "Chats re-sorted by your rules");

export const setJobInterval = (id: JobId, minutes: number) => void act("setJobInterval", [id, minutes]);
export const setJobEnabled = (id: JobId, enabled: boolean) => void act("setJobEnabled", [id, enabled], undefined, (s) => ({ ...s, jobs: s.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)) }));
export const setChannelSelected = (id: string, selected: boolean) =>
  void act("setChannelSelected", [id, selected], undefined, (s) => ({ ...s, channels: s.channels.map((c) => (c.id === id ? { ...c, selected } : c)) }));

/** Ticks or unticks Telegram chats to come in. Unticked, a chat and its messages leave the dashboard at once. */
export function setTelegramSync(ids: string[], on: boolean, name?: string) {
  const what = name ?? `${ids.length} ${ids.length === 1 ? "chat" : "chats"}`;
  const one = ids.length === 1;
  void act(
    "setTelegramSync",
    [ids, on],
    on ? `${what} ${one ? "comes" : "come"} in from the next check, starting with the last few days` : `${what} no longer ${one ? "comes" : "come"} in. ${one ? "Its" : "Their"} messages were removed from the dashboard.`,
    (s) => ({
      ...s,
      telegramChats: s.telegramChats.map((c) => (ids.includes(c.id) ? { ...c, synced: on } : c)),
      inbox: on ? s.inbox : s.inbox.filter((c) => c.source !== "telegram" || !ids.includes(c.id.slice("telegram:".length))),
    }),
  );
}
/** Ticks something as important: its messages go to the top of the inbox. */
export const setImportant = (source: "slack" | "telegram", kind: "chat" | "person", id: string, name: string, on: boolean) =>
  void act("setImportant", [source, kind, id, name, on], on ? `${name} is important: its messages go to the top of the inbox` : `${name} is no longer important`, (s) => ({
    ...s,
    important: [...s.important.filter((i) => !(i.source === source && i.kind === kind && i.id === id)), ...(on ? [{ source, kind, id, name }] : [])],
  }));

/**
 * Picks Agency, Consulting or Sales for a Slack channel, Telegram group or person, for the whole
 * team: the tasks from it are labelled so. Null takes the pick away. Shown at once.
 */
export const setChatLine = (source: "slack" | "telegram", kind: "chat" | "person", id: string, name: string, line: TaskLine | null) =>
  void act("setChatLine", [source, kind, id, name, line], line ? `${name}: ${TASK_LINE_NAME[line]}` : `${name}: no line`, (s) => ({
    ...s,
    chatLines: [...s.chatLines.filter((l) => !(l.source === source && l.kind === kind && l.id === id)), ...(line ? [{ source, kind, id, name, line }] : [])],
  }));

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

/** What the Telegram login needs next, or that it is done. */
export type TelegramReply =
  | { need: "code"; viaApp: boolean; email?: string; error?: string }
  | { need: "password"; hint?: string; error?: string }
  | { connected: true; label: string }
  | { failed: string };

/**
 * One step of connecting Telegram: the phone number, the code, or the password. What is typed
 * goes straight to the server on this machine and is never kept in the browser.
 */
export async function telegramStep(body: { step: "start"; phone: string } | { step: "code"; code: string } | { step: "password"; password: string } | { step: "cancel" }): Promise<TelegramReply> {
  try {
    const reply = await request<TelegramReply & { state?: AppState }>("/api/telegram", body);
    if ("connected" in reply) {
      if (reply.state) setState(reply.state);
      toast(`Telegram connected: ${reply.label}. Reading it now.`);
      // The first read runs in the background on the server; look again once it has had time.
      setTimeout(() => void refresh(), 12_000);
    }
    return reply;
  } catch (error) {
    return { failed: (error as Error).message };
  }
}

/** Ends one Google account's login, on Google's side too. `forget` also deletes the emails that were read from it. */
export async function disconnectGoogle(email: string, forget: boolean) {
  try {
    const { state } = await request<{ state: AppState }>("/api/google", { step: "disconnect", email, forget });
    setState(state);
    toast(forget ? `${email} disconnected, and its emails removed` : `${email} disconnected`);
  } catch (error) {
    toast((error as Error).message);
  }
}

/** Signs out of Telegram and removes the saved login. `forget` also deletes the chats that were read, and their pictures. */
export async function disconnectTelegram(forget: boolean) {
  try {
    const { state } = await request<{ state: AppState }>("/api/telegram", { step: "disconnect", forget });
    setState(state);
    toast(forget ? "Telegram disconnected, and its chats removed" : "Telegram disconnected");
  } catch (error) {
    toast((error as Error).message);
  }
}
