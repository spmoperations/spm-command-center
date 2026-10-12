// A small client for Fathom's API. Read-only: it lists recorded calls with their summary,
// transcript and action items.
import { RateLimited, type Fetch } from "./slack";

const BASE = "https://api.fathom.ai/external/v1";

export interface FathomPerson {
  name?: string | null;
  email?: string | null;
}

export interface FathomMeeting {
  title?: string | null;
  meeting_title?: string | null;
  url?: string | null;
  share_url?: string | null;
  meeting_url?: string | null;
  created_at: string;
  recording_id: number;
  recording_start_time?: string | null;
  recording_end_time?: string | null;
  scheduled_start_time?: string | null;
  transcript?: { speaker?: { display_name?: string | null } | null; text?: string | null; timestamp?: string | null }[] | null;
  default_summary?: { markdown_formatted?: string | null } | null;
  action_items?: { description?: string | null; completed?: boolean | null; assignee?: FathomPerson | null }[] | null;
  calendar_invitees?: (FathomPerson & { is_external?: boolean | null })[] | null;
  recorded_by?: FathomPerson | null;
}

export class FathomError extends Error {
  constructor(public status: number, detail: string) {
    super(`Fathom answered ${status}: ${detail}`);
  }
}

export interface FathomPage {
  items: FathomMeeting[];
  next_cursor: string | null;
}

/** One page of calls created after `createdAfter` (ISO time), oldest details included. */
export async function listMeetings(apiKey: string, opts: { createdAfter?: string; cursor?: string | null; full?: boolean }, fetchImpl: Fetch = fetch): Promise<FathomPage> {
  const params = new URLSearchParams();
  if (opts.createdAfter) params.set("created_after", opts.createdAfter);
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.full !== false) {
    params.set("include_summary", "true");
    params.set("include_transcript", "true");
    params.set("include_action_items", "true");
  }
  const res = await fetchImpl(`${BASE}/meetings?${params}`, { headers: { "X-Api-Key": apiKey } });
  if (res.status === 429) throw new RateLimited("Fathom", Number(res.headers.get("ratelimit-reset") ?? res.headers.get("retry-after") ?? 60));
  if (!res.ok) throw new FathomError(res.status, (await res.text()).slice(0, 200));
  const data = (await res.json()) as { items?: FathomMeeting[]; next_cursor?: string | null };
  return { items: data.items ?? [], next_cursor: data.next_cursor ?? null };
}

/** Checks a key and says whose calls it shows. Used when connecting, before anything is stored. */
export async function verifyFathomKey(apiKey: string, fetchImpl: Fetch = fetch) {
  const page = await listMeetings(apiKey, { full: false }, fetchImpl);
  const who = page.items[0]?.recorded_by;
  return { label: who?.name ?? who?.email ?? "Connected", email: who?.email ?? null };
}
