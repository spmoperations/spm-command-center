// Who can take a task: matched against the team list, no AI involved.
import { PRIORITY_NAME } from "./config";
import { parseDay } from "./dates";
import { norm } from "./rules";
import type { Person, Priority, Task } from "./types";

type Delegable = Pick<Task, "title" | "project" | "dept">;

/** The person's responsibilities that appear in the task's title or project. */
export function fitFor(person: Person, t: Pick<Task, "title" | "project">): string[] {
  const text = ` ${norm(`${t.title} ${t.project}`)} `;
  return person.handles.filter((h) => {
    const key = norm(h).replace(/s$/, "");
    return key !== "" && text.includes(` ${key}`);
  });
}

export type Candidate = Person & { matched: string[] };

/**
 * People offered for a task, best fit first. Unless `all` is set, only people in the
 * task's department or with a matching responsibility are offered.
 */
export function candidates(team: Person[], t: Delegable, all: boolean): Candidate[] {
  return team
    .map((p) => ({ ...p, matched: fitFor(p, t) }))
    .filter((p) => all || p.depts.includes(t.dept) || p.matched.length > 0)
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        Number(b.depts.includes(t.dept)) - Number(a.depts.includes(t.dept)),
    );
}

/**
 * On someone's plate: not done, and theirs on the board. Without `me`, as before tickets had
 * owners: not handed to anyone.
 */
export const isMine = (t: Task, me?: string) => !t.done && (me ? t.assignee === `user:${me}` : !t.delegatedTo);

/**
 * Whether a task can be assigned to someone else. Personal tasks stay with the owner, and so
 * does anything marked as only theirs to do. Who it can go to is the form's business: anyone
 * on the team list or in Slack.
 */
export const canAssign = (t: Task) => isMine(t) && t.mode === "professional" && t.delegable;

/** How the form names someone picked straight from Slack, before they are on the team list. */
export const SLACK_PICK = "slack:";

/**
 * Where an assignment is announced: a direct message to the person, the chat the task came
 * from, or any Slack channel ("channel:<id>"). In a chat or channel the person is optional:
 * the task can go to the channel as a whole.
 */
export type AssignWhere = "dm" | "chat" | `channel:${string}`;
export const CHANNEL_PICK = "channel:";

/**
 * A Slack channel or group message can carry an assignment. A one-to-one chat cannot: the
 * person assigned is not in it. Nor can a Telegram chat or an email, whatever it is called:
 * assignments are announced on Slack.
 */
export const canAssignInChat = (c: { ctx: string; source?: string }) =>
  c.source !== "telegram" && c.source !== "gmail" && (c.ctx.startsWith("#") || c.ctx === "Group message");

/**
 * The message that announces a task. It starts by tagging the person (`who`, as Slack's
 * <@id>), when there is one: in a direct message too, so Slack counts it as a mention and
 * notifies them. With nobody picked, a channel post is addressed to the channel as a whole.
 */
export function assignmentText(o: { where: AssignWhere; who: string; title: string; due: string; note: string; pri?: Priority; project?: string }): string {
  const head = o.who ? `${o.who} new task for you: ${o.title}` : o.where === "dm" ? `New task for you: ${o.title}` : `New task: ${o.title}`;
  // What the task is, when it is due, how much it matters and what it belongs to, then the
  // note. The task's description is not here: it follows as a reply in this message's thread.
  const due = parseDay(o.due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const facts = [`Due ${due}`, o.pri ? `${PRIORITY_NAME[o.pri]} priority` : "", o.project?.trim() ?? ""].filter(Boolean).join(" · ");
  return [`${head}\n${facts}`, o.note.trim()].filter(Boolean).join("\n\n");
}

/** Slack reads &, < and > as markup: written out, they show as themselves. */
const slackSafe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A piece of a Slack message laid out with Slack's blocks. */
export type SlackBlock = { type: "section"; text: { type: "mrkdwn"; text: string } } | { type: "context"; elements: { type: "mrkdwn"; text: string }[] };

/**
 * The same message as `assignmentText`, laid out for Slack: the tag and "New task for you" on
 * the first line, the task in bold with its note under it, then one quiet line with its number,
 * when it is due, how much it matters, what it belongs to and, for someone who can sign in, a
 * link to it. `tag` is Slack's <@id>, or a name; `ticket` is its number, such as SPM-23.
 */
export function assignmentBlocks(o: { tag: string; title: string; ticket?: string; due: string; note: string; pri?: Priority; project?: string; link?: string }): SlackBlock[] {
  const due = parseDay(o.due).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const note = slackSafe(o.note.trim()).slice(0, 2500);
  const facts = [o.ticket ? `*${o.ticket}*` : "", `Due *${due}*`, o.pri ? `${PRIORITY_NAME[o.pri]} priority` : "", slackSafe(o.project?.trim() ?? ""), o.link ? `<${o.link}|Open in Command Center>` : ""].filter(Boolean);
  return [
    { type: "section", text: { type: "mrkdwn", text: o.tag ? `${o.tag} *New task for you*` : "*New task*" } },
    { type: "section", text: { type: "mrkdwn", text: `*${slackSafe(o.title)}*${note ? `\n${note}` : ""}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: facts.join("  ·  ") }] },
  ];
}

/** The address of a ticket on the live site's board, or nothing where the site's address is not known. */
export function ticketLink(ticket: string): string | undefined {
  const site = process.env.SITE_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return site && ticket ? `${site.replace(/\/+$/, "")}/tasks?task=${encodeURIComponent(ticket)}` : undefined;
}

export type TaskStatus = "done" | "overdue" | "ontrack";

export const taskStatus = (t: Task, today: string): TaskStatus =>
  t.done ? "done" : t.due < today ? "overdue" : "ontrack";
