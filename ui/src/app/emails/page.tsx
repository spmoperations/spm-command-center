"use client";

import Link from "next/link";
import { useState } from "react";
import { gmailOf, MessageRow, NewEmail } from "@/components/Conversation";
import { Seg } from "@/components/bits";
import { EMAIL_TAGS_SHOWN } from "@/core/config";
import { ago } from "@/core/dates";
import { EMAIL_TAG_NAME, EMAIL_TAGS } from "@/core/email-tags";
import type { EmailTag } from "@/core/types";
import { runJobNow, useApp, type App } from "@/store/store";

type TagFilter = "all" | EmailTag | "untagged";

/** Why there are no emails to show, and what to do about it. */
function NotYet({ app }: { app: App }) {
  const { state } = app;
  const text = !state.googleAvailable
    ? "Google is not switched on for this site yet. Once it is, connect a Google account on the Connections page."
    : !state.connections.google.connected
      ? "Connect a Google account on the Connections page to see its emails here."
      : "Gmail was not allowed when the Google account was connected. Connect it again and tick Gmail.";
  return (
    <div className="panel">
      <p className="empty" style={{ padding: 18 }}>
        {text} <Link href="/connections#google">Go to Connections</Link>
      </p>
    </div>
  );
}

export default function EmailsPage() {
  const app = useApp();
  const [tag, setTag] = useState<TagFilter>("all");
  const [account, setAccount] = useState("all");
  const [query, setQuery] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [writing, setWriting] = useState(false);
  if (!app) return null;
  const { state, ui } = app;
  const ready = state.googleAvailable && state.connections.google.connected && state.googleAllows.gmail;
  const accounts = state.googleAccounts.filter((a) => a.gmail);
  const status = state.jobStatus["gmail-pull"];
  const checking = ui.running.includes("gmail-pull");

  const emails = state.inbox.filter((c) => c.source === "gmail" && (account === "all" || gmailOf(c).account === account) && c.done === showDone);
  const words = query.trim().toLowerCase();
  const found = words ? emails.filter((c) => `${c.from} ${c.ctx} ${c.text}`.toLowerCase().includes(words)) : emails;
  const matches = (t: TagFilter) => (c: (typeof found)[number]) => t === "all" || (t === "untagged" ? !c.tags?.length : Boolean(c.tags?.includes(t)));
  // Newest first, as in Gmail.
  const list = found.filter(matches(EMAIL_TAGS_SHOWN ? tag : "all")).sort((a, b) => b.at - a.at);
  const options: [TagFilter, string][] = [["all", `All ${found.length}`], ...EMAIL_TAGS.map((t): [TagFilter, string] => [t, `${EMAIL_TAG_NAME[t]} ${found.filter(matches(t)).length}`]), ["untagged", `No tag ${found.filter(matches("untagged")).length}`]];

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Emails</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            Every email that arrives in your connected Gmail, newest first.{EMAIL_TAGS_SHOWN ? " Payments, subscriptions and newsletters are tagged; pick a tag to see only those." : ""} Open an email to read and answer it.
          </div>
        </div>
        {ready && (
          <div className="brand-meta">
            <span className="muted" style={{ fontSize: 13 }}>
              {status?.lastRunAt ? `Checked ${ago(status.lastRunAt, app.now.getTime())} ago` : "Not checked yet"}
            </span>
            <button className="btn" disabled={checking} onClick={() => void runJobNow("gmail-pull")}>
              {checking ? "Checking…" : "Check for new"}
            </button>
            {state.googleAllows.send && (
              <button className="btn primary" onClick={() => setWriting(!writing)} aria-expanded={writing}>
                New email
              </button>
            )}
          </div>
        )}
      </div>

      {!ready ? (
        <NotYet app={app} />
      ) : (
        <>
          {writing && <NewEmail app={app} onClose={() => setWriting(false)} />}
          <div className="email-tools">
            {EMAIL_TAGS_SHOWN && <Seg label="Tag" value={tag} onChange={(v) => setTag(v)} options={options} />}
            <input type="search" className="f" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search sender, subject or text" aria-label="Search emails" />
            {accounts.length > 1 && (
              <select className="f" value={account} aria-label="Account" onChange={(e) => setAccount(e.target.value)}>
                <option value="all">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.email} value={a.email}>
                    {a.email}
                  </option>
                ))}
              </select>
            )}
            <label className="inline-check">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Done
            </label>
          </div>

          <div className="panel">
            {list.map((c) => (
              <MessageRow key={c.id} c={c} app={app} open={ui.openConversation === c.id} draft={drafts[c.id] ?? ""} onDraft={(text) => setDrafts({ ...drafts, [c.id]: text })} cleared={c.done} />
            ))}
            {list.length === 0 && (
              <p className="empty" style={{ padding: 18 }}>
                {emails.length === 0 && !showDone
                  ? "No emails yet. They come in from the moment the account was connected: when one arrives, click Check for new."
                  : showDone
                    ? "Nothing done here yet."
                    : "No emails match this."}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
