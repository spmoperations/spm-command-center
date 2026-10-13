// Who can take a task: matched against the team list, no AI involved.
import { norm } from "./rules";
import type { Person, Task } from "./types";

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

/** On the owner's plate: neither done nor handed to someone. */
export const isMine = (t: Task) => !t.done && !t.delegatedTo;

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
 * person assigned is not in it. Nor can a Telegram chat, whatever it is called: assignments
 * are announced on Slack.
 */
export const canAssignInChat = (c: { ctx: string; source?: string }) => c.source !== "telegram" && (c.ctx.startsWith("#") || c.ctx === "Group message");

/**
 * The message that announces a task. In a chat or channel it starts by tagging the person,
 * when one was picked; with nobody picked it is addressed to the channel as a whole.
 */
export function assignmentText(o: { where: AssignWhere; who: string; title: string; due: string; note: string }): string {
  const task = `${o.title} (due ${o.due})${o.note ? `\n\n${o.note}` : ""}`;
  if (o.where === "dm") return `New task for you: ${task}`;
  return o.who ? `${o.who} new task for you: ${task}` : `New task: ${task}`;
}

export type TaskStatus = "done" | "overdue" | "ontrack";

export const taskStatus = (t: Task, today: string): TaskStatus =>
  t.done ? "done" : t.due < today ? "overdue" : "ontrack";
