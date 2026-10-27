// The team's board and the review of what the checks flag, shared by everyone with a login.
//
// Every ticket is the team's: it is kept under the owner (TEAM) whoever made it, and everyone
// with a login reads and changes the same ones. What a ticket came from stays where it was, in
// the inbox or the calls of whoever it came from (`source_owner`). The ticket keeps the line
// itself and where it was said, so the rest of the team can read it without that inbox.
// Personal tickets and suggestions are never shown to anyone but the owner.
//
// The review shows every open suggestion from everyone's checks. Accepting one makes a ticket;
// turning one down keeps why. Assigning a ticket to a team member tells them on Slack or
// Telegram from the account of whoever assigned it, through the outbox like every message.
import crypto from "node:crypto";
import { PRIORITY_NAME, REJECT_REASONS, SOURCE_NAME, TICKET_PREFIX, TICKET_STATUS_NAME, TICKET_STATUSES, type RejectReason } from "@/core/config";
import { assignmentText, CHANNEL_PICK, SLACK_PICK } from "@/core/delegation";
import { isoDay, parseDay } from "@/core/dates";
import { norm } from "@/core/rules";
import type { Mode, Priority, ReviewItem, Source, SourceNote, Task, TaskSource, TeamPerson, TicketEvent, TicketInput, TicketStatus } from "@/core/types";
import type { Db } from "./db";
import { OWNER_ID } from "./owner";

/** Whose rows the team's tickets are: the owner's. */
export const TEAM = OWNER_ID;

type Ctx = { db: Db; ownerId: string; now: Date };
type Notify = NonNullable<TicketInput["notify"]>[number];

const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
const tidy = (text: unknown, most: number) =>
  String(text ?? "")
    .trim()
    .slice(0, most);
const PRIORITIES: Priority[] = ["high", "mid", "low"];
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parseDay(v).getTime());
const shortDay = (iso: string) =>
  parseDay(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

export const ticketName = (n: number | null | undefined) => (n ? `${TICKET_PREFIX}-${n}` : "");

/** The SQL that names everyone with a login on the team, the owner among them, with the team as the parameter `team` (such as "$1"). */
export const teamUsersSql = (team: string) => `select id from users where id = ${team} or (login_email is not null and password_hash is not null)`;
const TEAM_USERS = teamUsersSql("$1");

/**
 * A login's Slack account (with the team as $1, on the users row `u`): the one they connected,
 * else the one in the team's Slack with their email.
 */
const LOGIN_SLACK = `coalesce(u.slack_user_id, (select s.id from slack_users s where s.owner_id in (${TEAM_USERS}) and not s.deleted and not s.is_bot and s.email is not null
  and lower(s.email) = lower(coalesce(u.login_email, u.email)) order by (s.owner_id = $1) desc, s.id limit 1))`;

/**
 * Whether the Slack account `slackId` may be told about a task that `assigner` gave them. Jeremy
 * (the owner) never is. Another login, such as Alex, only when Jeremy gives it. Anyone else,
 * such as someone on the team list, always: from the Slack account of whoever gave it.
 */
export async function mayTellOnSlack(db: Db, assigner: string, slackId: string): Promise<boolean> {
  const [login] = await db.query<{ id: string }>(`select u.id from users u where u.id in (${TEAM_USERS}) and ${LOGIN_SLACK} = $2 limit 1`, [TEAM, slackId]);
  return !login || (login.id !== TEAM && assigner === TEAM);
}

/** The team's clients: those added by name, and those tickets, calls and chats already name. Each once, whatever its capitals. */
export async function teamClients(db: Db, viewer: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `select name from clients where owner_id = $1
     union all select project from tasks where owner_id = $1 and mode = 'professional'
     union all select project from meetings where owner_id = $2
     union all select project from conversations where owner_id = $2 and mode = 'professional'`,
    [TEAM, viewer],
  );
  const seen = new Map<string, string>();
  for (const { name } of rows) {
    const clean = name?.trim();
    if (clean && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Everyone with a login on the team, the owner first. */
export async function teamUsers(db: Db): Promise<{ id: string; name: string }[]> {
  return db.query<{ id: string; name: string }>(`select id, name from users where id in (${TEAM_USERS}) order by (id = $1) desc, created_at, id`, [TEAM]);
}

/** Everyone a ticket can be for: the logins first, then the team list. */
export async function teamPeople(db: Db): Promise<TeamPerson[]> {
  const users = await teamUsers(db);
  const slackOf = new Map((await db.query<{ id: string; slack: string | null }>(`select u.id, ${LOGIN_SLACK} as slack from users u where u.id in (${TEAM_USERS})`, [TEAM])).map((r) => [r.id, r.slack]));
  const members = await db.query<{
    id: string;
    name: string;
    role: string;
    slack_user_id: string | null;
    telegram_id: string | null;
  }>("select id, name, role, slack_user_id, telegram_id from team_members where owner_id = $1 order by position, name", [TEAM]);
  return [
    ...users.map((u) => ({
      id: `user:${u.id}`,
      name: u.name,
      role: u.id === TEAM ? "Owner" : "Team login",
      login: true,
      slack: Boolean(slackOf.get(u.id)),
      telegram: false,
    })),
    ...members.map((m) => ({
      id: `member:${m.id}`,
      name: m.name,
      role: m.role,
      login: false,
      slack: Boolean(m.slack_user_id),
      telegram: Boolean(m.telegram_id),
    })),
  ];
}

// ---------- Where something came from ----------

/** The message a request suggestion was found in, and the action item a call suggestion is. */
const askedIn = (key: string) => (key.startsWith("ask:") ? key.slice(4) : null);
const actionIndex = (key: string) => {
  const found = /:action:(\d+)$/.exec(key);
  return found ? Number(found[1]) : null;
};

interface ActionItemRow {
  text: string;
  who: string;
  mine: boolean;
  done: boolean;
}
interface SourceParts {
  c_source: Source | null;
  c_ctx: string | null;
  c_from: string | null;
  c_chat: string | null;
  c_text: string | null;
  m_body: string | null;
  mt_title: string | null;
  mt_url: string | null;
  mt_items: ActionItemRow[] | null;
}

/** Slack opens the chat itself from here; Gmail the thread, in the account it came to. */
function placeLink(source: Source | null, externalId: string | null): string | null {
  if (!externalId) return null;
  if (source === "slack") return `https://slack.com/app_redirect?channel=${encodeURIComponent(externalId)}`;
  if (source === "gmail") {
    const cut = externalId.lastIndexOf(":");
    return `https://mail.google.com/mail/u/${encodeURIComponent(externalId.slice(0, cut))}/#all/${encodeURIComponent(externalId.slice(cut + 1))}`;
  }
  return null;
}

function noteOf(type: TaskSource["type"] | null, r: SourceParts, item: number | null, from: string): SourceNote | null {
  if (type === "message" && r.c_source) {
    const where = !r.c_ctx || r.c_ctx === "Direct message" ? (r.c_from ?? "") : r.c_ctx;
    return {
      label: `${SOURCE_NAME[r.c_source]} · ${where}`,
      quote: tidy(r.m_body ?? r.c_text, 2000),
      link: placeLink(r.c_source, r.c_chat),
      from,
    };
  }
  if (type === "meeting" && r.mt_title !== null) {
    return {
      label: `Fathom · ${r.mt_title}`,
      quote: tidy(item !== null ? r.mt_items?.[item]?.text : "", 2000),
      link: r.mt_url,
      from,
    };
  }
  return null;
}

/** Where a ticket comes from, read from the inbox or calls of whoever it came from. */
export async function sourceNote(db: Db, ownerId: string, src: TaskSource | null | undefined, key = ""): Promise<SourceNote | null> {
  if (!src) return null;
  const [who] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const parts: SourceParts = {
    c_source: null,
    c_ctx: null,
    c_from: null,
    c_chat: null,
    c_text: null,
    m_body: null,
    mt_title: null,
    mt_url: null,
    mt_items: null,
  };
  if (src.type === "message") {
    const [c] = await db.query<{
      source: Source;
      ctx: string;
      from_name: string;
      external_id: string;
      last_text: string;
    }>("select source, ctx, from_name, external_id, last_text from conversations where owner_id = $1 and id = $2", [ownerId, src.id]);
    if (!c) return null;
    const asked = askedIn(key);
    const [m] = asked ? await db.query<{ body: string }>("select body from messages where owner_id = $1 and id = $2", [ownerId, asked]) : [];
    Object.assign(parts, {
      c_source: c.source,
      c_ctx: c.ctx,
      c_from: c.from_name,
      c_chat: c.external_id,
      c_text: c.last_text,
      m_body: m?.body ?? null,
    });
  } else {
    const [mt] = await db.query<{
      title: string;
      url: string | null;
      action_items: ActionItemRow[];
    }>("select title, url, action_items from meetings where owner_id = $1 and id = $2", [ownerId, src.id]);
    if (!mt) return null;
    Object.assign(parts, {
      mt_title: mt.title,
      mt_url: mt.url,
      mt_items: mt.action_items,
    });
  }
  return noteOf(src.type, parts, actionIndex(key), who?.name ?? "");
}

// ---------- The review ----------

interface SuggestionRow extends SourceParts {
  id: string;
  owner_id: string;
  title: string;
  why: string;
  project: string;
  pri: Priority;
  due: string;
  mode: Mode;
  src_type: TaskSource["type"] | null;
  src_id: string | null;
  dedupe_key: string;
  for_name: string | null;
  looks_done: string | null;
  delegable: boolean;
  created_at: number;
  from_name: string;
  m_at: number | null;
  mt_at: number | null;
  confidence: number | null;
  checked_at: number | null;
}

const firstName = (name: string) => norm(name).split(" ")[0] ?? "";

/** The checks write why a suggestion was found to whoever's inbox it is ("your reply"). For anyone else, and on a ticket the team shares, it names them. */
export const whyFor = (why: string, from: string) => why.replace(/\byour (reply|action item)\b/g, `${from}'s $1`);

/** The person a name is, on the team: the whole name first, then the first name if only one person has it. */
export function personNamed(people: TeamPerson[], name: string | null | undefined): TeamPerson | null {
  if (!name) return null;
  const whole = people.find((p) => norm(p.name) === norm(name));
  if (whole) return whole;
  const first = people.filter((p) => firstName(p.name) && firstName(p.name) === firstName(name));
  return first.length === 1 ? first[0] : null;
}

/** Who a suggestion would go to: whoever the source says, else whoever's inbox or call it is. */
/** Someone in the team's Slack, who can be picked straight from there: "slack:<id>". */
type InSlack = { id: string; name: string };

function guessFor(g: SuggestionRow, people: TeamPerson[], slack: InSlack[] = []): { forName: string | null; assignee: string | null } {
  const item = g.src_type === "meeting" ? (g.mt_items?.[actionIndex(g.dedupe_key) ?? -1] ?? null) : null;
  if (item && !item.mine) {
    const named = g.for_name ?? (item.who && item.who !== "Unassigned" ? item.who : null);
    // Someone on the team first; else the same name in Slack, who joins the team list once it is theirs.
    const inSlack = personNamed(
      slack.map((u) => ({ id: `${SLACK_PICK}${u.id}`, name: u.name, role: "", login: false, slack: true, telegram: false })),
      named,
    );
    return { forName: named, assignee: personNamed(people, named)?.id ?? inSlack?.id ?? null };
  }
  // A message the AI says is for someone on the team goes to them; otherwise to whoever it was written to.
  const named = personNamed(people, g.for_name);
  return { forName: g.for_name, assignee: named?.id ?? `user:${g.owner_id}` };
}

const SUGGESTION_FROM = `select s.id, s.owner_id, s.title, s.why, s.project, s.pri, s.due, s.mode, s.src_type, s.src_id, s.dedupe_key, s.for_name, s.looks_done, s.delegable, s.created_at, s.confidence, s.checked_at, u.name as from_name,
         c.source as c_source, c.ctx as c_ctx, c.from_name as c_from, c.external_id as c_chat, c.last_text as c_text,
         m.body as m_body, m.at as m_at, mt.title as mt_title, mt.url as mt_url, mt.action_items as mt_items, mt.started_at as mt_at
  from suggestions s
  join users u on u.id = s.owner_id
  left join conversations c on s.src_type = 'message' and c.owner_id = s.owner_id and c.id = s.src_id
  left join messages m on s.dedupe_key like 'ask:%' and m.owner_id = s.owner_id and m.id = substr(s.dedupe_key, 5)
  left join meetings mt on s.src_type = 'meeting' and mt.owner_id = s.owner_id and mt.id = s.src_id`;

/** Every open suggestion across the team that this person may see. Takes the team as $1 and the person as $2. */
const SUGGESTION_SQL = `${SUGGESTION_FROM}
  where s.owner_id in (${TEAM_USERS}) and s.status = 'new' and (s.mode = 'professional' or s.owner_id = $2)`;

/** What the AI set aside as not a task, that this person may see. */
const SET_ASIDE_SQL = `${SUGGESTION_FROM}
  where s.owner_id in (${TEAM_USERS}) and s.status = 'dismissed' and s.reason = 'not_task' and s.confidence is not null
    and (s.mode = 'professional' or s.owner_id = $2)`;

/** How many of the AI's set-aside messages are sent, newest first. The page shows those raised since the Review tab started (see `reviewWaiting`). */
const SET_ASIDE_MOST = 100;

function toReview(g: SuggestionRow, viewer: string, people: TeamPerson[], slack: InSlack[]): ReviewItem {
  const item = g.src_type === "meeting" ? (g.mt_items?.[actionIndex(g.dedupe_key) ?? -1] ?? null) : null;
  const guess = guessFor(g, people, slack);
  return {
    id: g.id,
    title: g.title,
    why: g.owner_id === viewer ? g.why : whyFor(g.why, g.from_name),
    source: noteOf(g.src_type, g, actionIndex(g.dedupe_key), g.from_name) ?? {
      label: "Added by hand",
      quote: "",
      link: null,
      from: g.from_name,
    },
    forName: guess.forName,
    assignee: guess.assignee,
    client: g.project,
    due: g.due,
    pri: g.pri,
    at: Number(g.created_at),
    raisedAt: Number(g.m_at ?? g.mt_at ?? g.created_at),
    confidence: g.confidence === null ? null : Number(g.confidence),
    unchecked: g.src_type === "message" && g.dedupe_key.startsWith("ask:") && g.checked_at === null,
    looksDone: g.looks_done ?? (item?.done ? "Marked done in Fathom." : null),
    src: g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null,
    fromUser: g.owner_id,
    mine: g.owner_id === viewer,
  };
}

/** Every open suggestion across the team, newest first, as the review shows it. */
export async function reviewItems(db: Db, viewer: string, people: TeamPerson[]): Promise<ReviewItem[]> {
  const rows = await db.query<SuggestionRow>(`${SUGGESTION_SQL} order by s.created_at desc, s.id limit 300`, [TEAM, viewer]);
  const slack = rows.some((g) => g.src_type === "meeting") ? await teamSlack(db) : [];
  return rows.map((g) => toReview(g, viewer, people, slack));
}

/** What the AI set aside as not a task, newest first, so anyone can see it and put one back. */
export async function setAsideItems(db: Db, viewer: string, people: TeamPerson[]): Promise<ReviewItem[]> {
  const rows = await db.query<SuggestionRow>(`${SET_ASIDE_SQL} order by s.checked_at desc, s.id limit $3`, [TEAM, viewer, SET_ASIDE_MOST]);
  return rows.map((g) => toReview(g, viewer, people, []));
}

/** Everyone in the team's Slack, as the team's logins have read it: they share one workspace. */
export async function teamSlack(db: Db): Promise<InSlack[]> {
  return db.query<InSlack>(`select distinct on (id) id, name from slack_users where owner_id in (${TEAM_USERS}) and not is_bot and not deleted order by id, (owner_id = $1) desc`, [TEAM]);
}

/**
 * The team-list row for someone picked straight from Slack ("slack:<id>") or from the assigner's
 * own Telegram chats ("telegram:<id>"). Someone already on the list is that row; anyone else is
 * added, so they are there next time and can be told.
 */
async function memberFor(c: Ctx, pick: string): Promise<string> {
  const slack = pick.startsWith(SLACK_PICK);
  const id = pick.slice(pick.indexOf(":") + 1);
  if (!(slack ? /^[UW][A-Z0-9]{2,20}$/ : /^-?\d{1,20}$/).test(id)) throw new Error("Who should it be for?");
  const [known] = slack
    ? await c.db.query<{ id: string }>("select id from team_members where owner_id = $1 and slack_user_id = $2 order by position limit 1", [TEAM, id])
    : await c.db.query<{ id: string }>("select id from team_members where owner_id = $1 and telegram_id = $2 order by position limit 1", [TEAM, id]);
  if (known) return known.id;
  const [found] = slack
    ? await c.db.query<{ name: string }>(`select name from slack_users where owner_id in (${TEAM_USERS}) and id = $2 and not is_bot and not deleted order by (owner_id = $1) desc limit 1`, [TEAM, id])
    : await c.db.query<{ name: string }>("select from_name as name from conversations where owner_id = $1 and source = 'telegram' and direct and external_id = $2 limit 1", [c.ownerId, id]);
  if (!found) throw new Error(slack ? "That person is no longer in Slack." : "That person is not one of your Telegram chats.");
  const memberId = uid("u");
  await c.db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id, telegram_id, position) values ($1, $2, $3, 'Team member', '[]', '[]', $4, $5, $6)", [
    memberId,
    TEAM,
    found.name,
    slack ? id : null,
    slack ? null : id,
    Math.floor(c.now.getTime() / 1000),
  ]);
  return memberId;
}

// ---------- The board ----------

interface TicketRow {
  id: string;
  title: string;
  description: string | null;
  mode: Mode;
  dept: string;
  project: string;
  pri: Priority;
  due: string;
  done: boolean;
  done_at: number | null;
  src_type: TaskSource["type"] | null;
  src_id: string | null;
  delegable: boolean;
  delegated_to: string | null;
  delegated_name: string | null;
  delegated_role: string | null;
  delegated_note: string | null;
  delegated_at: number | null;
  created_at: number;
  status: TicketStatus | null;
  number: number | null;
  assignee_user: string | null;
  created_by: string | null;
  source_owner: string | null;
  src_quote: string | null;
  src_label: string | null;
  src_link: string | null;
}

/** Where a ticket stands. `done` decides done-ness, so a ticket ticked off by code that only knows `done` is still right. */
const statusOf = (t: Pick<TicketRow, "done" | "status">): TicketStatus => (t.done ? "done" : t.status && t.status !== "done" ? t.status : "open");

/**
 * Who a ticket is for. A login, a team member it was handed to, or a whole Slack channel
 * (nobody in particular). A ticket made before tickets had owners is whoever made it: the owner.
 */
function assigneeOf(t: TicketRow): string | null {
  if (t.assignee_user) return `user:${t.assignee_user}`;
  if (t.delegated_to) return t.delegated_to.startsWith(CHANNEL_PICK) ? null : `member:${t.delegated_to}`;
  return `user:${t.created_by ?? TEAM}`;
}

/** The team's tickets for one person: everything for the owner, the work ones for everyone else. */
export async function teamTickets(db: Db, viewer: string): Promise<Task[]> {
  const rows = await db.query<TicketRow>(`select * from tasks where owner_id = $1 and (mode = 'professional' or $2::boolean) order by created_at, id limit 1000`, [TEAM, viewer === TEAM]);
  if (!rows.length) return [];
  const names = new Map((await db.query<{ id: string; name: string }>("select id, name from users")).map((u) => [u.id, u.name]));
  const history = new Map<string, TicketEvent[]>();
  for (const e of await db.query<{
    task_id: string;
    at: number;
    by_name: string;
    what: string;
  }>("select task_id, at, by_name, what from ticket_events where owner_id = $1 order by at, id limit 5000", [TEAM])) {
    const list = history.get(e.task_id) ?? [];
    list.push({ at: Number(e.at), by: e.by_name, what: e.what });
    history.set(e.task_id, list);
  }
  return rows.map((t): Task => {
    const assignee = assigneeOf(t);
    const from = t.source_owner ?? (t.src_type ? TEAM : null);
    return {
      id: t.id,
      title: t.title,
      description: t.description ?? "",
      mode: t.mode,
      dept: t.dept,
      project: t.project,
      pri: t.pri,
      due: t.due,
      done: t.done,
      doneAt: t.done_at,
      createdAt: Number(t.created_at),
      src: t.src_type && t.src_id ? { type: t.src_type, id: t.src_id } : null,
      delegable: t.delegable,
      delegatedTo: t.delegated_to
        ? {
            personId: t.delegated_to,
            name: t.delegated_name ?? "",
            role: t.delegated_role ?? "",
            note: t.delegated_note ?? "",
            at: t.delegated_at ?? 0,
          }
        : null,
      status: statusOf(t),
      number: t.number,
      assignee,
      assigneeName: assignee?.startsWith("user:") ? (names.get(assignee.slice(5)) ?? null) : (t.delegated_name ?? null),
      createdBy: t.created_by ? (names.get(t.created_by) ?? null) : null,
      source: t.src_label
        ? {
            label: t.src_label,
            quote: t.src_quote ?? "",
            link: t.src_link,
            from: from ? (names.get(from) ?? "") : "",
          }
        : null,
      theirs: Boolean(from && from !== viewer) || undefined,
      history: history.get(t.id),
    };
  });
}

// ---------- Changing tickets ----------

async function nameOf(db: Db, userId: string): Promise<string> {
  const [me] = await db.query<{ name: string }>("select name from users where id = $1", [userId]);
  return me?.name ?? "";
}

let written = 0;
/** History lines written in the same moment keep the order they were written in: their ids sort that way. */
const eventId = () => `e_${Date.now().toString(36).padStart(9, "0")}${(written++ % 1_679_616).toString(36).padStart(4, "0")}${crypto.randomBytes(3).toString("hex")}`;

/** One line in a ticket's history. */
export async function logEvent(c: Ctx, taskId: string, what: string): Promise<void> {
  await c.db.run("insert into ticket_events (id, owner_id, task_id, at, by_user, by_name, what) values ($1, $2, $3, $4, $5, $6, $7)", [
    eventId(),
    TEAM,
    taskId,
    c.now.getTime(),
    c.ownerId,
    await nameOf(c.db, c.ownerId),
    what,
  ]);
}

export interface NewTicket {
  title: string;
  description?: string;
  dept?: string;
  project: string;
  pri: Priority;
  due: string;
  mode?: Mode;
  status?: TicketStatus;
  src?: TaskSource | null;
  delegable?: boolean;
  /** The login it is for. Without one it is whoever makes it. */
  assigneeUser?: string | null;
  /** Whose inbox or call `src` is. Without one it is whoever makes it. */
  sourceOwner?: string | null;
  source?: SourceNote | null;
}

/** Makes a ticket on the team's board, with the next number, and says so in its history. */
export async function insertTicket(c: Ctx, t: NewTicket, said = "Created"): Promise<string> {
  const id = uid("t");
  const now = c.now.getTime();
  const status = t.status ?? "open";
  await c.db.run(
    `insert into tasks (id, owner_id, number, title, description, dept, project, pri, due, status, done, done_at, src_type, src_id, delegable, mode, created_at, updated_at, created_by, source_owner, src_quote, src_label, src_link, assignee_user)
     values ($1, $2, (select coalesce(max(number), 0) + 1 from tasks where owner_id = $2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $17, $18, $19, $20, $21, $22)`,
    [
      id,
      TEAM,
      tidy(t.title, 300),
      tidy(t.description, 4000),
      t.dept ?? "Operations",
      t.project,
      t.pri,
      t.due,
      status,
      status === "done",
      status === "done" ? now : null,
      t.src?.type ?? null,
      t.src?.id ?? null,
      t.delegable ?? true,
      t.mode ?? "professional",
      now,
      c.ownerId,
      t.src ? (t.sourceOwner ?? c.ownerId) : null,
      t.source?.quote ?? null,
      t.source?.label ?? null,
      t.source?.link ?? null,
      t.assigneeUser === undefined ? c.ownerId : t.assigneeUser,
    ],
  );
  await logEvent(c, id, said);
  return id;
}

/** A ticket of the team's, held for this change. Someone other than the owner never reaches a personal one. */
async function heldTicket(c: Ctx, id: string) {
  const [t] = await c.db.query<TicketRow>("select * from tasks where owner_id = $1 and id = $2 and (mode = 'professional' or $3::boolean) for update", [TEAM, id, c.ownerId === TEAM]);
  if (!t) throw new Error("That ticket no longer exists.");
  return t;
}

/**
 * Puts a ticket in someone's hands and answers what to write in its history. A login sees it on
 * the board. A team member is told, where `notify` says, from the account of whoever assigned it:
 * the message waits in the outbox like every other.
 */
/**
 * Tells someone a ticket is theirs, from the assigner's own Slack or Telegram: a direct message
 * that starts with their Slack @name, so Slack notifies them of a mention. Refused when the
 * assigner has not connected that app.
 */
async function tell(c: Ctx, taskId: string, name: string, to: { way: Notify; target: string }[]): Promise<void> {
  if (!to.length) return;
  const connected = new Set((await c.db.query<{ provider: string }>("select provider from connections where owner_id = $1", [c.ownerId])).map((r) => r.provider));
  const missing = [...new Set(to.map((t) => t.way))].filter((w) => !connected.has(w));
  if (missing.length) throw new Error(`Connect your own ${missing.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" and ")} first, to tell ${name} there. Or untick it.`);
  const [t] = await c.db.query<{
    title: string;
    description: string;
    due: string;
    pri: Priority;
    project: string;
    number: number | null;
    mode: Mode;
  }>("select title, description, due, pri, project, number, mode from tasks where owner_id = $1 and id = $2", [TEAM, taskId]);
  const now = c.now.getTime();
  for (const { way, target } of to) {
    const text = assignmentText({
      where: "dm",
      // Telegram has no tag for a person by id: there the message simply says it is theirs.
      who: way === "slack" ? `<@${target}>` : "",
      title: `${t.title}${t.number ? ` (${ticketName(t.number)})` : ""}`,
      due: t.due,
      note: tidy(t.description, 1500),
      pri: t.pri,
      project: t.mode === "personal" ? "" : t.project,
    });
    await c.db.run("insert into outbox (id, owner_id, source, target, to_name, ctx, body, task_id, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [
      uid("o"),
      c.ownerId,
      way,
      target,
      name,
      way === "slack" ? "Direct message" : "Telegram",
      text,
      taskId,
      now,
    ]);
  }
}

const toldOn = (ways: Notify[]) => (ways.length ? `, told on ${ways.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" and ")}` : "");

async function assignTo(c: Ctx, taskId: string, assignee: string | null, notify: Notify[] = []): Promise<string> {
  // A message about the ticket that has not gone yet no longer applies.
  await c.db.run("delete from outbox where owner_id = $1 and task_id = $2 and status = 'queued'", [c.ownerId, taskId]);
  const unhand = "delegated_to = null, delegated_name = null, delegated_role = null, delegated_note = null, delegated_at = null";
  if (!assignee) {
    await c.db.run(`update tasks set assignee_user = null, ${unhand} where owner_id = $1 and id = $2`, [TEAM, taskId]);
    return "Nobody's yet";
  }
  if (assignee.startsWith("user:")) {
    const userId = assignee.slice(5);
    const [user] = await c.db.query<{ name: string; slack: string | null }>(`select u.name, ${LOGIN_SLACK} as slack from users u where u.id = $2 and u.id in (${TEAM_USERS})`, [TEAM, userId]);
    if (!user) throw new Error("That person is not on the team.");
    // A login is told on Slack only when Jeremy gives them the task, and Jeremy himself never (see `mayTellOnSlack`).
    const to = notify.includes("slack") && user.slack && (await mayTellOnSlack(c.db, c.ownerId, user.slack)) ? [{ way: "slack" as const, target: user.slack }] : [];
    await tell(c, taskId, user.name, to);
    await c.db.run(`update tasks set assignee_user = $3, ${unhand} where owner_id = $1 and id = $2`, [TEAM, taskId, userId]);
    return `Assigned to ${user.name}${toldOn(to.map((t) => t.way))}`;
  }
  if (assignee.startsWith(SLACK_PICK) || assignee.startsWith("telegram:")) assignee = `member:${await memberFor(c, assignee)}`;
  if (!assignee.startsWith("member:")) throw new Error("Who should it be for?");
  const [member] = await c.db.query<{
    id: string;
    name: string;
    role: string;
    slack_user_id: string | null;
    telegram_id: string | null;
  }>("select id, name, role, slack_user_id, telegram_id from team_members where owner_id = $1 and id = $2", [TEAM, assignee.slice(7)]);
  if (!member) throw new Error("That person is no longer on the team list.");
  const to: { way: Notify; target: string }[] = [];
  for (const way of new Set(notify)) {
    const target = way === "slack" ? member.slack_user_id : member.telegram_id;
    // Someone on the list who is also a login (picked from Slack) follows the logins' rule.
    if (target && (way !== "slack" || (await mayTellOnSlack(c.db, c.ownerId, target)))) to.push({ way, target });
  }
  await tell(c, taskId, member.name, to);
  await c.db.run("update tasks set assignee_user = null, delegated_to = $3, delegated_name = $4, delegated_role = $5, delegated_note = '', delegated_at = $6 where owner_id = $1 and id = $2", [
    TEAM,
    taskId,
    member.id,
    member.name,
    member.role,
    c.now.getTime(),
  ]);
  return `Assigned to ${member.name}${toldOn(to.map((t) => t.way))}`;
}

/** What a ticket's form sends, checked. */
function checked(input: Partial<TicketInput>): Partial<TicketInput> {
  if (input.title !== undefined && !String(input.title).trim()) throw new Error("Give the ticket a title.");
  if (input.status !== undefined && !TICKET_STATUSES.includes(input.status)) throw new Error("That is not a status on the board.");
  if (input.due !== undefined && !isDay(input.due)) throw new Error("Pick a due date.");
  if (input.pri !== undefined && !PRIORITIES.includes(input.pri)) throw new Error("That is not a priority.");
  if (input.notify !== undefined && (!Array.isArray(input.notify) || input.notify.some((w) => w !== "slack" && w !== "telegram"))) throw new Error("Tell them on Slack or Telegram.");
  return input;
}

/** Sets a ticket's status, keeping `done` and when it was done in step. */
async function setStatus(c: Ctx, taskId: string, status: TicketStatus): Promise<void> {
  const done = status === "done";
  await c.db.run("update tasks set status = $3, done = $4, done_at = case when $4 then coalesce(done_at, $5) else null end, updated_at = $5 where owner_id = $1 and id = $2", [
    TEAM,
    taskId,
    status,
    done,
    c.now.getTime(),
  ]);
}

/** A suggestion anyone on the team may act on, held for this change. */
async function heldSuggestion(c: Ctx, id: string): Promise<SuggestionRow | null> {
  const [g] = await c.db.query<SuggestionRow>(`${SUGGESTION_SQL} and s.id = $3 for update of s`, [TEAM, c.ownerId, id]);
  return g ?? null;
}

const fromWhere = (note: SourceNote | null) => (note ? `${note.label}${note.from ? `, ${note.from}'s` : ""}` : "the review");

/** Makes a ticket of a suggestion, as it is or as it was edited, and gives it to whoever it is for. */
async function accept(c: Ctx, g: SuggestionRow, input: Partial<TicketInput> | undefined, people: TeamPerson[]): Promise<string> {
  const today = isoDay(c.now);
  const edits = checked(input ?? {});
  const src = g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null;
  const note = await sourceNote(c.db, g.owner_id, src, g.dedupe_key);
  const due = edits.due ?? (g.due < today ? today : g.due);
  const status = edits.status ?? "open";
  const ticket = await insertTicket(
    c,
    {
      title: edits.title ?? g.title,
      description: edits.description ?? whyFor(g.why, g.from_name),
      project: tidy(edits.client ?? g.project, 120),
      pri: edits.pri ?? g.pri,
      due,
      status,
      mode: g.mode,
      src,
      delegable: g.delegable,
      assigneeUser: null,
      sourceOwner: g.owner_id,
      source: note,
    },
    `Made a ticket from ${fromWhere(note)}`,
  );
  const assignee = edits.assignee !== undefined ? edits.assignee : guessFor(g, people, g.src_type === "meeting" ? await teamSlack(c.db) : []).assignee;
  await logEvent(c, ticket, await assignTo(c, ticket, assignee, edits.notify ?? []));
  await c.db.run("update suggestions set status = 'accepted', ticket_id = $3 where owner_id = $1 and id = $2", [g.owner_id, g.id, ticket]);
  return ticket;
}

async function reject(c: Ctx, g: SuggestionRow, reason: RejectReason | null): Promise<void> {
  if (reason !== null && !(reason in REJECT_REASONS)) throw new Error("Why is it not a ticket?");
  await c.db.run("update suggestions set status = 'dismissed', reason = $3 where owner_id = $1 and id = $2", [g.owner_id, g.id, reason]);
}

/** The most suggestions one click acts on. */
const MOST_AT_ONCE = 200;

// Each action is one change a person makes on screen, as in repo.ts. They are added to its ACTIONS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TICKET_ACTIONS: Record<string, (c: Ctx, ...args: any[]) => Promise<void>> = {
  /** A ticket made on the board. */
  async createTicket(c, input: TicketInput) {
    const t = checked(input);
    if (!t.title?.trim()) throw new Error("Give the ticket a title.");
    const id = await insertTicket(c, {
      title: t.title,
      description: t.description,
      project: tidy(t.client, 120),
      pri: t.pri ?? "mid",
      due: t.due ?? isoDay(c.now),
      status: t.status ?? "open",
      assigneeUser: null,
    });
    await logEvent(c, id, await assignTo(c, id, t.assignee ?? null, t.notify ?? []));
  },
  /** Changes what is given, and writes each change in the ticket's history. */
  async updateTicket(c, id: string, patch: Partial<TicketInput>) {
    const p = checked(patch);
    const t = await heldTicket(c, id);
    const said: string[] = [];
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length + 2}`);
    };
    if (p.title !== undefined && p.title.trim() !== t.title) {
      put("title", tidy(p.title, 300));
      said.push(`Title: ${tidy(p.title, 300)}`);
    }
    if (p.description !== undefined && tidy(p.description, 4000) !== (t.description ?? "")) {
      put("description", tidy(p.description, 4000));
      said.push("Description changed");
    }
    if (p.client !== undefined && tidy(p.client, 120) !== t.project) {
      put("project", tidy(p.client, 120));
      said.push(p.client.trim() ? `Client: ${tidy(p.client, 120)}` : "No client");
    }
    if (p.due !== undefined && p.due !== t.due) {
      put("due", p.due);
      said.push(`Due ${shortDay(p.due)}`);
    }
    if (p.pri !== undefined && p.pri !== t.pri) {
      put("pri", p.pri);
      said.push(`Priority: ${PRIORITY_NAME[p.pri]}`);
    }
    if (sets.length) {
      put("updated_at", c.now.getTime());
      const changes = sets.join(", ");
      await c.db.run(`update tasks set ${changes} where owner_id = $1 and id = $2`, [TEAM, id, ...values]);
    }
    if (p.status !== undefined && p.status !== statusOf(t)) {
      await setStatus(c, id, p.status);
      said.push(`Status: ${TICKET_STATUS_NAME[p.status]}`);
    }
    if (p.assignee !== undefined && p.assignee !== assigneeOf(t)) said.push(await assignTo(c, id, p.assignee, p.notify ?? []));
    if (said.length) await logEvent(c, id, said.join(" · "));
  },

  // The review
  /** Makes a ticket of a suggestion. `input` is what the card or the Edit form says; without it, the suggestion as it is. */
  async acceptSuggestion(c, id: string, input?: Partial<TicketInput>) {
    const g = await heldSuggestion(c, id);
    // Gone already: a second click.
    if (!g) return;
    await accept(c, g, input, await teamPeople(c.db));
  },
  async rejectSuggestion(c, id: string, reason: RejectReason) {
    const g = await heldSuggestion(c, id);
    if (g) await reject(c, g, reason);
  },
  /** Keeps a client name for the team, so it can be picked next time. A name already there, in any capitals, is left as it is. */
  async addClient(c, name: string) {
    const clean = tidy(name, 120).replace(/\s+/g, " ");
    if (!clean) throw new Error("Type the client's name.");
    await c.db.run("insert into clients (owner_id, name, created_at) values ($1, $2, $3) on conflict do nothing", [TEAM, clean, c.now.getTime()]);
  },
  /** Puts back a suggestion the AI set aside as not a task. It is not asked about again. */
  async restoreSuggestion(c, id: string) {
    const [g] = await c.db.query<{ owner_id: string }>(
      `select owner_id from suggestions where owner_id in (${TEAM_USERS}) and id = $2 and status = 'dismissed' and reason = 'not_task' and (mode = 'professional' or owner_id = $3) for update`,
      [TEAM, id, c.ownerId],
    );
    if (!g) return;
    await c.db.run("update suggestions set status = 'new', reason = null, confidence = null, checked_at = coalesce(checked_at, $3) where owner_id = $1 and id = $2", [g.owner_id, id, c.now.getTime()]);
  },
  /** Turned down without a reason, as the old list of suggestions did. */
  async dismissSuggestion(c, id: string) {
    const g = await heldSuggestion(c, id);
    if (g) await reject(c, g, null);
  },
  async editSuggestion(c, id: string, patch: { pri?: Priority; due?: string }) {
    const g = await heldSuggestion(c, id);
    if (!g) return;
    if (patch.pri !== undefined && !PRIORITIES.includes(patch.pri)) throw new Error("That is not a priority.");
    if (patch.due !== undefined && !isDay(patch.due)) throw new Error("Pick a due date.");
    await c.db.run("update suggestions set pri = coalesce($3, pri), due = coalesce($4, due) where owner_id = $1 and id = $2", [g.owner_id, id, patch.pri ?? null, patch.due ?? null]);
  },
  /** The same thing as a ticket already on the board: the ticket gets its words, and the suggestion is settled. */
  async mergeSuggestion(c, id: string, ticketId: string) {
    const g = await heldSuggestion(c, id);
    if (!g) return;
    const t = await heldTicket(c, ticketId);
    const note = await sourceNote(c.db, g.owner_id, g.src_type && g.src_id ? { type: g.src_type, id: g.src_id } : null, g.dedupe_key);
    const quote = note?.quote || g.title;
    const added = `Also raised${note ? ` in ${note.label}${note.from ? ` (${note.from}'s)` : ""}` : ""}:\n${quote}`;
    await c.db.run("update tasks set description = $3, updated_at = $4 where owner_id = $1 and id = $2", [
      TEAM,
      t.id,
      tidy([t.description ?? "", added].filter(Boolean).join("\n\n"), 4000),
      c.now.getTime(),
    ]);
    await logEvent(c, t.id, `Merged in: ${g.title}`);
    await c.db.run("update suggestions set status = 'accepted', ticket_id = $3 where owner_id = $1 and id = $2", [g.owner_id, g.id, t.id]);
  },
  /**
   * Many suggestions at once: made tickets for whoever each is for, or turned down for one
   * reason. Nobody is messaged from here: a ticket's person is told when it is assigned on the board.
   */
  async reviewMany(c, ids: string[], decision: "accept" | RejectReason) {
    if (!Array.isArray(ids) || ids.length > MOST_AT_ONCE) throw new Error(`Pick at most ${MOST_AT_ONCE} at once.`);
    if (decision !== "accept" && !(decision in REJECT_REASONS)) throw new Error("Why are they not tickets?");
    const people = await teamPeople(c.db);
    for (const id of ids) {
      const g = await heldSuggestion(c, String(id));
      if (!g) continue;
      if (decision === "accept") await accept(c, g, undefined, people);
      else await reject(c, g, decision);
    }
  },
};
