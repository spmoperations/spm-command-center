"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageRow } from "@/components/Conversation";
import { PriPill, Seg } from "@/components/bits";
import { INBOX_DAYS, liveSources, MODE_NAME, MODES, PERSONAL_SIDE, PRIORITIES, PRIORITY_NAME, SOURCE_NAME, SOURCE_PROVIDER } from "@/core/config";
import type { Line, Priority, Source } from "@/core/types";
import { openConversation, useApp } from "@/store/store";

export default function InboxPage() {
  const app = useApp();
  const [line, setLine] = useState<"all" | Line>("all");
  const [pri, setPri] = useState<"all" | Priority>("all");
  const [source, setSource] = useState<"all" | Source>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Looking at what was cleared, to read a chat or put one back. */
  const [showCleared, setShowCleared] = useState(false);
  if (!app) return null;
  const { state, ui } = app;
  const mode = ui.mode;

  // Emails have a tab of their own.
  const mine = state.inbox.filter((c) => c.mode === mode && c.source !== "gmail");
  const open = mine.filter((c) => !c.done);
  const consulting = open.filter((c) => c.line === "consulting").length;
  const byLineAndSource = open.filter((c) => (mode !== "professional" || line === "all" || c.line === line) && (source === "all" || c.source === source));
  const list = byLineAndSource.filter((c) => pri === "all" || c.pri === pri);
  // Newest first. Only the most recently cleared are kept to hand.
  const clearedList = mine.filter((c) => c.done).sort((a, b) => b.at - a.at);
  const cleared = clearedList.length;
  const viewingCleared = showCleared && cleared > 0;
  const queued = state.outbox.filter((o) => o.status === "queued").length;
  const connected = liveSources(state.telegramAvailable).filter((s) => state.connections[SOURCE_PROVIDER[s]].connected);
  const other = MODES.find((m) => m !== mode)!;
  const elsewhere = state.inbox.filter((c) => c.mode === other && !c.done && c.source !== "gmail").length;

  const groups = PRIORITIES.map((p) => ({
    p,
    // Conversations still waiting for a reply come first, newest on top.
    items: list.filter((c) => c.pri === p).sort((a, b) => Number(a.replied) - Number(b.replied) || b.at - a.at),
  })).filter((g) => g.items.length > 0);

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Inbox</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {PERSONAL_SIDE ? `${MODE_NAME[mode]} conversations` : "Conversations"} from {connected.length ? connected.map((s) => SOURCE_NAME[s]).join(" and ") : "Slack"}, sorted by priority. Reply without leaving the page. A chat with nothing new for {INBOX_DAYS} days is cleared by itself.
          </div>
        </div>
        <div className="brand-meta">
          {queued > 0 && (
            <span className="outbox-note" title={state.sendingEnabled ? "These will be sent on the next try" : "Saved, not sent: sending is switched off"}>
              {queued} {queued === 1 ? "reply" : "replies"} waiting to send
            </span>
          )}
          {cleared > 0 && (
            <button
              className="linkbtn"
              aria-expanded={viewingCleared}
              title="See the chats you cleared, and put one back in the inbox"
              onClick={() => {
                openConversation(null);
                setShowCleared(!viewingCleared);
              }}
            >
              {viewingCleared ? "Back to the inbox" : `Restore: see ${cleared} cleared`}
            </button>
          )}
        </div>
      </div>

      {viewingCleared && (
        <div className="inbox-group">
          <div className="group-head">
            <span className="chip">Cleared</span>
            <span className="n">
              {cleared} {cleared === 1 ? "conversation" : "conversations"}. Open one to read it, or click Restore to put it back in the inbox. A restored chat stays for {INBOX_DAYS} days, or longer if something new arrives.
            </span>
          </div>
          <div className="panel">
            {clearedList.map((c) => (
              <MessageRow key={c.id} c={c} app={app} cleared open={ui.openConversation === c.id} draft={drafts[c.id] ?? ""} onDraft={(text) => setDrafts({ ...drafts, [c.id]: text })} />
            ))}
          </div>
        </div>
      )}

      {!viewingCleared && (
        <div className="filters">
          {mode === "professional" && consulting > 0 && (
            <Seg
              label="Business line"
              value={line}
              onChange={(v) => setLine(v)}
              options={[["all", `All ${open.length}`], ["consulting", `Consulting ${consulting}`], ["agency", `Agency ${open.length - consulting}`]]}
            />
          )}
          <Seg
            label="Priority"
            value={pri}
            onChange={(v) => setPri(v)}
            options={[["all", `Any priority ${byLineAndSource.length}`], ...PRIORITIES.map((p): [Priority, string] => [p, `${PRIORITY_NAME[p]} ${byLineAndSource.filter((c) => c.pri === p).length}`])]}
          />
          {connected.length > 1 && (
            <select className="f" value={source} aria-label="Source" onChange={(e) => setSource(e.target.value as "all" | Source)}>
              <option value="all">All sources</option>
              {connected.map((s) => (
                <option key={s} value={s}>
                  {SOURCE_NAME[s]}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {!viewingCleared && groups.map(({ p, items }) => (
        <div className="inbox-group" key={p}>
          <div className="group-head">
            <PriPill p={p} />
            <span className="n">
              {items.length} {items.length === 1 ? "conversation" : "conversations"}
            </span>
          </div>
          <div className="panel">
            {items.map((c) => (
              <MessageRow key={c.id} c={c} app={app} open={ui.openConversation === c.id} draft={drafts[c.id] ?? ""} onDraft={(text) => setDrafts({ ...drafts, [c.id]: text })} />
            ))}
          </div>
        </div>
      ))}

      {!viewingCleared && groups.length === 0 && (
        <div className="panel">
          <p className="empty" style={{ padding: 18 }}>
            {!state.connections.slack.connected ? (
              <>
                Nothing here yet. Connect Slack on the <Link href="/connections">Connections</Link> page.
              </>
            ) : open.length > 0 ? (
              "No conversations match this filter."
            ) : mode === "personal" ? (
              `No personal conversations yet. To move one here, open the Professional inbox and change its "Professional" box to "Personal".${elsewhere ? ` There ${elsewhere === 1 ? "is 1 conversation" : `are ${elsewhere} conversations`} on the Professional side.` : ""}`
            ) : (
              "Inbox clear."
            )}
          </p>
        </div>
      )}
    </section>
  );
}
