// Repeating tasks: the same ticket made again on the same days each week, for the same person,
// such as a check-in every Monday and Thursday. Set up on the board by anyone with a
// login. At 6:00 Central European time on each of those days the scheduler makes the ticket,
// with no due date, and assigns it as the board does: the person is told on Slack from the
// account of whoever set it up, through the outbox like every message. A new one each time,
// whether or not the last one is done. Plain code: no AI. When is in core/repeats.ts.
import crypto from "node:crypto";
import { TASK_LINES } from "@/core/config";
import { cleanDays, daysName, heldBackTo, repeatIsDue } from "@/core/repeats";
import type { Priority, RepeatingTask, RepeatInput, TaskLine, TicketStatus } from "@/core/types";
import type { Db } from "./db";
import { assignTo, insertTicket, logEvent, memberFor, TEAM, teamUsersSql } from "./tickets";

type Ctx = { db: Db; ownerId: string; now: Date };
type Way = RepeatInput["notify"][number];

const TEAM_USERS = teamUsersSql("$1");
const PRIORITIES: Priority[] = ["high", "mid", "low"];
const WAYS: Way[] = ["slack", "telegram"];
const tidy = (text: unknown, most: number) =>
  String(text ?? "")
    .trim()
    .slice(0, most);

interface RepeatRow {
  id: string;
  title: string;
  description: string;
  project: string;
  pri: Priority;
  line: TaskLine | null;
  assignee: string;
  days: number[];
  notify: Way[];
  set_by: string;
  set_by_name: string | null;
  active: boolean;
  last_day: string | null;
  problem: string | null;
  last_id: string | null;
  last_number: number | null;
  last_done: boolean | null;
  last_status: TicketStatus | null;
  made: number;
}

/** The team's repeating tasks, newest first, each with the last ticket it made. */
export async function repeatingTasks(db: Db): Promise<RepeatingTask[]> {
  const rows = await db.query<RepeatRow>(
    `select r.id, r.title, r.description, r.project, r.pri, r.line, r.assignee, r.days, r.notify, r.set_by, u.name as set_by_name, r.active, r.last_day, r.problem,
       l.id as last_id, l.number as last_number, l.done as last_done, l.status as last_status,
       (select count(*)::int from tasks k where k.owner_id = r.owner_id and k.repeat_id = r.id) as made
     from repeating_tasks r
     left join users u on u.id = r.set_by
     left join lateral (select t.id, t.number, t.done, t.status from tasks t where t.owner_id = r.owner_id and t.repeat_id = r.id order by t.created_at desc, t.id desc limit 1) l on true
     where r.owner_id = $1
     order by r.created_at desc, r.id`,
    [TEAM],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    client: r.project,
    pri: r.pri,
    line: r.line,
    assignee: r.assignee,
    days: cleanDays(r.days),
    notify: (r.notify ?? []).filter((w) => WAYS.includes(w)),
    active: r.active,
    setBy: { id: r.set_by, name: r.set_by_name ?? "" },
    lastDay: r.last_day,
    last: r.last_id ? { id: r.last_id, number: r.last_number, status: r.last_done ? "done" : r.last_status && r.last_status !== "done" ? r.last_status : "open" } : null,
    made: Number(r.made),
    problem: r.problem,
  }));
}

/** What a form sent, checked: who it is for comes back as someone on the team list or a login. */
async function checked(c: Ctx, input: Partial<RepeatInput>): Promise<Omit<RepeatInput, "client"> & { project: string }> {
  const title = tidy(input.title, 300);
  if (!title) throw new Error("Give the task a title.");
  const days = cleanDays(input.days);
  if (!days.length) throw new Error("Pick at least one day of the week.");
  const pri = input.pri ?? "mid";
  if (!PRIORITIES.includes(pri)) throw new Error("That is not a priority.");
  const line = input.line || null;
  if (line !== null && !TASK_LINES.includes(line)) throw new Error("That is not Agency, Consulting or Sales.");
  let assignee = String(input.assignee ?? "");
  // Someone picked straight from Slack or Telegram joins the team list, as on the board.
  if (assignee.startsWith("slack:") || assignee.startsWith("telegram:")) assignee = `member:${await memberFor(c, assignee)}`;
  if (assignee.startsWith("member:")) {
    const [m] = await c.db.query<{ id: string }>("select id from team_members where owner_id = $1 and id = $2", [TEAM, assignee.slice(7)]);
    if (!m) throw new Error("That person is no longer on the team list.");
  } else if (assignee.startsWith("user:")) {
    const [u] = await c.db.query<{ id: string }>(`select id from users where id = $2 and id in (${TEAM_USERS})`, [TEAM, assignee.slice(5)]);
    if (!u) throw new Error("That person is not on the team.");
  } else throw new Error("Who should it be for?");
  const notify = [...new Set(Array.isArray(input.notify) ? input.notify : [])].filter((w) => WAYS.includes(w));
  // Told from the account of whoever sets it up: that account must be there, as when a ticket is assigned.
  const connected = new Set((await c.db.query<{ provider: string }>("select provider from connections where owner_id = $1", [c.ownerId])).map((r) => r.provider));
  const missing = notify.filter((w) => !connected.has(w));
  if (missing.length) throw new Error(`Connect your own ${missing.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" and ")} first, to tell them there each time. Or untick it.`);
  return { title, description: tidy(input.description, 4000), project: tidy(input.client, 120), pri, line, assignee, days, notify };
}

async function heldRepeat(c: Ctx, id: string): Promise<{ id: string; last_day: string | null; active: boolean }> {
  const [r] = await c.db.query<{ id: string; last_day: string | null; active: boolean }>("select id, last_day, active from repeating_tasks where owner_id = $1 and id = $2 for update", [TEAM, String(id)]);
  if (!r) throw new Error("That repeating task no longer exists.");
  return r;
}

// Each action is one change a person makes on screen, as in repo.ts. They are added to its ACTIONS.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REPEAT_ACTIONS: Record<string, (c: Ctx, ...args: any[]) => Promise<void>> = {
  /** Sets one up. The first comes on the next day it is on at 6:00 CET: today, if that is one and 6:00 has not come yet. */
  async addRepeat(c, input: RepeatInput) {
    const r = await checked(c, input);
    const now = c.now.getTime();
    await c.db.run(
      `insert into repeating_tasks (id, owner_id, title, description, project, pri, line, assignee, days, notify, set_by, active, last_day, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, true, $12, $13, $13)`,
      [`r_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, TEAM, r.title, r.description, r.project, r.pri, r.line, r.assignee, JSON.stringify(r.days), JSON.stringify(r.notify), c.ownerId, heldBackTo(null, c.now), now],
    );
  },
  /** Changes it. It becomes the changer's: from then on the person is told from their account. Not made again today once 6:00 has passed. */
  async editRepeat(c, id: string, input: RepeatInput) {
    const held = await heldRepeat(c, id);
    const r = await checked(c, input);
    await c.db.run(
      `update repeating_tasks set title = $3, description = $4, project = $5, pri = $6, line = $7, assignee = $8, days = $9::jsonb, notify = $10::jsonb, set_by = $11, last_day = $12, problem = null, updated_at = $13
       where owner_id = $1 and id = $2`,
      [TEAM, held.id, r.title, r.description, r.project, r.pri, r.line, r.assignee, JSON.stringify(r.days), JSON.stringify(r.notify), c.ownerId, heldBackTo(held.last_day, c.now), c.now.getTime()],
    );
  },
  /** Pauses it, or starts it again: then the next one comes on the next day it is on at 6:00 CET, not straight away. */
  async pauseRepeat(c, id: string, paused: boolean) {
    const held = await heldRepeat(c, id);
    if (held.active === !paused) return;
    await c.db.run("update repeating_tasks set active = $3, last_day = $4, updated_at = $5 where owner_id = $1 and id = $2", [TEAM, held.id, !paused, paused ? held.last_day : heldBackTo(held.last_day, c.now), c.now.getTime()]);
  },
  /** Stops it for good. The tickets it made stay on the board. */
  async removeRepeat(c, id: string) {
    await c.db.run("delete from repeating_tasks where owner_id = $1 and id = $2", [TEAM, String(id)]);
  },
};

/** Makes one ticket for a repeating task that is due, as the login that set it up. Answers its id, or null when it was not due after all. */
async function makeOne(db: Db, id: string, now: Date): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Held, so two schedulers running at once make one ticket, not two.
    const [r] = await tx.query<RepeatRow>("select * from repeating_tasks where owner_id = $1 and id = $2 for update", [TEAM, id]);
    if (!r) return null;
    const { due, day } = repeatIsDue({ days: r.days, lastDay: r.last_day, active: r.active }, now);
    if (!due) return null;
    const c: Ctx = { db: tx, ownerId: r.set_by, now };
    const every = daysName(r.days);
    const ticket = await insertTicket(
      c,
      { title: r.title, description: r.description, project: r.project, pri: r.pri, due: "", status: "open", assigneeUser: null, line: r.line, source: { label: `Repeats ${every === "every day" || every === "weekdays" ? every : `every ${every}`}`, quote: "", from: "" } },
      `Created: repeats ${every === "every day" || every === "weekdays" ? every : `every ${every}`}`,
    );
    await tx.run("update tasks set repeat_id = $3 where owner_id = $1 and id = $2", [TEAM, ticket, r.id]);
    // Told only where the account it is told from is still connected; the rest is said in its history.
    const connected = new Set((await tx.query<{ provider: string }>("select provider from connections where owner_id = $1", [r.set_by])).map((x) => x.provider));
    const notify = (r.notify ?? []).filter((w) => WAYS.includes(w));
    const told = notify.filter((w) => connected.has(w));
    const said = await assignTo(c, ticket, r.assignee, told);
    const notTold = notify.filter((w) => !connected.has(w));
    await logEvent(c, ticket, notTold.length ? `${said}. Not told on ${notTold.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" or ")}: the account it is told from is not connected` : said);
    await tx.run("update repeating_tasks set last_day = $3, problem = $4 where owner_id = $1 and id = $2", [
      TEAM,
      r.id,
      day,
      notTold.length ? `Not told on ${notTold.map((w) => (w === "slack" ? "Slack" : "Telegram")).join(" or ")}: connect it again in Connections.` : null,
    ]);
    return ticket;
  });
}

/**
 * Makes the tickets that are due: on each repeating task's days, once 6:00 CET has come, one a
 * day. The scheduler runs this every few minutes. One that fails is noted on it, and not tried
 * again until its next day, so a person taken off the team list does not fail every few minutes.
 */
export async function makeRepeats(db: Db, now = new Date()): Promise<{ made: number; failed: number }> {
  const rows = await db.query<{ id: string; days: number[]; last_day: string | null; active: boolean }>("select id, days, last_day, active from repeating_tasks where owner_id = $1 and active", [TEAM]);
  let made = 0;
  let failed = 0;
  for (const r of rows) {
    const { due, day } = repeatIsDue({ days: r.days, lastDay: r.last_day, active: r.active }, now);
    if (!due) continue;
    try {
      if (await makeOne(db, r.id, now)) made++;
    } catch (error) {
      failed++;
      await db.run("update repeating_tasks set last_day = $3, problem = $4 where owner_id = $1 and id = $2", [TEAM, r.id, day, tidy((error as Error).message, 300)]);
    }
  }
  return { made, failed };
}
