// A small client for Calendly's API. Read-only: whose key it is, the booking links (event
// types), and the calls booked through them.
import { RateLimited, type Fetch } from "./slack";

const BASE = "https://api.calendly.com";
/** The most pages of 100 one list reads. */
const MAX_PAGES = 10;

export class CalendlyError extends Error {
  constructor(public status: number, detail: string) {
    super(`Calendly answered ${status}: ${detail}`);
  }
}

/** The person the key belongs to. */
export interface CalendlyUser {
  uri: string;
  name?: string | null;
  email?: string | null;
  current_organization?: string | null;
}

/** A booking link. */
export interface CalendlyEventType {
  uri: string;
  name?: string | null;
  scheduling_url?: string | null;
  active?: boolean | null;
}

/** A call booked through a link. */
export interface CalendlyEvent {
  uri: string;
  status?: string | null;
  start_time: string;
  end_time: string;
  event_type?: string | null;
  event_memberships?: { user_email?: string | null }[] | null;
}

async function get<T>(token: string, url: string, fetchImpl: Fetch): Promise<T> {
  // A whole address comes from Calendly's own answers (the next page, a booking link's); the key goes nowhere else.
  if (url.startsWith("https://") && !url.startsWith(`${BASE}/`)) throw new CalendlyError(0, "an address outside Calendly's API");
  const res = await fetchImpl(url.startsWith("https://") ? url : `${BASE}${url}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new RateLimited("Calendly", Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("retry-after") ?? 60) || 60);
  if (!res.ok) throw new CalendlyError(res.status, (await res.text()).slice(0, 200));
  return (await res.json()) as T;
}

export async function calendlyMe(token: string, fetchImpl: Fetch = fetch): Promise<CalendlyUser> {
  return (await get<{ resource: CalendlyUser }>(token, "/users/me", fetchImpl)).resource;
}

/**
 * Every page of a list, for the whole organization when the key may see it (an admin's), else
 * for the key's own person.
 */
async function listAll<T>(token: string, me: CalendlyUser, path: string, params: Record<string, string>, fetchImpl: Fetch): Promise<T[]> {
  const read = async (scope: Record<string, string>) => {
    const items: T[] = [];
    let url: string | null = `${path}?${new URLSearchParams({ ...scope, ...params, count: "100" })}`;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const found: { collection?: T[]; pagination?: { next_page?: string | null } } = await get(token, url, fetchImpl);
      items.push(...(found.collection ?? []));
      url = found.pagination?.next_page ?? null;
    }
    return items;
  };
  if (me.current_organization) {
    try {
      return await read({ organization: me.current_organization });
    } catch (error) {
      if (!(error instanceof CalendlyError && (error.status === 403 || error.status === 401))) throw error;
    }
  }
  return read({ user: me.uri });
}

export const eventTypes = (token: string, me: CalendlyUser, fetchImpl: Fetch = fetch) => listAll<CalendlyEventType>(token, me, "/event_types", {}, fetchImpl);

/** The calls booked to start between `from` and `to` (epoch milliseconds), cancelled ones too. */
export const scheduledEvents = (token: string, me: CalendlyUser, from: number, to: number, fetchImpl: Fetch = fetch) =>
  listAll<CalendlyEvent>(token, me, "/scheduled_events", { min_start_time: new Date(from).toISOString(), max_start_time: new Date(to).toISOString(), sort: "start_time:asc" }, fetchImpl);

/** One booking link by its address in the API, such as one that is no longer listed. */
export async function eventType(token: string, uri: string, fetchImpl: Fetch = fetch): Promise<CalendlyEventType> {
  return (await get<{ resource: CalendlyEventType }>(token, uri, fetchImpl)).resource;
}

/** Checks a key and says whose it is. Used when connecting, before anything is stored. */
export async function verifyCalendlyKey(token: string, fetchImpl: Fetch = fetch) {
  const me = await calendlyMe(token, fetchImpl);
  return { label: me.name || me.email || "Connected" };
}
