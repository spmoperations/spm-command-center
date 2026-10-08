"use client";

import { useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { PriPill, PrioritySelect, Seg, SrcBadge } from "@/components/bits";
import { LINE_NAME, PRIORITIES, SOURCE_NAME, SOURCES } from "@/core/config";
import { ago, stamp } from "@/core/dates";
import type { Conversation, Line, Priority, Source } from "@/core/types";
import {
  conversationToTask, delegateConversation, markConversationDone, openConversation, restoreInbox, sendReply,
  setConversationPriority, toast, useApp, type App,
} from "@/store/store";

function Thread({ c, app, draft, onDraft }: { c: Conversation; app: App; draft: string; onDraft(text: string): void }) {
  const where = c.source === "slack" && c.ctx.startsWith("#") ? `Slack in ${c.ctx}` : `${SOURCE_NAME[c.source]} to ${c.from}`;
  const send = (markDone: boolean) => {
    const text = draft.trim();
    if (!text) return toast("Write a reply first");
    sendReply(c.id, text, markDone);
    onDraft("");
  };
  return (
    <div className="thread">
      <div className="bubbles">
        {c.thread.map((b, k) => (
          <div key={k} className={`bubble ${b.me ? "me" : ""}`}>
            {b.text}
            <div className="bmeta">
              {b.me ? "You" : c.from} · {stamp(b.at, app.now)}
              {b.status === "queued" && <span className="queued">Queued</span>}
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
          autoFocus
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
            ⌘ + Enter to send. {SOURCE_NAME[c.source]} is not connected yet, so replies wait in the outbox.
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

export default function InboxPage() {
  const app = useApp();
  const [line, setLine] = useState<"all" | Line>("all");
  const [pri, setPri] = useState<"all" | Priority>("all");
  const [source, setSource] = useState<"all" | Source>("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [delegating, setDelegating] = useState<string | null>(null);
  if (!app) return null;
  const { state, ui, now, today } = app;

  const open = state.inbox.filter((c) => !c.done);
  const list = open.filter((c) => (line === "all" || c.line === line) && (pri === "all" || c.pri === pri) && (source === "all" || c.source === source));
  const lineCount = (l: "all" | Line) => open.filter((c) => l === "all" || c.line === l).length;
  const cleared = state.inbox.length - open.length;
  const queued = state.outbox.filter((o) => o.status === "queued").length;

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
            Conversations from Slack and Telegram, most important first. Reply without leaving the page.
          </div>
        </div>
        <div className="brand-meta">
          {queued > 0 && (
            <span className="outbox-note" title="Replies wait here until each app is connected">
              {queued} {queued === 1 ? "message" : "messages"} queued
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
        <Seg
          label="Business line"
          value={line}
          onChange={(v) => setLine(v)}
          options={[["all", `All ${lineCount("all")}`], ["consulting", `Consulting ${lineCount("consulting")}`], ["agency", `Agency ${lineCount("agency")}`]]}
        />
        <Seg label="Priority" value={pri} onChange={(v) => setPri(v)} options={[["all", "Any priority"], ["high", "High"], ["mid", "Mid"], ["low", "Low"]]} />
        <select className="f" value={source} aria-label="Source" onChange={(e) => setSource(e.target.value as "all" | Source)}>
          <option value="all">All sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_NAME[s]}
            </option>
          ))}
        </select>
      </div>

      {groups.length === 0 && (
        <div className="panel">
          <p className="empty" style={{ padding: 18 }}>
            Inbox clear for this filter.
          </p>
        </div>
      )}

      {groups.map(({ p, items }) => (
        <div className="inbox-group" key={p}>
          <div className="group-head">
            <PriPill p={p} />
            <span className="n">
              {items.length} {items.length === 1 ? "conversation" : "conversations"}
            </span>
          </div>
          <div className="panel">
            {items.map((c) => {
              const isOpen = ui.openConversation === c.id;
              const last = c.thread[c.thread.length - 1];
              return (
                <div key={c.id} className={`msg ${c.replied ? "replied" : ""} ${isOpen ? "open" : ""}`}>
                  <SrcBadge source={c.source} />
                  <div style={{ minWidth: 0 }}>
                    <div className="line1">
                      <span className="who">{c.from}</span>
                      <span className="ctx">
                        {SOURCE_NAME[c.source]} · {c.ctx}
                      </span>
                      <span className={`chip ${c.line === "consulting" ? "biz" : ""}`}>{LINE_NAME[c.line]}</span>
                      {c.tagged && <span className="chip me">Tagged you</span>}
                    </div>
                    <p className="txt">
                      {last.me && <span className="muted">You: </span>}
                      {last.text}
                    </p>
                  </div>
                  <div className="side">
                    <span className="ago">{ago(c.at, now.getTime())} ago</span>
                    <div className="acts">
                      <button
                        className={`btn ${isOpen ? "" : "primary"}`}
                        aria-expanded={isOpen}
                        onClick={() => {
                          setDelegating(null);
                          openConversation(isOpen ? null : c.id);
                        }}
                      >
                        {isOpen ? "Close" : "Reply"}
                      </button>
                      <PrioritySelect value={c.pri} onChange={(v) => setConversationPriority(c.id, v)} />
                      <button className="btn" onClick={() => conversationToTask(c.id, today)}>
                        Make task
                      </button>
                      <button
                        className="btn dg"
                        aria-expanded={delegating === c.id}
                        onClick={() => {
                          openConversation(null);
                          setDelegating(delegating === c.id ? null : c.id);
                        }}
                      >
                        Delegate
                      </button>
                      <button className="btn" onClick={() => markConversationDone(c.id)}>
                        Done
                      </button>
                    </div>
                  </div>
                  {isOpen && <Thread c={c} app={app} draft={drafts[c.id] ?? ""} onDraft={(text) => setDrafts({ ...drafts, [c.id]: text })} />}
                  {delegating === c.id && (
                    <DelegateForm
                      team={state.team}
                      today={today}
                      subject={{ title: c.text, project: c.project, dept: "", due: today }}
                      onCancel={() => setDelegating(null)}
                      onDelegate={(personId, note, due) => {
                        delegateConversation(c.id, personId, note, due);
                        setDelegating(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
