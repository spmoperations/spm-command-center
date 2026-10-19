// Google, through a person's own accounts: Gmail for the inbox and Calendar for the Calendar
// and Meetings tabs. More than one account can be connected. It reads, and it can send an
// email and add an event, both only when the person does so in the dashboard.
//
// Connecting is one button. The person is sent to Google's own page, picks an account and
// allows it; Google sends them back here with a one-time code, which is swapped for a lasting
// login (a refresh token). Each account's login is kept encrypted in `google_accounts`.
//
// As with Telegram, a developer's own account must not reach the hosted database: with it,
// Google stays off unless GOOGLE_HOSTED=true says this server is the one meant to hold it.
import crypto from "node:crypto";
import type { Db } from "./db";
import type { GmailThread } from "./gmail";
import { seal, unseal } from "./secrets";
import { RateLimited, type Fetch } from "./slack";

/** Read the mailbox. */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Send email as the account. It cannot read, change or delete anything. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Read the calendar's events. What accounts connected before events could be added have. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
/** Read, add, change and delete events, and answer invitations. */
export const CALENDAR_EDIT_SCOPE = "https://www.googleapis.com/auth/calendar.events";
/** What Connect Google asks for. */
export const GOOGLE_SCOPES = [GMAIL_SCOPE, GMAIL_SEND_SCOPE, CALENDAR_EDIT_SCOPE];
const KNOWN_SCOPES = [...GOOGLE_SCOPES, CALENDAR_SCOPE];

/** What an account may do, by what it allowed on Google's page. */
export const googleCan = (scopes: string[]) => ({
  gmail: scopes.includes(GMAIL_SCOPE),
  send: scopes.includes(GMAIL_SEND_SCOPE),
  calendar: scopes.includes(CALENDAR_SCOPE) || scopes.includes(CALENDAR_EDIT_SCOPE),
  addEvents: scopes.includes(CALENDAR_EDIT_SCOPE),
});

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";

/** The cookie that carries a login in progress from the Connect button to Google's answer. */
export const GOOGLE_LOGIN_COOKIE = "cc_google_login";
/** How long the person has on Google's page. */
const LOGIN_MINUTES = 10;

/** A setting as it was meant: a value pasted with quotes or spaces around it still counts. */
const setting = (name: string) => (process.env[name] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();

/** What is wrong with the app keys from Google Cloud, or null when both are in place. */
function keysProblem(): string | null {
  const id = setting("GOOGLE_CLIENT_ID");
  const secret = setting("GOOGLE_CLIENT_SECRET");
  const where = "Add them to the environment. On a host that means for Production, followed by a redeploy.";
  if (!id && !secret) return `Google's app keys are not set: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. ${where}`;
  if (!id) return `GOOGLE_CLIENT_ID is not set. GOOGLE_CLIENT_SECRET is. ${where}`;
  if (!secret) return `GOOGLE_CLIENT_SECRET is not set. GOOGLE_CLIENT_ID is. ${where}`;
  if (!id.endsWith(".apps.googleusercontent.com")) return "GOOGLE_CLIENT_ID does not look right. It is the Client ID of the OAuth client in Google Cloud, and ends with .apps.googleusercontent.com.";
  return null;
}

export const GOOGLE_OFF_HERE =
  "The app keys are in place, but Google is switched off while the app uses the hosted database. The live site turns it on with GOOGLE_HOSTED=true (on a host: for Production, followed by a redeploy). On your own machine, start the app with: npm run dev:local";

/** Why Google cannot be used here, in words for the person, or null when it can. */
export const googleBlocked = (): string | null =>
  keysProblem() ?? (process.env.DATABASE_URL && setting("GOOGLE_HOSTED").toLowerCase() !== "true" ? GOOGLE_OFF_HERE : null);

export const googleAvailable = () => googleBlocked() === null;

/** Something already put in words for the person. It is shown as it is. */
export class GoogleSaid extends Error {}

export class GoogleError extends Error {
  constructor(public status: number, detail: string) {
    super(`Google answered ${status}: ${detail}`);
  }
}

/** Gmail no longer has the history asked for: it keeps about a week. The check then looks by date instead. */
export class HistoryGone extends Error {}

// ---------- The saved logins ----------

/** A connected Google account, as the checks and the screens see it. Never the login itself. */
export interface GoogleAccount {
  email: string;
  scopes: string[];
  connectedAt: number;
  /** Where the mailbox stood when it was connected. Null when Gmail was not allowed. */
  startHistory: string | null;
}

interface Saved {
  refresh: string;
}

type AccountRow = { email: string; secret: string; scopes: string; start_history: string | null; connected_at: number };
const toAccount = (r: AccountRow): GoogleAccount => ({ email: r.email, scopes: r.scopes.split(",").filter(Boolean), connectedAt: Number(r.connected_at), startHistory: r.start_history });

/** The Google accounts connected here, in the order they were connected. None on a server that may not use Google. */
export async function googleAccounts(db: Db, ownerId: string): Promise<GoogleAccount[]> {
  if (!googleAvailable()) return [];
  const rows = await db.query<AccountRow>("select email, secret, scopes, start_history, connected_at from google_accounts where owner_id = $1 order by connected_at, email", [ownerId]);
  return rows.map(toAccount);
}

/** True when at least one Google account is connected here. */
export async function googleConnected(db: Db, ownerId: string): Promise<boolean> {
  return (await googleAccounts(db, ownerId)).length > 0;
}

async function savedLogin(db: Db, ownerId: string, email: string): Promise<(GoogleAccount & { login: Saved }) | null> {
  if (!googleAvailable()) return null;
  const [row] = await db.query<AccountRow>("select email, secret, scopes, start_history, connected_at from google_accounts where owner_id = $1 and email = $2", [ownerId, email]);
  return row ? { ...toAccount(row), login: JSON.parse(unseal(row.secret)) as Saved } : null;
}

const forgetLogin = (db: Db, ownerId: string, email: string) => db.run("delete from google_accounts where owner_id = $1 and email = $2", [ownerId, email]);

// ---------- Connecting ----------

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * Where to send the person to connect, and the cookie that remembers this login until Google
 * sends them back. `site` is the address the dashboard was opened at: Google sends them back
 * to the same one, which must be listed in the OAuth client in Google Cloud.
 */
export function startGoogleLogin(site: string, secure: boolean, now = Date.now()): { url: string; cookie: string } {
  const blocked = googleBlocked();
  if (blocked) throw new GoogleSaid(blocked);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const redirect = `${site}/api/google/callback`;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: setting("GOOGLE_CLIENT_ID"),
    redirect_uri: redirect,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // A lasting login, asked for again on every connect so Google always hands one over, and
    // the account chooser every time, so a second account can be added.
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  // Lax, not Strict: the way back from Google is a link from another site, and a Strict
  // cookie would not come with it.
  const cookie = `${GOOGLE_LOGIN_COOKIE}=${seal(JSON.stringify({ v: 1, state, verifier, redirect, at: now }))}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MINUTES * 60}${secure ? "; Secure" : ""}`;
  return { url: url.toString(), cookie };
}

export const clearedGoogleCookie = (secure: boolean) => `${GOOGLE_LOGIN_COOKIE}=; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

async function form(fetchImpl: Fetch, url: string, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Google's answer, after the person was on its page: the one-time code is swapped for the
 * lasting login, which is kept for that account. Connecting an account again replaces its
 * login. Answers with the connected address and what was allowed.
 */
export async function finishGoogleLogin(
  db: Db,
  ownerId: string,
  answer: URLSearchParams,
  cookie: string | undefined,
  fetchImpl: Fetch = fetch,
  now = Date.now(),
): Promise<{ email: string; scopes: string[] }> {
  const blocked = googleBlocked();
  if (blocked) throw new GoogleSaid(blocked);
  const again = "That Google login has timed out or did not start here. Click Connect Google again.";
  let pending: { v: number; state: string; verifier: string; redirect: string; at: number };
  try {
    pending = JSON.parse(unseal(cookie ?? ""));
  } catch {
    throw new GoogleSaid(again);
  }
  if (pending.v !== 1 || now - pending.at > LOGIN_MINUTES * 60_000 || now < pending.at) throw new GoogleSaid(again);
  const state = answer.get("state") ?? "";
  if (state.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new GoogleSaid(again);
  const refused = answer.get("error");
  if (refused) throw new GoogleSaid(refused === "access_denied" ? "Google was not allowed in, so nothing was connected." : `Google did not connect: ${refused}.`);
  const code = answer.get("code");
  if (!code) throw new GoogleSaid(again);

  const { status, body } = await form(fetchImpl, TOKEN_URL, {
    code,
    client_id: setting("GOOGLE_CLIENT_ID"),
    client_secret: setting("GOOGLE_CLIENT_SECRET"),
    redirect_uri: pending.redirect,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });
  if (status !== 200 || typeof body.access_token !== "string") {
    if (body.error === "invalid_client") throw new GoogleSaid("Google did not accept the app keys. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET against the OAuth client in Google Cloud.");
    if (body.error === "redirect_uri_mismatch") throw new GoogleSaid(`Google does not know this address. Add ${pending.redirect} to the OAuth client's Authorized redirect URIs in Google Cloud.`);
    throw new GoogleSaid(again);
  }
  if (typeof body.refresh_token !== "string") throw new GoogleSaid("Google did not hand over a lasting login. Click Connect Google again.");
  // The person may untick Gmail or Calendar on Google's page. What was allowed is kept, and shown.
  const scopes = String(body.scope ?? "").split(" ").filter((s) => KNOWN_SCOPES.includes(s));
  if (!scopes.length) {
    await revoke(fetchImpl, body.refresh_token);
    throw new GoogleSaid("Neither Gmail nor Calendar was allowed, so nothing was connected. Click Connect Google again and tick the boxes.");
  }

  const who = await whoIs(fetchImpl, body.access_token, scopes);
  if (!who.email) {
    await revoke(fetchImpl, body.refresh_token);
    throw new GoogleSaid("Google did not say which account this is, so nothing was connected. Click Connect Google again.");
  }
  await db.run(
    `insert into google_accounts (owner_id, email, secret, scopes, start_history, connected_at) values ($1, $2, $3, $4, $5, $6)
     on conflict (owner_id, email) do update set secret = excluded.secret, scopes = excluded.scopes, start_history = excluded.start_history, connected_at = excluded.connected_at`,
    [ownerId, who.email, seal(JSON.stringify({ refresh: body.refresh_token } satisfies Saved)), scopes.join(","), who.history, now],
  );
  return { email: who.email, scopes };
}

/**
 * The connected address, and where its mailbox stands now: emails after this point are the
 * new ones. With only Calendar allowed, the address is the main calendar's id.
 */
async function whoIs(fetchImpl: Fetch, access: string, scopes: string[]): Promise<{ email: string; history: string | null }> {
  try {
    if (googleCan(scopes).gmail) {
      const profile = (await call(fetchImpl, access, `${GMAIL}/profile`)) as { emailAddress?: string; historyId?: string };
      return { email: String(profile.emailAddress ?? "").toLowerCase(), history: profile.historyId ? String(profile.historyId) : null };
    }
    const list = (await call(fetchImpl, access, `${CALENDAR}/events?maxResults=1`)) as { summary?: string };
    return { email: String(list.summary ?? "").toLowerCase(), history: null };
  } catch {
    return { email: "", history: null };
  }
}

async function revoke(fetchImpl: Fetch, token: string): Promise<void> {
  try {
    await form(fetchImpl, REVOKE_URL, { token });
  } catch {
    // Google unreachable: removing the saved login here is what matters.
  }
}

/** Ends one account's login on Google's side too, then removes it here. */
export async function disconnectGoogle(db: Db, ownerId: string, email: string, fetchImpl: Fetch = fetch): Promise<void> {
  const saved = await savedLogin(db, ownerId, email).catch(() => null);
  if (saved) await revoke(fetchImpl, saved.login.refresh);
  await forgetLogin(db, ownerId, email);
}

// ---------- What the checks use ----------

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  location?: string;
  hangoutLink?: string;
  /** "default" for a meeting; also "outOfOffice", "focusTime", "workingLocation", "birthday", "fromGmail". */
  eventType?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string; organizer?: boolean; resource?: boolean }[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  description?: string;
  /** Set on one occurrence of a repeating event. */
  recurringEventId?: string;
}

/** The owner's answer to an invitation, in Google's words. */
export type InviteAnswer = "accepted" | "tentative" | "declined";

/** One page of what changed in the mailbox: the emails that arrived in the inbox, oldest first. */
export interface MailboxChanges {
  added: { id: string; threadId: string }[];
  /** Where the mailbox stands after this page. */
  historyId: string;
  /** Set when there is more to read. */
  next?: string;
}

/** An event to add, as the person filled it in. Times are epoch milliseconds. */
export interface NewEvent {
  title: string;
  start: number;
  end: number;
  /** The person's timezone, such as "America/New_York", so the event is set in it. */
  timeZone: string;
  guests: string[];
  /** Add a Google Meet link. */
  meet: boolean;
  description?: string;
}

/** The few things the checks do with one Google account. The tests swap in a fake. */
export interface GoogleApi {
  email: string;
  /** What the account allowed. */
  scopes: string[];
  /** Where the mailbox stands now. */
  mailboxNow(): Promise<string>;
  /** The emails that arrived in the inbox since `historyId`. Throws HistoryGone when Gmail no longer has that far back. */
  changes(historyId: string, page?: string): Promise<MailboxChanges>;
  /** Threads matching a Gmail search, newest first. */
  threads(query: string, max: number): Promise<{ id: string; historyId?: string }[]>;
  thread(id: string): Promise<GmailThread>;
  /** Events on the main calendar that overlap this window, in start order, repeating ones as single events. */
  events(from: number, to: number): Promise<{ timeZone: string; items: CalendarEvent[] }>;
  /** Sends an email written out by `rawEmail`, into a thread when one is given. */
  send(raw: string, threadId?: string): Promise<{ id: string; threadId: string }>;
  /** Adds an event to the main calendar. Its guests get Google's own invitation. */
  addEvent(event: NewEvent): Promise<CalendarEvent>;
  /** Changes an event the owner made. Guests keep their answers and are told of the change. */
  updateEvent(id: string, event: NewEvent): Promise<CalendarEvent>;
  /** Deletes an event the owner made. Guests are told it is cancelled. */
  deleteEvent(id: string): Promise<void>;
  /** Answers an invitation: going, maybe or not. The organizer is told. */
  respond(id: string, answer: InviteAnswer): Promise<CalendarEvent>;
}

async function call(fetchImpl: Fetch, access: string, url: string, send?: { method: "POST" | "PATCH" | "DELETE"; body?: unknown }): Promise<unknown> {
  const res = await fetchImpl(
    url,
    !send
      ? { headers: { authorization: `Bearer ${access}` } }
      : send.body === undefined
        ? { method: send.method, headers: { authorization: `Bearer ${access}` } }
        : { method: send.method, headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify(send.body) },
  );
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
  if (res.ok) return body;
  const reason = body.error?.errors?.[0]?.reason ?? "";
  if (res.status === 429 || /rateLimitExceeded|userRateLimitExceeded/.test(reason)) throw new RateLimited("Google", Number(res.headers.get("retry-after") ?? 60) || 60);
  throw new GoogleError(res.status, body.error?.message ?? res.statusText);
}

/** The most events one read of a calendar takes, over a few pages. */
const MAX_EVENT_PAGES = 4;

/** A Google that reads one account with its saved login. Throws, in words for the person, when it cannot. */
export async function googleApi(db: Db, ownerId: string, email: string, fetchImpl: Fetch = fetch): Promise<GoogleApi> {
  const saved = await savedLogin(db, ownerId, email);
  if (!saved) throw new GoogleSaid(`${email} is not connected.`);
  const { status, body } = await form(fetchImpl, TOKEN_URL, {
    client_id: setting("GOOGLE_CLIENT_ID"),
    client_secret: setting("GOOGLE_CLIENT_SECRET"),
    refresh_token: saved.login.refresh,
    grant_type: "refresh_token",
  });
  if (status !== 200 || typeof body.access_token !== "string") {
    if (body.error === "invalid_grant") {
      // Signed out on Google's side: the password changed, access was removed, or it went unused for months.
      await forgetLogin(db, ownerId, email);
      throw new GoogleSaid(`Google has signed ${email} out. Connect it again.`);
    }
    throw new GoogleError(status, String(body.error_description ?? body.error ?? "could not refresh the login"));
  }
  const access = body.access_token;
  const get = (url: string) => call(fetchImpl, access, url);
  const post = (url: string, body: unknown) => call(fetchImpl, access, url, { method: "POST", body });
  const patch = (url: string, body: unknown) => call(fetchImpl, access, url, { method: "PATCH", body });
  const eventUrl = (id: string) => `${CALENDAR}/events/${encodeURIComponent(id)}`;
  const at = (ms: number, timeZone: string) => ({ dateTime: new Date(ms).toISOString(), timeZone });
  const meetRequest = () => ({ conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } });
  return {
    email: saved.email,
    scopes: saved.scopes,
    async mailboxNow() {
      return String(((await get(`${GMAIL}/profile`)) as { historyId?: string }).historyId ?? "");
    },
    async changes(historyId, page) {
      const query = new URLSearchParams({ startHistoryId: historyId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "500", ...(page ? { pageToken: page } : {}) });
      let found: { history?: { messagesAdded?: { message?: { id?: string; threadId?: string } }[] }[]; historyId?: string; nextPageToken?: string };
      try {
        found = (await get(`${GMAIL}/history?${query}`)) as typeof found;
      } catch (error) {
        if (error instanceof GoogleError && error.status === 404) throw new HistoryGone(`Gmail no longer has ${email}'s history from ${historyId}`);
        throw error;
      }
      const added = (found.history ?? []).flatMap((h) => h.messagesAdded ?? []).map((a) => a.message).filter((m): m is { id: string; threadId: string } => Boolean(m?.id && m.threadId));
      return { added, historyId: String(found.historyId ?? historyId), next: found.nextPageToken };
    },
    async threads(query, max) {
      const found = (await get(`${GMAIL}/threads?${new URLSearchParams({ q: query, maxResults: String(max) })}`)) as { threads?: { id: string; historyId?: string }[] };
      return found.threads ?? [];
    },
    async thread(id) {
      return (await get(`${GMAIL}/threads/${encodeURIComponent(id)}?format=full`)) as GmailThread;
    },
    async events(from, to) {
      const items: CalendarEvent[] = [];
      let timeZone = "UTC";
      let page: string | undefined;
      for (let i = 0; i < MAX_EVENT_PAGES; i++) {
        const query = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(page ? { pageToken: page } : {}) });
        const found = (await get(`${CALENDAR}/events?${query}`)) as { timeZone?: string; items?: CalendarEvent[]; nextPageToken?: string };
        timeZone = found.timeZone ?? timeZone;
        items.push(...(found.items ?? []));
        page = found.nextPageToken;
        if (!page) break;
      }
      return { timeZone, items };
    },
    async send(raw, threadId) {
      const sent = (await post(`${GMAIL}/messages/send`, { raw, ...(threadId ? { threadId } : {}) })) as { id?: string; threadId?: string };
      return { id: String(sent.id ?? ""), threadId: String(sent.threadId ?? threadId ?? "") };
    },
    async addEvent(e) {
      const body = {
        summary: e.title,
        ...(e.description ? { description: e.description } : {}),
        start: at(e.start, e.timeZone),
        end: at(e.end, e.timeZone),
        attendees: e.guests.map((email) => ({ email })),
        ...(e.meet ? meetRequest() : {}),
      };
      // conferenceDataVersion lets Google make the Meet link; sendUpdates sends the guests their invitation.
      return (await post(`${CALENDAR}/events?conferenceDataVersion=1&sendUpdates=all`, body)) as CalendarEvent;
    },
    async updateEvent(id, e) {
      const current = (await get(eventUrl(id))) as CalendarEvent;
      // The owner and any rooms stay; a guest who is still invited keeps their answer; new guests are added.
      const before = current.attendees ?? [];
      const kept = before.filter((a) => a.self || a.resource);
      const attendees = [...kept, ...e.guests.map((email) => before.find((a) => !a.self && !a.resource && (a.email ?? "").toLowerCase() === email) ?? { email })];
      const hasMeet = Boolean(current.hangoutLink || current.conferenceData);
      const body = { summary: e.title, description: e.description ?? "", start: at(e.start, e.timeZone), end: at(e.end, e.timeZone), attendees, ...(e.meet && !hasMeet ? meetRequest() : {}) };
      return (await patch(`${eventUrl(id)}?conferenceDataVersion=1&sendUpdates=all`, body)) as CalendarEvent;
    },
    async deleteEvent(id) {
      await call(fetchImpl, access, `${eventUrl(id)}?sendUpdates=all`, { method: "DELETE" });
    },
    async respond(id, answer) {
      const current = (await get(eventUrl(id))) as CalendarEvent;
      const attendees = current.attendees ?? [];
      if (!attendees.some((a) => a.self)) throw new GoogleSaid("This is an event you made, so there is no invitation to answer.");
      // Only the owner's own answer changes. Google tells the organizer.
      return (await patch(`${eventUrl(id)}?sendUpdates=all`, { attendees: attendees.map((a) => (a.self ? { ...a, responseStatus: answer } : a)) })) as CalendarEvent;
    },
  };
}
