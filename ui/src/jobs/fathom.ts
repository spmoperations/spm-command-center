// Fathom job. Read-only: brings in recorded calls with their notes, transcript and action
// items. Action items Fathom assigned to the owner become suggested tasks, with no AI of ours.
import { addDays } from "@/core/dates";
import type { ActionItem } from "@/core/types";
import { listMeetings, type FathomMeeting } from "@/server/fathom";
import type { Fetch } from "@/server/slack";
import { uid } from "@/server/repo";
import type { JobContext, JobResult } from "./runner";

// How far back the first read goes, and how many pages of 10 calls one run may read.
// Both can be turned down in the environment while developing.
const BACKFILL_DAYS = Number(process.env.FATHOM_BACKFILL_DAYS ?? 7);
const MAX_PAGES = Number(process.env.FATHOM_MAX_PAGES ?? 5);
// Fathom action items carry no due date, so they start two days out and the owner adjusts.
const DEFAULT_DUE_DAYS = 2;

/** Where a call happens, by its link. */
export const PLACES: [RegExp, string][] = [[/zoom\./, "Zoom"], [/meet\.google\./, "Google Meet"], [/teams\.(microsoft|live)\./, "Teams"]];

const sameEmail = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Turns one Fathom call into the row we store. `ownerEmail` decides which action items are the owner's. */
export function toMeeting(m: FathomMeeting, ownerEmail: string | null) {
  const start = Date.parse(m.recording_start_time ?? m.scheduled_start_time ?? m.created_at);
  const end = m.recording_end_time ? Date.parse(m.recording_end_time) : start;
  const others = (m.calendar_invitees ?? []).filter((p) => !sameEmail(p.email, ownerEmail)).map((p) => p.name || p.email || "").filter(Boolean);
  const actionItems: ActionItem[] = (m.action_items ?? [])
    .filter((a) => a.description)
    .map((a) => ({ text: a.description!, who: a.assignee?.name || a.assignee?.email || "Unassigned", mine: sameEmail(a.assignee?.email, ownerEmail), done: Boolean(a.completed) }));
  return {
    externalId: String(m.recording_id),
    title: m.meeting_title || m.title || "Untitled call",
    startedAt: start,
    durationMin: Math.max(0, Math.round((end - start) / 60_000)),
    who: others.join(", "),
    place: PLACES.find(([pattern]) => pattern.test(m.meeting_url ?? ""))?.[1] ?? "",
    url: m.share_url ?? m.url ?? null,
    summary: m.default_summary?.markdown_formatted ?? "",
    transcript: (m.transcript ?? []).filter((l) => l.text).map((l): [string, string] => [l.speaker?.display_name || "Speaker", l.text!]),
    actionItems,
  };
}

export async function fathomPull({ db, ownerId, now, cursor }: JobContext, apiKey: string, fetchImpl: Fetch = fetch): Promise<JobResult> {
  const [owner] = await db.query<{ email: string | null }>("select email from users where id = $1", [ownerId]);
  const createdAfter = typeof cursor.createdAfter === "string" ? cursor.createdAfter : new Date(now - BACKFILL_DAYS * 86_400_000).toISOString();

  let newest = createdAfter;
  let calls = 0;
  let suggested = 0;
  let next: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listMeetings(apiKey, { createdAfter, cursor: next }, fetchImpl);
    for (const raw of res.items) {
      // The owner's address, learned from their own recordings, decides which action items are theirs.
      const ownerEmail = owner?.email ?? raw.recorded_by?.email ?? null;
      const m = toMeeting(raw, ownerEmail);
      const id = `fathom:${m.externalId}`;
      await db.run(
        `insert into meetings (id, owner_id, external_id, title, started_at, duration_min, who, place, url, summary, transcript, action_items)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (owner_id, id) do update set title = excluded.title, summary = excluded.summary, transcript = excluded.transcript, action_items = excluded.action_items, who = excluded.who, duration_min = excluded.duration_min`,
        [id, ownerId, m.externalId, m.title, m.startedAt, m.durationMin, m.who, m.place, m.url, m.summary, JSON.stringify(m.transcript), JSON.stringify(m.actionItems)],
      );
      calls++;
      for (const [k, item] of m.actionItems.entries()) {
        if (!item.mine || item.done) continue;
        suggested += await db.run(
          `insert into suggestions (id, owner_id, title, dept, pri, due, why, src_type, src_id, dedupe_key, created_at)
           values ($1, $2, $3, 'Operations', 'mid', $4, $5, 'meeting', $6, $7, $8) on conflict (owner_id, dedupe_key) do nothing`,
          [uid("s"), ownerId, item.text.slice(0, 160), addDays(new Date(m.startedAt), DEFAULT_DUE_DAYS), `Fathom listed this as your action item on "${m.title}".`, id, `${id}:action:${k}`, now],
        );
      }
      if (raw.created_at > newest) newest = raw.created_at;
    }
    next = res.next_cursor;
    if (!next) break;
  }
  return {
    items: calls,
    cursor: { createdAfter: newest },
    message: `${calls} ${calls === 1 ? "call" : "calls"}, ${suggested} suggested ${suggested === 1 ? "task" : "tasks"}${next ? ". More to read on the next run." : ""}`,
  };
}
