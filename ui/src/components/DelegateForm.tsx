"use client";

import { useId, useState } from "react";
import { assignmentText, candidates, CHANNEL_PICK, SLACK_PICK, type AssignWhere } from "@/core/delegation";
import type { Channel, Person } from "@/core/types";
import { toast } from "@/store/store";
import { Combo } from "./Combo";

interface Props {
  team: Person[];
  /** Everyone in the Slack workspace. Anyone here can be picked, on the team list or not. */
  slackPeople: { id: string; name: string }[];
  /** The Slack channels the owner is in. The task can be announced in any of them. */
  channels: Channel[];
  /** What is being assigned. An empty `dept` offers the whole team. */
  subject: { title: string; project: string; dept: string; due: string };
  today: string;
  /** The chat this came from, e.g. "#sales", when the task can be announced there. */
  chat?: string | null;
  onDelegate(personId: string, note: string, due: string, where: AssignWhere): void;
  onCancel(): void;
}

/** Value of the channel picker that means "the chat this came from". */
const SOURCE_CHAT = "source";

/**
 * Assigns a task. It goes to a person by direct message, or into a Slack channel, where
 * tagging a person is optional: a task can belong to the channel as a whole.
 */
export function DelegateForm({ team, slackPeople, channels, subject, today, chat, onDelegate, onCancel }: Props) {
  const noteId = useId();
  const dueId = useId();
  const slackId = useId();
  const channelId = useId();
  const hasDept = subject.dept !== "";
  const [everyone, setEveryone] = useState(!hasDept);
  /** A team member's id, "slack:<id>", or "" for nobody. Null until the person picks. */
  const [chosen, setChosen] = useState<string | null>(null);
  const [inChannel, setInChannel] = useState(false);
  const [channel, setChannel] = useState(chat ? SOURCE_CHAT : "");
  const [note, setNote] = useState("");
  const [due, setDue] = useState(subject.due < today ? today : subject.due);

  const suggested = candidates(team, subject, false);
  // With nobody suggested for this task, the whole team is shown straight away.
  const people = everyone || suggested.length === 0 ? candidates(team, subject, true) : suggested;
  const others = slackPeople.filter((p) => !team.some((t) => t.slackUserId === p.id));
  // A direct message needs someone, so the best fit starts picked. A channel does not.
  const selected = chosen ?? (inChannel ? "" : (people[0]?.id ?? ""));
  const fromSlack = selected.startsWith(SLACK_PICK) ? selected : "";
  const selectedName = team.find((p) => p.id === selected)?.name ?? others.find((p) => `${SLACK_PICK}${p.id}` === selected)?.name ?? "";
  const place = channel === SOURCE_CHAT ? (chat ?? "") : channel ? `#${channels.find((c) => c.id === channel)?.name ?? ""}` : "";
  const canPost = Boolean(chat) || channels.length > 0;

  if (team.length === 0 && others.length === 0 && !canPost) {
    return (
      <div className="dg-form">
        <h4>Assign to</h4>
        <p className="muted" style={{ margin: 0 }}>
          There is nobody to assign to yet. Connect Slack, or add people in Settings under Team.
        </p>
        <div className="dg-actions">
          <button className="btn" type="button" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="dg-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (inChannel && !channel) return toast("Pick the channel to post in");
        if (!inChannel && !selected) return toast("Pick who should take it");
        const where: AssignWhere = !inChannel ? "dm" : channel === SOURCE_CHAT ? "chat" : `${CHANNEL_PICK}${channel}`;
        onDelegate(selected, note.trim(), due || subject.due, where);
      }}
    >
      {canPost && (
        <div className="dg-where" role="radiogroup" aria-label="How to assign it">
          <span className="label">Send it</span>
          <label className="person">
            <input type="radio" name={`${noteId}-where`} checked={!inChannel} onChange={() => setInChannel(false)} />
            <span>
              To a person <small>a direct message only they see</small>
            </span>
          </label>
          <label className="person">
            <input type="radio" name={`${noteId}-where`} checked={inChannel} onChange={() => setInChannel(true)} />
            <span>
              In a Slack channel <small>everyone there sees it</small>
            </span>
          </label>
        </div>
      )}

      {inChannel && (
        <div className="dg-slack">
          <label className="label" htmlFor={channelId} style={{ margin: 0 }}>
            Channel
          </label>
          <Combo
            id={channelId}
            value={channel}
            onChange={setChannel}
            placeholder="Type or pick a channel…"
            choices={[...(chat ? [{ value: SOURCE_CHAT, label: `${chat} (where this came from)` }] : []), ...channels.map((c) => ({ value: c.id, label: `#${c.name}` }))]}
          />
        </div>
      )}

      <h4>{inChannel ? "Tag someone (optional)" : "Assign to"}</h4>
      {people.length > 0 && (
        <div className="people" role="radiogroup" aria-label="Team member">
          {inChannel && (
            <label className="person">
              <input type="radio" name={`${noteId}-to`} checked={selected === ""} onChange={() => setChosen("")} />
              <span>
                Nobody <small>the channel takes it</small>
              </span>
            </label>
          )}
          {people.map((p) => (
            <label className="person" key={p.id}>
              <input type="radio" name={`${noteId}-to`} checked={p.id === selected} onChange={() => setChosen(p.id)} />
              <span>
                {p.name}{" "}
                <small>
                  {p.role}
                  {p.depts.length > 0 && (everyone || !p.depts.includes(subject.dept)) ? ` · ${p.depts.join(", ")}` : ""}
                </small>
                {p.matched.length > 0 && (
                  <>
                    <br />
                    <span className="fit">Best fit: {p.matched.join(", ")}</span>
                  </>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {hasDept && suggested.length > 0 && suggested.length < team.length && (
        <button type="button" className="linkbtn inline" style={{ justifySelf: "start" }} onClick={() => setEveryone(!everyone)}>
          {everyone ? `Show only people in ${subject.dept} or with matching responsibilities` : "Show the whole team"}
        </button>
      )}
      {others.length > 0 && (
        <div className="dg-slack">
          <label className="label" htmlFor={slackId} style={{ margin: 0 }}>
            {people.length > 0 ? "Or anyone else on Slack" : "Anyone on Slack"}
          </label>
          <Combo
            id={slackId}
            value={fromSlack}
            onChange={setChosen}
            placeholder="Type or pick a person…"
            none={inChannel ? "Nobody: the channel takes it" : undefined}
            choices={others.map((p) => ({ value: `${SLACK_PICK}${p.id}`, label: p.name }))}
          />
        </div>
      )}

      <label className="label" htmlFor={noteId}>
        Note (optional)
      </label>
      <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context, what done looks like, and anything they need from you" />
      <div className="dg-actions">
        <label className="label" htmlFor={dueId} style={{ margin: 0 }}>
          Due
        </label>
        <input className="f" type="date" id={dueId} value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="btn primary" type="submit">
          Assign
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">
          {inChannel
            ? `You post in ${place || "the channel"}${selectedName ? ", tagging them," : ""} with the task, the due date and your note.`
            : "They get a Slack direct message from you with the task, the due date and your note."}
        </span>
      </div>
      {inChannel && place && (
        <div className="dg-preview">
          <span className="label">What will be posted in {place}</span>
          <p>{assignmentText({ where: "chat", who: selectedName ? `@${selectedName}` : "", title: subject.title, due: due || subject.due, note: note.trim() })}</p>
        </div>
      )}
    </form>
  );
}
