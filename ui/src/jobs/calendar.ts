// The Calendar check. Keeps a copy of the main Google Calendar of each connected account,
// from the start of last week to three weeks ahead, for the Calendar tab and for the meetings
// coming up on the Meetings tab. The check only reads. Adding, changing, deleting and answering
// an event run when the person does so on the Calendar tab (`addCalendarEvent` and the rest).
//
// Left out: events the owner declined, cancelled ones, birthdays and working-location
// markers. All-day events, focus time and out of office are kept, as Google Calendar shows them.
import type { Db } from "@/server/db";
import { isEmailAddress } from "@/server/gmail";
import { hostedProblem } from "@/server/app-keys";
import { googleCan, GoogleSaid, type CalendarEvent, type GoogleAccount, type GoogleApi, type InviteAnswer, type NewEvent } from "@/server/google";
import { sendingEnabled } from "@/server/repo";
import { PLACES } from "./fathom";
import type { JobContext, JobResult } from "./runner";

const DAY = 86_400_000;
/** Far enough back and ahead to cover last week and the next three, wherever the owner is. */
const BEHIND = 15 * DAY;
const AHEAD = 30 * DAY;
const LEFT_OUT = new Set(["workingLocation", "birthday"]);

/** Where to join: the Meet link, another video link the event carries, or a link typed as its location. */
export function joinLink(e: CalendarEvent): string | null {
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video" && p.uri)?.uri;
  const typed = /^https:\/\/\S+$/.test((e.location ?? "").trim()) ? e.location!.trim() : null;
  return e.hangoutLink ?? video ?? typed ?? null;
}

/** "Google Meet", "Zoom" or "Teams" by the link; otherwise the location as written. */
export function placeOf(link: string | null, location: string | undefined): string {
  const named = link ? PLACES.find(([pattern]) => pattern.test(link))?.[1] : undefined;
  if (named) return named;
  const where = (location ?? "").trim();
  return /^https?:\/\//.test(where) ? "Online" : where;
}

/** The owner's own answer to the invite. An event they made themselves counts as accepted. */
const answerOf = (e: CalendarEvent) => e.attendees?.find((a) => a.self)?.responseStatus ?? "accepted";

/** An event the Calendar tab shows. */
export function isShown(e: CalendarEvent): boolean {
  if (e.status === "cancelled" || LEFT_OUT.has(e.eventType ?? "default")) return false;
  const timed = Boolean(e.start?.dateTime && e.end?.dateTime);
  const allDay = Boolean(e.start?.date && e.end?.date);
  return (timed || allDay) && answerOf(e) !== "declined";
}

/** Midnight UTC of a "2026-10-15" date, which is how an all-day event is kept. */
const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** One account's events as the rows that are kept. */
export function toRows(account: string, items: CalendarEvent[]) {
  return items.filter(isShown).map((e) => {
    const link = joinLink(e);
    const allDay = !e.start?.dateTime;
    const others = (e.attendees ?? [])
      .filter((a) => !a.self && !a.resource)
      .map((a) => ({ name: a.displayName || a.email || "", email: a.email ?? "", response: a.responseStatus ?? "" }))
      .filter((a) => a.name);
    return {
      account,
      id: e.id,
      title: (e.summary ?? "").trim() || "(no title)",
      start_at: allDay ? dayStart(e.start!.date!) : Date.parse(e.start!.dateTime!),
      end_at: allDay ? dayStart(e.end!.date!) : Date.parse(e.end!.dateTime!),
      all_day: allDay,
      kind: e.eventType ?? "default",
      place: placeOf(link, e.location),
      link,
      html_link: e.htmlLink ?? null,
      organizer: e.organizer?.self ? null : e.organizer?.displayName || e.organizer?.email || null,
      attendees: others,
      response: answerOf(e),
      // An event with no organizer named is one the owner made on their own calendar.
      mine: e.organizer ? Boolean(e.organizer.self) : true,
      description: (e.description ?? "").slice(0, 4000) || null,
      recurring: Boolean(e.recurringEventId),
    };
  });
}

/** Keeps these rows, replacing what was kept for the same events. */
async function saveRows(db: Db, ownerId: string, rows: ReturnType<typeof toRows>, now: number): Promise<void> {
  if (!rows.length) return;
  await db.run(
    `insert into calendar_events (owner_id, account, id, title, start_at, end_at, all_day, kind, location, link, html_link, organizer, attendees, response, mine, description, recurring, saved_at)
     select $1, r.account, r.id, r.title, r.start_at, r.end_at, r.all_day, r.kind, r.place, r.link, r.html_link, r.organizer, coalesce(r.attendees, '[]'), r.response, coalesce(r.mine, false), r.description, coalesce(r.recurring, false), $3
     from jsonb_to_recordset($2::jsonb) as r(account text, id text, title text, start_at bigint, end_at bigint, all_day boolean, kind text, place text, link text, html_link text, organizer text, attendees jsonb, response text, mine boolean, description text, recurring boolean)
     on conflict (owner_id, account, id) do update set title = excluded.title, start_at = excluded.start_at, end_at = excluded.end_at, all_day = excluded.all_day, kind = excluded.kind,
       location = excluded.location, link = excluded.link, html_link = excluded.html_link, organizer = excluded.organizer, attendees = excluded.attendees, response = excluded.response,
       mine = excluded.mine, description = excluded.description, recurring = excluded.recurring, saved_at = excluded.saved_at`,
    [ownerId, JSON.stringify(rows), now],
  );
}

/** What the New event form sends. */
export interface EventForm {
  account: string;
  title: string;
  start: number;
  end: number;
  timeZone: string;
  guests: string;
  meet: boolean;
  description?: string;
}

const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * Changes to a calendar reach other people (an invitation, a change, a cancellation, an
 * answer), so they need sending switched on, like replies, and an account that allowed it.
 */
async function mayChange(db: Db, ownerId: string, account: string): Promise<void> {
  if (!sendingEnabled()) throw new GoogleSaid("Sending is switched off (SENDING_ENABLED), so nothing is changed in Google Calendar and nobody is told.");
  const [row] = !hostedProblem("google") ? await db.query<{ scopes: string }>("select scopes from google_accounts where owner_id = $1 and email = $2", [ownerId, account]) : [];
  if (!row) throw new GoogleSaid(`${account} is not connected. Connect it on the Connections tab.`);
  if (!googleCan(row.scopes.split(",")).addEvents) throw new GoogleSaid(`Changing events was not allowed for ${account}. Connect it again on the Connections tab and allow it.`);
}

/** The form as Google takes it, or what is wrong with it, in words for the person. */
function checkForm(form: EventForm): NewEvent {
  const title = String(form.title ?? "").trim();
  if (!title) throw new GoogleSaid("Give the event a title.");
  const start = Number(form.start);
  const end = Number(form.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new GoogleSaid("The event has to end after it starts.");
  if (end - start > 14 * DAY) throw new GoogleSaid("An event can be at most two weeks long.");
  const guests: string[] = [];
  for (const part of String(form.guests ?? "").split(/[,;\s]+/).map((g) => g.trim().toLowerCase()).filter(Boolean)) {
    if (!isEmailAddress(part)) throw new GoogleSaid(`"${part}" is not an email address.`);
    if (part !== form.account.toLowerCase() && !guests.includes(part)) guests.push(part);
  }
  return { title, start, end, timeZone: validZone(form.timeZone) ? form.timeZone : "UTC", guests, meet: Boolean(form.meet), description: String(form.description ?? "").trim() || undefined };
}

/** The kept copy of one event, to check what may be done with it. */
async function keptEvent(db: Db, ownerId: string, account: string, eventId: string): Promise<{ mine: boolean; title: string }> {
  const [row] = await db.query<{ mine: boolean; title: string }>("select mine, title from calendar_events where owner_id = $1 and account = $2 and id = $3", [ownerId, account, eventId]);
  if (!row) throw new GoogleSaid("That event is no longer on the calendar here. Click Refresh and try again.");
  return row;
}

/**
 * Adds an event to one connected account's main calendar, as the person filled it in, and to
 * the copy the Calendar tab shows. Google sends the guests its own invitation.
 */
export async function addCalendarEvent(db: Db, ownerId: string, form: EventForm, open: (email: string) => Promise<GoogleApi>, now = Date.now()): Promise<{ title: string; link: string | null }> {
  await mayChange(db, ownerId, form.account);
  const event = checkForm(form);
  const made = await (await open(form.account)).addEvent(event);
  await saveRows(db, ownerId, toRows(form.account, [made]), now);
  return { title: event.title, link: joinLink(made) };
}

/** Changes an event the owner made. Its guests keep their answers and are told. One occurrence of a repeating event changes alone. */
export async function updateCalendarEvent(db: Db, ownerId: string, eventId: string, form: EventForm, open: (email: string) => Promise<GoogleApi>, now = Date.now()): Promise<{ title: string }> {
  await mayChange(db, ownerId, form.account);
  if (!(await keptEvent(db, ownerId, form.account, eventId)).mine) throw new GoogleSaid("Only whoever made an event can change it. Answer the invitation instead.");
  const event = checkForm(form);
  const changed = await (await open(form.account)).updateEvent(eventId, event);
  await saveRows(db, ownerId, toRows(form.account, [changed]), now);
  return { title: event.title };
}

/** Deletes an event the owner made. Its guests are told it is cancelled. */
export async function deleteCalendarEvent(db: Db, ownerId: string, account: string, eventId: string, open: (email: string) => Promise<GoogleApi>): Promise<{ title: string }> {
  await mayChange(db, ownerId, account);
  const kept = await keptEvent(db, ownerId, account, eventId);
  if (!kept.mine) throw new GoogleSaid("Only whoever made an event can delete it. Answer No to the invitation instead.");
  await (await open(account)).deleteEvent(eventId);
  await db.run("delete from calendar_events where owner_id = $1 and account = $2 and id = $3", [ownerId, account, eventId]);
  return { title: kept.title };
}

const ANSWERS: InviteAnswer[] = ["accepted", "tentative", "declined"];

/** Answers an invitation from someone else. A declined one leaves the calendar here, as it does in Google Calendar's list. */
export async function respondToEvent(db: Db, ownerId: string, account: string, eventId: string, answer: InviteAnswer, open: (email: string) => Promise<GoogleApi>, now = Date.now()): Promise<{ title: string; answer: InviteAnswer }> {
  if (!ANSWERS.includes(answer)) throw new GoogleSaid("Answer going, maybe or not going.");
  await mayChange(db, ownerId, account);
  const kept = await keptEvent(db, ownerId, account, eventId);
  if (kept.mine) throw new GoogleSaid("This is an event you made, so there is no invitation to answer.");
  const answered = await (await open(account)).respond(eventId, answer);
  const rows = toRows(account, [answered]);
  if (rows.length) await saveRows(db, ownerId, rows, now);
  else await db.run("delete from calendar_events where owner_id = $1 and account = $2 and id = $3", [ownerId, account, eventId]);
  return { title: kept.title, answer };
}

export async function calendarPull({ db, ownerId, now }: JobContext, accounts: GoogleAccount[], open: (email: string) => Promise<GoogleApi>): Promise<JobResult> {
  const rows: ReturnType<typeof toRows> = [];
  let found = 0;
  const signedOut: string[] = [];
  const reading = accounts.filter((a) => googleCan(a.scopes).calendar);
  for (const account of reading) {
    let google: GoogleApi;
    try {
      google = await open(account.email);
    } catch (error) {
      if (error instanceof GoogleSaid) {
        signedOut.push(account.email);
        continue;
      }
      throw error;
    }
    const { items } = await google.events(now - BEHIND, now + AHEAD);
    found += items.length;
    rows.push(...toRows(account.email, items));
  }

  // The copy is replaced as a whole: a meeting moved out of the window, or cancelled, is gone here too.
  await db.transaction(async (tx) => {
    await tx.run("delete from calendar_events where owner_id = $1", [ownerId]);
    await saveRows(tx, ownerId, rows, now);
  });

  // A meeting on two connected calendars is counted once.
  const once = (list: typeof rows) => new Set(list.map((r) => `${r.id}@${r.start_at}`)).size;
  const events = once(rows);
  const soon = once(rows.filter((r) => !r.all_day && r.kind === "default" && r.end_at > now && r.start_at < now + 2 * DAY));
  const calendars = reading.length - signedOut.length;
  const parts = [`${events} ${events === 1 ? "event" : "events"} from ${calendars} ${calendars === 1 ? "calendar" : "calendars"}, ${soon} ${soon === 1 ? "meeting" : "meetings"} in the next two days`];
  if (found > rows.length) parts.push(`${found - rows.length} left out: declined, cancelled and birthdays`);
  if (signedOut.length) parts.push(`connect again: ${signedOut.join(", ")}`);
  return { items: events, message: parts.join(". ") };
}
