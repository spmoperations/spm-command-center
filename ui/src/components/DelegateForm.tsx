"use client";

import { useId, useState } from "react";
import { candidates } from "@/core/delegation";
import type { Person } from "@/core/types";
import { toast } from "@/store/store";

interface Props {
  team: Person[];
  /** What is being handed over. An empty `dept` offers the whole team. */
  subject: { title: string; project: string; dept: string; due: string };
  today: string;
  onDelegate(personId: string, note: string, due: string): void;
  onCancel(): void;
}

export function DelegateForm({ team, subject, today, onDelegate, onCancel }: Props) {
  const noteId = useId();
  const dueId = useId();
  const hasDept = subject.dept !== "";
  const [everyone, setEveryone] = useState(!hasDept);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [due, setDue] = useState(subject.due < today ? today : subject.due);

  const people = candidates(team, subject, everyone);
  const selected = people.find((p) => p.id === chosen) ?? people[0];

  return (
    <form
      className="dg-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected) return toast("Pick who should take it");
        onDelegate(selected.id, note.trim(), due || subject.due);
      }}
    >
      <h4>Delegate to {everyone ? "anyone on the team" : `someone in ${subject.dept} or with matching responsibilities`}</h4>
      <div className="people" role="radiogroup" aria-label="Team member">
        {people.map((p) => (
          <label className="person" key={p.id}>
            <input type="radio" name={`${noteId}-to`} checked={p.id === selected?.id} onChange={() => setChosen(p.id)} />
            <span>
              {p.name}{" "}
              <small>
                {p.role}
                {everyone || !p.depts.includes(subject.dept) ? ` · ${p.depts.join(", ")}` : ""}
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
        {people.length === 0 && <span className="muted">No one on the team yet. Add people in Settings.</span>}
      </div>
      {hasDept && (
        <button type="button" className="linkbtn inline" style={{ justifySelf: "start" }} onClick={() => setEveryone(!everyone)}>
          {everyone ? "Show suggested people only" : "Show everyone"}
        </button>
      )}
      <label className="label" htmlFor={noteId}>
        What needs to be done
      </label>
      <textarea
        id={noteId}
        required
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Context, what done looks like, and anything they need from you"
      />
      <div className="dg-actions">
        <label className="label" htmlFor={dueId} style={{ margin: 0 }}>
          Due
        </label>
        <input className="f" type="date" id={dueId} value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="btn primary" type="submit">
          Delegate
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel
        </button>
        <span className="hint">They get a Slack message from you with your note. Slack is not connected yet, so it waits in the outbox.</span>
      </div>
    </form>
  );
}
