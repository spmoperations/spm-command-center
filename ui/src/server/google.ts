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
import type { GmailMessage, GmailThread } from "./gmail";
import { hostedProblem, keysById, keysForNew, offHere, settingsProblem, type GoogleKeys } from "./app-keys";
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

/**
 * Why this person cannot connect a Google account here, in words for them, or null when they
 * can: Google may not be used on this server, or there are no app keys anywhere (their own, the
 * team's, or the server's settings). See app-keys.ts.
 */
export async function googleBlocked(db: Db, ownerId: string): Promise<string | null> {
  const hosted = hostedProblem("google");
  if (hosted) return hosted;
  if (await keysForNew(db, ownerId, "google")) return null;
  return `Google's app keys are not in place yet. Save a Client ID and Client secret from Google Cloud on the Connections page, under Google, App keys. ${settingsProblem("google") ?? ""}`.trim();
}

export const googleAvailable = async (db: Db, ownerId: string) => (await googleBlocked(db, ownerId)) === null;

export const GOOGLE_OFF_HERE = offHere("google");

/**
 * Checks app keys with Google before they are saved: a made-up code is swapped at Google's
 * token address. Google answers that the code is wrong when the keys are right, and that the
 * client is unknown when they are not. Nothing is connected and nothing is kept on Google's side.
 */
export async function checkGoogleKeys(keys: GoogleKeys, redirect: string, fetchImpl: Fetch = fetch): Promise<void> {
  let answer: { status: number; body: Record<string, unknown> };
  try {
    answer = await form(fetchImpl, TOKEN_URL, { code: "command-center-key-check", client_id: keys.clientId, client_secret: keys.clientSecret, redirect_uri: redirect, grant_type: "authorization_code" });
  } catch {
    throw new GoogleSaid("Google could not be reached to check the keys. Try again in a minute.");
  }
  if (answer.body.error === "invalid_client" || answer.body.error === "unauthorized_client") {
    throw new GoogleSaid("Google does not know these keys. Copy the Client ID and Client secret again from the OAuth client in Google Cloud.");
  }
}

/** Google may be used on this server at all. The accounts already connected each have their own keys. */
const mayUseGoogle = () => hostedProblem("google") === null;

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

type AccountRow = { email: string; secret: string; scopes: string; start_history: string | null; connected_at: number; app_key_id: string | null };
const toAccount = (r: AccountRow): GoogleAccount => ({ email: r.email, scopes: r.scopes.split(",").filter(Boolean), connectedAt: Number(r.connected_at), startHistory: r.start_history });

/** The Google accounts connected here, in the order they were connected. None on a server that may not use Google. */
export async function googleAccounts(db: Db, ownerId: string): Promise<GoogleAccount[]> {
  if (!mayUseGoogle()) return [];
  const rows = await db.query<AccountRow>("select email, secret, scopes, start_history, connected_at, app_key_id from google_accounts where owner_id = $1 order by connected_at, email", [ownerId]);
  return rows.map(toAccount);
}

/** True when at least one Google account is connected here. */
export async function googleConnected(db: Db, ownerId: string): Promise<boolean> {
  return (await googleAccounts(db, ownerId)).length > 0;
}

async function savedLogin(db: Db, ownerId: string, email: string): Promise<(GoogleAccount & { login: Saved; keyId: string | null }) | null> {
  if (!mayUseGoogle()) return null;
  const [row] = await db.query<AccountRow>("select email, secret, scopes, start_history, connected_at, app_key_id from google_accounts where owner_id = $1 and email = $2", [ownerId, email]);
  return row ? { ...toAccount(row), login: JSON.parse(unseal(row.secret)) as Saved, keyId: row.app_key_id } : null;
}

const forgetLogin = (db: Db, ownerId: string, email: string) => db.run("delete from google_accounts where owner_id = $1 and email = $2", [ownerId, email]);

// ---------- Connecting ----------

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/**
 * Where to send the person to connect, and the cookie that remembers this login until Google
 * sends them back. `site` is the address the dashboard was opened at: Google sends them back
 * to the same one, which must be listed in the OAuth client in Google Cloud.
 */
export async function startGoogleLogin(db: Db, ownerId: string, site: string, secure: boolean, now = Date.now()): Promise<{ url: string; cookie: string }> {
  const blocked = await googleBlocked(db, ownerId);
  if (blocked) throw new GoogleSaid(blocked);
  // The keys this login is made with: the person's own, else the team's. The account keeps them.
  const keys = (await keysForNew(db, ownerId, "google"))!;
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const redirect = `${site}/api/google/callback`;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: keys.keys.clientId,
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
  const cookie = `${GOOGLE_LOGIN_COOKIE}=${seal(JSON.stringify({ v: 1, state, verifier, redirect, at: now, owner: ownerId, keyId: keys.id }))}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MINUTES * 60}${secure ? "; Secure" : ""}`;
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
  const hosted = hostedProblem("google");
  if (hosted) throw new GoogleSaid(hosted);
  const again = "That Google login has timed out or did not start here. Click Connect Google again.";
  let pending: { v: number; state: string; verifier: string; redirect: string; at: number; owner?: string; keyId?: string | null };
  try {
    pending = JSON.parse(unseal(cookie ?? ""));
  } catch {
    throw new GoogleSaid(again);
  }
  if (pending.v !== 1 || now - pending.at > LOGIN_MINUTES * 60_000 || now < pending.at) throw new GoogleSaid(again);
  // Started by someone else signed in on this browser: it would connect the account to the wrong person.
  if (pending.owner !== undefined && pending.owner !== ownerId) throw new GoogleSaid(again);
  const state = answer.get("state") ?? "";
  if (state.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new GoogleSaid(again);
  const refused = answer.get("error");
  if (refused) throw new GoogleSaid(refused === "access_denied" ? "Google was not allowed in, so nothing was connected." : `Google did not connect: ${refused}.`);
  const code = answer.get("code");
  if (!code) throw new GoogleSaid(again);
  // The same keys the login was started with: Google hands the code to that app only.
  const keys = await keysById(db, ownerId, "google", pending.keyId);
  if (!keys) throw new GoogleSaid(again);

  const { status, body } = await form(fetchImpl, TOKEN_URL, {
    code,
    client_id: keys.keys.clientId,
    client_secret: keys.keys.clientSecret,
    redirect_uri: pending.redirect,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });
  if (status !== 200 || typeof body.access_token !== "string") {
    if (body.error === "invalid_client") throw new GoogleSaid("Google did not accept the app keys. Check the Client ID and Client secret against the OAuth client in Google Cloud.");
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

  const refresh = body.refresh_token;
  const who = await whoIs(fetchImpl, body.access_token, scopes).catch(async (error) => {
    // Nothing is kept, so the login Google handed over is ended.
    await revoke(fetchImpl, refresh);
    throw error;
  });
  if (!who.email) {
    await revoke(fetchImpl, refresh);
    throw new GoogleSaid("Google did not say which account this is, so nothing was connected. Click Connect Google again.");
  }
  await db.run(
    `insert into google_accounts (owner_id, email, secret, scopes, start_history, connected_at, app_key_id) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (owner_id, email) do update set secret = excluded.secret, scopes = excluded.scopes, start_history = excluded.start_history, connected_at = excluded.connected_at, app_key_id = excluded.app_key_id`,
    [ownerId, who.email, seal(JSON.stringify({ refresh: body.refresh_token } satisfies Saved)), scopes.join(","), who.history, now, keys.id],
  );
  return { email: who.email, scopes };
}

/**
 * The connected address, and where its mailbox stands now: emails after this point are the
 * new ones. With only Calendar allowed, the address is the main calendar's id.
 */
async function whoIs(fetchImpl: Fetch, access: string, scopes: string[]): Promise<{ email: string; history: string | null }> {
  const gmail = googleCan(scopes).gmail;
  try {
    if (gmail) {
      const profile = (await call(fetchImpl, access, `${GMAIL}/profile`)) as { emailAddress?: string; historyId?: string };
      return { email: String(profile.emailAddress ?? "").toLowerCase(), history: profile.historyId ? String(profile.historyId) : null };
    }
    const list = (await call(fetchImpl, access, `${CALENDAR}/events?maxResults=1`)) as { summary?: string };
    return { email: String(list.summary ?? "").toLowerCase(), history: null };
  } catch (error) {
    // The most likely snag in a new Google Cloud project: the API was never switched on.
    if (error instanceof GoogleError && error.status === 403 && /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(error.message)) {
      throw new GoogleSaid(`The ${gmail ? "Gmail API" : "Google Calendar API"} is not switched on in the Google Cloud project. Do part 2 of the setup guide (Turn on Gmail and Calendar), then click Connect Google again.`);
    }
    throw new GoogleSaid(`Google did not say which account this is (${error instanceof Error ? error.message : String(error)}), so nothing was connected. Click Connect Google again.`);
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
  /** One email, whole, to show it as its sender laid it out. */
  message(id: string): Promise<GmailMessage>;
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

/**
 * Access tokens Google handed out, kept in this server's memory until shortly before they run
 * out (an hour), so opening an email asks Google once an hour instead of every time. Kept for
 * each way of reaching Google: the tests' pretend Googles each start with none. A token is
 * found by the login it came from, so connecting again never reuses an old one.
 */
const accessTokens = new WeakMap<Fetch, Map<string, { token: string; until: number }>>();
/** A token is let go this long before Google says it runs out. */
const TOKEN_MARGIN_MS = 2 * 60_000;

/** A Google that reads one account with its saved login. Throws, in words for the person, when it cannot. */
export async function googleApi(db: Db, ownerId: string, email: string, fetchImpl: Fetch = fetch): Promise<GoogleApi> {
  const saved = await savedLogin(db, ownerId, email);
  if (!saved) throw new GoogleSaid(`${email} is not connected.`);
  // The keys this account was connected with, even if newer ones have been saved since. Without
  // them nothing is asked of Google, and the account stays as it is.
  const keys = await keysById(db, ownerId, "google", saved.keyId);
  if (!keys) throw new GoogleSaid(`The app keys ${email} was connected with are not here any more. Nothing was changed; put the same keys back to go on reading it.`);
  let tokens = accessTokens.get(fetchImpl);
  if (!tokens) accessTokens.set(fetchImpl, (tokens = new Map()));
  const tokenKey = `${ownerId}\n${email}\n${crypto.createHash("sha256").update(saved.login.refresh).digest("base64url")}`;
  const kept = tokens.get(tokenKey);
  let access: string;
  if (kept && kept.until > Date.now()) access = kept.token;
  else {
    const { status, body } = await form(fetchImpl, TOKEN_URL, {
      client_id: keys.keys.clientId,
      client_secret: keys.keys.clientSecret,
      refresh_token: saved.login.refresh,
      grant_type: "refresh_token",
    });
    if (status !== 200 || typeof body.access_token !== "string") {
      tokens.delete(tokenKey);
      if (body.error === "invalid_grant") {
        // Signed out on Google's side: the password changed, access was removed, or it went unused for months.
        await forgetLogin(db, ownerId, email);
        throw new GoogleSaid(`Google has signed ${email} out. Connect it again.`);
      }
      throw new GoogleError(status, String(body.error_description ?? body.error ?? "could not refresh the login"));
    }
    access = body.access_token;
    tokens.set(tokenKey, { token: access, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 - TOKEN_MARGIN_MS });
  }
  /** A request with the token. One Google no longer accepts is let go, so the next request asks for a fresh one. */
  const ask = async (url: string, send?: Parameters<typeof call>[3]) => {
    try {
      return await call(fetchImpl, access, url, send);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 401) tokens.delete(tokenKey);
      throw error;
    }
  };
  const get = (url: string) => ask(url);
  const post = (url: string, body: unknown) => ask(url, { method: "POST", body });
  const patch = (url: string, body: unknown) => ask(url, { method: "PATCH", body });
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
    async message(id) {
      return (await get(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage;
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
      await ask(`${eventUrl(id)}?sendUpdates=all`, { method: "DELETE" });
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
