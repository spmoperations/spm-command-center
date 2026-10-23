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

/** The four parts every guide has, in the same order, so each one reads the same way. */
const FOR = "What this page is for";
const FROM = "Where it comes from";
const CAN = "What you can do";
const KNOW = "Good to know";

const GUIDES: Record<string, Guide> = {
  today: {
    title: "Today",
    intro: "The first page of the day: what needs an answer now, what is due, and what you want to get done.",
    parts: [
      { head: FOR, body: <p>A short view of the day, so nothing urgent waits until you happen to open the right tab.</p> },
      {
        head: FROM,
        body: (
          <ul>
            <li>
              <strong>Needs a reply</strong>: the high-priority messages from the Inbox that nobody has answered yet.
            </li>
            <li>
              <strong>Tasks due today</strong>: your tasks on the board that are due today or overdue, and the ones you gave to someone that are due.
            </li>
            <li>
              <strong>Focus</strong> and <strong>Quick links</strong>: what you type in yourself.
            </li>
          </ul>
        ),
      },
      {
        head: CAN,
        body: (
          <ul>
            <li>Click a waiting message to open it in the Inbox and reply.</li>
            <li>Tick a task when it is done.</li>
            <li>Add a focus for today or for this week, tick it off, or remove it.</li>
            <li>Add a quick link (the text to show and the address), or remove one.</li>
          </ul>
        ),
      },
      { head: KNOW, body: <p>Focus and quick links are yours only. The line about what was flagged this week links to the Review tab.</p> },
    ],
  },
  inbox: {
    title: "Inbox",
    intro: "Every Slack and Telegram conversation that needs you, the most urgent first, answered without leaving the page.",
    parts: [
      { head: FOR, body: <p>One list instead of two apps: read a chat, answer it, turn it into a task, or hand it to someone.</p> },
      {
        head: FROM,
        body: (
          <p>
            Your connected Slack and Telegram, checked about every 15 minutes (or straight away with Sync now in Settings): direct messages, group chats, the Slack channels you follow, and any message
            that tags you. Each conversation is High, Medium or Low, set by the sorting rules and the Important list in Settings.
          </p>
        ),
      },
      {
        head: CAN,
        body: (
          <ul>
            <li>
              <strong>Reply</strong>: read the whole conversation and answer, from your own Slack or Telegram. In Slack you can answer inside a thread, and paste or drop a screenshot to send it too.
            </li>
            <li>
              <strong>Make task</strong>: puts a task on the board for you, due today, and clears the chat.
            </li>
            <li>
              <strong>Assign</strong>: makes a task for someone on the team and tells them on Slack.
            </li>
            <li>
              <strong>Done</strong>: clears the chat. Change its priority with the list beside it; your choice stays.
            </li>
            <li>Show only Slack or only Telegram, and tick several chats to mark them done or set their priority together.</li>
            <li>
              <strong>Restore</strong>: see what was cleared, read it, or put it back.
            </li>
          </ul>
        ),
      },
      {
        head: KNOW,
        body: (
          <p>
            A chat you have answered is cleared after the next check, and one with nothing new for {INBOX_DAYS} days is cleared by itself. A new message brings it back. Pictures sent in Slack show
            once the Slack app is allowed to read files.
          </p>
        ),
      },
    ],
  },
  emails: {
    title: "Emails",
    intro: "Your Gmail, sorted into what needs you: emails to answer, money to pay, newsletters, and the rest.",
    parts: [
      { head: FOR, body: <p>Seeing at a glance which emails need you, without going through the whole inbox in Gmail.</p> },
      {
        head: FROM,
        body: <p>Each Gmail account connected on the Connections tab. Emails come in from the day the account was connected, checked about every 15 minutes, one row per conversation.</p>,
      },
      {
        head: "The views",
        body: (
          <ul>
            <li>
              <strong>Must respond</strong>: a person wrote to you, you are in To, it is in Gmail&apos;s Primary tab, and they wrote last. Company addresses (billing@, support@, no-reply@), payment
              services and calendar invitations do not count. Answering clears it.
            </li>
            <li>
              <strong>Payments</strong>: money still to pay: an invoice or bill, a payment due or overdue, a payment or card that failed, or a subscription about to renew or end. Receipts, refunds and
              payouts are already settled, so they are not here.
            </li>
            <li>
              <strong>Newsletters</strong>: mailings, and Gmail&apos;s Promotions, Social and Forums tabs. Notices from tools, receipts and invitations are not newsletters.
            </li>
            <li>
              <strong>Other</strong>: everything else, such as notices from tools, calendar invitations, receipts, and emails you are only copied on.
            </li>
          </ul>
        ),
      },
      {
        head: CAN,
        body: (
          <ul>
            <li>Search by sender, subject or words in the email, and pick one account when you have several.</li>
            <li>
              <strong>Reply</strong>: the email&apos;s text shows at once, then the email as it was sent. The answer goes from that Gmail account into the same conversation; <strong>Reply all</strong>{" "}
              includes everyone on it.
            </li>
            <li>
              <strong>New email</strong> writes one from scratch; <strong>Open in Gmail</strong> opens the conversation there.
            </li>
            <li>Mark done, set the priority, or tick several to do it to all of them.</li>
          </ul>
        ),
      },
      { head: KNOW, body: <p>Nothing is archived, deleted or marked as read in Gmail. Sorting is plain rules, the same for everyone.</p> },
    ],
  },
  meetings: {
    title: "Meetings",
    intro: "Your recorded calls and what was agreed on them, and today's meetings to join.",
    parts: [
      { head: FOR, body: <p>Keeping what was said and promised on a call, so nothing agreed on a call is forgotten afterwards.</p> },
      {
        head: FROM,
        body: (
          <ul>
            <li>
              <strong>Fathom</strong>: each recorded call, with its notes, its action items and the full transcript.
            </li>
            <li>
              <strong>Google Calendar</strong>: today&apos;s meetings, at the top, each with its Join link.
            </li>
          </ul>
        ),
      },
      {
        head: CAN,
        body: (
          <ul>
            <li>Join today&apos;s meetings from their link.</li>
            <li>Read a call&apos;s notes, and open its transcript.</li>
            <li>Tick off your tasks from a call, and add or dismiss the ones suggested from it.</li>
            <li>
              <strong>Follow up</strong> on an item someone else took on the call: it adds a task to chase them.
            </li>
          </ul>
        ),
      },
      { head: KNOW, body: <p>Every open action item from a call also goes to the Review tab, with the person Fathom gave it to, so it can become a task on the board.</p> },
    ],
  },
  calendar: {
    title: "Calendar",
    intro: "Your Google Calendar, week by week, and changes to it made right here.",
    parts: [
      { head: FOR, body: <p>Seeing your weeks next to your messages and tasks, and adding or answering meetings without switching to Google.</p> },
      { head: FROM, body: <p>The main calendar of each connected Google account, from last week to three weeks ahead, checked about every 30 minutes.</p> },
      {
        head: CAN,
        body: (
          <ul>
            <li>Move a week back or forward, and hide or show each account&apos;s calendar.</li>
            <li>
              <strong>New event</strong>, or click an empty time: a title, the date, the start time, how long, guests, a description and a Google Meet link. Google sends the guests its invitation.
            </li>
            <li>Click one of your own events to change it or delete it; the guests are told.</li>
            <li>
              For someone else&apos;s invitation, answer <strong>Yes</strong>, <strong>Maybe</strong> or <strong>No</strong>; Google tells the organizer.
            </li>
          </ul>
        ),
      },
      { head: KNOW, body: <p>Times show in your own timezone. Declined and cancelled events, and birthdays, are left out. A meeting not answered yet has a dashed outline.</p> },
    ],
  },
  review: {
    title: "Review",
    intro: "What the Command Center found this week that might be a task, from everyone's chats, emails and calls. Nothing becomes a task until someone here says so.",
    flow: true,
    parts: [
      { head: FOR, body: <p>Deciding, in one place, which of the requests and call action items are real tasks, who should do each, and by when.</p> },
      {
        head: FROM,
        body: (
          <>
            <p>About every 15 minutes, two things are flagged:</p>
            <ul>
              <li>a message to Jeremy or Alex, in Slack, Telegram or email, that asks for something and has had no reply;</li>
              <li>an open action item from a recorded call.</li>
            </ul>
            <p>
              An AI then reads each flagged message with the conversation around it and keeps only real tasks, with a clear title, who it is for, and how sure it is. The AI is paused while its account
              is out of credit; until then everything flagged shows here, marked &quot;Not checked by the AI yet&quot;. Only what was said this week, since Monday, is shown.
            </p>
          </>
        ),
      },
      {
        head: CAN,
        body: (
          <ul>
            <li>
              <strong>Accept</strong>: it becomes a numbered task on the board, for the person shown.
            </li>
            <li>
              <strong>Edit</strong>: change the title, description, who it is for, the client, the due date or the status first, then accept.
            </li>
            <li>
              <strong>Merge</strong>: it is the same as a task already on the board. Its words are added to that task, and no second task is made.
            </li>
            <li>
              <strong>Reject</strong>: say why: not a task, a duplicate, already done, the wrong person, chit-chat, or something else.
            </li>
            <li>Tick several cards (shift-click for a range) to accept or reject them together. Accepting several messages nobody.</li>
            <li>Show everyone&apos;s or only yours. A team login, such as Alex, can also show Jeremy&apos;s.</li>
          </ul>
        ),
      },
      {
        head: "Who it is for, and the client",
        body: (
          <p>
            Type a name: anyone with a Command Center login, anyone on the team list, anyone in Slack, or anyone in your Telegram chats. The client is a tag: pick one, or type a new client and press
            Enter to keep it for next time.
          </p>
        ),
      },
      { head: "How someone is told", body: TOLD },
      { head: KNOW, body: <p>What the AI decided is not a task is listed at the bottom, never deleted. If it got one wrong, click Put back.</p> },
    ],
  },
  tasks: {
    title: "Tasks",
    intro: "The team's board: every task, who has it, and where it stands. Jeremy and Alex see the same board.",
    flow: true,
    parts: [
      { head: FOR, body: <p>Keeping track of every task until it is done, and following up with whoever has it.</p> },
      { head: FROM, body: <p>Tasks accepted on the Review tab, tasks made from a chat or a call, and tasks added here by hand. Each has a number, like SPM-12, to mention it in Slack.</p> },
      {
        head: CAN,
        body: (
          <ul>
            <li>
              <strong>By status</strong>: four columns, Open, In progress, Waiting (on someone else) and Done. Drag a task to another column, change its status on the card, or tick it done.
            </li>
            <li>
              <strong>By person</strong>: each person&apos;s tasks together, with how many are open, overdue or waiting: the view for following up.
            </li>
            <li>Show everyone&apos;s tasks, yours, or one person&apos;s, and one client&apos;s.</li>
            <li>Click a task to change anything about it, read the line it came from with a link to the original, see the messages sent about it, and its history.</li>
            <li>
              <strong>+ New task</strong> adds one by hand, for anyone, with a client and a due date.
            </li>
          </ul>
        ),
      },
      { head: "How someone is told", body: TOLD },
      { head: KNOW, body: <p>Every change is written in the task&apos;s history: who made it, who it went to, and what changed, by whom and when.</p> },
    ],
  },
  connections: {
    title: "Connections",
    intro: "Where each person connects their own accounts, so the Command Center can read them and send replies as them.",
    parts: [
      { head: FOR, body: <p>Linking your Slack, Telegram, Fathom and Google to the Command Center. What you connect is yours: nobody else on the team sees your messages.</p> },
      {
        head: CAN,
        body: (
          <ul>
            <li>
              <strong>Slack</strong>: Connect Slack, then Allow. Or paste a token, as the steps on its card say.
            </li>
            <li>
              <strong>Telegram</strong>: your phone number, then the code Telegram sends you.
            </li>
            <li>
              <strong>Fathom</strong>: paste your Fathom API key; the steps show where to find it.
            </li>
            <li>
              <strong>Google</strong>: Connect Google, pick the account, Allow. Add another account the same way.
            </li>
            <li>Each card has step-by-step instructions with pictures, and a Disconnect button.</li>
          </ul>
        ),
      },
      {
        head: KNOW,
        body: (
          <p>
            Every person on the team connects their own accounts. Disconnecting stops the reading; nothing is changed in Slack, Telegram, Fathom or Gmail. Disconnecting Google also ends the login on
            Google&apos;s side.
          </p>
        ),
      },
    ],
  },
  settings: {
    title: "Settings",
    intro: "How the Command Center works for you and the team: how often it checks, what it follows, who is on the team, and how messages are sorted.",
    parts: [
      { head: FOR, body: <p>Adjusting how things are picked up and sorted. Most of it is set once and left alone.</p> },
      {
        head: "The sections",
        body: (
          <ul>
            <li>
              <strong>Sync</strong>: each check (Slack, Telegram, Gmail, Calendar, Fathom, the request finder, the AI check, sending) has its own timer. Switch one off, change how many minutes between
              runs, or run it now. Sync now runs them all.
            </li>
            <li>
              <strong>Slack channels</strong>: which channels to follow. Direct and group messages, and any message that tags you, are always read.
            </li>
            <li>
              <strong>Important</strong>: tick the Slack channels and people, and Telegram groups and people, that matter most. Their messages always come first, as High, marked Important.
            </li>
            <li>
              <strong>Team logins</strong> (Jeremy only): who else can sign in, such as Alex. Add one with a name, email and password, set a new password, turn a login off, or remove it.
            </li>
            <li>
              <strong>Team and responsibilities</strong>: the team list everyone assigns from, shared by the whole team. Pick each person&apos;s Slack account, and their Telegram, so a task can reach
              them; add what they are responsible for.
            </li>
            <li>
              <strong>Sorting rules</strong>: rules that decide how urgent a message is, such as &quot;anything in #client- channels is High&quot;. They run top to bottom; the first that matches wins.
            </li>
          </ul>
        ),
      },
      { head: KNOW, body: <p>A priority you set by hand in the Inbox always wins over the rules.</p> },
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
