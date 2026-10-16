// The Calendar check. Keeps a copy of the main Google Calendar of each connected account,
// from the start of last week to three weeks ahead, for the Calendar tab and for the meetings
// coming up on the Meetings tab. Reading only: nothing is changed in Google.
//
// Left out: events the owner declined, cancelled ones, birthdays and working-location
// markers. All-day events, focus time and out of office are kept, as Google Calendar shows them.
import { CALENDAR_SCOPE, GoogleSaid, type CalendarEvent, type GoogleAccount, type GoogleApi } from "@/server/google";
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
    };
  });
}

export async function calendarPull({ db, ownerId, now }: JobContext, accounts: GoogleAccount[], open: (email: string) => Promise<GoogleApi>): Promise<JobResult> {
  const rows: ReturnType<typeof toRows> = [];
  let found = 0;
  const signedOut: string[] = [];
  const reading = accounts.filter((a) => a.scopes.includes(CALENDAR_SCOPE));
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
    if (!rows.length) return;
    await tx.run(
      `insert into calendar_events (owner_id, account, id, title, start_at, end_at, all_day, kind, location, link, html_link, organizer, attendees, response, saved_at)
       select $1, r.account, r.id, r.title, r.start_at, r.end_at, r.all_day, r.kind, r.place, r.link, r.html_link, r.organizer, coalesce(r.attendees, '[]'), r.response, $3
       from jsonb_to_recordset($2::jsonb) as r(account text, id text, title text, start_at bigint, end_at bigint, all_day boolean, kind text, place text, link text, html_link text, organizer text, attendees jsonb, response text)
       on conflict (owner_id, account, id) do nothing`,
      [ownerId, JSON.stringify(rows), now],
    );
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
