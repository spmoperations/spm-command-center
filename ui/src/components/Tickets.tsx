"use client";

// What the board and the review share: the ticket form, who a ticket can be for, and where it came from.

import { useEffect, useState } from "react";
import { Combo } from "@/components/Combo";
import { Avatar } from "@/components/MessageText";
import { PRIORITIES, PRIORITY_NAME, TICKET_PREFIX, TICKET_STATUS_NAME, TICKET_STATUSES } from "@/core/config";
import type { AppState, SourceNote, TeamPerson, TicketInput, TicketStatus } from "@/core/types";

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

/** Someone a ticket can be given to, and the heading they are listed under. */
export type Assignable = TeamPerson & { group: string };

/**
 * Everyone a ticket can be for, as the picker lists them: the Command Center logins, the team
 * list, then anyone else in Slack or in the signed-in person's own Telegram chats. Someone picked
 * from Slack or Telegram joins the team list, so they can be told and are there next time.
 */
export function assignable(state: AppState): Assignable[] {
  const logins = state.people.filter((p) => p.login);
  const members = state.people.filter((p) => !p.login);
  const loginNames = new Set(logins.map((p) => p.name.toLowerCase()));
  const onSlack = new Set(state.team.map((p) => p.slackUserId).filter(Boolean));
  const onTelegram = new Set(state.team.map((p) => p.telegramId).filter(Boolean));
  const telegram = new Map<string, string>();
  for (const c of state.inbox) if (c.source === "telegram" && c.direct && c.id.startsWith("telegram:")) telegram.set(c.id.slice("telegram:".length), c.from);
  return [
    ...logins.map((p) => ({ ...p, group: "Command Center" })),
    ...members.map((p) => ({ ...p, group: "Team list" })),
    ...(state.teamSlack.length ? state.teamSlack : state.slackPeople)
      .filter((u) => !onSlack.has(u.id) && !loginNames.has(u.name.toLowerCase()))
      .map((u) => ({ id: `slack:${u.id}`, name: u.name, role: "", login: false, slack: true, telegram: false, group: "Slack" })),
    ...[...telegram].filter(([id]) => !onTelegram.has(id)).map(([id, name]) => ({ id: `telegram:${id}`, name, role: "", login: false, slack: false, telegram: true, group: "Telegram" })),
  ];
}

/** The name of whoever a ticket is for, and what they are: "Jeremy Moser", "Luis Ramos (team list)". */
export function whose(people: Assignable[], id: string | null): string {
  const p = people.find((x) => x.id === id);
  return p ? p.name : "Nobody yet";
}

/** Who a ticket is for: type a few letters of anyone's name, or pick. */
export function PersonPicker({ people, value, onChange, label = "Assigned to" }: { people: Assignable[]; value: string | null; onChange(id: string | null): void; label?: string }) {
  return (
    <Combo
      value={value ?? ""}
      label={label}
      placeholder="Type a name: Command Center, team, Slack or Telegram…"
      none="Nobody yet"
      choices={people.map((p) => ({ value: p.id, label: p.group === "Team list" && p.role ? `${p.name} · ${p.role}` : p.name, group: p.group }))}
      onChange={(v) => onChange(v || null)}
    />
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
  people: Assignable[];
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
            <span className="label">Assigned to: whose task it is</span>
            <PersonPicker people={people} value={t.assignee} onChange={(assignee) => set({ assignee, notify: defaultNotify(people, assignee) })} />
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
