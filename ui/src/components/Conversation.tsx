"use client";

// One conversation as a row of the Inbox or the Emails tab, opened to read and answer it, and
// the form for a new email. Shared by both tabs.

import { useEffect, useRef, useState } from "react";
import { DelegateForm } from "@/components/DelegateForm";
import { tidyEmailText } from "@/core/email-text";
import { EMAIL_TAG_NAME } from "@/core/email-tags";
import { Avatar, MessageText, Pictures, Reactions } from "@/components/MessageText";
import { PrioritySelect } from "@/components/bits";
import { EMAIL_TAGS_SHOWN, INBOX_DAYS, LINE_NAME, MODE_NAME, MODES, PERSONAL_SIDE, SOURCE_NAME } from "@/core/config";
import { ago, stamp } from "@/core/dates";
import { plainPreview } from "@/core/message-format";
import { requestSummary } from "@/core/requests";
import { groupByThread, threadToAnswer } from "@/core/threads";
import { canAssignInChat } from "@/core/delegation";
import type { Conversation, Mode, ThreadMessage } from "@/core/types";
import {
  composeEmail, conversationToTask, delegateConversation, markConversationDone, openConversation, readThreads, replyEmail, restoreConversation, sendReply,
  setConversationMode, setConversationPriority, toast, type App,
} from "@/store/store";

/** Slack hands a picture over only to an app that may read files. Until this one may, pictures are named and linked instead. */
const slackPicturesBlocked = (c: Conversation, app: App) => c.source === "slack" && app.state.slackFilesAllowed === false;

/** The tallest an email is drawn, so that a page that grows with its frame cannot grow for ever. */
const EMAIL_TALLEST = 40_000;
/** The most a wide email is shrunk to fit its frame. */
const EMAIL_SMALLEST = 0.45;

/**
 * An email as its sender laid it out: its formatting, pictures and links. It comes from Gmail
 * when it is opened, in a frame that can run nothing (see server/email-page.ts), and is as tall
 * as the email, so all of it shows with no scrolling inside.
 */
function EmailFrame({ c, b }: { c: Conversation; b: ThreadMessage }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const watch = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState(120);
  useEffect(() => () => watch.current?.disconnect(), []);
  const fit = () => {
    try {
      const root = frame.current?.contentDocument?.documentElement;
      if (!root) return;
      // An email wider than the frame, such as a 600px newsletter on a phone, is shrunk to fit, as
      // Gmail does. One so wide it would be too small to read scrolls sideways instead.
      root.style.zoom = "";
      const scale = root.scrollWidth > root.clientWidth + 1 ? Math.max(root.clientWidth / root.scrollWidth, EMAIL_SMALLEST) : 1;
      if (scale < 1) root.style.zoom = String(scale);
      // The page has no height of its own (see emailPage), so its box is the email's height,
      // with room for the sideways bar when there is one.
      const bar = root.scrollWidth > root.clientWidth + 1 ? 16 : 0;
      const tall = Math.ceil(root.getBoundingClientRect().height) + bar;
      if (tall > 0) setHeight(Math.min(Math.max(tall, 40), EMAIL_TALLEST));
    } catch {
      // The height cannot be read: it keeps the one it has.
    }
  };
  const loaded = () => {
    fit();
    const doc = frame.current?.contentDocument;
    const win = doc?.defaultView as (Window & typeof globalThis) | null | undefined;
    if (!doc || !win) return;
    // Pictures and web fonts arrive after the page, and a narrower window makes it taller.
    for (const img of Array.from(doc.images)) {
      if (img.complete) continue;
      img.addEventListener("load", fit);
      img.addEventListener("error", fit);
    }
    void doc.fonts?.ready.then(fit);
    watch.current?.disconnect();
    watch.current = new win.ResizeObserver(fit);
    watch.current.observe(doc.documentElement);
  };
  return (
    <iframe
      ref={frame}
      className="email-frame"
      title={`Email from ${b.me ? "you" : (b.from ?? c.from)}`}
      src={`/api/gmail/message?c=${encodeURIComponent(c.id)}&m=${encodeURIComponent(b.ts ?? "")}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      style={{ height }}
      onLoad={loaded}
    />
  );
}

/**
 * One email in its thread, the way Gmail shows it: who sent it and when along the top, then the
 * email across the whole width. Earlier emails in the thread are folded to one line; a click opens one.
 */
function EmailMessage({ b, c, app }: { b: ThreadMessage; c: Conversation; app: App }) {
  const who = b.me ? app.state.owner.name : (b.from ?? c.from);
  const newest = c.thread.filter((m) => m.ts && m.status !== "queued").at(-1);
  const [open, setOpen] = useState(!newest || newest.ts === b.ts);
  return (
    <div className={`email-msg ${b.me ? "me" : ""} ${open ? "open" : ""}`}>
      <button type="button" className="email-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar name={who} src={app.state.avatars[who]} small />
        <span className="email-who">{b.me ? "You" : who}</span>
        {!open && <span className="email-peek">{plainPreview(tidyEmailText(b.text), 140)}</span>}
        <span className="email-when">{stamp(b.at, app.now)}</span>
      </button>
      {open && <EmailFrame c={c} b={b} />}
    </div>
  );
}

/** One message in the conversation. */
function Bubble({ b, c, app }: { b: ThreadMessage; c: Conversation; app: App }) {
  const who = b.me ? app.state.owner.name : (b.from ?? c.from);
  // An email that is in Gmail (it has Gmail's id) is shown formatted. A reply still waiting to go is shown as written.
  if (c.source === "gmail" && b.ts && b.status !== "queued") return <EmailMessage b={b} c={c} app={app} />;
  const pictures = b.attachments ?? [];
  // "(sent a photo)" stands in for a picture that is not here. Beside the picture itself it says nothing.
  const standIn = pictures.length > 0 && /^\(sent an? [^)]*\)$/.test(b.text);
  return (
    <div className={`brow ${b.me ? "me" : ""}`}>
      {!b.me && <Avatar name={who} src={c.source === "telegram" ? b.avatar : app.state.avatars[who]} small />}
      <div className={`bubble ${b.me ? "me" : ""}`}>
        {pictures.length > 0 && <Pictures pictures={pictures} blocked={slackPicturesBlocked(c, app)} />}
        {!standIn && <MessageText text={b.text} />}
        <div className="bmeta">
          {b.me ? "You" : who} · {stamp(b.at, app.now)}
          {b.status === "queued" && <span className="queued">{app.state.sendingEnabled ? "Sending" : "Saved, not sent"}</span>}
        </div>
        {b.reactions && <Reactions reactions={b.reactions} />}
      </div>
    </div>
  );
}

/**
 * The conversation itself, opened under its row, laid out the way Slack shows it: each
 * message, with the replies in its thread under it. Then the reply box.
 */
function Thread({ c, app, draft, onDraft }: { c: Conversation; app: App; draft: string; onDraft(text: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  /** Where the reply goes: a thread's id, "" for the chat itself, or null until the person chooses. */
  const [picked, setPicked] = useState<string | null>(null);
  // Open at the newest message, and stay there when one is added.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [c.thread.length]);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  // The other messages here may have replies in Slack that were never read: fetch them now.
  useEffect(() => {
    void readThreads(c.id);
  }, [c.id]);

  const groups = groupByThread(c.thread);
  const checking = app.ui.checking.includes(c.id);
  // Threads are Slack's. A Telegram chat is one line of messages, so nothing there offers one.
  const threads = c.source === "slack";
  // A row that is one thread is answered in that thread. Otherwise a reply goes by default
  // where the latest message from someone else is: into its thread.
  const target = c.root ?? picked ?? threadToAnswer(c.thread) ?? "";
  const into = target ? groups.find((g) => g.key === target) : undefined;
  const chat = c.ctx.startsWith("#") ? c.ctx : `your chat with ${c.from}`;
  const where = c.ctx.startsWith("#") ? `${SOURCE_NAME[c.source]} in ${c.ctx}` : `${SOURCE_NAME[c.source]} to ${c.from}`;
  const answer = (key: string) => {
    setPicked(key);
    field.current?.focus();
  };
  const send = (markDone: boolean) => {
    const text = draft.trim();
    if (!text) {
      toast("Write a reply first");
      return field.current?.focus();
    }
    sendReply(c.id, text, markDone, into ? target : null);
    onDraft("");
  };

  return (
    <div className="thread">
      <div className={`bubbles ${c.source === "gmail" ? "emails" : ""}`} ref={box}>
        {groups.length === 0 && <p className="muted">No messages in this conversation yet.</p>}
        {checking && <p className="checking">{c.source === "telegram" ? "Checking Telegram for new messages and reactions…" : "Checking Slack for replies, pictures and reactions…"}</p>}
        {slackPicturesBlocked(c, app) && c.thread.some((m) => m.attachments?.length) && (
          <p className="checking">Pictures from Slack cannot be shown here yet. The Slack app needs one more permission (files:read). Until then each one has a link that opens it in Slack.</p>
        )}
        {groups.map((g) => (
          <div className={`tgroup ${!c.root && into?.key === g.key ? "answering" : ""}`} key={g.key}>
            {g.first && <Bubble b={g.first} c={c} app={app} />}
            {(g.replies.length > 0 || g.threaded) && (
              <div className="treplies">
                <div className="tlabel">
                  {g.first ? `Thread · ${g.replies.length} ${g.replies.length === 1 ? "reply" : "replies"}` : "Replies in a thread that started earlier"}
                  {threads && g.first?.ts && into?.key !== g.key && (
                    <button className="linkbtn inline" onClick={() => answer(g.key)}>
                      Reply in this thread
                    </button>
                  )}
                </div>
                {g.replies.map((r, k) => (
                  <Bubble b={r} c={c} app={app} key={k} />
                ))}
              </div>
            )}
            {/* A single message from someone else can be answered in a thread of its own. */}
            {threads && g.first?.ts && !g.first.me && !g.threaded && g.replies.length === 0 && into?.key !== g.key && (
              <button className="linkbtn inline tstart" onClick={() => answer(g.key)}>
                Reply in a thread
              </button>
            )}
          </div>
        ))}
      </div>
      {c.source === "gmail" ? (
        <EmailReply c={c} app={app} draft={draft} onDraft={onDraft} />
      ) : (
        <div className="composer">
          <label className="label" htmlFor={`reply-${c.id}`}>
            Reply on {where}
          </label>
          <div className="reply-to">
            {into ? (
              <>
                <span>
                  In the thread{into.first ? ` ${into.first.me ? "you" : (into.first.from ?? c.from)} started: “${plainPreview(into.first.text, 60)}”` : ""}
                </span>
                {!c.root && (
                  <button className="linkbtn inline" onClick={() => setPicked("")}>
                    Post in {chat} instead
                  </button>
                )}
              </>
            ) : (
              <span>As a new message in {chat}</span>
            )}
          </div>
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
      )}
    </div>
  );
}

/** The account and the Gmail thread of an email row, whose id is "gmail:<account>:<thread>". */
export function gmailOf(c: Conversation): { account: string; thread: string } {
  const rest = c.id.replace(/^gmail:/, "");
  const cut = rest.lastIndexOf(":");
  return { account: rest.slice(0, Math.max(0, cut)), thread: rest.slice(cut + 1) };
}

/** The thread in Gmail itself, opened in the account it came to. */
export const gmailLink = (c: Conversation) => {
  const { account, thread } = gmailOf(c);
  return `https://mail.google.com/mail/u/${encodeURIComponent(account || "0")}/#all/${encodeURIComponent(thread)}`;
};

/**
 * The reply box on an email. The answer goes from the account the email came to, into the same
 * thread, to whoever wrote last; "Reply all" adds everyone else that email was to or copied to.
 */
function EmailReply({ c, app, draft, onDraft }: { c: Conversation; app: App; draft: string; onDraft(text: string): void }) {
  const [all, setAll] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const { account } = gmailOf(c);
  const canSend = app.state.googleAccounts.find((a) => a.email === account)?.send ?? false;
  const lastFrom = [...c.thread].reverse().find((m) => !m.me)?.from ?? c.from;
  if (!canSend) {
    return (
      <div className="composer">
        <div className="composer-row">
          <span className="hint">
            To answer from here, <a href="/api/google/start">connect {account} again</a> and allow sending. Or reply in Gmail.
          </span>
          <div className="btns">
            <a className="btn" href={gmailLink(c)} target="_blank" rel="noopener noreferrer">
              Open in Gmail ↗
            </a>
          </div>
        </div>
      </div>
    );
  }
  const send = (markDone: boolean) => {
    const text = draft.trim();
    if (!text) {
      toast("Write a reply first");
      return field.current?.focus();
    }
    replyEmail(c.id, text, markDone, all);
    onDraft("");
  };
  return (
    <div className="composer">
      <label className="label" htmlFor={`reply-${c.id}`}>
        Reply by email from {account}
      </label>
      <div className="reply-to">
        <span>
          To {lastFrom}
          {all ? " and everyone else on the email" : ""}, in this thread
        </span>
        <label className="inline-check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Reply all
        </label>
      </div>
      <textarea
        id={`reply-${c.id}`}
        ref={field}
        value={draft}
        placeholder="Write your reply…"
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
          {app.state.sendingEnabled ? "⌘ + Enter to send. It goes out from your Gmail, as a normal reply." : "⌘ + Enter to save. Sending is switched off, so it waits in the outbox."}{" "}
          <a href={gmailLink(c)} target="_blank" rel="noopener noreferrer">
            Open in Gmail ↗
          </a>
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
  );
}

/** A new email from one of the connected accounts that may send. */
export function NewEmail({ app, onClose }: { app: App; onClose(): void }) {
  const senders = app.state.googleAccounts.filter((a) => a.send);
  const [from, setFrom] = useState(senders[0]?.email ?? "");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const failed = await composeEmail(from, to, cc, subject, body);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  return (
    <div className="panel new-email">
      <div className="new-email-head">
        <h3>New email</h3>
        <button className="linkbtn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="new-email-grid">
        <label htmlFor="ne-from">From</label>
        <select id="ne-from" className="f" value={from} onChange={(e) => setFrom(e.target.value)}>
          {senders.map((a) => (
            <option key={a.email} value={a.email}>
              {a.email}
            </option>
          ))}
        </select>
        <label htmlFor="ne-to">To</label>
        <input id="ne-to" className="f" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com, another@example.com" autoFocus />
        <label htmlFor="ne-cc">Cc</label>
        <input id="ne-cc" className="f" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Optional" />
        <label htmlFor="ne-subject">Subject</label>
        <input id="ne-subject" className="f" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <textarea className="f" rows={8} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your email…" aria-label="Message" />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-row">
        <span className="hint">{app.state.sendingEnabled ? "It goes out from your Gmail straight away." : "Sending is switched off, so it waits in the outbox."}</span>
        <div className="btns">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !from} onClick={() => void go()}>
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One conversation: who, where, the latest message, and what can be done with it. A cleared
 * one can only be read and put back.
 */
export function MessageRow({ c, app, open, draft, onDraft, cleared }: { c: Conversation; app: App; open: boolean; draft: string; onDraft(text: string): void; cleared?: boolean }) {
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
      <Avatar name={c.from} src={c.source === "telegram" ? c.avatar : app.state.avatars[c.from]} />
      <div style={{ minWidth: 0 }}>
        <div className="line1">
          <span className="who">{c.from}</span>
          <span className="ctx">
            {SOURCE_NAME[c.source]}
            {c.source === "gmail" && app.state.googleAccounts.length > 1 ? ` to ${gmailOf(c).account}` : ""} · {c.ctx}
            {c.root && c.thread.length > 1 ? " · thread" : ""}
          </span>
          {c.important && <span className="chip important">Important</span>}
          {c.tagged && <span className="chip me">Tagged you</span>}
          {EMAIL_TAGS_SHOWN && c.tags?.map((t) => (
            <span key={t} className={`chip etag etag-${t}`}>
              {EMAIL_TAG_NAME[t]}
            </span>
          ))}
          {cleared && c.autoCleared && <span className="chip">{c.replied ? "You answered" : `Nothing new for ${INBOX_DAYS} days`}</span>}
          {c.mode === "professional" && c.line === "consulting" && <span className="chip biz">{LINE_NAME[c.line]}</span>}
        </div>
        <p className="txt">
          {last?.me && <span className="muted">You: </span>}
          {plainPreview(c.source === "gmail" ? tidyEmailText(last?.me ? last.text : c.text) : last?.me ? last.text : c.text)}
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
            {open ? "Close" : cleared ? "Open" : "Reply"}
          </button>
          {cleared && (
            <button className="btn" title="Puts this chat back in the inbox" onClick={() => restoreConversation(c.id)}>
              Restore
            </button>
          )}
          {!cleared && PERSONAL_SIDE && (
            <select className="f" value={c.mode} aria-label="Personal or Professional" onChange={(e) => setConversationMode(c.id, e.target.value as Mode)}>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_NAME[m]}
                </option>
              ))}
            </select>
          )}
          {!cleared && <PrioritySelect value={c.pri} onChange={(p) => setConversationPriority(c.id, p)} />}
          {!cleared && (
            <button className="btn" title="Adds a task to reply, due today, and clears this from the inbox" onClick={() => conversationToTask(c.id, app.today)}>
              Make task
            </button>
          )}
          {!cleared && canDelegate && (
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
          {!cleared && (
            <button className="btn" title="Clears this from the inbox. A new message brings it back." onClick={() => markConversationDone(c.id)}>
              Done
            </button>
          )}
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
