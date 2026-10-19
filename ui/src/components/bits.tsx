"use client";

import Link from "next/link";
import { conversationPage, PRIORITIES, PRIORITY_NAME, SOURCE_NAME, SOURCE_SHORT } from "@/core/config";
import { dueLabel } from "@/core/dates";
import type { Priority, Source, Task, TaskSource } from "@/core/types";
import { openConversation, showMeeting, type App } from "@/store/store";

export function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export const PriPill = ({ p }: { p: Priority }) => <Pill tone={`p-${p}`}>{PRIORITY_NAME[p]}</Pill>;

export function SrcBadge({ source }: { source: Source }) {
  return (
    <span className={`src src-${source}`} title={SOURCE_NAME[source]} aria-label={SOURCE_NAME[source]}>
      {SOURCE_SHORT[source]}
    </span>
  );
}

/** `tag` draws it as the colored priority tag, which can still be clicked to change it. */
export function PrioritySelect({ value, onChange, label = "Priority", tag }: { value: Priority; onChange(p: Priority): void; label?: string; tag?: boolean }) {
  return (
    <select className={tag ? `f pri-tag p-${value}` : "f"} value={value} aria-label={label} title={tag ? "Click to change the priority" : undefined} onChange={(e) => onChange(e.target.value as Priority)}>
      {PRIORITIES.map((p) => (
        <option key={p} value={p}>
          {PRIORITY_NAME[p]}
        </option>
      ))}
    </select>
  );
}

/** "Today", "2d overdue", "Fri"… or who has the task, or "Done". */
export function DueText({ task, today }: { task: Task; today: string }) {
  if (task.done) return <span className="due">Done</span>;
  const d = dueLabel(task.due, today);
  return <span className={`due ${d.tone}`}>{d.text}</span>;
}

/** Link back to the message or call a task came from. */
export function SourceLink({ src, app }: { src: TaskSource | null | undefined; app: App }) {
  if (!src) return null;
  if (src.type === "message") {
    const c = app.state.inbox.find((x) => x.id === src.id);
    if (!c) return null;
    return (
      <Link className="srclink" href={conversationPage(c.id)} onClick={() => openConversation(c.id)}>
        {SOURCE_NAME[c.source]} · {c.from}
      </Link>
    );
  }
  const m = app.state.meetings.find((x) => x.id === src.id);
  if (!m) return null;
  return (
    <Link className="srclink" href="/meetings" onClick={() => showMeeting(m.id)}>
      Call · {m.title}
    </Link>
  );
}

// `T` comes from `value`; the options must then fit it.
export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [NoInfer<T>, string][]; onChange(v: T): void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export const VisuallyHidden = ({ children }: { children: React.ReactNode }) => (
  <span style={{ position: "absolute", left: -9999 }}>{children}</span>
);
