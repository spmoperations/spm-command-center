"use client";

// What the board and the review share: the ticket form, who a ticket can be for, and where it came from.

import { useEffect, useState } from "react";
import { Avatar } from "@/components/MessageText";
import { PRIORITIES, PRIORITY_NAME, TICKET_PREFIX, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import type { SourceNote, TeamPerson, TicketInput, TicketStatus } from "@/core/types";

export const ticketName = (n: number | null | undefined) => (n ? `${TICKET_PREFIX}-${n}` : "");

/** How a team member is told a ticket is theirs, unless the form says otherwise: Slack when they have it, else Telegram. */
export function defaultNotify(people: TeamPerson[], assignee: string | null): NonNullable<TicketInput["notify"]> {
  const person = people.find((p) => p.id === assignee);
  if (!person || person.login) return [];
  return person.slack ? ["slack"] : person.telegram ? ["telegram"] : [];
}

/** The app a source is in, by the first word of where it came from. */
export const sourceApp = (note: SourceNote | null | undefined) => note?.label.split(" · ")[0] ?? "By hand";

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`pill tk-${status}`}>{TICKET_STATUS_NAME[status]}</span>;
}

/** Who a ticket is for, as a list to pick from: the logins, then the team list. */
export function PersonSelect({
  people,
  value,
  onChange,
  label = "Assignee",
  allowNobody = true,
}: {
  people: TeamPerson[];
  value: string | null;
  onChange(id: string | null): void;
  label?: string;
  allowNobody?: boolean;
}) {
  const logins = people.filter((p) => p.login);
  const members = people.filter((p) => !p.login);
  return (
    <select className="f" value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value || null)}>
      {allowNobody && <option value="">Nobody yet</option>}
      <optgroup label="With a login">
        {logins.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </optgroup>
      {members.length > 0 && (
        <optgroup label="Team list">
          {members.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role ? ` · ${p.role}` : ""}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

/** Where a team member is told, when the ticket is theirs. A login is not told: they see it here. */
export function NotifyChoice({
  people,
  assignee,
  value,
  onChange,
}: {
  people: TeamPerson[];
  assignee: string | null;
  value: NonNullable<TicketInput["notify"]>;
  onChange(v: NonNullable<TicketInput["notify"]>): void;
}) {
  const person = people.find((p) => p.id === assignee);
  if (!person || person.login) return null;
  if (!person.slack && !person.telegram) return <span className="tk-notify muted">{person.name} has no Slack or Telegram linked in Settings, so they are not told.</span>;
  const flip = (way: "slack" | "telegram", on: boolean) => onChange(on ? [...value.filter((w) => w !== way), way] : value.filter((w) => w !== way));
  return (
    <span className="tk-notify">
      Tell {person.name.split(" ")[0]} on
      {person.slack && (
        <label className="inline-check">
          <input type="checkbox" checked={value.includes("slack")} onChange={(e) => flip("slack", e.target.checked)} /> Slack
        </label>
      )}
      {person.telegram && (
        <label className="inline-check">
          <input type="checkbox" checked={value.includes("telegram")} onChange={(e) => flip("telegram", e.target.checked)} /> Telegram
        </label>
      )}
    </span>
  );
}

/** A person's picture or initials, and their name. */
export function Who({ name }: { name: string | null }) {
  if (!name) return <span className="tk-who muted">Nobody yet</span>;
  return (
    <span className="tk-who">
      <Avatar name={name} small />
      {name}
    </span>
  );
}

/** The line a ticket or suggestion came from, where it was said, and a way to it. */
export function SourceBox({ note, extra }: { note: SourceNote; extra?: React.ReactNode }) {
  const app = sourceApp(note);
  return (
    <div className="tk-source">
      <div className="tk-source-head">
        <span>
          {note.label}
          {note.from ? <span className="muted"> · {note.from}&apos;s</span> : null}
        </span>
        <span className="tk-source-links">
          {note.link && (
            <a href={note.link} target="_blank" rel="noopener noreferrer">
              {app === "Fathom" ? "Open the recording" : `Open in ${app}`} ↗
            </a>
          )}
          {extra}
        </span>
      </div>
      {note.quote && <p className="tk-quote">{note.quote}</p>}
    </div>
  );
}

/**
 * A ticket's fields, for a new ticket, a suggestion being edited before it is accepted, or a
 * ticket opened on the board. `onSubmit` answers true once it is saved, and the form closes.
 * `assigned` is a ticket already in someone's hands: they were told when it was given to them,
 * so being told is only asked about when it goes to someone else.
 */
export function TicketForm({
  heading,
  initial,
  people,
  clients,
  submit,
  onSubmit,
  onCancel,
  children,
  assigned = false,
}: {
  heading: string;
  initial: TicketInput;
  people: TeamPerson[];
  clients: string[];
  submit: string;
  onSubmit(input: TicketInput): Promise<boolean>;
  onCancel(): void;
  children?: React.ReactNode;
  assigned?: boolean;
}) {
  const [t, setT] = useState<TicketInput>({
    ...initial,
    notify: initial.notify ?? defaultNotify(people, initial.assignee),
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TicketInput>) => setT((x) => ({ ...x, ...patch }));
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  return (
    <div className="cal-modal" role="presentation" onClick={onCancel}>
      <form
        className="panel tk-form"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!t.title.trim()) return;
          setBusy(true);
          const saved = await onSubmit({ ...t, title: t.title.trim() });
          setBusy(false);
          if (saved) onCancel();
        }}
      >
        <h3>{heading}</h3>
        <label className="tk-field">
          <span className="label">Title</span>
          <input className="f" value={t.title} required autoFocus onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="tk-field">
          <span className="label">Description</span>
          <textarea className="f" rows={5} value={t.description} placeholder="Context, links, what done looks like." onChange={(e) => set({ description: e.target.value })} />
        </label>
        <div className="tk-grid">
          <label className="tk-field">
            <span className="label">Assignee</span>
            <PersonSelect people={people} value={t.assignee} onChange={(assignee) => set({ assignee, notify: defaultNotify(people, assignee) })} />
          </label>
          <label className="tk-field">
            <span className="label">Client</span>
            <input className="f" list="tk-clients" value={t.client} placeholder="Client or project" onChange={(e) => set({ client: e.target.value })} />
          </label>
          <label className="tk-field">
            <span className="label">Due date</span>
            <input className="f" type="date" required value={t.due} onChange={(e) => set({ due: e.target.value })} />
          </label>
          <label className="tk-field">
            <span className="label">Status</span>
            <select className="f" value={t.status} onChange={(e) => set({ status: e.target.value as TicketStatus })}>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_NAME[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="tk-field">
            <span className="label">Priority</span>
            <select className="f" value={t.pri ?? "mid"} onChange={(e) => set({ pri: e.target.value as TicketInput["pri"] })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_NAME[p]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <datalist id="tk-clients">
          {clients.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {(!assigned || t.assignee !== initial.assignee) && <NotifyChoice people={people} assignee={t.assignee} value={t.notify ?? []} onChange={(notify) => set({ notify })} />}
        {children}
        <div className="tk-form-foot">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : submit}
          </button>
        </div>
      </form>
    </div>
  );
}
