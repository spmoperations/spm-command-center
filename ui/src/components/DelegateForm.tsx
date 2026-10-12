"use client";

import { useId, useState } from "react";
import { assignmentText, candidates, SLACK_PICK, type AssignWhere } from "@/core/delegation";
import type { Person } from "@/core/types";
import { toast } from "@/store/store";

interface Props {
  team: Person[];
  /** Everyone in the Slack workspace. Anyone here can be picked, on the team list or not. */
  slackPeople: { id: string; name: string }[];
  /** What is being assigned. An empty `dept` offers the whole team. */
  subject: { title: string; project: string; dept: string; due: string };
  today: string;
  /** The chat this came from, e.g. "#sales", when the person can be told there. Leave out for a direct message only. */
  chat?: string | null;
  onDelegate(personId: string, note: string, due: string, where: AssignWhere): void;
  onCancel(): void;
}

/** Assigns a task to someone: a person from the team list, or anyone else in Slack. */
export function DelegateForm({ team, slackPeople, subject, today, chat, onDelegate, onCancel }: Props) {
  const [where, setWhere] = useState<AssignWhere>("dm");
  const noteId = useId();
  const dueId = useId();
  const slackId = useId();
  const hasDept = subject.dept !== "";
  const [everyone, setEveryone] = useState(!hasDept);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [due, setDue] = useState(subject.due < today ? today : subject.due);

  const suggested = candidates(team, subject, false);
  // With nobody suggested for this task, the whole team is shown straight away.
  const people = everyone || suggested.length === 0 ? candidates(team, subject, true) : suggested;
  const others = slackPeople.filter((p) => !team.some((t) => t.slackUserId === p.id));
  const selected = chosen ?? people[0]?.id ?? null;
  const fromSlack = selected?.startsWith(SLACK_PICK) ? selected : "";
  const selectedName = team.find((p) => p.id === selected)?.name ?? others.find((p) => `${SLACK_PICK}${p.id}` === selected)?.name ?? "the person you pick";
  const inChat = Boolean(chat) && where === "chat";

  if (team.length === 0 && others.length === 0) {
    return (
      <div className="dg-form">
        <h4>Assign to</h4>
        <p className="muted" style={{ margin: 0 }}>
          There is nobody to assign to yet. Connect Slack on the Connections tab, or add people in Settings under Team.
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
        if (!selected) return toast("Pick who should take it");
        onDelegate(selected, note.trim(), due || subject.due, inChat ? "chat" : "dm");
      }}
    >
      <h4>Assign to</h4>
      {people.length > 0 && (
        <div className="people" role="radiogroup" aria-label="Team member">
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
            {people.length > 0 ? "Or anyone else on Slack" : "Pick anyone on Slack"}
          </label>
          <select className="f" id={slackId} value={fromSlack} onChange={(e) => setChosen(e.target.value || null)}>
            <option value="">Choose a person…</option>
            {others.map((p) => (
              <option key={p.id} value={`${SLACK_PICK}${p.id}`}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {chat && (
        <div className="dg-where" role="radiogroup" aria-label="Where to tell them">
          <span className="label">Tell them</span>
          <label className="person">
            <input type="radio" name={`${noteId}-where`} checked={!inChat} onChange={() => setWhere("dm")} />
            <span>
              In a direct message <small>only they see it</small>
            </span>
          </label>
          <label className="person">
            <input type="radio" name={`${noteId}-where`} checked={inChat} onChange={() => setWhere("chat")} />
            <span>
              In {chat} <small>everyone in that chat sees it</small>
            </span>
          </label>
        </div>
      )}
      <label className="label" htmlFor={noteId}>
        Note for them (optional)
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
          {inChat ? `You post in ${chat}, tagging them, with the task, the due date and your note.` : "They get a Slack direct message from you with the task, the due date and your note."}
        </span>
      </div>
      {inChat && (
        <div className="dg-preview">
          <span className="label">What will be posted in {chat}</span>
          <p>{assignmentText({ where: "chat", who: `@${selectedName}`, title: subject.title, due: due || subject.due, note: note.trim() })}</p>
        </div>
      )}
    </form>
  );
}
