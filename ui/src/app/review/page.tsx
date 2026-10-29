"use client";

// The review: everything the checks flagged across the team, from everyone's inbox and calls,
// waiting to become a ticket on the board or be turned down. Shared by everyone with a login.

import Link from "next/link";
import { useState } from "react";
import { Seg } from "@/components/bits";
import { assignable, ClientPicker, defaultNotify, LineChip, NotifyChoice, PersonPicker, SourceBox, ticketName, TicketForm, type Assignable } from "@/components/Tickets";
import { conversationPage, REJECT_REASONS, REVIEW_FROM, type RejectReason } from "@/core/config";
import { parseDay, stamp } from "@/core/dates";
import { raisedIn, REVIEW_WHEN_NAME, reviewWaiting, type ReviewWhen } from "@/core/review";
import type { ReviewItem, TicketInput } from "@/core/types";
import { acceptReview, mergeReview, openConversation, rejectReview, restoreReview, reviewMany, showMeeting, useApp, type App } from "@/store/store";

const REASONS = Object.entries(REJECT_REASONS) as [RejectReason, string][];

/** What a card would make, as it stands on screen. */
const asInput = (g: ReviewItem, today: string, people: Assignable[]): TicketInput => ({
  title: g.title,
  description: g.why,
  assignee: g.assignee,
  client: g.client,
  due: g.due < today ? today : g.due,
  status: "open",
  pri: g.pri,
  notify: defaultNotify(people, g.assignee),
  // As its chat (see ChatLine), unless one is picked when editing.
  line: null,
});

function ReviewCard({ g, app, people, picked, onPick, clients }: { g: ReviewItem; app: App; people: Assignable[]; picked: boolean; onPick(on: boolean, range: boolean): void; clients: string[] }) {
  const { state, today, now } = app;
  const [card, setCard] = useState<TicketInput>(() => asInput(g, today, people));
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [into, setInto] = useState("");
  const open = state.tasks.filter((t) => !t.done && t.mode === "professional").sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  const set = (patch: Partial<TicketInput>) => setCard((c) => ({ ...c, ...patch }));
  return (
    <article className={`panel rv-card ${picked ? "picked" : ""}`}>
      <div className="rv-top">
        <input type="checkbox" className="pick" checked={picked} aria-label={`Select: ${g.title}`} onClick={(e) => onPick(!picked, e.shiftKey)} onChange={() => {}} />
        <span className="pill tk-new">New task</span>
        {g.line && <LineChip line={g.line} />}
        {g.looksDone && <span className="pill tk-done">Looks done already</span>}
        {g.confidence !== null && (
          <span className="chip rv-sure" title="How sure the AI is that this is a real task">
            AI: {g.confidence}% sure
          </span>
        )}
        {g.unchecked && (
          <span className="chip" title="The AI reads each flagged message and keeps only real tasks. This one is next.">
            Not checked by the AI yet
          </span>
        )}
        <span className="muted rv-when">
          Found in {g.source.from}&apos;s {g.source.label.split(" · ")[0]} · {stamp(g.raisedAt, now)}
        </span>
      </div>
      <h3 className="rv-title">{g.title}</h3>
      <div className="rv-fields">
        <div className="rv-field rv-who">
          <span className="label">Assigned to: whose task</span>
          <PersonPicker people={people} value={card.assignee} onChange={(assignee) => set({ assignee, notify: defaultNotify(people, assignee) })} />
        </div>
        <div className="rv-field">
          <span className="label">Client</span>
          <ClientPicker value={card.client} clients={clients} onChange={(client) => set({ client })} />
        </div>
        <div className="rv-field">
          <span className="label">Due</span>
          <input className="f" type="date" value={card.due} aria-label="Due date" onChange={(e) => set({ due: e.target.value })} />
        </div>
      </div>
      <NotifyChoice people={people} assignee={card.assignee} value={card.notify ?? []} onChange={(notify) => set({ notify })} />
      {g.forName && !people.some((p) => p.id === card.assignee) && (
        <p className="rv-for">
          {g.source.label.startsWith("Fathom") ? "Fathom" : "The message"} says it is for <strong>{g.forName}</strong>. Type their name above to give it to them, from the team list, Slack or Telegram.
        </p>
      )}
      <SourceBox
        note={g.source}
        extra={
          g.mine && g.src ? (
            g.src.type === "message" ? (
              <Link href={conversationPage(g.src.id)} onClick={() => openConversation(g.src!.id)}>
                Open the conversation
              </Link>
            ) : (
              <Link href="/meetings" onClick={() => showMeeting(g.src!.id)}>
                Open the call&apos;s notes
              </Link>
            )
          ) : null
        }
      />
      {g.why && <p className="rv-why">{g.why}</p>}
      {g.looksDone && (
        <div className="rv-done">
          <span>
            <strong>Looks done already.</strong> {g.looksDone}
          </span>
          <button className="btn" onClick={() => void rejectReview(g.id, "already_done")}>
            Dismiss
          </button>
        </div>
      )}
      <div className="rv-acts">
        <div className="btns">
          <button className="btn primary" onClick={() => void acceptReview(g.id, card)}>
            Accept
          </button>
          <button className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button className="btn" aria-expanded={merging} onClick={() => setMerging(!merging)}>
            Merge…
          </button>
        </div>
        <div className="rv-reject">
          <span className="muted">Reject</span>
          {REASONS.map(([key, name]) => (
            <button key={key} className="btn bad" onClick={() => void rejectReview(g.id, key)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      {merging && (
        <div className="rv-merge">
          <select className="f" value={into} aria-label="The ticket it is the same as" onChange={(e) => setInto(e.target.value)}>
            <option value="">The same as which ticket?</option>
            {open.map((t) => (
              <option key={t.id} value={t.id}>
                {ticketName(t.number)} {t.title}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!into} onClick={() => void mergeReview(g.id, into)}>
            Merge
          </button>
        </div>
      )}
      {editing && (
        <TicketForm heading="Edit and accept" initial={card} people={people} clients={clients} submit="Accept" fromChat={g.line} onSubmit={(input) => acceptReview(g.id, input)} onCancel={() => setEditing(false)} />
      )}
    </article>
  );
}

export default function ReviewPage() {
  const app = useApp();
  const [from, setFrom] = useState("all");
  const [when, setWhen] = useState<ReviewWhen>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [last, setLast] = useState<string | null>(null);
  const [reason, setReason] = useState<RejectReason>("not_task");
  if (!app) return null;
  const { state } = app;
  const clients = state.clients;
  const people = assignable(state);
  const logins = state.people.filter((p) => p.login);
  // Everything raised since the Review tab started (REVIEW_FROM), then narrowed by whose it is and when it was raised.
  const whose = (g: ReviewItem) => from === "all" || (from === "mine" ? g.mine : `user:${g.fromUser}` === from);
  const waiting = reviewWaiting(state.review).filter(whose);
  const shown = waiting.filter((g) => raisedIn(g.raisedAt, when, app.now));
  const setAside = reviewWaiting(state.setAside)
    .filter(whose)
    .filter((g) => raisedIn(g.raisedAt, when, app.now));
  const count = (w: ReviewWhen) => waiting.filter((g) => raisedIn(g.raisedAt, w, app.now)).length;
  // A part of the filter with nothing in it is left out, unless it is the one picked.
  const whens = (["all", "today", "this_week", "last_week", "earlier"] as ReviewWhen[]).filter((w) => w === "all" || w === when || count(w) > 0);
  const start = parseDay(REVIEW_FROM).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const ids = shown.filter((g) => picked.has(g.id)).map((g) => g.id);
  const all = shown.length > 0 && ids.length === shown.length;
  const pick = (id: string, on: boolean, range: boolean) => {
    const next = new Set(picked);
    // Shift-click picks everything between the last one picked and this one.
    const span = range && last ? [shown.findIndex((g) => g.id === last), shown.findIndex((g) => g.id === id)].sort((a, b) => a - b) : null;
    for (const g of span && span[0] >= 0 ? shown.slice(span[0], span[1] + 1) : shown.filter((x) => x.id === id)) {
      if (on) next.add(g.id);
      else next.delete(g.id);
    }
    setPicked(next);
    setLast(id);
  };
  const decide = async (decision: "accept" | RejectReason) => {
    if (await reviewMany(ids, decision)) setPicked(new Set());
  };

  return (
    <section className="view">
      <div className="view-head">
        <div>
          <h2>Review</h2>
          <div className="muted" style={{ fontSize: 14 }}>
            {waiting.length} waiting, raised since {start} in the team&apos;s chats, emails and calls. Each stays here until someone accepts or rejects it. Accept what is worth doing: it goes on
            the <Link href="/tasks">board</Link>.
          </div>
        </div>
        <div className="rv-filters">
          <Seg<ReviewWhen> value={when} label="When it was raised" onChange={setWhen} options={whens.map((w): [ReviewWhen, string] => [w, `${REVIEW_WHEN_NAME[w]} ${count(w)}`])} />
          <Seg
            value={from}
            label="Whose"
            onChange={setFrom}
            options={[
              ["all", "Everyone's"],
              ["mine", "Mine"],
              ...(state.me.isOwner ? [] : logins.filter((p) => p.id !== `user:${state.me.id}`).map((p): [string, string] => [p.id, `${p.name.split(" ")[0]}'s`])),
            ]}
          />
        </div>
      </div>

      {shown.length > 0 && (
        <div className="bulk rv-bulk">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={all}
              ref={(box) => {
                if (box) box.indeterminate = ids.length > 0 && !all;
              }}
              onChange={() => setPicked(new Set(all ? [] : shown.map((g) => g.id)))}
            />
            {ids.length ? `${ids.length} of ${shown.length} selected` : "Select cards to act on several at once · shift-click for a range"}
          </label>
          {ids.length > 0 && (
            <div className="bulk-acts">
              <button className="btn primary" onClick={() => void decide("accept")}>
                Accept {ids.length}
              </button>
              <select className="f" value={reason} aria-label="Why they are not tickets" onChange={(e) => setReason(e.target.value as RejectReason)}>
                {REASONS.map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
              <button className="btn bad" onClick={() => void decide(reason)}>
                Reject {ids.length}
              </button>
              <button className="linkbtn" onClick={() => setPicked(new Set())}>
                Clear selection
              </button>
              <span className="muted" style={{ fontSize: 12.5 }}>
                Accepting several messages nobody. Assign from the board to tell someone.
              </span>
            </div>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div className="panel hint-panel">
          {waiting.length === 0 ? (
            <>
              <strong>Nothing to review.</strong> Requests in everyone&apos;s chats and emails, and action items from calls, show here as they come in.
            </>
          ) : (
            <>
              <strong>Nothing raised {REVIEW_WHEN_NAME[when].toLowerCase()}.</strong> {waiting.length} {waiting.length === 1 ? "other is" : "others are"} waiting:{" "}
              <button className="linkbtn" onClick={() => setWhen("all")}>
                show all
              </button>
              .
            </>
          )}
        </div>
      ) : (
        <div className="rv-list">
          {shown.map((g) => (
            <ReviewCard key={g.id} g={g} app={app} people={people} clients={clients} picked={picked.has(g.id)} onPick={(on, range) => pick(g.id, on, range)} />
          ))}
        </div>
      )}

      {setAside.length > 0 && (
        <details className="panel rv-aside">
          <summary>
            Set aside by the AI: {setAside.length} {setAside.length === 1 ? "message that is" : "messages that are"} not a task
          </summary>
          <p className="muted">The AI read each of these and was not sure it is a real task. If one is, put it back and it waits above like the rest.</p>
          <ul>
            {setAside.map((g) => (
              <li key={g.id}>
                <div>
                  <strong>{g.title}</strong>{" "}
                  <span className="muted">
                    · {g.source.label} · {g.source.from}&apos;s · AI: {g.confidence}% sure it is a task
                  </span>
                  {g.source.quote && <p className="tk-quote">{g.source.quote}</p>}
                </div>
                <button className="btn" onClick={() => void restoreReview(g.id)}>
                  Put back
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
