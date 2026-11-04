// The Calendly check. Read-only: keeps the booking links (event types), to pick Agency,
// Consulting or Sales for in Settings, and the calls booked through them, so a call Fathom
// recorded takes the line of the link it was booked through (see `lineFromCall`).
import { bookingKey } from "@/core/config";
import { calendlyMe, eventType, eventTypes, scheduledEvents } from "@/server/calendly";
import type { Fetch } from "@/server/slack";
import type { JobContext, JobResult } from "./runner";

const DAY = 86_400_000;
/** How far back the first read goes, and later ones: bookings moved or cancelled lately. */
const FIRST_DAYS = 90;
const AGAIN_DAYS = 14;
/** Bookings coming up are read too, so a call is known before it is recorded. */
const AHEAD_DAYS = 7;
/** Booking links not in the list (secret ones, or a teammate's) looked up one by one, at most. */
const MAX_LOOKUPS = 25;

export async function calendlyPull({ db, ownerId, now, cursor }: JobContext, token: string, fetchImpl: Fetch = fetch): Promise<JobResult> {
  const me = await calendlyMe(token, fetchImpl);
  const types = await eventTypes(token, me, fetchImpl);
  const events = await scheduledEvents(token, me, now - (cursor.read ? AGAIN_DAYS : FIRST_DAYS) * DAY, now + AHEAD_DAYS * DAY, fetchImpl);

  const linkOf = new Map<string, string>();
  for (const t of types) {
    const link = bookingKey(t.scheduling_url ?? "");
    if (!link) continue;
    linkOf.set(t.uri, link);
    await db.run(
      `insert into booking_types (owner_id, link, name, active, saved_at) values ($1, $2, $3, $4, $5)
       on conflict (owner_id, link) do update set name = excluded.name, active = excluded.active, saved_at = excluded.saved_at`,
      [ownerId, link, (t.name ?? "").trim() || link, t.active !== false, now],
    );
  }
  // A link Calendly no longer lists stays, for the picks made on it, as no longer offered.
  await db.run("update booking_types set active = false where owner_id = $1 and saved_at < $2", [ownerId, now]);
  const missing = [...new Set(events.map((e) => e.event_type).filter((u): u is string => Boolean(u) && !linkOf.has(u!)))].slice(0, MAX_LOOKUPS);
  for (const uri of missing) {
    const link = bookingKey((await eventType(token, uri, fetchImpl).catch(() => null))?.scheduling_url ?? "");
    if (link) linkOf.set(uri, link);
  }

  const rows = events.map((e) => ({
    id: e.uri.split("/").pop() ?? e.uri,
    link: e.event_type ? (linkOf.get(e.event_type) ?? null) : null,
    name: (e.name ?? "").trim().slice(0, 200) || null,
    start_at: Date.parse(e.start_time),
    end_at: Date.parse(e.end_time),
    hosts: [...new Set((e.event_memberships ?? []).map((m) => (m.user_email ?? "").trim().toLowerCase()).filter(Boolean))],
    active: e.status !== "canceled",
  }));
  if (rows.length) {
    await db.run(
      `insert into bookings (owner_id, id, link, name, start_at, end_at, hosts, active, saved_at)
       select $1, r.id, r.link, r.name, r.start_at, r.end_at, array(select jsonb_array_elements_text(r.hosts)), r.active, $3
       from jsonb_to_recordset($2::jsonb) as r(id text, link text, name text, start_at bigint, end_at bigint, hosts jsonb, active boolean)
       on conflict (owner_id, id) do update set link = excluded.link, name = excluded.name, start_at = excluded.start_at, end_at = excluded.end_at, hosts = excluded.hosts, active = excluded.active, saved_at = excluded.saved_at`,
      [ownerId, JSON.stringify(rows), now],
    );
  }
  const booked = rows.filter((r) => r.active).length;
  return {
    items: rows.length,
    cursor: { ...cursor, read: true },
    message: `${booked} ${booked === 1 ? "booking" : "bookings"} from ${linkOf.size} booking ${linkOf.size === 1 ? "link" : "links"}${rows.length > booked ? `, ${rows.length - booked} cancelled` : ""}`,
  };
}
