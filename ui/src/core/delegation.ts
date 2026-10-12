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

/** Where the person is told: a direct message, or the chat the task came from. */
export type AssignWhere = "dm" | "chat";

/** A channel or a group message can carry an assignment. A one-to-one chat cannot: the person assigned is not in it. */
export const canAssignInChat = (c: { ctx: string }) => c.ctx.startsWith("#") || c.ctx === "Group message";

/** The message that tells someone a task is theirs. In a chat it starts by tagging them. */
export function assignmentText(o: { where: AssignWhere; who: string; title: string; due: string; note: string }): string {
  const task = `${o.title} (due ${o.due})${o.note ? `\n\n${o.note}` : ""}`;
  return o.where === "chat" ? `${o.who} new task for you: ${task}` : `New task for you: ${task}`;
}

export type TaskStatus = "done" | "overdue" | "ontrack";

export const taskStatus = (t: Task, today: string): TaskStatus =>
  t.done ? "done" : t.due < today ? "overdue" : "ontrack";
