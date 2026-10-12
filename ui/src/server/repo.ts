// Reads and writes for the dashboard. `loadState` builds what the screens show; `ACTIONS`
// holds every change a person can make. Jobs write through their own modules in `src/jobs`.
import crypto from "node:crypto";
import { PERSONAL } from "@/core/config";
import { assignmentText, canAssignInChat, SLACK_PICK, type AssignWhere } from "@/core/delegation";
import { addDays, isoDay, monthKey, pad } from "@/core/dates";
import { clampInterval, defaultJobSettings, JOBS } from "@/core/jobs";
import { requestSummary } from "@/core/requests";
import { applyRules } from "@/core/rules";
import type {
  AppState, Conversation, FocusBoard, JobId, JobStatus, Meeting, Metric, Mode, Person, Priority, Provider, Rule, Suggestion, Task,
} from "@/core/types";
import { aiConfigured } from "./ai";
import type { Db } from "./db";

/** Phase 1 has one person. Every table already carries the owner, so more can be added later. */
export const OWNER_ID = "owner";

export const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const sendingEnabled = () => process.env.SENDING_ENABLED === "true";

// Starting targets, copied from Jeremy's prototype. He changes them on the Targets tab.
const STARTING_METRICS: Metric[] = [
  { id: "calls", name: "Calls Booked", target: 60, unit: "n" },
  { id: "dms", parent: "calls", name: "Outbound DMs sent", target: 1500, unit: "n" },
  { id: "inbound", parent: "calls", name: "Inbound leads from content", target: 90, unit: "n" },
  { id: "cash", name: "Client Cash Collected", target: 85000, unit: "$" },
  { id: "invoiced", parent: "cash", name: "Invoices issued", target: 95000, unit: "$" },
  { id: "ontime", parent: "cash", name: "Invoices paid on time", target: 22, unit: "n" },
  { id: "revenue", name: "Overall Agency Revenue", target: 120000, unit: "$" },
  { id: "deals", parent: "revenue", name: "New deals closed", target: 6, unit: "n" },
  { id: "upsells", parent: "revenue", name: "Upsell / expansion revenue", target: 15000, unit: "$" },
  { id: "held", parent: "revenue", name: "Sales calls held", target: 48, unit: "n" },
];

/** Creates the owner and their starting settings the first time the server runs. */
export async function ensureOwner(db: Db, ownerId = OWNER_ID): Promise<void> {
  const now = Date.now();
  await db.run("insert into users (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing", [ownerId, process.env.OWNER_NAME ?? "You", now]);
  for (const job of defaultJobSettings()) {
    await db.run("insert into jobs (owner_id, job_id, interval_min) values ($1, $2, $3) on conflict do nothing", [ownerId, job.id, job.intervalMin]);
  }
  const [{ n: rules }] = await db.query<{ n: number }>("select count(*)::int as n from rules where owner_id = $1", [ownerId]);
  if (rules === 0) {
    // Sensible starting point: being tagged is urgent, a direct message comes next.
    await db.run("insert into rules (id, owner_id, kind, position, source, match_on, pri) values ($1, $2, 'priority', 0, 'any', 'tagged', 'high')", [uid("r"), ownerId]);
    await db.run("insert into rules (id, owner_id, kind, position, source, match_on, pri) values ($1, $2, 'priority', 1, 'any', 'direct', 'mid')", [uid("r"), ownerId]);
  }
  const [{ n: metrics }] = await db.query<{ n: number }>("select count(*)::int as n from metrics where owner_id = $1", [ownerId]);
  if (metrics === 0) {
    for (const [position, m] of STARTING_METRICS.entries()) {
      await db.run("insert into metrics (owner_id, id, parent, name, target, unit, is_sum, position) values ($1, $2, $3, $4, $5, $6, false, $7)", [ownerId, m.id, m.parent ?? null, m.name, m.target, m.unit, position]);
    }
  }
}

// ---------- Reading ----------

interface ConversationRow {
  id: string; source: Conversation["source"]; from_name: string; ctx: string; direct: boolean; tagged: boolean;
  last_text: string; last_at: number; pri: Priority; line: Conversation["line"]; mode: Mode; project: string; done: boolean; replied: boolean; manual_pri: boolean; manual_mode: boolean;
}
interface MessageRow { conversation_id: string; sender_name: string; me: boolean; body: string; at: number; status: "queued" | "sent" | "failed" | null }
interface TaskRow {
  id: string; title: string; mode: Mode; dept: string; project: string; pri: Priority; due: string; done: boolean; done_at: number | null;
  src_type: "message" | "meeting" | null; src_id: string | null; delegable: boolean;
  delegated_to: string | null; delegated_name: string | null; delegated_role: string | null; delegated_note: string | null; delegated_at: number | null;
}
interface RuleRow { id: string; kind: "priority" | "label"; source: Rule["source"]; match_on: Rule["when"]; op: Rule["op"]; value: string; pri: Priority | null; line: Rule["line"] | null; mode: Mode | null }

const THREAD_LENGTH = 30;

const toRule = (r: RuleRow): Rule => ({ id: r.id, source: r.source, when: r.match_on, op: r.op, value: r.value, pri: r.pri ?? undefined, line: r.line ?? undefined, mode: r.mode ?? undefined });

const toTask = (t: TaskRow): Task => ({
  id: t.id, title: t.title, mode: t.mode, dept: t.dept, project: t.project, pri: t.pri, due: t.due, done: t.done, doneAt: t.done_at,
  src: t.src_type && t.src_id ? { type: t.src_type, id: t.src_id } : null,
  delegable: t.delegable,
  delegatedTo: t.delegated_to ? { personId: t.delegated_to, name: t.delegated_name ?? "", role: t.delegated_role ?? "", note: t.delegated_note ?? "", at: t.delegated_at ?? 0 } : null,
});

export async function loadRules(db: Db, ownerId: string): Promise<{ labelRules: Rule[]; priorityRules: Rule[] }> {
  const rows = await db.query<RuleRow>("select * from rules where owner_id = $1 order by position", [ownerId]);
  return { labelRules: rows.filter((r) => r.kind === "label").map(toRule), priorityRules: rows.filter((r) => r.kind === "priority").map(toRule) };
}

// Everything still open, plus what was cleared lately so links back to it keep working.
const SHOWN = `(select id from conversations where owner_id = $1 and not done order by last_at desc limit 300)
               union all
               (select id from conversations where owner_id = $1 and done order by last_at desc limit 100)`;

async function loadConversations(db: Db, ownerId: string): Promise<Conversation[]> {
  // Both reads go out together. Only the newest messages of each conversation are fetched:
  // a busy channel can hold thousands.
  const [rows, messages] = await Promise.all([
    db.query<ConversationRow>(`select * from conversations where id in (${SHOWN})`, [ownerId]),
    db.query<MessageRow>(
      `select conversation_id, sender_name, me, body, at, status from (
         select m.*, row_number() over (partition by m.conversation_id order by m.at desc, m.id desc) as newest
         from messages m where m.conversation_id in (${SHOWN})
       ) latest where newest <= $2 order by at, id`,
      [ownerId, THREAD_LENGTH],
    ),
  ]);
  const threads = new Map<string, Conversation["thread"]>();
  for (const m of messages) {
    const thread = threads.get(m.conversation_id) ?? [];
    thread.push({ me: m.me, text: m.body, at: m.at, from: m.me ? undefined : m.sender_name, status: m.status === "failed" ? "queued" : (m.status ?? undefined) });
    threads.set(m.conversation_id, thread);
  }
  return rows.map((r) => ({
    id: r.id, source: r.source, from: r.from_name, ctx: r.ctx, direct: r.direct, tagged: r.tagged, text: r.last_text, at: r.last_at,
    pri: r.pri, line: r.line, mode: r.mode, project: r.project, done: r.done, replied: r.replied, manualPri: r.manual_pri || undefined, manualMode: r.manual_mode || undefined,
    thread: threads.get(r.id) ?? [],
  }));
}

interface MeetingRow {
  id: string; title: string; started_at: number; duration_min: number; who: string; place: string; project: string; url: string | null;
  summary: string; action_items: Meeting["actionItems"]; lines: number;
}

async function loadMeetings(db: Db, ownerId: string): Promise<Meeting[]> {
  // Transcripts are long, so they are fetched one at a time when a person opens one.
  const rows = await db.query<MeetingRow>(
    `select id, title, started_at, duration_min, who, place, project, url, summary, action_items, jsonb_array_length(transcript) as lines
     from meetings where owner_id = $1 order by started_at desc limit 60`,
    [ownerId],
  );
  return rows.map((m) => {
    const start = new Date(Number(m.started_at));
    return {
      id: m.id, title: m.title, date: isoDay(start), time: `${pad(start.getHours())}:${pad(start.getMinutes())}`, dur: m.duration_min,
      who: m.who, where: m.place, project: m.project, url: m.url, summary: m.summary, actionItems: m.action_items ?? [], transcript: [], transcriptLines: m.lines,
    };
  });
}

export async function loadTranscript(db: Db, ownerId: string, meetingId: string): Promise<[string, string][]> {
  const [row] = await db.query<{ transcript: [string, string][] }>("select transcript from meetings where owner_id = $1 and id = $2", [ownerId, meetingId]);
  return row?.transcript ?? [];
}

async function loadJobStatus(db: Db, ownerId: string): Promise<AppState["jobStatus"]> {
  const [jobs, runs] = await Promise.all([
    db.query<{ job_id: JobId; last_run_at: number | null; not_before: number | null }>("select job_id, last_run_at, not_before from jobs where owner_id = $1", [ownerId]),
    db.query<{ job_id: JobId; ok: boolean | null; items: number; message: string | null }>(
      "select distinct on (job_id) job_id, ok, items, message from job_runs where owner_id = $1 order by job_id, started_at desc, id desc",
      [ownerId],
    ),
  ]);
  const status: AppState["jobStatus"] = {};
  for (const j of jobs) {
    const last = runs.find((r) => r.job_id === j.job_id);
    status[j.job_id] = { lastRunAt: j.last_run_at, notBefore: j.not_before, ok: last?.ok ?? null, items: last?.items ?? 0, message: last?.message ?? null } satisfies JobStatus;
  }
  return status;
}

export async function loadState(db: Db, ownerId = OWNER_ID, now = new Date()): Promise<AppState> {
  const month = monthKey(now);
  const today = isoDay(now);
  // Every read is independent, so they go out together: one wait instead of twenty.
  const [
    [owner],
    { labelRules, priorityRules },
    tasks,
    suggestions,
    team,
    metrics,
    logRows,
    focusRows,
    links,
    outbox,
    jobs,
    connections,
    channels,
    slackPeople,
    projects,
    inbox,
    meetings,
    jobStatus,
  ] = await Promise.all([
    db.query<{ name: string }>("select name from users where id = $1", [ownerId]),
    loadRules(db, ownerId),
    db.query<TaskRow>("select * from tasks where owner_id = $1 order by created_at, id limit 1000", [ownerId]),
    db.query<{ id: string; title: string; mode: Mode; dept: string; project: string; pri: Priority; due: string; why: string; src_type: "message" | "meeting" | null; src_id: string | null; status: Suggestion["status"]; delegable: boolean }>(
      "select * from suggestions where owner_id = $1 and (status = 'new' or created_at > $2) order by created_at desc limit 300",
      [ownerId, now.getTime() - 14 * 86_400_000],
    ),
    db.query<{ id: string; name: string; role: string; depts: string[]; handles: string[]; slack_user_id: string | null }>("select * from team_members where owner_id = $1 order by position, name", [ownerId]),
    db.query<{ id: string; parent: string | null; name: string; target: number; unit: Metric["unit"]; is_sum: boolean }>("select * from metrics where owner_id = $1 order by position", [ownerId]),
    db.query<{ metric_id: string; day: string; value: number }>("select metric_id, day, value from metric_logs where owner_id = $1 and day like $2", [ownerId, `${month}-%`]),
    db.query<{ id: string; scope: "day" | "week"; period: string; body: string; done: boolean; mode: Mode }>("select * from focus_items where owner_id = $1 and period >= $2 order by position", [ownerId, addDays(now, -14)]),
    db.query<{ id: string; label: string; url: string; mode: Mode }>("select id, label, url, mode from quick_links where owner_id = $1 order by position", [ownerId]),
    db.query<{ id: string; source: "slack" | "telegram"; to_name: string; ctx: string; body: string; created_at: number; status: "queued" | "sent" | "failed"; conversation_id: string | null; task_id: string | null }>(
      "select * from outbox where owner_id = $1 order by created_at desc limit 100",
      [ownerId],
    ),
    db.query<{ job_id: JobId; interval_min: number; enabled: boolean }>("select job_id, interval_min, enabled from jobs where owner_id = $1", [ownerId]),
    db.query<{ provider: Provider; label: string | null; connected_at: number }>("select provider, label, connected_at from connections where owner_id = $1", [ownerId]),
    db.query<{ id: string; name: string; kind: "public" | "private"; selected: boolean }>("select id, name, kind, selected from slack_channels where owner_id = $1 and kind in ('public', 'private') order by name", [ownerId]),
    db.query<{ id: string; name: string }>("select id, name from slack_users where owner_id = $1 and not is_bot and not deleted order by name", [ownerId]),
    db.query<{ project: string }>(
      "select distinct project from (select project from tasks where owner_id = $1 union select project from meetings where owner_id = $1 union select project from conversations where owner_id = $1) p where project <> '' order by project",
      [ownerId],
    ),
    loadConversations(db, ownerId),
    loadMeetings(db, ownerId),
    loadJobStatus(db, ownerId),
  ]);

  const logs: AppState["logs"] = {};
  for (const l of logRows) (logs[l.metric_id] ??= {})[Number(l.day.slice(8))] = Number(l.value);
  const board = (): FocusBoard => ({ day: {}, week: {} });
  const focus: AppState["focus"] = { professional: board(), personal: board() };
  for (const f of focusRows) (focus[f.mode][f.scope][f.period] ??= []).push({ id: f.id, text: f.body, done: f.done });
  const connection = (p: Provider) => {
    const row = connections.find((c) => c.provider === p);
    return row ? { connected: true, connectedAt: Number(row.connected_at), label: row.label ?? undefined } : { connected: false };
  };

  return {
    month,
    inbox,
    tasks: tasks.map(toTask),
    suggestions: suggestions.map((g) => ({
      // A call from last week suggests a date that has passed: offer today instead.
      id: g.id, title: g.title, mode: g.mode, dept: g.dept, project: g.project, pri: g.pri, due: g.status === "new" && g.due < today ? today : g.due, why: g.why,
      src: g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null, status: g.status, delegable: g.delegable,
    })),
    meetings,
    team: team.map((p): Person => ({ id: p.id, name: p.name, role: p.role, depts: p.depts ?? [], handles: p.handles ?? [], slackUserId: p.slack_user_id })),
    projects: projects.map((p) => p.project),
    labelRules,
    priorityRules,
    metrics: metrics.map((m) => ({ id: m.id, parent: m.parent ?? undefined, name: m.name, target: Number(m.target), unit: m.unit, sum: m.is_sum || undefined })),
    logs,
    focus,
    links,
    outbox: outbox.map((o) => ({ id: o.id, source: o.source, to: o.to_name, ctx: o.ctx, text: o.body, at: Number(o.created_at), status: o.status, conversationId: o.conversation_id ?? undefined, taskId: o.task_id ?? undefined })),
    jobs: JOBS.map((def) => {
      const row = jobs.find((j) => j.job_id === def.id);
      return { id: def.id, intervalMin: row?.interval_min ?? def.defaultMin, enabled: row?.enabled ?? true };
    }),
    connections: { slack: connection("slack"), telegram: connection("telegram"), fathom: connection("fathom") },
    jobStatus,
    channels,
    slackPeople,
    owner: { name: owner?.name ?? "You" },
    sendingEnabled: sendingEnabled(),
    aiConfigured: aiConfigured(),
  };
}

// ---------- Sorting ----------

/** Re-applies the rules to every open conversation and saves what changed. */
export async function resortInbox(db: Db, ownerId: string): Promise<number> {
  const { labelRules, priorityRules } = await loadRules(db, ownerId);
  const rows = await db.query<ConversationRow>("select * from conversations where owner_id = $1 and not done", [ownerId]);
  const before = rows.map((r) => ({ id: r.id, source: r.source, from: r.from_name, ctx: r.ctx, direct: r.direct, tagged: r.tagged, pri: r.pri, line: r.line, mode: r.mode, manualPri: r.manual_pri, manualMode: r.manual_mode }) as Conversation);
  const after = applyRules(before, labelRules, priorityRules);
  let changed = 0;
  for (const [k, c] of after.entries()) {
    if (c.pri === before[k].pri && c.line === before[k].line && c.mode === before[k].mode) continue;
    await db.run("update conversations set pri = $1, line = $2, mode = $3 where id = $4", [c.pri, c.line, c.mode, c.id]);
    // A suggestion waiting on this chat moves to the same side as the chat.
    await db.run("update suggestions set mode = $1 where owner_id = $2 and src_type = 'message' and src_id = $3 and status = 'new'", [c.mode, ownerId, c.id]);
    changed++;
  }
  return changed;
}

// ---------- Actions ----------

export interface ActionContext {
  db: Db;
  ownerId: string;
  now: Date;
}

type RuleKind = "labelRules" | "priorityRules";
const kindOf = (k: RuleKind) => (k === "labelRules" ? "label" : "priority");

const asMode = (value: unknown): Mode => (value === "personal" ? "personal" : "professional");

async function insertTask(c: ActionContext, t: { title: string; dept: string; project: string; pri: Priority; due: string; mode?: Mode; src?: { type: "message" | "meeting"; id: string } | null; delegable?: boolean }): Promise<string> {
  const id = uid("t");
  const mode = asMode(t.mode);
  // A personal task has no department or client: it is filed under "Personal".
  const [dept, project] = mode === "personal" ? [PERSONAL, PERSONAL] : [t.dept, t.project];
  await c.db.run(
    "insert into tasks (id, owner_id, title, dept, project, pri, due, src_type, src_id, delegable, mode, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    [id, c.ownerId, t.title, dept, project, t.pri, t.due, t.src?.type ?? null, t.src?.id ?? null, t.delegable ?? true, mode, c.now.getTime()],
  );
  return id;
}

interface Assignee { id: string; name: string; role: string; slack_user_id: string | null }

/**
 * Who a task is being assigned to. `personId` is someone on the team list, or "slack:<id>"
 * for a person picked straight from Slack, who is then added to the team list so they are
 * there next time.
 */
async function assignee(c: ActionContext, personId: string): Promise<Assignee> {
  if (!personId.startsWith(SLACK_PICK)) {
    const [person] = await c.db.query<Assignee>("select id, name, role, slack_user_id from team_members where owner_id = $1 and id = $2", [c.ownerId, personId]);
    if (!person) throw new Error("That task or person no longer exists.");
    return person;
  }
  const slackUserId = personId.slice(SLACK_PICK.length);
  const [known] = await c.db.query<Assignee>("select id, name, role, slack_user_id from team_members where owner_id = $1 and slack_user_id = $2 order by position limit 1", [c.ownerId, slackUserId]);
  if (known) return known;
  const [user] = await c.db.query<{ name: string }>("select name from slack_users where owner_id = $1 and id = $2 and not is_bot and not deleted", [c.ownerId, slackUserId]);
  if (!user) throw new Error("That person is no longer in Slack.");
  const person: Assignee = { id: uid("u"), name: user.name, role: "Team member", slack_user_id: slackUserId };
  await c.db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id, position) values ($1, $2, $3, $4, '[]', '[]', $5, $6)", [person.id, c.ownerId, person.name, person.role, slackUserId, Math.floor(c.now.getTime() / 1000)]);
  return person;
}

/**
 * Assigns a task to someone and queues the Slack message that tells them. The note is optional.
 * With `where` "chat" the message goes into the chat the task came from, tagging the person,
 * and shows in that conversation's thread; otherwise it is a direct message to them.
 */
async function delegate(c: ActionContext, taskId: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
  const person = await assignee(c, personId);
  const [task] = await c.db.query<{ title: string; src_type: string | null; src_id: string | null }>("select title, src_type, src_id from tasks where owner_id = $1 and id = $2", [c.ownerId, taskId]);
  if (!task) throw new Error("That task or person no longer exists.");
  const text = (who: string) => assignmentText({ where, who, title: task.title, due, note });
  const now = c.now.getTime();

  if (where === "chat") {
    const [chat] = task.src_type === "message"
      ? await c.db.query<{ id: string; source: string; external_id: string; ctx: string }>("select id, source, external_id, ctx from conversations where owner_id = $1 and id = $2", [c.ownerId, task.src_id])
      : [];
    if (!chat || !canAssignInChat(chat)) throw new Error("This task did not come from a channel or a group message, so it can only go as a direct message.");
    const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
    const messageId = uid("m");
    // In the dashboard the tag reads as a name; Slack needs the person's id to notify them.
    await c.db.run("insert into messages (id, conversation_id, owner_id, sender_name, me, body, at, status, scanned, asked) values ($1, $2, $3, $4, true, $5, $6, 'queued', true, true)", [messageId, chat.id, c.ownerId, owner?.name ?? "You", text(`@${person.name}`), now]);
    await c.db.run("update conversations set replied = true where id = $1", [chat.id]);
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, conversation_id, message_id, task_id, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [uid("o"), c.ownerId, chat.source, chat.external_id, person.name, chat.ctx, text(person.slack_user_id ? `<@${person.slack_user_id}>` : person.name), chat.id, messageId, taskId, now],
    );
  } else {
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, task_id, created_at) values ($1, $2, 'slack', $3, $4, 'Direct message', $5, $6, $7)",
      [uid("o"), c.ownerId, person.slack_user_id, person.name, text(person.name), taskId, now],
    );
  }
  await c.db.run("update tasks set due = $1, delegated_to = $2, delegated_name = $3, delegated_role = $4, delegated_note = $5, delegated_at = $6 where id = $7", [due, person.id, person.name, person.role, note, now, taskId]);
}

/** The task still open for a conversation, if there is one. One is enough. */
async function openTaskFor(c: ActionContext, conversationId: string) {
  const [task] = await c.db.query<{ id: string; delegated_to: string | null }>("select id, delegated_to from tasks where owner_id = $1 and src_type = 'message' and src_id = $2 and not done order by created_at limit 1", [c.ownerId, conversationId]);
  return task ?? null;
}

/** "Reply to Maya: …" without links or the owner's own tag in it. */
async function replyTitle(c: ActionContext, lead: string, text: string) {
  const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
  return `${lead}: ${requestSummary(text, `@${owner?.name ?? ""}`)}`;
}

/** Reads a conversation and holds it for this change, so two clicks on the same button cannot both act on it. */
async function conversation(c: ActionContext, id: string) {
  const [row] = await c.db.query<ConversationRow & { external_id: string }>("select * from conversations where owner_id = $1 and id = $2 for update", [c.ownerId, id]);
  if (!row) throw new Error("That conversation no longer exists.");
  return row;
}

// Each action is one change a person makes on screen. Arguments arrive from the browser as JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTIONS: Record<string, (c: ActionContext, ...args: any[]) => Promise<void>> = {
  // Inbox
  async setConversationPriority(c, id: string, pri: Priority) {
    await c.db.run("update conversations set pri = $1, manual_pri = true where owner_id = $2 and id = $3", [pri, c.ownerId, id]);
  },
  /** Moves a chat to the Personal or the Professional side. The rules leave it there. */
  async setConversationMode(c, id: string, mode: Mode) {
    await c.db.run("update conversations set mode = $1, manual_mode = true where owner_id = $2 and id = $3", [asMode(mode), c.ownerId, id]);
    await c.db.run("update suggestions set mode = $1 where owner_id = $2 and src_type = 'message' and src_id = $3 and status = 'new'", [asMode(mode), c.ownerId, id]);
  },
  async sendReply(c, id: string, text: string, markDone: boolean) {
    const conv = await conversation(c, id);
    const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
    const messageId = uid("m");
    await c.db.run("insert into messages (id, conversation_id, owner_id, sender_name, me, body, at, status, scanned) values ($1, $2, $3, $4, true, $5, $6, 'queued', true)", [messageId, id, c.ownerId, owner?.name ?? "You", text, c.now.getTime()]);
    await c.db.run("update conversations set replied = true, done = done or $1 where id = $2", [markDone, id]);
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, conversation_id, message_id, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [uid("o"), c.ownerId, conv.source, conv.external_id, conv.from_name, conv.ctx, text, id, messageId, c.now.getTime()],
    );
  },
  async markConversationDone(c, id: string) {
    await c.db.run("update conversations set done = true where owner_id = $1 and id = $2", [c.ownerId, id]);
  },
  async restoreInbox(c) {
    await c.db.run("update conversations set done = false where owner_id = $1 and done", [c.ownerId]);
  },
  async conversationToTask(c, id: string, today: string) {
    const conv = await conversation(c, id);
    // A second click, or a chat that already has its task, adds nothing.
    if (!(await openTaskFor(c, id))) {
      await insertTask(c, { title: await replyTitle(c, `Reply to ${conv.from_name}`, conv.last_text), dept: "Operations", project: conv.project, pri: conv.pri, due: today, mode: conv.mode, src: { type: "message", id } });
    }
    await c.db.run("update conversations set done = true where id = $1", [id]);
  },
  async delegateConversation(c, id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
    const conv = await conversation(c, id);
    const existing = await openTaskFor(c, id);
    // Already assigned: this is a second click on Assign.
    if (existing?.delegated_to) return;
    const person = await assignee(c, personId);
    const [team] = await c.db.query<{ depts: string[] }>("select depts from team_members where owner_id = $1 and id = $2", [c.ownerId, person.id]);
    const taskId = existing?.id ?? (await insertTask(c, { title: await replyTitle(c, `From ${conv.from_name}`, conv.last_text), dept: team?.depts?.[0] ?? "Operations", project: conv.project, pri: conv.pri, due, src: { type: "message", id } }));
    await delegate(c, taskId, person.id, note, due, where);
    await c.db.run("update conversations set done = true where id = $1", [id]);
  },

  // Tasks
  /** `assignTo` hands the new task straight to someone. Personal tasks stay with the owner. */
  async addTask(c, input: { title: string; dept: string; project: string; pri: Priority; due: string; mode?: Mode; assignTo?: string }) {
    const id = await insertTask(c, input);
    if (input.assignTo && asMode(input.mode) === "professional") await delegate(c, id, input.assignTo, "", input.due);
  },
  /** Turns one action item from a call into a task, once. Someone else's becomes a follow-up. */
  async actionItemToTask(c, meetingId: string, index: number) {
    const [meeting] = await c.db.query<{ project: string; action_items: Meeting["actionItems"] }>("select project, action_items from meetings where owner_id = $1 and id = $2", [c.ownerId, meetingId]);
    const item = meeting?.action_items?.[index];
    if (!item) throw new Error("That action item no longer exists.");
    const title = (item.mine ? item.text : `Follow up with ${item.who}: ${item.text}`).slice(0, 160);
    const [{ n }] = await c.db.query<{ n: number }>("select count(*)::int as n from tasks where owner_id = $1 and src_type = 'meeting' and src_id = $2 and title = $3", [c.ownerId, meetingId, title]);
    if (n > 0) return;
    await insertTask(c, { title, dept: "Operations", project: meeting.project, pri: "mid", due: addDays(c.now, 2), src: { type: "meeting", id: meetingId } });
  },
  async toggleTask(c, id: string, done: boolean) {
    await c.db.run("update tasks set done = $1, done_at = $2 where owner_id = $3 and id = $4", [done, done ? c.now.getTime() : null, c.ownerId, id]);
  },
  async setTaskPriority(c, id: string, pri: Priority) {
    await c.db.run("update tasks set pri = $1 where owner_id = $2 and id = $3", [pri, c.ownerId, id]);
  },
  async delegateTask(c, id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
    const [task] = await c.db.query<{ delegated_to: string | null }>("select delegated_to from tasks where owner_id = $1 and id = $2 for update", [c.ownerId, id]);
    // Already assigned: this is a second click on Assign.
    if (task?.delegated_to) return;
    await delegate(c, id, personId, note, due, where);
  },
  async undelegateTask(c, id: string) {
    await c.db.run("update tasks set delegated_to = null, delegated_name = null, delegated_role = null, delegated_note = null, delegated_at = null where owner_id = $1 and id = $2", [c.ownerId, id]);
    // A hand-off that was never sent is withdrawn with the task: from the outbox, and from the
    // chat's thread if it was going to be posted there.
    const unsent = await c.db.query<{ message_id: string | null; conversation_id: string | null }>("delete from outbox where owner_id = $1 and task_id = $2 and status = 'queued' returning message_id, conversation_id", [c.ownerId, id]);
    for (const row of unsent) {
      if (!row.message_id || !row.conversation_id) continue;
      await c.db.run("delete from messages where id = $1", [row.message_id]);
      await c.db.run("update conversations set replied = coalesce((select me from messages where conversation_id = $1 order by at desc, id desc limit 1), false) where id = $1", [row.conversation_id]);
    }
  },

  // Suggested tasks
  async editSuggestion(c, id: string, patch: { pri?: Priority; due?: string }) {
    await c.db.run("update suggestions set pri = coalesce($1, pri), due = coalesce($2, due) where owner_id = $3 and id = $4", [patch.pri ?? null, patch.due ?? null, c.ownerId, id]);
  },
  async acceptSuggestion(c, id: string) {
    // Held for this change, so two clicks on Add task add one task.
    const [g] = await c.db.query<{ title: string; mode: Mode; dept: string; project: string; pri: Priority; due: string; src_type: "message" | "meeting" | null; src_id: string | null; delegable: boolean }>("select * from suggestions where owner_id = $1 and id = $2 and status = 'new' for update", [c.ownerId, id]);
    if (!g) return;
    const today = isoDay(c.now);
    await insertTask(c, { title: g.title, dept: g.dept, project: g.project, pri: g.pri, due: g.due < today ? today : g.due, mode: g.mode, src: g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null, delegable: g.delegable });
    await c.db.run("update suggestions set status = 'accepted' where id = $1", [id]);
  },
  async dismissSuggestion(c, id: string) {
    await c.db.run("update suggestions set status = 'dismissed' where owner_id = $1 and id = $2", [c.ownerId, id]);
  },

  // Today
  async addFocus(c, scope: "day" | "week", period: string, text: string, mode?: Mode) {
    await c.db.run("insert into focus_items (id, owner_id, scope, period, body, position, mode) values ($1, $2, $3, $4, $5, $6, $7)", [uid("f"), c.ownerId, scope, period, text, c.now.getTime(), asMode(mode)]);
  },
  async toggleFocus(c, _scope: string, _period: string, id: string, done: boolean) {
    await c.db.run("update focus_items set done = $1 where owner_id = $2 and id = $3", [done, c.ownerId, id]);
  },
  async removeFocus(c, _scope: string, _period: string, id: string) {
    await c.db.run("delete from focus_items where owner_id = $1 and id = $2", [c.ownerId, id]);
  },
  async addLink(c, label: string, url: string, mode?: Mode) {
    await c.db.run("insert into quick_links (id, owner_id, label, url, position, mode) values ($1, $2, $3, $4, $5, $6)", [uid("l"), c.ownerId, label, url, c.now.getTime(), asMode(mode)]);
  },
  async removeLink(c, id: string) {
    await c.db.run("delete from quick_links where owner_id = $1 and id = $2", [c.ownerId, id]);
  },

  // Targets
  async saveLogs(c, dayOfMonth: number, values: Record<string, number | null>) {
    const day = `${monthKey(c.now)}-${pad(dayOfMonth)}`;
    for (const [metricId, value] of Object.entries(values)) {
      if (value == null) await c.db.run("delete from metric_logs where owner_id = $1 and metric_id = $2 and day = $3", [c.ownerId, metricId, day]);
      else await c.db.run("insert into metric_logs (owner_id, metric_id, day, value) values ($1, $2, $3, $4) on conflict (owner_id, metric_id, day) do update set value = excluded.value", [c.ownerId, metricId, day, Math.max(0, value)]);
    }
  },
  async saveTargets(c, values: Record<string, number>) {
    for (const [id, target] of Object.entries(values)) {
      if (Number.isFinite(target) && target > 0) await c.db.run("update metrics set target = $1 where owner_id = $2 and id = $3 and not is_sum", [target, c.ownerId, id]);
    }
    await c.db.run("update metrics m set target = (select coalesce(sum(k.target), 0) from metrics k where k.owner_id = m.owner_id and k.parent = m.id) where m.owner_id = $1 and m.is_sum", [c.ownerId]);
  },

  // Settings: team
  async togglePersonDept(c, id: string, dept: string) {
    const [p] = await c.db.query<{ depts: string[] }>("select depts from team_members where owner_id = $1 and id = $2", [c.ownerId, id]);
    if (!p) return;
    const depts = p.depts.includes(dept) ? p.depts.filter((d) => d !== dept) : [...p.depts, dept];
    await c.db.run("update team_members set depts = $1 where id = $2", [JSON.stringify(depts), id]);
  },
  async addHandle(c, id: string, handle: string) {
    const [p] = await c.db.query<{ handles: string[] }>("select handles from team_members where owner_id = $1 and id = $2", [c.ownerId, id]);
    if (!p || p.handles.some((h) => h.toLowerCase() === handle.toLowerCase())) return;
    await c.db.run("update team_members set handles = $1 where id = $2", [JSON.stringify([...p.handles, handle]), id]);
  },
  async removeHandle(c, id: string, index: number) {
    const [p] = await c.db.query<{ handles: string[] }>("select handles from team_members where owner_id = $1 and id = $2", [c.ownerId, id]);
    if (!p) return;
    await c.db.run("update team_members set handles = $1 where id = $2", [JSON.stringify(p.handles.filter((_, k) => k !== index)), id]);
  },
  async addPerson(c, input: { name: string; role: string; depts: string[]; handles: string[]; slackUserId?: string | null }) {
    await c.db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id, position) values ($1, $2, $3, $4, $5, $6, $7, $8)", [uid("u"), c.ownerId, input.name, input.role, JSON.stringify(input.depts), JSON.stringify(input.handles), input.slackUserId || null, Math.floor(c.now.getTime() / 1000)]);
  },
  async removePerson(c, id: string) {
    await c.db.run("delete from team_members where owner_id = $1 and id = $2", [c.ownerId, id]);
  },

  // Settings: sorting rules
  async addRule(c, kind: RuleKind, rule: Omit<Rule, "id">) {
    const [{ next }] = await c.db.query<{ next: number }>("select coalesce(max(position), -1) + 1 as next from rules where owner_id = $1 and kind = $2", [c.ownerId, kindOf(kind)]);
    await c.db.run("insert into rules (id, owner_id, kind, position, source, match_on, op, value, pri, line, mode) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)", [uid("r"), c.ownerId, kindOf(kind), next, rule.source, rule.when, rule.op, rule.value, rule.pri ?? null, rule.line ?? null, rule.mode ?? null]);
    await resortInbox(c.db, c.ownerId);
  },
  async moveRule(c, kind: RuleKind, id: string, direction: -1 | 1) {
    const rows = await c.db.query<{ id: string }>("select id from rules where owner_id = $1 and kind = $2 order by position", [c.ownerId, kindOf(kind)]);
    const from = rows.findIndex((r) => r.id === id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= rows.length) return;
    [rows[from], rows[to]] = [rows[to], rows[from]];
    for (const [position, r] of rows.entries()) await c.db.run("update rules set position = $1 where id = $2", [position, r.id]);
    await resortInbox(c.db, c.ownerId);
  },
  async deleteRule(c, _kind: RuleKind, id: string) {
    await c.db.run("delete from rules where owner_id = $1 and id = $2", [c.ownerId, id]);
    await resortInbox(c.db, c.ownerId);
  },
  /** Hands every chat that was sorted by hand back to the rules. */
  async clearManualPriorities(c) {
    await c.db.run("update conversations set manual_pri = false, manual_mode = false where owner_id = $1", [c.ownerId]);
    await resortInbox(c.db, c.ownerId);
  },

  // Settings: timers and channels
  async setJobInterval(c, id: JobId, minutes: number) {
    await c.db.run("update jobs set interval_min = $1 where owner_id = $2 and job_id = $3", [clampInterval(id, minutes), c.ownerId, id]);
  },
  async setJobEnabled(c, id: JobId, enabled: boolean) {
    await c.db.run("update jobs set enabled = $1 where owner_id = $2 and job_id = $3", [enabled, c.ownerId, id]);
  },
  async setChannelSelected(c, id: string, selected: boolean) {
    await c.db.run("update slack_channels set selected = $1 where owner_id = $2 and id = $3", [selected, c.ownerId, id]);
  },

  // Connections
  async disconnectProvider(c, provider: Provider) {
    await c.db.run("delete from connections where owner_id = $1 and provider = $2", [c.ownerId, provider]);
  },
};

export async function applyAction(db: Db, type: string, args: unknown[], ownerId = OWNER_ID, now = new Date()): Promise<void> {
  const action = ACTIONS[type];
  if (!action) throw new Error(`Unknown action: ${type}`);
  await db.transaction((tx) => action({ db: tx, ownerId, now }, ...args));
}
