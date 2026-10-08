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

export const canDelegate = (team: Person[], t: Task) =>
  isMine(t) && t.delegable && candidates(team, t, false).length > 0;

export type TaskStatus = "done" | "overdue" | "ontrack";

export const taskStatus = (t: Task, today: string): TaskStatus =>
  t.done ? "done" : t.due < today ? "overdue" : "ontrack";
