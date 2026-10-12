"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { MessageText } from "@/components/MessageText";
import { PriPill, PrioritySelect, Seg, SrcBadge } from "@/components/bits";
import { LINE_NAME, LIVE_SOURCES, MODE_NAME, MODES, PERSONAL_SIDE, PRIORITIES, PRIORITY_NAME, SOURCE_NAME } from "@/core/config";
import { ago, stamp } from "@/core/dates";
import { plainPreview } from "@/core/message-format";
import { requestSummary } from "@/core/requests";
import { canAssignInChat } from "@/core/delegation";
import type { Conversation, Line, Mode, Priority, Source } from "@/core/types";
import {
  conversationToTask, delegateConversation, markConversationDone, openConversation, restoreInbox, sendReply,
  setConversationMode, setConversationPriority, toast, useApp, type App,
} from "@/store/store";

/** The conversation itself, opened under its row: every message, then the reply box. */
function Thread({ c, app, draft, onDraft }: { c: Conversation; app: App; draft: string; onDraft(text: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Open at the newest message, and stay there when one is added.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [c.thread.length]);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);

  const where = c.ctx.startsWith("#") ? `${SOURCE_NAME[c.source]} in ${c.ctx}` : `${SOURCE_NAME[c.source]} to ${c.from}`;
  const send = (markDone: boolean) => {
    const text = draft.trim();
    if (!text) {
      toast("Write a reply first");
      return field.current?.focus();
    }
    sendReply(c.id, text, markDone);
    onDraft("");
  };

  return (
    <div className="thread">
      <div className="bubbles" ref={box}>
        {c.thread.length === 0 && <p className="muted">No messages in this conversation yet.</p>}
        {c.thread.map((b, k) => (
          <div className={`bubble ${b.me ? "me" : ""}`} key={k}>
            <MessageText text={b.text} />
            <div className="bmeta">
              {b.me ? "You" : (b.from ?? c.from)} · {stamp(b.at, app.now)}
              {b.status === "queued" && <span className="queued">{app.state.sendingEnabled ? "Sending" : "Saved, not sent"}</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="composer">
        <label className="label" htmlFor={`reply-${c.id}`}>
          Reply on {where}
        </label>
        <textarea
          id={`reply-${c.id}`}
          ref={field}
          value={draft}
          placeholder="Write a reply…"
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(false);
            }
          }}
        />
        <div className="composer-row">
          <span className="hint">
            {app.state.sendingEnabled ? `⌘ + Enter to send. It goes out from your own ${SOURCE_NAME[c.source]} account.` : "⌘ + Enter to save. Sending is switched off, so replies wait in the outbox."}
          </span>
          <div className="btns">
            <button className="btn" onClick={() => send(true)}>
              Send and mark done
            </button>
            <button className="btn primary" onClick={() => send(false)}>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One conversation: who, where, the latest message, and what can be done with it. */
function MessageRow({ c, app, open, draft, onDraft }: { c: Conversation; app: App; open: boolean; draft: string; onDraft(text: string): void }) {
  const [delegating, setDelegating] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  // Arriving from another tab's "Reply" link: bring the opened conversation into view.
  useEffect(() => {
    if (open) row.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const last = c.thread[c.thread.length - 1];
  const canDelegate = c.mode === "professional";
  return (
    <div className={`msg ${c.replied ? "replied" : ""} ${open || delegating ? "open" : ""}`} ref={row}>
      <SrcBadge source={c.source} />
      <div style={{ minWidth: 0 }}>
        <div className="line1">
          <span className="who">{c.from}</span>
          <span className="ctx">
            {SOURCE_NAME[c.source]} · {c.ctx}
          </span>
          {c.tagged && <span className="chip me">Tagged you</span>}
          {c.mode === "professional" && c.line === "consulting" && <span className="chip biz">{LINE_NAME[c.line]}</span>}
        </div>
        <p className="txt">
          {last?.me && <span className="muted">You: </span>}
          {plainPreview(last?.me ? last.text : c.text)}
        </p>
      </div>
      <div className="side">
        <span className="ago">{ago(c.at, app.now.getTime())} ago</span>
        <div className="acts">
          <button
            className={`btn ${open ? "" : "primary"}`}
            aria-expanded={open}
            onClick={() => {
              setDelegating(false);
              openConversation(open ? null : c.id);
            }}
          >
            {open ? "Close" : "Reply"}
          </button>
          {PERSONAL_SIDE && (
            <select className="f" value={c.mode} aria-label="Personal or Professional" onChange={(e) => setConversationMode(c.id, e.target.value as Mode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_NAME[m]}
                </option>
              ))}
            </select>
          )}
          <PrioritySelect value={c.pri} onChange={(p) => setConversationPriority(c.id, p)} />
          <button className="btn" title="Adds a task to reply, due today, and clears this from the inbox" onClick={() => conversationToTask(c.id, app.today)}>
            Make task
          </button>
          {canDelegate && (
            <button
              className="btn dg"
              title="Turns this into a task for someone else and tells them on Slack"
              aria-expanded={delegating}
              onClick={() => {
                if (open) openConversation(null);
                setDelegating(!delegating);
              }}
            >
              Assign
            </button>
          )}
          <button className="btn" title="Clears this from the inbox. A new message brings it back." onClick={() => markConversationDone(c.id)}>
            Done
          </button>
        </div>
      </div>
      {delegating && (
        <div className="thread">
          <DelegateForm
            team={app.state.team}
            slackPeople={app.state.slackPeople}
            channels={app.state.channels}
            today={app.today}
            subject={{ title: `From ${c.from}: ${requestSummary(c.text, `@${app.state.owner.name}`)}`, project: c.project, dept: "", due: app.today }}
            chat={canAssignInChat(c) ? (c.ctx.startsWith("#") ? c.ctx : "this group message") : null}
            onCancel={() => setDelegating(false)}
            onDelegate={(personId, note, due, where) => delegateConversation(c.id, personId, note, due, where)}
          />
        </div>
      )}
      {open && !delegating && <Thread c={c} app={app} draft={draft} onDraft={onDraft} />}
    </div>
  );
}

export default function InboxPage() {
  const app = useApp();
  const [line, setLine] = useState<"all" | Line>("all");
  const [pri, setPri] = useState<"all" | Priority>("all");
  const [source, setSource] = useState<"all" | Source>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  if (!app) return null;
  const { state, ui } = app;
  const mode = ui.mode;

  const mine = state.inbox.filter((c) => c.mode === mode);
  const open = mine.filter((c) => !c.done);
  const consulting = open.filter((c) => c.line === "consulting").length;
  const byLineAndSource = open.filter((c) => (mode !== "professional" || line === "all" || c.line === line) && (source === "all" || c.source === source));
  const list = byLineAndSource.filter((c) => pri === "all" || c.pri === pri);
  const cleared = mine.length - open.length;
  const queued = state.outbox.filter((o) => o.status === "queued").length;
  const connected = LIVE_SOURCES.filter((s) => state.connections[s].connected);
  const other = MODES.find((m) => m !== mode)!;
  const elsewhere = state.inbox.filter((c) => c.mode === other && !c.done).length;

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
            {PERSONAL_SIDE ? `${MODE_NAME[mode]} conversations` : "Conversations"} from {connected.length ? connected.map((s) => SOURCE_NAME[s]).join(" and ") : "Slack"}, sorted by priority. Reply without leaving the page.
          </div>
        </div>
        <div className="brand-meta">
          {queued > 0 && (
            <span className="outbox-note" title={state.sendingEnabled ? "These will be sent on the next try" : "Saved, not sent: sending is switched off"}>
              {queued} {queued === 1 ? "reply" : "replies"} waiting to send
            </span>
          )}
          {cleared > 0 && (
            <button className="linkbtn" onClick={restoreInbox}>
              Restore {cleared} cleared
            </button>
          )}
        </div>
      </div>

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

      {groups.map(({ p, items }) => (
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

      {groups.length === 0 && (
        <div className="panel">
          <p className="empty" style={{ padding: 18 }}>
            {!state.connections.slack.connected ? (
              <>
                Nothing here yet. Connect Slack on the <Link href="/connections">Connections</Link> tab.
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
