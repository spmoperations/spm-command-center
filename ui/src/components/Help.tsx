"use client";

// "How it works": a short guide to each tab in plain words, opened from the button in the
// header. The guide that opens is the one for the tab on screen; the others are a click away.

import { useEffect, useState } from "react";
import { INBOX_DAYS } from "@/core/config";

type Guide = { title: string; intro: string; parts: { head: string; body: React.ReactNode }[]; flow?: boolean };

/** The path from a message to a finished task, as five steps in a row. */
function Flow() {
  const steps = ["Spotted", "AI check", "Review", "Board", "Told"];
  return (
    <ol className="help-flow" aria-label="From a message to a finished task">
      {steps.map((s, k) => (
        <li key={s} className={s === "AI check" ? "paused" : ""}>
          <span className="help-flow-n">{k + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

/** How someone is told a task is theirs: the same on the Review tab and the board. */
const TOLD = (
  <>
    <p>
      When you give a task to someone on the team list, a line appears under their name, such as <em>Tell Luis, from your own account, on ☑ Slack ☐ Telegram</em>.
    </p>
    <ul>
      <li>Only the apps they have linked are shown. Slack is ticked if they have it, otherwise Telegram. Tick both, or untick both to tell nobody.</li>
      <li>The message goes from your own Slack or Telegram. If yours is not connected yet, you are asked to connect it first, or to untick it.</li>
      <li>Jeremy and Alex are never messaged about their own tasks: they see them on the board.</li>
      <li>Afterwards the task&apos;s history says, for example, &quot;told on Slack&quot;, and the opened task shows whether the message was sent.</li>
    </ul>
  </>
);

const GUIDES: Record<string, Guide> = {
  today: {
    title: "Today",
    intro: "Your day at a glance: what needs an answer, what is due, and what you want to get done.",
    parts: [
      { head: "Needs a reply", body: <p>The most urgent messages still waiting for you: high priority and not answered yet. Click one to open it in the Inbox and reply.</p> },
      { head: "Tasks due today", body: <p>Your tasks that are due today or overdue, and the ones you have given to someone that are due. Tick a task when it is done.</p> },
      { head: "Focus", body: <p>A short list of what you want to get done today and this week. It is yours only: add a line, tick it off.</p> },
      { head: "Quick links", body: <p>The links you open often, one click away.</p> },
      { head: "Flagged this week", body: <p>How many requests and call action items were found this week. The Review link takes you to them.</p> },
    ],
  },
  inbox: {
    title: "Inbox",
    intro: "Your Slack and Telegram conversations that need you, sorted by how urgent they are.",
    parts: [
      { head: "Priority", body: <p>Each conversation is High, Medium or Low, decided by the sorting rules in Settings. Change it by hand and your choice stays.</p> },
      {
        head: "Replying",
        body: (
          <p>
            Click <strong>Reply</strong> to read the conversation and answer. The answer goes from your own Slack or Telegram. In Slack you can answer inside a thread, and paste or drop a screenshot
            to send it too.
          </p>
        ),
      },
      {
        head: "What leaves the inbox",
        body: (
          <p>
            A chat you have answered is cleared after the next check, and one with nothing new for {INBOX_DAYS} days is cleared by itself. A new message brings it back. You can look at what was
            cleared, and put a chat back.
          </p>
        ),
      },
      {
        head: "Make task, Assign, Done",
        body: (
          <ul>
            <li>
              <strong>Make task</strong> puts a task on the board for you, due today.
            </li>
            <li>
              <strong>Assign</strong> gives it to someone on the team and tells them on Slack.
            </li>
            <li>
              <strong>Done</strong> clears the chat. A new message brings it back.
            </li>
          </ul>
        ),
      },
      { head: "Several at once", body: <p>Tick the box on several rows, or the one above the list for all of them, to mark them done or set their priority together.</p> },
    ],
  },
  emails: {
    title: "Emails",
    intro: "The emails that arrive in your connected Gmail, one row per conversation, from the day the account was connected.",
    parts: [
      {
        head: "The views",
        body: (
          <ul>
            <li>
              <strong>Must respond</strong>: a person wrote to you and is waiting for your answer.
            </li>
            <li>
              <strong>Payments</strong>: money still to pay: an invoice or bill, a payment due or failed, a subscription that renews or ends.
            </li>
            <li>
              <strong>Newsletters</strong>: mailings and Gmail&apos;s Promotions, Social and Forums tabs.
            </li>
            <li>
              <strong>Other</strong>: everything else.
            </li>
          </ul>
        ),
      },
      {
        head: "Reading and replying",
        body: (
          <p>
            Click <strong>Reply</strong>: the email&apos;s text shows at once, then the email as it was sent. Your answer goes from your Gmail into the same conversation; <strong>Reply all</strong>{" "}
            includes everyone on it. <strong>New email</strong> writes one from scratch, and <strong>Open in Gmail</strong> opens it there.
          </p>
        ),
      },
      { head: "Several at once", body: <p>Tick several rows to mark them done, put them back, or set their priority together.</p> },
    ],
  },
  meetings: {
    title: "Meetings",
    intro: "Your recorded calls from Fathom: what was said, and what was agreed.",
    parts: [
      { head: "Each call", body: <p>The notes Fathom wrote, the action items, and the full transcript when you open it. Open the recording links to the call in Fathom.</p> },
      { head: "Action items", body: <p>Each open action item goes to the Review tab, with the person Fathom gave it to, so it can become a task on the board.</p> },
      { head: "Today's meetings", body: <p>With Google connected, today&apos;s meetings come first, each with its Join link.</p> },
    ],
  },
  calendar: {
    title: "Calendar",
    intro: "Your Google Calendar, week by week, from last week to three weeks ahead.",
    parts: [
      {
        head: "Adding an event",
        body: (
          <p>
            Click <strong>New event</strong>, or an empty time, for a title, time, guests and a Google Meet link. Google sends the guests its invitation.
          </p>
        ),
      },
      {
        head: "Changing one",
        body: (
          <p>
            Click one of your own events to edit or delete it; the guests are told. For someone else&apos;s invitation, answer <strong>Going? Yes / Maybe / No</strong>.
          </p>
        ),
      },
      { head: "More than one account", body: <p>Each connected Google account has its own color, and can be hidden.</p> },
    ],
  },
  review: {
    title: "Review",
    intro: "What the Command Center found this week that might be a task, from everyone's chats, emails and calls. Nothing becomes a task until someone here says so.",
    flow: true,
    parts: [
      {
        head: "Where these come from",
        body: (
          <p>
            About every 15 minutes, messages that ask Jeremy or Alex for something and have no reply yet are spotted, along with action items from recorded calls. An AI then reads each message and
            keeps only real tasks, with a clear title, who it is for, and how sure it is. The AI is paused while its account is out of credit: until then, everything spotted shows here, marked
            &quot;Not checked by the AI yet&quot;.
          </p>
        ),
      },
      {
        head: "What you can do with each card",
        body: (
          <ul>
            <li>
              <strong>Accept</strong>: it becomes a numbered task on the board, for the person shown.
            </li>
            <li>
              <strong>Edit</strong>: change the title, description, who it is for, the client, the due date or the status first.
            </li>
            <li>
              <strong>Merge</strong>: it is the same as a task already on the board. Its words are added to that task, and no second task is made.
            </li>
            <li>
              <strong>Reject</strong>: say why: not a task, a duplicate, already done, the wrong person, chit-chat, or something else.
            </li>
          </ul>
        ),
      },
      {
        head: "Who it is for, and the client",
        body: (
          <p>
            Type a name: anyone with a Command Center login, anyone on the team list, anyone in Slack, or anyone in your Telegram chats. Type a client and press Enter to add a new one; it can be
            picked next time.
          </p>
        ),
      },
      { head: "How someone is told", body: TOLD },
      { head: "Set aside by the AI", body: <p>What the AI decided is not a task is listed at the bottom. If it got one wrong, click Put back.</p> },
    ],
  },
  tasks: {
    title: "Tasks",
    intro: "The team's board: every task, who has it, and where it stands. Jeremy and Alex see the same board.",
    flow: true,
    parts: [
      {
        head: "The columns",
        body: (
          <p>
            <strong>Open</strong>, <strong>In progress</strong>, <strong>Waiting</strong> (on someone else) and <strong>Done</strong>. Drag a task to another column, or change its status on the card.
            Each task has a number, like SPM-12, to refer to it in Slack.
          </p>
        ),
      },
      { head: "By person", body: <p>Shows each person&apos;s tasks together, with how many are open, overdue or waiting: the easiest way to follow up with whoever has what.</p> },
      {
        head: "A task opened",
        body: (
          <p>
            Click a task to change anything about it, read the line it came from with a link to the original, see the messages sent about it, and its history: who made it, who it went to, and what
            changed.
          </p>
        ),
      },
      { head: "New task", body: <p>Adds one by hand, for anyone, with a client and a due date.</p> },
      { head: "How someone is told", body: TOLD },
    ],
  },
  connections: {
    title: "Connections",
    intro: "Where each person connects their own accounts. What you connect is yours: nobody else sees your messages.",
    parts: [
      {
        head: "The apps",
        body: (
          <ul>
            <li>
              <strong>Slack</strong>: Connect Slack, then Allow. Or paste a token, as the steps on its card say.
            </li>
            <li>
              <strong>Telegram</strong>: your phone number, then the code Telegram sends you.
            </li>
            <li>
              <strong>Fathom</strong>: your Fathom API key; the steps show where to find it.
            </li>
            <li>
              <strong>Google</strong>: Connect Google, pick the account, Allow. Add more than one account if you use several.
            </li>
          </ul>
        ),
      },
      { head: "Disconnecting", body: <p>Each card can be disconnected at any time. Nothing is changed in Slack, Telegram, Fathom or Gmail by disconnecting.</p> },
    ],
  },
  settings: {
    title: "Settings",
    intro: "How often things are checked, who is on the team, and how messages are sorted.",
    parts: [
      { head: "Sync", body: <p>Each check runs on its own timer. Change how often, run one now, or click Sync now to run them all.</p> },
      { head: "Slack channels", body: <p>The channels to follow. A message there shows in your Inbox; one that tags you always does.</p> },
      { head: "Important", body: <p>Chats and people that always count as high priority.</p> },
      { head: "Team and responsibilities", body: <p>The team list everyone assigns from, with each person&apos;s Slack and Telegram, so a task can reach them.</p> },
      { head: "Team logins", body: <p>Jeremy only: who else can sign in to the Command Center, such as Alex.</p> },
      { head: "Sorting rules", body: <p>The rules that decide how urgent a message is. They run top to bottom, and the first that matches wins.</p> },
    ],
  },
};

/** Which guide a page has: the tab's own, by its address. */
function guideFor(pathname: string): string {
  const first = pathname.split("/")[1] ?? "";
  return first === "" ? "today" : first in GUIDES ? first : "today";
}

/** The button in the header, and the guide it opens for the tab on screen. */
export function HelpButton({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const guide = open ? GUIDES[open] : null;
  return (
    <>
      <button className="help-btn" aria-haspopup="dialog" aria-expanded={Boolean(open)} title={`How the ${GUIDES[guideFor(pathname)].title} tab works`} onClick={() => setOpen(guideFor(pathname))}>
        <span aria-hidden="true">?</span> How it works
      </button>
      {guide && open && (
        <div className="help-back" role="presentation" onClick={() => setOpen(null)}>
          <aside className="help-panel" role="dialog" aria-modal="true" aria-label={`How the ${guide.title} tab works`} onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span className="eyebrow">How it works</span>
              <button className="linkbtn" onClick={() => setOpen(null)} aria-label="Close">
                ✕
              </button>
            </div>
            <h2>{guide.title}</h2>
            <p className="help-intro">{guide.intro}</p>
            {guide.flow && <Flow />}
            {guide.parts.map((part) => (
              <section key={part.head} className="help-part">
                <h3>{part.head}</h3>
                {part.body}
              </section>
            ))}
            <nav className="help-other" aria-label="The other tabs">
              <span className="muted">Other tabs:</span>
              {Object.entries(GUIDES)
                .filter(([key]) => key !== open)
                .map(([key, g]) => (
                  <button key={key} className="linkbtn" onClick={() => setOpen(key)}>
                    {g.title}
                  </button>
                ))}
            </nav>
          </aside>
        </div>
      )}
    </>
  );
}
