// Reads and writes for the dashboard. `loadState` builds what the screens show; `ACTIONS`
// holds every change a person can make. Jobs write through their own modules in `src/jobs`.
import crypto from "node:crypto";
import { INBOX_DAYS, MOST_PICTURES, PERSONAL, PRIORITIES } from "@/core/config";
import { assignmentText, canAssignInChat, CHANNEL_PICK, SLACK_PICK, type AssignWhere } from "@/core/delegation";
import { addDays, isoDay, monthKey, pad } from "@/core/dates";
import { clampInterval, defaultJobSettings, JOBS } from "@/core/jobs";
import { requestSummary } from "@/core/requests";
import { applyRules } from "@/core/rules";
import type {
  AddedPicture, AppState, Conversation, ConversationChange, FocusBoard, HeavyPart, JobId, JobStatus, Meeting, MessagePicture, Metric, Mode, Person, Priority, Provider, Reaction, Rule, Source, Stamps,
  StateAnswer, StatePart, StateUpdate, Suggestion, CalendarItem,
} from "@/core/types";
import { aiConfigured } from "./ai";
import { emailTags, type TaggedEmail } from "@/core/email-tags";
import { isEmailAddress, parseAddress, type Address } from "./gmail";
import { hostedProblem, keysOnScreen } from "./app-keys";
import { disconnectGoogle, googleAccounts, googleBlocked, googleCan } from "./google";
import { isUploadKey, telegramAvatarIds, type StoredPicture } from "./media";
import { SLACK_FILES_SCOPE, SLACK_NEEDS_UPLOAD, SLACK_UPLOAD_SCOPE, type Fetch } from "./slack";
import { hashPassword, MIN_PASSWORD, teamLogins } from "./team";
import { telegramBlocked } from "./telegram";
import { insertTicket, logEvent, reviewItems, setAsideItems, sourceNote, TEAM, teamClients, teamPeople, teamSlack, teamTickets, teamUsersSql, TICKET_ACTIONS } from "./tickets";
import type { Db } from "./db";
import { OWNER_ID } from "./owner";

/** Phase 1 has one person. Every table already carries the owner, so more can be added later. */
export { OWNER_ID };

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

/**
 * Gives this login a timer for every check, at its default settings. A check added after the
 * login was made has none yet: without a timer it never runs on its own. One statement, so it
 * is cheap to do on every tick.
 */
export async function ensureJobs(db: Db, ownerId: string): Promise<void> {
  await db.run("insert into jobs (owner_id, job_id, interval_min) select $1, j.id, j.minutes from jsonb_to_recordset($2::jsonb) as j(id text, minutes integer) on conflict do nothing", [
    ownerId,
    JSON.stringify(defaultJobSettings().map((job) => ({ id: job.id, minutes: job.intervalMin }))),
  ]);
}

/** Creates the owner and their starting settings the first time the server runs. */
export async function ensureOwner(db: Db, ownerId = OWNER_ID): Promise<void> {
  const now = Date.now();
  await db.run("insert into users (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing", [ownerId, process.env.OWNER_NAME ?? "You", now]);
  await ensureJobs(db, ownerId);
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
  id: string; source: Conversation["source"]; external_id: string; thread_ts: string | null; from_name: string; ctx: string; direct: boolean; tagged: boolean;
  last_text: string; last_at: number; pri: Priority; line: Conversation["line"]; mode: Mode; project: string; done: boolean; auto_done: boolean; replied: boolean; manual_pri: boolean; manual_mode: boolean;
}
interface MessageRow {
  id: string; conversation_id: string; sender_name: string; sender_id: string | null; me: boolean; body: string; at: number; status: "queued" | "sent" | "failed" | null; external_id: string | null; thread_ts: string | null;
  attachments: StoredPicture[] | null; reactions: Reaction[] | null;
  /** For an email: who it went to, and whether it is a mailing and which Gmail tab it landed in. */
  email: { bulk?: boolean; tab?: string } | null;
}

/** Where the browser gets a message's picture from. The dashboard hands it over itself, to a signed-in person only. */
const pictureUrl = (messageId: string, n: number, full = false) => `/api/media?m=${encodeURIComponent(messageId)}&n=${n}${full ? "&full=1" : ""}`;
const avatarUrl = (id: string) => `/api/media?avatar=${encodeURIComponent(id)}`;

/** How long after a reply was written its copy from Slack or Telegram can still arrive. */
const COPY_DAYS = 7;

/**
 * A reply sent from here comes back from its app as a message of its own, with the app's id.
 * Once it has, that copy is the one shown, so the reply is not there twice. Each copy stands for
 * one reply: the same words, from the owner, in the same conversation, not before it was written.
 */
function backFromTheApp(messages: MessageRow[]): Set<string> {
  const copies = messages.filter((m) => m.me && m.external_id);
  const used = new Set<string>();
  const shownOnce = new Set<string>();
  for (const m of messages) {
    if (!m.me || m.external_id || m.status !== "sent") continue;
    const copy = copies.find((x) => !used.has(x.id) && x.conversation_id === m.conversation_id && x.body === m.body && Number(x.at) > Number(m.at) - 5 * 60_000 && Number(x.at) < Number(m.at) + COPY_DAYS * 86_400_000);
    if (!copy) continue;
    used.add(copy.id);
    shownOnce.add(m.id);
  }
  return shownOnce;
}
interface RuleRow { id: string; kind: "priority" | "label"; source: Rule["source"]; match_on: Rule["when"]; op: Rule["op"]; value: string; pri: Priority | null; line: Rule["line"] | null; mode: Mode | null }

// How much of a conversation the screens get: the threads and single messages written in
// most recently, each thread's first message and newest replies, within an overall limit.
const GROUPS_SHOWN = 30;
const REPLIES_SHOWN = 40;
const MESSAGES_SHOWN = 150;
/**
 * How many of a chat's messages come with the inbox until it is opened: enough for its row.
 * The rest come when it is opened, so the inbox is small to read every time something changes.
 */
const PREVIEW_SHOWN = 2;

const toRule = (r: RuleRow): Rule => ({ id: r.id, source: r.source, when: r.match_on, op: r.op, value: r.value, pri: r.pri ?? undefined, line: r.line ?? undefined, mode: r.mode ?? undefined });

export async function loadRules(db: Db, ownerId: string): Promise<{ labelRules: Rule[]; priorityRules: Rule[] }> {
  const rows = await db.query<RuleRow>("select * from rules where owner_id = $1 order by position", [ownerId]);
  return { labelRules: rows.filter((r) => r.kind === "label").map(toRule), priorityRules: rows.filter((r) => r.kind === "priority").map(toRule) };
}

// Everything still open, plus what was cleared lately so links back to it keep working.
// Counted for each source on its own, so a busy mailbox never pushes chats out of view.
const SHOWN = `select id from (
                 select id, done, row_number() over (partition by source, done order by last_at desc) as n from conversations where owner_id = $1
               ) shown where shown.n <= case when shown.done then 100 else 300 end`;

/**
 * The conversations that are important: in a Slack channel or Telegram group ticked in
 * Settings, a direct chat with someone ticked, or one where someone ticked wrote last.
 */
export async function importantConversations(db: Db, ownerId: string): Promise<Set<string>> {
  const rows = await db.query<{ id: string }>(
    `select c.id from conversations c
     where c.owner_id = $1 and c.source in ('slack', 'telegram') and (
       exists (select 1 from important i where i.owner_id = $1 and i.source = c.source and i.kind = 'chat' and i.external_id = c.external_id)
       or exists (select 1 from important i where i.owner_id = $1 and i.source = c.source and i.kind = 'person' and (
         (c.direct and i.external_id = c.external_id)
         or i.external_id = (select s.user_id from slack_channels s where s.owner_id = $1 and s.id = c.external_id and s.kind = 'im')
         or i.external_id = (select m.sender_id from messages m where m.owner_id = c.owner_id and m.conversation_id = c.id and not m.me and m.sender_id is not null order by m.at desc limit 1)
       ))
     )`,
    [ownerId],
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * The conversations the inbox shows. `open` is the one open on the page, which comes whole; the
 * other chats bring only their newest messages (see `PREVIEW_SHOWN`). `only` reads that one alone.
 */
async function loadConversations(db: Db, ownerId: string, { open = null, only = null }: { open?: string | null; only?: string | null } = {}): Promise<Conversation[]> {
  // Both reads go out together. Only the newest part of each conversation is fetched: a busy
  // channel can hold thousands of messages. A thread counts as one group and is kept whole
  // (its first message and its newest replies), so a reply never shows without what it answers.
  // An email thread is always whole: its tags are worked out from all of it.
  const [rows, messages, important] = await Promise.all([
    // An email row's text is the text of an email in it, which comes whole below: it is not read twice.
    db.query<ConversationRow>(
      `select id, source, external_id, thread_ts, from_name, ctx, direct, tagged, last_at, pri, line, mode, project, done, auto_done, replied, manual_pri, manual_mode,
              case when source = 'gmail' and exists (select 1 from messages m where m.owner_id = $1 and m.conversation_id = c.id) then '' else last_text end as last_text
       from conversations c where owner_id = $1 and id in (${SHOWN}) and ($2::text is null or id = $2)`,
      [ownerId, only],
    ),
    db.query<MessageRow & { in_window: number }>(
      `with grouped as (
         select m.*, coalesce(m.thread_ts, m.external_id, m.id) as grp,
                max(m.at) over (partition by m.conversation_id, coalesce(m.thread_ts, m.external_id, m.id)) as grp_at
         from messages m where m.owner_id = $1 and m.conversation_id in (${SHOWN}) and ($6::text is null or m.conversation_id = $6)
       ), ranked as (
         select g.*,
                dense_rank() over (partition by conversation_id order by grp_at desc, grp desc) as grp_rank,
                row_number() over (partition by conversation_id, grp order by at desc, id desc) as in_grp,
                row_number() over (partition by conversation_id order by grp_at desc, at desc, id desc) as overall
         from grouped g
       ), windowed as (
         select r.*, count(*) over (partition by conversation_id) as in_window from ranked r
         where grp_rank <= $2 and overall <= $4 and (in_grp <= $3 or external_id = grp)
       )
       select id, conversation_id, sender_name, sender_id, me, body, at, status, external_id, thread_ts, attachments, reactions, email, in_window from windowed
       where conversation_id = $5 or conversation_id like 'gmail:%' or overall <= $7
       order by at, id`,
      [ownerId, GROUPS_SHOWN, REPLIES_SHOWN, MESSAGES_SHOWN, only ?? open ?? "", only, PREVIEW_SHOWN],
    ),
    importantConversations(db, ownerId),
  ]);
  // How many messages each conversation would show whole, to tell which ones came cut short.
  const whole = new Map<string, number>();
  const sent = new Map<string, number>();
  // An email row's text, as `refreshConversation` keeps it: its latest email from someone else, else its latest.
  const emailText = new Map<string, { incoming?: string; latest: string }>();
  for (const m of messages) {
    whole.set(m.conversation_id, Number(m.in_window));
    sent.set(m.conversation_id, (sent.get(m.conversation_id) ?? 0) + 1);
    if (!m.conversation_id.startsWith("gmail:")) continue;
    const text = emailText.get(m.conversation_id) ?? { latest: "" };
    text.latest = m.body;
    if (!m.me) text.incoming = m.body;
    emailText.set(m.conversation_id, text);
  }
  const textOf = (r: ConversationRow) => {
    const email = r.source === "gmail" ? emailText.get(r.id) : undefined;
    return email ? (email.incoming ?? email.latest) : r.last_text;
  };
  // Telegram's profile pictures are kept by the dashboard. Slack's are addresses, in `avatars`.
  const telegram = new Set(rows.filter((r) => r.source === "telegram").map((r) => r.id));
  const faces = telegram.size ? await telegramAvatarIds(db, ownerId) : new Set<string>();
  const threads = new Map<string, Conversation["thread"]>();
  // What an email thread's tags are worked out from: its emails from other people.
  const mail = new Map<string, TaggedEmail>();
  const copied = backFromTheApp(messages);
  for (const m of messages) {
    if (copied.has(m.id)) continue;
    if (m.email && !m.me) {
      const seen = mail.get(m.conversation_id) ?? { subject: "", texts: [], senders: [], bulk: true, tab: undefined, direct: false, answered: false };
      seen.texts.push(m.body);
      if (m.sender_id) seen.senders.push(m.sender_id);
      seen.bulk = seen.bulk && Boolean(m.email.bulk);
      seen.tab = m.email.tab ?? seen.tab;
      mail.set(m.conversation_id, seen);
    }
    const thread = threads.get(m.conversation_id) ?? [];
    thread.push({
      me: m.me, text: m.body, at: Number(m.at), from: m.me ? undefined : m.sender_name, status: m.status === "failed" ? "queued" : (m.status ?? undefined), ts: m.external_id ?? undefined, thread: m.thread_ts ?? undefined,
      attachments: m.attachments?.length
        ? m.attachments.map((a, n): MessagePicture => ({ kind: a.kind, name: a.name, w: a.w, h: a.h, src: pictureUrl(m.id, n), full: a.url && a.thumb ? pictureUrl(m.id, n, true) : undefined, link: a.link, here: isUploadKey(a.key) || undefined }))
        : undefined,
      reactions: m.reactions?.length ? m.reactions : undefined,
      avatar: !m.me && m.sender_id && telegram.has(m.conversation_id) && faces.has(m.sender_id) ? avatarUrl(m.sender_id) : undefined,
    });
    threads.set(m.conversation_id, thread);
  }
  return rows.map((r) => {
    const thread = threads.get(r.id) ?? [];
    return {
      id: r.id, source: r.source, from: r.from_name, ctx: r.ctx, direct: r.direct, tagged: r.tagged, text: textOf(r), at: r.last_at,
      pri: r.pri, line: r.line, mode: r.mode, project: r.project, done: r.done, replied: r.replied, manualPri: r.manual_pri || undefined, manualMode: r.manual_mode || undefined,
      root: r.thread_ts ?? undefined,
      important: important.has(r.id) || undefined,
      tags: r.source === "gmail" ? emailTags({ ...(mail.get(r.id) ?? { texts: [textOf(r)], senders: [], bulk: false }), subject: r.ctx, direct: r.direct, answered: r.replied }) : undefined,
      autoCleared: (r.done && r.auto_done) || undefined,
      // A one-to-one chat shows the other person. A group shows whoever wrote last.
      avatar: r.source !== "telegram" ? undefined : r.direct && faces.has(r.external_id) ? avatarUrl(r.external_id) : thread.findLast((m) => !m.me)?.avatar,
      thread,
      // Counted before the copies of the dashboard's own replies are left out (see `backFromTheApp`).
      partial: (sent.get(r.id) ?? 0) < (whole.get(r.id) ?? 0) || undefined,
    };
  });
}

/** One conversation, whole, for when it is opened on the page. */
export async function loadConversation(db: Db, ownerId: string, id: string): Promise<Conversation | null> {
  const [found] = await loadConversations(db, ownerId, { only: id });
  return found ?? null;
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
      // `date` and `time` here are in the server's timezone. The page works them out again from
      // `at` in the timezone of the person looking, since a host's clock is not theirs.
      id: m.id, title: m.title, at: start.getTime(), date: isoDay(start), time: `${pad(start.getHours())}:${pad(start.getMinutes())}`, dur: m.duration_min,
      who: m.who, where: m.place, project: m.project, url: m.url, summary: m.summary, actionItems: m.action_items ?? [], transcript: [], transcriptLines: m.lines,
    };
  });
}

/**
 * Disconnects one Google account, or every one when `email` is null. Its login is ended on
 * Google's side and removed here, its calendar is no longer shown, and its place in the
 * mailbox is forgotten, so connecting it again starts from that moment. With `everything`, the
 * emails that were read from it are removed too.
 */
export async function forgetGoogle(db: Db, ownerId: string, email: string | null, everything: boolean, fetchImpl: Fetch = fetch): Promise<void> {
  const emails = email ? [email] : (await db.query<{ email: string }>("select email from google_accounts where owner_id = $1", [ownerId])).map((r) => r.email);
  for (const account of emails) {
    await disconnectGoogle(db, ownerId, account, fetchImpl);
    await db.run("update jobs set cursor = cursor #- array['accounts', $2]::text[] where owner_id = $1 and job_id = 'gmail-pull'", [ownerId, account]);
    await db.run("delete from calendar_events where owner_id = $1 and account = $2", [ownerId, account]);
    // An email row's external id is "<account>:<thread>".
    if (everything) await db.run("delete from conversations where owner_id = $1 and source = 'gmail' and left(external_id, length($2) + 1) = $2 || ':'", [ownerId, account]);
  }
}

const KIND: Record<string, CalendarItem["kind"]> = { focusTime: "focus", outOfOffice: "away" };

/**
 * The events on the connected Google Calendars, in start order. A meeting on two connected
 * calendars, with the same id and start, is one item that names both.
 */
async function loadCalendar(db: Db, ownerId: string): Promise<CalendarItem[]> {
  if (hostedProblem("google")) return [];
  const rows = await db.query<{
    account: string; id: string; title: string; start_at: number; end_at: number; all_day: boolean; kind: string; location: string | null; link: string | null;
    html_link: string | null; organizer: string | null; attendees: { name: string; email: string }[]; response: string | null; mine: boolean; description: string | null; recurring: boolean;
  }>("select account, id, title, start_at, end_at, all_day, kind, location, link, html_link, organizer, attendees, response, mine, description, recurring from calendar_events where owner_id = $1 order by start_at, account", [ownerId]);
  const items = new Map<string, CalendarItem>();
  const mine = new Set(rows.map((e) => e.account));
  for (const e of rows) {
    const key = `${e.id}@${e.start_at}`;
    const seen = items.get(key);
    if (seen) {
      seen.accounts.push(e.account);
      continue;
    }
    items.set(key, {
      id: key, accounts: [e.account], title: e.title, at: Number(e.start_at), end: Number(e.end_at), allDay: e.all_day, kind: KIND[e.kind] ?? "meeting",
      // The owner's other connected accounts are not "someone else" in the meeting.
      who: (e.attendees ?? []).filter((a) => !mine.has(a.email.toLowerCase())).map((a) => a.name).join(", "),
      where: e.location ?? "", link: e.link ?? undefined, calendarLink: e.html_link ?? undefined, organizer: e.organizer ?? undefined, response: e.response ?? undefined,
      eventId: e.id, mine: e.mine, recurring: e.recurring, description: e.description ?? undefined, guests: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
    });
  }
  return [...items.values()];
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

/** The fingerprint of some rows: each row's own, put in order, so the order they are read in does not matter. */
const rowsHash = (row: string, from: string) => `(select md5(coalesce(string_agg(h, '' order by h), '')) from (select md5((${row})::text) as h ${from}) x)`;

const PARTS: StatePart[] = ["inbox", "calendar", "meetings", "rest"];
const HEAVY: HeavyPart[] = ["inbox", "calendar", "meetings"];

/**
 * A fingerprint of each part of the data, worked out by the database, so only a few bytes come
 * back. Each covers what its part shows: while it stays the same, so does the part. Left out:
 * when each timer last ran, which changes every few minutes; the page reads that now and then.
 */
export async function stateStamps(db: Db, ownerId: string, now = new Date()): Promise<Stamps> {
  const [row] = await db.query<Stamps>(
    `select
       md5(concat(
         ${rowsHash("c", "from conversations c where c.owner_id = $1")},
         ${rowsHash("m", `from messages m where m.owner_id = $1 and m.conversation_id in (${SHOWN})`)},
         ${rowsHash("row(i.source, i.kind, i.external_id)", "from important i where i.owner_id = $1")},
         ${rowsHash("d.key", "from media d where d.owner_id = $1 and d.key like 'telegram/avatar/%' and d.mime <> ''")}
       )) as inbox,
       ${rowsHash(
         "row(e.account, e.id, e.title, e.start_at, e.end_at, e.all_day, e.kind, e.location, e.link, e.html_link, e.organizer, e.attendees, e.response, e.mine, e.description, e.recurring)",
         "from calendar_events e where e.owner_id = $1",
       )} as calendar,
       ${rowsHash("row(t.id, t.title, t.started_at, t.duration_min, t.who, t.place, t.project, t.url, md5(t.summary), t.action_items, jsonb_array_length(t.transcript))", "from meetings t where t.owner_id = $1")} as meetings,
       md5(concat(
         $3::text,
         ${rowsHash("k", "from tasks k where k.owner_id = $2")},
         ${rowsHash("row(v.id, v.at)", "from ticket_events v where v.owner_id = $2")},
         ${rowsHash("g", `from suggestions g where g.owner_id in (${teamUsersSql("$2")})`)},
         ${rowsHash("row(o.id, o.status, o.body, o.to_name, o.ctx, o.created_at, o.conversation_id, o.task_id, o.after_id)", "from outbox o where o.owner_id = $1")},
         ${rowsHash("p", "from team_members p where p.owner_id = $2")},
         ${rowsHash("n", "from clients n where n.owner_id = $2")},
         ${rowsHash("row(x.provider, x.label, x.connected_at, x.scopes)", "from connections x where x.owner_id = $1")},
         ${rowsHash("row(a.email, a.scopes, a.connected_at)", "from google_accounts a where a.owner_id = $1")},
         ${rowsHash("row(u.id, u.name)", `from users u where u.id in (${teamUsersSql("$2")})`)},
         ${rowsHash("row(tc.id, tc.name, tc.kind, tc.synced)", "from telegram_chats tc where tc.owner_id = $1")}
       )) as rest`,
    [ownerId, TEAM, isoDay(now)],
  );
  return { inbox: row.inbox, calendar: row.calendar, meetings: row.meetings, rest: row.rest };
}

/**
 * Everything the screens show, read fresh. `open` is the conversation open on the page: it comes
 * whole, where the other chats bring only their newest messages.
 */
export async function loadState(db: Db, ownerId = OWNER_ID, now = new Date(), open: string | null = null): Promise<AppState> {
  return (await readState(db, ownerId, now, open, new Set(), await stateStamps(db, ownerId, now))) as AppState;
}

/**
 * What changed since the page read the data with the stamps `have`: `unchanged`, in a few
 * bytes, when nothing did. Otherwise everything small, and each big part (the inbox, the
 * calendar, the calls) only if it changed. Without `have`, everything.
 */
export async function stateUpdate(db: Db, ownerId: string, have: Partial<Stamps> | null, open: string | null = null, now = new Date()): Promise<StateAnswer> {
  // The stamps are worked out before anything is read: a change made in between is then newer
  // than the stamps, and the next check reads it.
  const stamps = await stateStamps(db, ownerId, now);
  if (have && PARTS.every((p) => have[p] === stamps[p])) return { unchanged: true, stamps };
  return readState(db, ownerId, now, open, new Set(have ? HEAVY.filter((p) => have[p] === stamps[p]) : []), stamps);
}

/** The stamps a page sent, as far as they are stamps: anything else counts as none. */
export function stampsFrom(value: unknown): Partial<Stamps> | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const have: Partial<Stamps> = {};
  for (const part of PARTS) {
    const stamp = (parsed as Record<string, unknown>)[part];
    if (typeof stamp === "string") have[part] = stamp;
  }
  return have;
}

async function readState(db: Db, ownerId: string, now: Date, open: string | null, skip: Set<HeavyPart>, stamps: Stamps): Promise<StateUpdate> {
  const month = monthKey(now);
  const today = isoDay(now);
  // Telegram may be used on this server at all (each login has the keys it was made with).
  const telegramHere = !hostedProblem("telegram");
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
    pictures,
    projects,
    inbox,
    meetings,
    calendar,
    google,
    importantRows,
    telegramChats,
    telegramPeople,
    jobStatus,
  ] = await Promise.all([
    db.query<{ name: string }>("select name from users where id = $1", [ownerId]),
    loadRules(db, ownerId),
    teamTickets(db, ownerId),
    db.query<{ id: string; title: string; mode: Mode; dept: string; project: string; pri: Priority; due: string; why: string; src_type: "message" | "meeting" | null; src_id: string | null; status: Suggestion["status"]; delegable: boolean }>(
      "select * from suggestions where owner_id = $1 and (status = 'new' or created_at > $2) order by created_at desc limit 300",
      [ownerId, now.getTime() - 14 * 86_400_000],
    ),
    // The team list is the team's: everyone with a login assigns from the same one.
    db.query<{ id: string; name: string; role: string; depts: string[]; handles: string[]; slack_user_id: string | null; telegram_id: string | null }>("select * from team_members where owner_id = $1 order by position, name", [TEAM]),
    db.query<{ id: string; parent: string | null; name: string; target: number; unit: Metric["unit"]; is_sum: boolean }>("select * from metrics where owner_id = $1 order by position", [ownerId]),
    db.query<{ metric_id: string; day: string; value: number }>("select metric_id, day, value from metric_logs where owner_id = $1 and day like $2", [ownerId, `${month}-%`]),
    db.query<{ id: string; scope: "day" | "week"; period: string; body: string; done: boolean; mode: Mode }>("select * from focus_items where owner_id = $1 and period >= $2 order by position", [ownerId, addDays(now, -14)]),
    db.query<{ id: string; label: string; url: string; mode: Mode }>("select id, label, url, mode from quick_links where owner_id = $1 order by position", [ownerId]),
    db.query<{ id: string; source: Source; to_name: string; ctx: string; body: string; created_at: number; status: "queued" | "sent" | "failed"; conversation_id: string | null; task_id: string | null; after_id: string | null }>(
      "select * from outbox where owner_id = $1 order by created_at desc limit 100",
      [ownerId],
    ),
    db.query<{ job_id: JobId; interval_min: number; enabled: boolean }>("select job_id, interval_min, enabled from jobs where owner_id = $1", [ownerId]),
    db.query<{ provider: Provider; label: string | null; connected_at: number; scopes: string | null }>("select provider, label, connected_at, scopes from connections where owner_id = $1", [ownerId]),
    db.query<{ id: string; name: string; kind: "public" | "private"; selected: boolean }>("select id, name, kind, selected from slack_channels where owner_id = $1 and kind in ('public', 'private') order by name", [ownerId]),
    db.query<{ id: string; name: string }>("select id, name from slack_users where owner_id = $1 and not is_bot and not deleted order by name", [ownerId]),
    // Apps and people who have left come first, so someone current with the same name wins.
    db.query<{ name: string; image: string }>("select name, image from slack_users where owner_id = $1 and image <> '' order by (not deleted) asc, (not is_bot) asc", [ownerId]),
    db.query<{ project: string }>(
      "select distinct project from (select project from tasks where owner_id = $2 union select project from meetings where owner_id = $1 union select project from conversations where owner_id = $1) p where project <> '' order by project",
      [ownerId, TEAM],
    ),
    skip.has("inbox") ? undefined : loadConversations(db, ownerId, { open }),
    skip.has("meetings") ? undefined : loadMeetings(db, ownerId),
    skip.has("calendar") ? undefined : loadCalendar(db, ownerId),
    googleAccounts(db, ownerId),
    db.query<{ source: "slack" | "telegram"; kind: "chat" | "person"; external_id: string; name: string }>("select source, kind, external_id, name from important where owner_id = $1 order by lower(name)", [ownerId]),
    telegramHere
      ? db.query<{ id: string; name: string; kind: "group" | "channel" | "direct"; synced: boolean; last_at: number | null }>(
          "select id, name, kind, synced, last_at from telegram_chats where owner_id = $1 order by lower(name)",
          [ownerId],
        )
      : Promise.resolve([]),
    telegramHere
      ? db.query<{ id: string; name: string }>(
          // The people of the one-to-one chats, and whoever wrote in a group, each once under their latest name.
          `select distinct on (id) id, name from (
             select c.external_id as id, c.from_name as name, c.last_at as at from conversations c where c.owner_id = $1 and c.source = 'telegram' and c.direct
             union all
             select m.sender_id, m.sender_name, m.at from messages m join conversations c on c.owner_id = m.owner_id and c.id = m.conversation_id
             where c.owner_id = $1 and c.source = 'telegram' and not m.me and m.sender_id is not null
           ) p order by id, at desc`,
          [ownerId],
        )
      : Promise.resolve([]),
    loadJobStatus(db, ownerId),
  ]);

  const people = await teamPeople(db);
  const logs: AppState["logs"] = {};
  for (const l of logRows) (logs[l.metric_id] ??= {})[Number(l.day.slice(8))] = Number(l.value);
  const board = (): FocusBoard => ({ day: {}, week: {} });
  const focus: AppState["focus"] = { professional: board(), personal: board() };
  for (const f of focusRows) (focus[f.mode][f.scope][f.period] ??= []).push({ id: f.id, text: f.body, done: f.done });
  const slackScopes = connections.find((c) => c.provider === "slack")?.scopes;
  const allows = (what: keyof ReturnType<typeof googleCan>) => google.some((a) => googleCan(a.scopes)[what]);
  // Why this person cannot connect Telegram or Google now. A login already here keeps its own keys.
  const telegramIn = telegramHere && connections.some((c) => c.provider === "telegram");
  const [telegramNow, googleNow, telegramKeys, googleKeys, aiKeys, slackKeys, ai] = await Promise.all([
    telegramIn ? Promise.resolve(null) : telegramBlocked(db, ownerId),
    google.length ? Promise.resolve(hostedProblem("google")) : googleBlocked(db, ownerId),
    keysOnScreen(db, ownerId, "telegram"),
    keysOnScreen(db, ownerId, "google"),
    keysOnScreen(db, ownerId, "anthropic"),
    keysOnScreen(db, ownerId, "slack"),
    aiConfigured(db, ownerId),
  ]);
  const connection = (p: Provider) => {
    const row = connections.find((c) => c.provider === p);
    return row ? { connected: true, connectedAt: Number(row.connected_at), label: row.label ?? undefined } : { connected: false };
  };

  const state: StateUpdate = {
    month,
    inbox,
    tasks,
    review: await reviewItems(db, ownerId, people),
    setAside: await setAsideItems(db, ownerId, people),
    clients: await teamClients(db, ownerId),
    people,
    teamSlack: (await teamSlack(db)).sort((a, b) => a.name.localeCompare(b.name)),
    suggestions: suggestions.map((g) => ({
      // A call from last week suggests a date that has passed: offer today instead.
      id: g.id, title: g.title, mode: g.mode, dept: g.dept, project: g.project, pri: g.pri, due: g.status === "new" && g.due < today ? today : g.due, why: g.why,
      src: g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null, status: g.status, delegable: g.delegable,
    })),
    meetings,
    calendar,
    team: team.map((p): Person => ({ id: p.id, name: p.name, role: p.role, depts: p.depts ?? [], handles: p.handles ?? [], slackUserId: p.slack_user_id, telegramId: p.telegram_id })),
    projects: projects.map((p) => p.project),
    labelRules,
    priorityRules,
    metrics: metrics.map((m) => ({ id: m.id, parent: m.parent ?? undefined, name: m.name, target: Number(m.target), unit: m.unit, sum: m.is_sum || undefined })),
    logs,
    focus,
    links,
    outbox: outbox.map((o) => ({ id: o.id, source: o.source, to: o.to_name, ctx: o.ctx, text: o.body || "(a picture)", at: Number(o.created_at), status: o.status, conversationId: o.conversation_id ?? undefined, taskId: o.task_id ?? undefined, inThread: Boolean(o.after_id) || undefined })),
    jobs: JOBS.map((def) => {
      const row = jobs.find((j) => j.job_id === def.id);
      return { id: def.id, intervalMin: row?.interval_min ?? def.defaultMin, enabled: row?.enabled ?? true };
    }),
    // A Telegram or Google login counts only on a server that may use it (see `telegramAvailable`).
    connections: {
      slack: connection("slack"),
      telegram: telegramHere ? connection("telegram") : { connected: false },
      fathom: connection("fathom"),
      // Google's accounts are kept apart (see `google_accounts`): connected when there is at least one.
      google: google.length ? { connected: true, connectedAt: google[0].connectedAt, label: google.length === 1 ? google[0].email : `${google.length} accounts` } : { connected: false },
    },
    jobStatus,
    channels,
    slackPeople,
    important: importantRows.map((r) => ({ source: r.source, kind: r.kind, id: r.external_id, name: r.name })),
    telegramChats: telegramChats.map((c) => ({ id: c.id, name: c.name, kind: c.kind, synced: c.synced, lastAt: c.last_at == null ? null : Number(c.last_at) })),
    telegramPeople: telegramPeople.sort((a, b) => a.name.localeCompare(b.name)),
    avatars: Object.fromEntries(pictures.map((p) => [p.name, p.image])),
    owner: { name: owner?.name ?? "You" },
    me: { id: ownerId, isOwner: ownerId === OWNER_ID },
    logins: ownerId === OWNER_ID ? await teamLogins(db) : [],
    sendingEnabled: sendingEnabled(),
    slackFilesAllowed: slackScopes ? slackScopes.split(",").includes(SLACK_FILES_SCOPE) : null,
    slackUploadAllowed: slackScopes ? slackScopes.split(",").includes(SLACK_UPLOAD_SCOPE) : null,
    telegramAvailable: telegramNow === null,
    telegramBlocked: telegramNow,
    googleAvailable: googleNow === null,
    googleBlocked: googleNow,
    appKeys: { google: googleKeys, telegram: telegramKeys, anthropic: aiKeys, slack: slackKeys },
    googleAccounts: google.map((a) => ({ email: a.email, connectedAt: a.connectedAt, ...googleCan(a.scopes) })),
    googleAllows: { gmail: allows("gmail"), send: allows("send"), calendar: allows("calendar"), addEvents: allows("addEvents") },
    localData: !process.env.DATABASE_URL,
    aiConfigured: ai,
    stamps,
  };
  // A part left out is not there at all, so the page keeps the copy it has.
  for (const part of skip) delete state[part];
  return state;
}

// ---------- Sorting ----------

/** Re-applies the rules to every open conversation and saves what changed. */
export async function resortInbox(db: Db, ownerId: string): Promise<number> {
  const { labelRules, priorityRules } = await loadRules(db, ownerId);
  const rows = await db.query<ConversationRow>("select * from conversations where owner_id = $1 and not done", [ownerId]);
  const important = await importantConversations(db, ownerId);
  const before = rows.map((r) => ({ id: r.id, source: r.source, from: r.from_name, ctx: r.ctx, direct: r.direct, tagged: r.tagged, important: important.has(r.id), pri: r.pri, line: r.line, mode: r.mode, manualPri: r.manual_pri, manualMode: r.manual_mode }) as Conversation);
  const after = applyRules(before, labelRules, priorityRules);
  let changed = 0;
  for (const [k, c] of after.entries()) {
    if (c.pri === before[k].pri && c.line === before[k].line && c.mode === before[k].mode) continue;
    await db.run("update conversations set pri = $1, line = $2, mode = $3 where owner_id = $5 and id = $4", [c.pri, c.line, c.mode, c.id, ownerId]);
    // A suggestion waiting on this chat moves to the same side as the chat.
    await db.run("update suggestions set mode = $1 where owner_id = $2 and src_type = 'message' and src_id = $3 and status = 'new'", [c.mode, ownerId, c.id]);
    changed++;
  }
  return changed;
}

/**
 * Clears the Slack and Telegram conversations the owner has answered: those whose latest
 * message is theirs. It runs after every read, so an answer written in Slack or Telegram
 * itself clears the chat too. Something new from someone else brings it back, as any cleared
 * chat comes back. One the owner put back by hand after their answer stays. Returns how many.
 */
export async function clearAnswered(db: Db, ownerId: string): Promise<number> {
  return db.run(
    "update conversations set done = true, auto_done = true where owner_id = $1 and not done and replied and source in ('slack', 'telegram') and coalesce(restored_at, 0) < last_at",
    [ownerId],
  );
}

/**
 * Clears conversations with nothing new for `INBOX_DAYS` days, so the inbox holds what is
 * current. One the owner put back by hand counts from when they did. Returns how many.
 */
export async function ageOutInbox(db: Db, ownerId: string, now: number): Promise<number> {
  return db.run("update conversations set done = true, auto_done = true where owner_id = $1 and not done and greatest(last_at, coalesce(restored_at, 0)) < $2", [ownerId, now - INBOX_DAYS * 86_400_000]);
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

/** A description as it is kept: trimmed, and not longer than a page. */
const asDescription = (text: unknown) => String(text ?? "").trim().slice(0, 4000);

async function insertTask(c: ActionContext, t: { title: string; description?: string; dept: string; project: string; pri: Priority; due: string; mode?: Mode; src?: { type: "message" | "meeting"; id: string } | null; delegable?: boolean }): Promise<string> {
  // A ticket is the team's. Only the owner has a personal side: everyone else's are work tickets.
  const mode = c.ownerId === TEAM ? asMode(t.mode) : "professional";
  const [dept, project] = mode === "personal" ? [PERSONAL, PERSONAL] : [t.dept, t.project];
  return insertTicket(c, { title: t.title, description: asDescription(t.description), dept, project, pri: t.pri, due: t.due, mode, src: t.src ?? null, delegable: t.delegable ?? true, source: await sourceNote(c.db, c.ownerId, t.src) });
}

/** A ticket of the team's that this person may change: someone other than the owner never reaches a personal one. */
async function teamTask(c: ActionContext, id: string): Promise<void> {
  const [t] = await c.db.query<{ id: string }>("select id from tasks where owner_id = $1 and id = $2 and (mode = 'professional' or $3::boolean)", [TEAM, id, c.ownerId === TEAM]);
  if (!t) throw new Error("That task no longer exists.");
}

interface Assignee { id: string; name: string; role: string; slack_user_id: string | null }

/**
 * Who a task is being assigned to. `personId` is someone on the team list, or "slack:<id>"
 * for a person picked straight from Slack, who is then added to the team list so they are
 * there next time.
 */
async function assignee(c: ActionContext, personId: string): Promise<Assignee> {
  if (!personId.startsWith(SLACK_PICK)) {
    const [person] = await c.db.query<Assignee>("select id, name, role, slack_user_id from team_members where owner_id = $1 and id = $2", [TEAM, personId]);
    if (!person) throw new Error("That task or person no longer exists.");
    return person;
  }
  const slackUserId = personId.slice(SLACK_PICK.length);
  const [known] = await c.db.query<Assignee>("select id, name, role, slack_user_id from team_members where owner_id = $1 and slack_user_id = $2 order by position limit 1", [TEAM, slackUserId]);
  if (known) return known;
  const [user] = await c.db.query<{ name: string }>("select name from slack_users where owner_id = $1 and id = $2 and not is_bot and not deleted", [c.ownerId, slackUserId]);
  if (!user) throw new Error("That person is no longer in Slack.");
  const person: Assignee = { id: uid("u"), name: user.name, role: "Team member", slack_user_id: slackUserId };
  await c.db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id, position) values ($1, $2, $3, $4, '[]', '[]', $5, $6)", [person.id, TEAM, person.name, person.role, slackUserId, Math.floor(c.now.getTime() / 1000)]);
  return person;
}

/**
 * Assigns a task and queues the Slack message that announces it. The note is optional.
 *   "dm"            a direct message to the person, who must be picked.
 *   "chat"          the chat the task came from; shows in that conversation's thread.
 *   "channel:<id>"  any Slack channel the owner is in.
 * In a chat or channel the person is optional. With one, they are tagged and the task is
 * theirs; without, the task belongs to the channel.
 */
async function delegate(c: ActionContext, taskId: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
  const person = personId ? await assignee(c, personId) : null;
  const [task] = await c.db.query<{ title: string; description: string | null; pri: Priority; project: string; mode: Mode; src_type: string | null; src_id: string | null }>(
    "select title, description, pri, project, mode, src_type, src_id from tasks where owner_id = $1 and id = $2 and (mode = 'professional' or $3::boolean)",
    [TEAM, taskId, c.ownerId === TEAM],
  );
  if (!task) throw new Error("That task or person no longer exists.");
  // The message says what the task is, when it is due and how much it matters. Its description follows in the thread.
  const text = (who: string) => assignmentText({ where, who, title: task.title, due, note, pri: task.pri, project: task.mode === "personal" ? "" : task.project });
  const description = asDescription(task.description);
  /** Queues the description to go under the message with this id, as a reply in its thread. */
  const thenDescription = async (firstId: string, target: string | null, toName: string, ctx: string, thread: string | null) => {
    if (!description) return;
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, task_id, thread_ts, after_id, created_at) values ($1, $2, 'slack', $3, $4, $5, $6, $7, $8, $9, $10)",
      [uid("o"), c.ownerId, target, toName, ctx, description, taskId, thread, firstId, now + 1],
    );
  };
  const now = c.now.getTime();
  let holder = person ? { id: person.id, name: person.name, role: person.role } : null;

  if (where === "dm") {
    if (!person) throw new Error("Pick who should get the direct message.");
    const first = uid("o");
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, task_id, created_at) values ($1, $2, 'slack', $3, $4, 'Direct message', $5, $6, $7)",
      [first, c.ownerId, person.slack_user_id, person.name, text(person.name), taskId, now],
    );
    await thenDescription(first, person.slack_user_id, person.name, "Direct message", null);
  } else {
    // Where it is posted, and the conversation it shows in when the dashboard follows that chat.
    let place: { target: string; label: string; conversationId: string | null; thread?: string | null };
    if (where === "chat") {
      const [chat] = task.src_type === "message"
        ? await c.db.query<{ id: string; external_id: string; ctx: string; source: string; thread_ts: string | null }>("select id, external_id, ctx, source, thread_ts from conversations where owner_id = $1 and id = $2", [c.ownerId, task.src_id])
        : [];
      if (!chat || !canAssignInChat(chat)) throw new Error("This task did not come from a channel or a group message. Pick a Slack channel, or send a direct message.");
      // A task from one thread is announced in that thread, where the people it concerns are.
      place = { target: chat.external_id, label: chat.ctx, conversationId: chat.id, thread: chat.thread_ts };
    } else {
      const channelId = where.slice(CHANNEL_PICK.length);
      const [channel] = await c.db.query<{ id: string; name: string }>("select id, name from slack_channels where owner_id = $1 and id = $2", [c.ownerId, channelId]);
      if (!channel) throw new Error("That Slack channel is not on your channel list.");
      // The channel's own row, not the row of one thread in it: this is a new message in the channel.
      const [followed] = await c.db.query<{ id: string }>("select id from conversations where owner_id = $1 and source = 'slack' and external_id = $2 and thread_ts is null", [c.ownerId, channel.id]);
      place = { target: channel.id, label: `#${channel.name}`, conversationId: followed?.id ?? null };
    }
    holder ??= { id: `${CHANNEL_PICK}${place.target}`, name: place.label, role: "Slack channel" };

    let messageId: string | null = null;
    if (place.conversationId) {
      const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
      messageId = uid("m");
      // In the dashboard the tag reads as a name; Slack needs the person's id to notify them.
      await c.db.run("insert into messages (id, conversation_id, owner_id, sender_name, me, body, at, status, scanned, asked, thread_ts) values ($1, $2, $3, $4, true, $5, $6, 'queued', true, true, $7)", [messageId, place.conversationId, c.ownerId, owner?.name ?? "You", text(person ? `@${person.name}` : ""), now, place.thread ?? null]);
      if (place.thread) await c.db.run("update messages set thread_ts = $1 where owner_id = $3 and conversation_id = $2 and external_id = $1 and thread_ts is null", [place.thread, place.conversationId, c.ownerId]);
      await c.db.run("update conversations set replied = true where owner_id = $2 and id = $1", [place.conversationId, c.ownerId]);
    }
    const first = uid("o");
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, conversation_id, message_id, task_id, thread_ts, created_at) values ($1, $2, 'slack', $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [first, c.ownerId, place.target, holder.name, place.label, text(person ? (person.slack_user_id ? `<@${person.slack_user_id}>` : person.name) : ""), place.conversationId, messageId, taskId, place.thread ?? null, now],
    );
    // In a thread that exists already it goes into that same thread, right after the message.
    await thenDescription(first, place.target, holder.name, place.label, place.thread ?? null);
  }
  await c.db.run("update tasks set due = $1, delegated_to = $2, delegated_name = $3, delegated_role = $4, delegated_note = $5, delegated_at = $6, assignee_user = null, updated_at = $6 where owner_id = $8 and id = $7", [due, holder!.id, holder!.name, holder!.role, note, now, taskId, TEAM]);
  await logEvent(c, taskId, `Assigned to ${holder!.name}, told on Slack${where === "dm" ? "" : ` in ${holder!.role === "Slack channel" ? holder!.name : "the chat"}`}`);
}

/** The task still open for a conversation, if there is one. One is enough. */
async function openTaskFor(c: ActionContext, conversationId: string) {
  const [task] = await c.db.query<{ id: string; delegated_to: string | null }>("select id, delegated_to from tasks where owner_id = $3 and coalesce(source_owner, owner_id) = $1 and src_type = 'message' and src_id = $2 and not done order by created_at limit 1", [c.ownerId, conversationId, TEAM]);
  return task ?? null;
}

/** "Reply to Maya: …" without links or the owner's own tag in it. */
async function replyTitle(c: ActionContext, lead: string, text: string) {
  const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
  return `${lead}: ${requestSummary(text, `@${owner?.name ?? ""}`)}`;
}

/** What a message with pictures and no words says, as the Slack check also has it. */
const PICTURE_ONLY = "(sent a picture)";

/** A number fit to be a picture's width or height on screen, or nothing. */
const side = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 20_000 ? v : undefined);

/**
 * The pictures added to a reply on screen, checked: each was kept here for this person when it
 * was added (see `saveUpload`), Slack may be sent them, and there are not too many.
 */
async function addedPictures(c: ActionContext, source: Source, given: unknown): Promise<StoredPicture[]> {
  if (given === undefined || given === null || (Array.isArray(given) && !given.length)) return [];
  if (!Array.isArray(given)) throw new Error("Those pictures could not be read. Add them again.");
  if (source !== "slack") throw new Error("Pictures can only be sent on Slack for now.");
  if (given.length > MOST_PICTURES) throw new Error(`At most ${MOST_PICTURES} pictures can go with one message.`);
  const [slack] = await c.db.query<{ scopes: string | null }>("select scopes from connections where owner_id = $1 and provider = 'slack'", [c.ownerId]);
  if (slack?.scopes && !slack.scopes.split(",").includes(SLACK_UPLOAD_SCOPE)) throw new Error(SLACK_NEEDS_UPLOAD);
  const pictures = given as Partial<AddedPicture>[];
  const keys = pictures.map((p) => p?.key);
  if (!keys.every(isUploadKey) || new Set(keys).size !== keys.length) throw new Error("Those pictures could not be read. Add them again.");
  const kept = await c.db.query<{ key: string }>("select key from media where owner_id = $1 and key in (select jsonb_array_elements_text($2::jsonb))", [c.ownerId, JSON.stringify(keys)]);
  if (kept.length !== keys.length) throw new Error("A picture is no longer here. Add it again.");
  return pictures.map((p, n) => ({
    kind: "image",
    name: (typeof p.name === "string" ? p.name.trim() : "").slice(0, 120) || `Picture ${n + 1}`,
    w: side(p.w),
    h: side(p.h),
    key: keys[n] as string,
  }));
}

/** Reads a conversation and holds it for this change, so two clicks on the same button cannot both act on it. */
/** What an email waiting in the outbox needs to go out: see `rawEmail` and outbox.ts. */
export interface EmailDetails {
  account: string;
  threadId?: string;
  to: Address[];
  cc: Address[];
  subject: string;
  inReplyTo?: string;
  references?: string;
}

/** An email row's account and Gmail thread: its external id is "<account>:<thread>". */
function emailPlace(externalId: string): { account: string; threadId: string } {
  const cut = externalId.lastIndexOf(":");
  return { account: externalId.slice(0, cut), threadId: externalId.slice(cut + 1) };
}

/** Sending needs the account connected here, and allowed to send on Google's page. */
async function mustSendFrom(c: ActionContext, account: string): Promise<void> {
  const [row] = !hostedProblem("google") ? await c.db.query<{ scopes: string }>("select scopes from google_accounts where owner_id = $1 and email = $2", [c.ownerId, account]) : [];
  if (!row) throw new Error(`${account} is not connected. Connect it on the Connections tab.`);
  if (!googleCan(row.scopes.split(",")).send) throw new Error(`Sending was not allowed for ${account}. Connect it again on the Connections tab and allow sending.`);
}

/** Addresses typed in a box, split on commas, semicolons and new lines. Each one must be an address. */
function typedAddresses(typed: string): Address[] {
  return typed
    .split(/[,;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const address = parseAddress(part);
      if (!isEmailAddress(address.email)) throw new Error(`"${part}" is not an email address.`);
      return address;
    });
}

const reSubject = (subject: string) => (/^re\s*:/i.test(subject) ? subject : `Re: ${subject}`);

/**
 * Puts the answer to an email in the outbox. It goes to whoever wrote last, and with `replyAll`
 * also to everyone else that email was to or copied to, except the owner's own account. It
 * carries the headers that keep it in the same thread in everyone's mail.
 */
async function replyByEmail(c: ActionContext, conv: ConversationRow & { external_id: string }, text: string, markDone: boolean, replyAll: boolean): Promise<void> {
  const { account, threadId } = emailPlace(conv.external_id);
  await mustSendFrom(c, account);
  if (!text.trim()) throw new Error("Write a reply first.");
  const [last] = await c.db.query<{ sender_name: string; sender_id: string | null; email: { to?: Address[]; cc?: Address[]; messageId?: string; references?: string } | null }>(
    "select sender_name, sender_id, email from messages where owner_id = $2 and conversation_id = $1 and not me and sender_id is not null order by at desc limit 1",
    [conv.id, c.ownerId],
  );
  if (!last?.sender_id) throw new Error("There is no email from someone else here to answer.");
  const to: Address[] = [{ name: last.sender_name, email: last.sender_id }];
  const cc: Address[] = [];
  const taken = new Set([account.toLowerCase(), last.sender_id.toLowerCase()]);
  for (const a of replyAll ? [...(last.email?.to ?? []), ...(last.email?.cc ?? [])] : []) {
    if (taken.has(a.email.toLowerCase())) continue;
    taken.add(a.email.toLowerCase());
    cc.push(a);
  }
  const messageId = last.email?.messageId || undefined;
  const details: EmailDetails = { account, threadId, to, cc, subject: reSubject(conv.ctx), inReplyTo: messageId, references: [last.email?.references, messageId].filter(Boolean).join(" ") || undefined };
  const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
  const messageRow = uid("m");
  await c.db.run(
    "insert into messages (id, conversation_id, owner_id, sender_name, me, body, at, status, scanned, asked, email) values ($1, $2, $3, $4, true, $5, $6, 'queued', true, true, $7::jsonb)",
    [messageRow, conv.id, c.ownerId, owner?.name ?? "You", text, c.now.getTime(), JSON.stringify({ to, cc })],
  );
  await c.db.run("update conversations set replied = true, done = done or $1, auto_done = auto_done and not $1 where owner_id = $3 and id = $2", [markDone, conv.id, c.ownerId]);
  await c.db.run(
    "insert into outbox (id, owner_id, source, target, to_name, ctx, body, conversation_id, message_id, created_at, details) values ($1, $2, 'gmail', $3, $4, $5, $6, $7, $8, $9, $10::jsonb)",
    [uid("o"), c.ownerId, conv.external_id, `${last.sender_name}${cc.length ? ` and ${cc.length} more` : ""}`, conv.ctx, text, conv.id, messageRow, c.now.getTime(), JSON.stringify(details)],
  );
}

async function conversation(c: ActionContext, id: string) {
  const [row] = await c.db.query<ConversationRow & { external_id: string }>("select * from conversations where owner_id = $1 and id = $2 for update", [c.ownerId, id]);
  if (!row) throw new Error("That conversation no longer exists.");
  return row;
}

/** Changes to team logins are the owner's alone. */
function onlyOwner(c: ActionContext): void {
  if (c.ownerId !== OWNER_ID) throw new Error("Only the owner can change team logins.");
}

/** The most conversations one change made on screen may touch. */
const BULK_MOST = 500;

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
  /**
   * `thread` is the id of the message that started a thread: the reply then goes into that thread, as it would in Slack.
   * `pictures` were added to the reply on screen, and go with it (Slack only).
   */
  async sendReply(c, id: string, text: string, markDone: boolean, thread?: string | null, pictures?: AddedPicture[]) {
    const conv = await conversation(c, id);
    // An email is answered by email (see `replyEmail`).
    if (conv.source === "gmail" && !pictures?.length) return replyByEmail(c, conv, text, markDone, false);
    const added = await addedPictures(c, conv.source, pictures);
    if (typeof text !== "string" || (!text.trim() && !added.length)) throw new Error("Write a reply first.");
    const [owner] = await c.db.query<{ name: string }>("select name from users where id = $1", [c.ownerId]);
    let threadTs: string | null = null;
    // A row that is one thread in a channel is answered in that thread, never beside it.
    thread = conv.thread_ts ?? thread;
    if (thread) {
      // Only a thread that really is in this conversation.
      const [known] = await c.db.query<{ n: number }>("select count(*)::int as n from messages where owner_id = $3 and conversation_id = $1 and (external_id = $2 or thread_ts = $2)", [id, thread, c.ownerId]);
      if (!known?.n) throw new Error("That thread is no longer in this conversation.");
      threadTs = thread;
      // The message being answered now starts a thread, if it did not before.
      await c.db.run("update messages set thread_ts = $1 where owner_id = $3 and conversation_id = $2 and external_id = $1 and thread_ts is null", [thread, id, c.ownerId]);
    }
    const messageId = uid("m");
    // The pictures go with the message: the conversation shows them, and the outbox sends them from there.
    await c.db.run(
      "insert into messages (id, conversation_id, owner_id, sender_name, me, body, at, status, scanned, asked, thread_ts, attachments) values ($1, $2, $3, $4, true, $5, $6, 'queued', true, true, $7, $8::jsonb)",
      [messageId, id, c.ownerId, owner?.name ?? "You", text.trim() ? text : PICTURE_ONLY, c.now.getTime(), threadTs, JSON.stringify(added)],
    );
    await c.db.run("update conversations set replied = true, done = done or $1, auto_done = auto_done and not $1 where owner_id = $3 and id = $2", [markDone, id, c.ownerId]);
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, conversation_id, message_id, thread_ts, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
      [uid("o"), c.ownerId, conv.source, conv.external_id, conv.from_name, conv.ctx, text.trim() ? text : "", id, messageId, threadTs, c.now.getTime()],
    );
  },
  /** Answers an email: to whoever wrote last, or with `replyAll` also to everyone else on that email. */
  async replyEmail(c, id: string, text: string, markDone: boolean, replyAll: boolean) {
    const conv = await conversation(c, id);
    if (conv.source !== "gmail") throw new Error("That conversation is not an email.");
    await replyByEmail(c, conv, text, markDone, replyAll);
  },
  /** A new email from one of the connected accounts. It goes out through the outbox, like a reply. */
  async composeEmail(c, account: string, to: string, cc: string, subject: string, body: string) {
    await mustSendFrom(c, account);
    const toList = typedAddresses(to);
    const ccList = typedAddresses(cc);
    if (!toList.length) throw new Error("Who is it to? Type at least one email address.");
    if (!body.trim()) throw new Error("Write the email first.");
    const title = subject.trim() || "(no subject)";
    const toName = `${toList[0].name}${toList.length + ccList.length > 1 ? ` and ${toList.length + ccList.length - 1} more` : ""}`;
    await c.db.run(
      "insert into outbox (id, owner_id, source, target, to_name, ctx, body, created_at, details) values ($1, $2, 'gmail', $3, $4, $5, $6, $7, $8::jsonb)",
      [uid("o"), c.ownerId, account, toName, title, body, c.now.getTime(), JSON.stringify({ account, to: toList, cc: ccList, subject: title } satisfies EmailDetails)],
    );
  },
  async markConversationDone(c, id: string) {
    await c.db.run("update conversations set done = true, auto_done = false where owner_id = $1 and id = $2", [c.ownerId, id]);
  },
  /** Puts one cleared conversation back in the inbox. */
  async restoreConversation(c, id: string) {
    // Its age counts from now, so the rule that clears old conversations leaves it for a few days.
    await c.db.run("update conversations set done = false, auto_done = false, restored_at = $3 where owner_id = $1 and id = $2", [c.ownerId, id, c.now.getTime()]);
  },
  /**
   * The same change to many conversations at once, picked on screen: done, back in the inbox,
   * a priority or a side, each as the one-at-a-time action does it. Only the owner's own change.
   */
  async editConversations(c, ids: unknown, change: ConversationChange) {
    const list = Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string"))] : [];
    if (!list.length) return;
    if (list.length > BULK_MOST) throw new Error(`Pick at most ${BULK_MOST} at a time.`);
    if (change.pri !== undefined && !PRIORITIES.includes(change.pri)) throw new Error("That priority does not exist.");
    const args = [c.ownerId, JSON.stringify(list)];
    if (change.done === true) await c.db.run(`update conversations set done = true, auto_done = false where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))`, args);
    if (change.done === false) await c.db.run(`update conversations set done = false, auto_done = false, restored_at = $3 where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))`, [...args, c.now.getTime()]);
    if (change.pri) await c.db.run(`update conversations set pri = $3, manual_pri = true where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))`, [...args, change.pri]);
    if (change.mode) {
      await c.db.run(`update conversations set mode = $3, manual_mode = true where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))`, [...args, asMode(change.mode)]);
      await c.db.run("update suggestions set mode = $3 where owner_id = $1 and src_type = 'message' and status = 'new' and src_id in (select jsonb_array_elements_text($2::jsonb))", [...args, asMode(change.mode)]);
    }
  },
  async conversationToTask(c, id: string, today: string) {
    const conv = await conversation(c, id);
    // A second click, or a chat that already has its task, adds nothing.
    if (!(await openTaskFor(c, id))) {
      await insertTask(c, { title: await replyTitle(c, `Reply to ${conv.from_name}`, conv.last_text), dept: "Operations", project: conv.project, pri: conv.pri, due: today, mode: conv.mode, src: { type: "message", id } });
    }
    await c.db.run("update conversations set done = true, auto_done = false where owner_id = $2 and id = $1", [id, c.ownerId]);
  },
  async delegateConversation(c, id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
    const conv = await conversation(c, id);
    const existing = await openTaskFor(c, id);
    // Already assigned: this is a second click on Assign.
    if (existing?.delegated_to) return;
    // The person is optional when the task goes to a chat or a channel.
    const person = personId ? await assignee(c, personId) : null;
    const [team] = person ? await c.db.query<{ depts: string[] }>("select depts from team_members where owner_id = $1 and id = $2", [c.ownerId, person.id]) : [];
    const taskId = existing?.id ?? (await insertTask(c, { title: await replyTitle(c, `From ${conv.from_name}`, conv.last_text), dept: team?.depts?.[0] ?? "Operations", project: conv.project, pri: conv.pri, due, src: { type: "message", id } }));
    await delegate(c, taskId, person?.id ?? "", note, due, where);
    await c.db.run("update conversations set done = true, auto_done = false where owner_id = $2 and id = $1", [id, c.ownerId]);
  },

  // Tasks
  /** Makes the task, on the owner's plate. Handing it to someone is a step of its own (`delegateTask`), so the whole task can be read first. */
  async addTask(c, input: { title: string; description?: string; dept: string; project: string; pri: Priority; due: string; mode?: Mode }) {
    await insertTask(c, input);
  },
  async setTaskDescription(c, id: string, description: string) {
    await teamTask(c, id);
    await c.db.run("update tasks set description = $1, updated_at = $4 where owner_id = $2 and id = $3", [asDescription(description), TEAM, id, c.now.getTime()]);
    await logEvent(c, id, "Description changed");
  },
  /** Turns one action item from a call into a task, once. Someone else's becomes a follow-up. */
  async actionItemToTask(c, meetingId: string, index: number) {
    const [meeting] = await c.db.query<{ project: string; action_items: Meeting["actionItems"] }>("select project, action_items from meetings where owner_id = $1 and id = $2", [c.ownerId, meetingId]);
    const item = meeting?.action_items?.[index];
    if (!item) throw new Error("That action item no longer exists.");
    const title = (item.mine ? item.text : `Follow up with ${item.who}: ${item.text}`).slice(0, 160);
    const [{ n }] = await c.db.query<{ n: number }>("select count(*)::int as n from tasks where owner_id = $4 and coalesce(source_owner, owner_id) = $1 and src_type = 'meeting' and src_id = $2 and title = $3", [c.ownerId, meetingId, title, TEAM]);
    if (n > 0) return;
    await insertTask(c, { title, dept: "Operations", project: meeting.project, pri: "mid", due: addDays(c.now, 2), src: { type: "meeting", id: meetingId } });
  },
  async toggleTask(c, id: string, done: boolean) {
    await teamTask(c, id);
    await c.db.run("update tasks set done = $1, done_at = $2, status = case when $1 then 'done' when status = 'done' then 'open' else status end, updated_at = $5 where owner_id = $3 and id = $4", [done, done ? c.now.getTime() : null, TEAM, id, c.now.getTime()]);
    await logEvent(c, id, done ? "Status: Done" : "Status: Open");
  },
  async setTaskPriority(c, id: string, pri: Priority) {
    await teamTask(c, id);
    await c.db.run("update tasks set pri = $1, updated_at = $4 where owner_id = $2 and id = $3", [pri, TEAM, id, c.now.getTime()]);
  },
  async delegateTask(c, id: string, personId: string, note: string, due: string, where: AssignWhere = "dm") {
    await teamTask(c, id);
    const [task] = await c.db.query<{ delegated_to: string | null }>("select delegated_to from tasks where owner_id = $1 and id = $2 for update", [TEAM, id]);
    // Already assigned: this is a second click on Assign.
    if (task?.delegated_to) return;
    await delegate(c, id, personId, note, due, where);
  },
  async undelegateTask(c, id: string) {
    await teamTask(c, id);
    // Back with whoever took it back.
    await c.db.run("update tasks set delegated_to = null, delegated_name = null, delegated_role = null, delegated_note = null, delegated_at = null, assignee_user = $3 where owner_id = $1 and id = $2", [TEAM, id, c.ownerId]);
    await logEvent(c, id, "Taken back");
    // A hand-off that was never sent is withdrawn with the task: from the outbox, and from the
    // chat's thread if it was going to be posted there.
    const unsent = await c.db.query<{ message_id: string | null; conversation_id: string | null }>("delete from outbox where owner_id = $1 and task_id = $2 and status = 'queued' returning message_id, conversation_id", [c.ownerId, id]);
    for (const row of unsent) {
      if (!row.message_id || !row.conversation_id) continue;
      await c.db.run("delete from messages where owner_id = $2 and id = $1", [row.message_id, c.ownerId]);
      await c.db.run("update conversations set replied = coalesce((select me from messages where owner_id = $2 and conversation_id = $1 order by at desc, id desc limit 1), false) where owner_id = $2 and id = $1", [row.conversation_id, c.ownerId]);
    }
  },

  // Suggested tasks: see TICKET_ACTIONS in tickets.ts, which reviews them for the whole team.

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

  // Settings: team logins. Only the owner adds, changes and turns them off; nothing here touches the owner's own login.
  async addTeamLogin(c, name: unknown, email: unknown, password: unknown) {
    onlyOwner(c);
    const who = String(name ?? "").trim();
    const address = String(email ?? "").trim().toLowerCase();
    const secret = String(password ?? "");
    if (!who) throw new Error("Write their name.");
    if (!isEmailAddress(address)) throw new Error("That email address does not look right.");
    if (secret.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
    if (address === (process.env.LOGIN_EMAIL ?? "").trim().toLowerCase()) throw new Error("That is your own login.");
    const [taken] = await c.db.query<{ id: string }>("select id from users where lower(login_email) = $1", [address]);
    if (taken) throw new Error("Someone already signs in with that email.");
    const id = uid("u");
    await c.db.run("insert into users (id, name, email, login_email, password_hash, created_at) values ($1, $2, $3, $3, $4, $5)", [id, who, address, hashPassword(secret), c.now.getTime()]);
    // Their own checks, timers and starting rules, as the owner had on their first start.
    await ensureOwner(c.db, id);
  },
  /** A new password. Every session made with the old one ends. It also turns a login that was off back on. */
  async setTeamPassword(c, id: string, password: unknown) {
    onlyOwner(c);
    const secret = String(password ?? "");
    if (secret.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
    const changed = await c.db.run("update users set password_hash = $1 where id = $2 and id <> $3 and login_email is not null", [hashPassword(secret), id, OWNER_ID]);
    if (!changed) throw new Error("That login no longer exists.");
  },
  /** Removes a team member's login and everything of theirs: their connections, messages and tasks. Never the owner's. */
  async removeTeamLogin(c, id: string) {
    onlyOwner(c);
    if (id === OWNER_ID) throw new Error("That is your own login.");
    // Every table of theirs goes with them (on delete cascade).
    await c.db.run("delete from users where id = $1 and id <> $2 and login_email is not null", [id, OWNER_ID]);
  },
  /** They can no longer sign in, and their checks stop. What they had stays, for when it is turned on again. */
  async turnOffTeamLogin(c, id: string) {
    onlyOwner(c);
    await c.db.run("update users set password_hash = null where id = $1 and id <> $2 and login_email is not null", [id, OWNER_ID]);
  },

  // Settings: team
  // Settings: the team list. It is the team's: everyone with a login assigns from the same one.
  async togglePersonDept(c, id: string, dept: string) {
    const [p] = await c.db.query<{ depts: string[] }>("select depts from team_members where owner_id = $1 and id = $2", [TEAM, id]);
    if (!p) return;
    const depts = p.depts.includes(dept) ? p.depts.filter((d) => d !== dept) : [...p.depts, dept];
    await c.db.run("update team_members set depts = $1 where owner_id = $3 and id = $2", [JSON.stringify(depts), id, TEAM]);
  },
  async addHandle(c, id: string, handle: string) {
    const [p] = await c.db.query<{ handles: string[] }>("select handles from team_members where owner_id = $1 and id = $2", [TEAM, id]);
    if (!p || p.handles.some((h) => h.toLowerCase() === handle.toLowerCase())) return;
    await c.db.run("update team_members set handles = $1 where owner_id = $3 and id = $2", [JSON.stringify([...p.handles, handle]), id, TEAM]);
  },
  async removeHandle(c, id: string, index: number) {
    const [p] = await c.db.query<{ handles: string[] }>("select handles from team_members where owner_id = $1 and id = $2", [TEAM, id]);
    if (!p) return;
    await c.db.run("update team_members set handles = $1 where owner_id = $3 and id = $2", [JSON.stringify(p.handles.filter((_, k) => k !== index)), id, TEAM]);
  },
  async addPerson(c, input: { name: string; role: string; depts: string[]; handles: string[]; slackUserId?: string | null }) {
    await c.db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id, position) values ($1, $2, $3, $4, $5, $6, $7, $8)", [uid("u"), TEAM, input.name, input.role, JSON.stringify(input.depts), JSON.stringify(input.handles), input.slackUserId || null, Math.floor(c.now.getTime() / 1000)]);
  },
  /** Their Telegram account, so an assignment can reach them there. Empty takes it away. */
  async setPersonTelegram(c, id: string, telegramId: string) {
    const value = String(telegramId ?? "").trim();
    if (value && !/^-?\d{1,20}$/.test(value)) throw new Error("Pick them from your Telegram chats.");
    await c.db.run("update team_members set telegram_id = $3 where owner_id = $1 and id = $2", [TEAM, id, value || null]);
  },
  async removePerson(c, id: string) {
    await c.db.run("delete from team_members where owner_id = $1 and id = $2", [TEAM, id]);
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
    for (const [position, r] of rows.entries()) await c.db.run("update rules set position = $1 where owner_id = $3 and id = $2", [position, r.id, c.ownerId]);
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
  /** Ticks or unticks a channel, chat or person as important, and re-sorts the inbox straight away. */
  async setImportant(c, source: "slack" | "telegram", kind: "chat" | "person", id: string, name: string, on: boolean) {
    if (!["slack", "telegram"].includes(source) || !["chat", "person"].includes(kind) || !id) throw new Error("That is not something that can be marked important.");
    if (on) {
      await c.db.run("insert into important (owner_id, source, kind, external_id, name) values ($1, $2, $3, $4, $5) on conflict (owner_id, source, kind, external_id) do update set name = excluded.name", [c.ownerId, source, kind, id, name || id]);
    } else {
      await c.db.run("delete from important where owner_id = $1 and source = $2 and kind = $3 and external_id = $4", [c.ownerId, source, kind, id]);
    }
    await resortInbox(c.db, c.ownerId);
  },
  async setChannelSelected(c, id: string, selected: boolean) {
    await c.db.run("update slack_channels set selected = $1 where owner_id = $2 and id = $3", [selected, c.ownerId, id]);
  },
  /**
   * Ticks or unticks Telegram chats to come in (see jobs/telegram.ts). A chat switched off leaves
   * the dashboard at once: its messages, its pictures, and its suggestions nobody has decided on.
   * Telegram itself is not touched, and a task already made from it stays.
   */
  async setTelegramSync(c, ids: unknown, on: unknown) {
    const chats = (Array.isArray(ids) ? ids : [ids]).filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 1000);
    if (!chats.length) throw new Error("Which chats?");
    await c.db.run("update telegram_chats set synced = $3 where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))", [c.ownerId, JSON.stringify(chats), Boolean(on)]);
    if (on) return;
    const rows = JSON.stringify(chats.map((id) => `telegram:${id}`));
    await c.db.run(
      "update suggestions set status = 'dismissed', reason = 'chat_off' where owner_id = $1 and status = 'new' and src_type = 'message' and src_id in (select jsonb_array_elements_text($2::jsonb))",
      [c.ownerId, rows],
    );
    // Its messages go with it.
    await c.db.run("delete from conversations where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))", [c.ownerId, rows]);
    await c.db.run("delete from media where owner_id = $1 and split_part(key, '/', 1) = 'telegram' and split_part(key, '/', 2) in (select jsonb_array_elements_text($2::jsonb))", [
      c.ownerId,
      JSON.stringify(chats),
    ]);
  },

  // Connections
  async disconnectProvider(c, provider: Provider) {
    // Google's login is ended on Google's side too, and its checks start over next time.
    if (provider === "google") return forgetGoogle(c.db, c.ownerId, null, false);
    await c.db.run("delete from connections where owner_id = $1 and provider = $2", [c.ownerId, provider]);
  },

  // The board and the review, shared by the team.
  ...TICKET_ACTIONS,
};

export async function applyAction(db: Db, type: string, args: unknown[], ownerId = OWNER_ID, now = new Date()): Promise<void> {
  const action = ACTIONS[type];
  if (!action) throw new Error(`Unknown action: ${type}`);
  await db.transaction((tx) => action({ db: tx, ownerId, now }, ...args));
}
