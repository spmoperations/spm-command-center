"use client";

import type { Suggestion } from "@/core/types";
import { acceptSuggestion, dismissSuggestion, editSuggestion, type App } from "@/store/store";
import { PrioritySelect, SourceLink } from "./bits";

/** A task found in a message or call. Nothing becomes a task until "Add task" is clicked. */
export function SuggestionRow({ g, app }: { g: Suggestion; app: App }) {
  return (
    <div className="sg">
      <div style={{ minWidth: 0 }}>
        <div className="t-title">{g.title}</div>
        <div className="sg-why">{g.why}</div>
        <div className="sg-meta">
          <SourceLink src={g.src} app={app} />
          {g.example && <span className="chip">Example</span>}
          <span className="chip">{g.project}</span>
        </div>
      </div>
      <div className="sg-ctrl">
        <PrioritySelect value={g.pri} label="Suggested priority" onChange={(pri) => editSuggestion(g.id, { pri })} />
        <input
          className="f"
          type="date"
          value={g.due}
          aria-label="Suggested due date"
          onChange={(e) => e.target.value && editSuggestion(g.id, { due: e.target.value })}
        />
        <button className="btn primary" onClick={() => acceptSuggestion(g.id)}>
          Add task
        </button>
        <button className="btn" onClick={() => dismissSuggestion(g.id)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
