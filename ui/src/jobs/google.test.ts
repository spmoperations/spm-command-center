import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allDayOn, layDay, weekDays, weekStart, weekTitle } from "@/core/calendar";
import { emailTags } from "@/core/email-tags";
import { GOOGLE_PERMISSIONS } from "@/core/providers";
import { upcomingDay } from "@/core/dates";
import type { CalendarItem } from "@/core/types";
import type { Db } from "@/server/db";
import { htmlToText, parseAddress, parseAddresses, rawEmail, readEmail, withoutQuoted, type GmailMessage, type GmailThread } from "@/server/gmail";
import {
  CALENDAR_EDIT_SCOPE, CALENDAR_SCOPE, finishGoogleLogin, GMAIL_SCOPE, GMAIL_SEND_SCOPE, GOOGLE_OFF_HERE, GOOGLE_SCOPES, googleApi, googleBlocked, GoogleSaid, HistoryGone, startGoogleLogin,
  type CalendarEvent, type GoogleAccount, type GoogleApi, type MailboxChanges, type NewEvent,
} from "@/server/google";
import { googleCallback, googleLoginRedirect } from "@/server/google-routes";
import { applyAction, forgetGoogle, loadState, OWNER_ID, resortInbox } from "@/server/repo";
import { seal, unseal } from "@/server/secrets";
import { createSession, SESSION_COOKIE } from "@/server/session";
import { RateLimited, type Fetch } from "@/server/slack";
import { NOW, reset, testDb } from "@/server/testing";
import { addCalendarEvent, calendarPull, deleteCalendarEvent, isShown, joinLink, placeOf, respondToEvent, toRows, updateCalendarEvent } from "./calendar";
import { gmailPull } from "./gmail";
import { outboxSend } from "./outbox";
import { runJob, type JobContext } from "./runner";

let db: Db;
const ctx = (cursor: Record<string, unknown> = {}, now = NOW): JobContext => ({ db, ownerId: OWNER_ID, now, cursor });
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const SITE = "http://127.0.0.1:3000";
const HOSTED = "postgres://user:secret@db.example.com:5432/postgres";
const JEREMY_MAIL = "jeremy@example.com";
const OPS_MAIL = "ops@example.com";

function withKeys() {
  process.env.GOOGLE_CLIENT_ID = "1234-abcd.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "GOCSPX-not-a-real-secret";
}

/** As if a Google account had been connected here an hour ago, allowing these. */
async function connected(email = JEREMY_MAIL, scopes = GOOGLE_SCOPES, history: string | null = "100") {
  withKeys();
  await db.run("insert into google_accounts (owner_id, email, secret, scopes, start_history, connected_at) values ($1, $2, $3, $4, $5, $6)", [
    OWNER_ID, email, seal(JSON.stringify({ refresh: `refresh-${email}` })), scopes.join(","), history, NOW - HOUR,
  ]);
}

const account = (email = JEREMY_MAIL, more: Partial<GoogleAccount> = {}): GoogleAccount => ({ email, scopes: GOOGLE_SCOPES, connectedAt: NOW - HOUR, startHistory: "100", ...more });

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(() => reset(db));
afterEach(() => {
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_HOSTED", "DATABASE_URL", "LOGIN_EMAIL", "LOGIN_PASSWORD", "SENDING_ENABLED"]) delete process.env[name];
});

// ---------- A pretend Gmail ----------

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** One Gmail message as the API returns it with format=full. */
function mail(id: string, threadId: string, o: { from: string; to?: string; cc?: string; subject?: string; text?: string; html?: string; at: number; labels?: string[]; headers?: [string, string][]; files?: string[] }): GmailMessage {
  const headers = [["From", o.from], ["To", o.to ?? "Jeremy Moser <jeremy@example.com>"], ["Subject", o.subject ?? "Thursday"], ["Message-ID", `<${id}@mail.example.com>`], ...(o.cc ? [["Cc", o.cc]] : []), ...(o.headers ?? [])].map(([name, value]) => ({ name, value }));
  const body = [
    ...(o.text !== undefined ? [{ mimeType: "text/plain", body: { data: b64(o.text), size: o.text.length } }] : []),
    ...(o.html !== undefined ? [{ mimeType: "text/html", body: { data: b64(o.html), size: o.html.length } }] : []),
  ];
  const files = (o.files ?? []).map((name) => ({ mimeType: "application/pdf", filename: name, body: { attachmentId: `att-${name}`, size: 2000 } }));
  return {
    id,
    threadId,
    labelIds: o.labels ?? ["INBOX", "UNREAD"],
    internalDate: String(o.at),
    snippet: (o.text ?? "").slice(0, 40),
    payload: { mimeType: "multipart/mixed", headers, parts: [{ mimeType: "multipart/alternative", parts: body }, ...files] },
  };
}

const DANA = "Dana Whitfield <dana@example.com>";
const JEREMY = "Jeremy Moser <jeremy@example.com>";

/**
 * A pretend mailbox and calendar for one account. `deliver` is an email arriving: it moves the
 * mailbox's history on, as Gmail's does. What was in the mailbox before is not in its history.
 */
function fakeGoogle(email = JEREMY_MAIL, events: CalendarEvent[] = []) {
  const threads: GmailThread[] = [];
  const log: { history: number; id: string; threadId: string }[] = [];
  const fake = {
    email,
    scopes: GOOGLE_SCOPES,
    history: 100,
    pageSize: 500,
    gone: false,
    opened: [] as string[],
    queries: [] as string[],
    /** Mail that was there before the account was connected: not in the history. */
    already(message: GmailMessage): void {
      const thread = threads.find((t) => t.id === message.threadId) ?? threads[threads.push({ id: message.threadId, messages: [] }) - 1];
      thread.messages!.push(message);
    },
    deliver(message: GmailMessage): void {
      fake.already(message);
      fake.history++;
      log.push({ history: fake.history, id: message.id, threadId: message.threadId });
    },
    async mailboxNow(): Promise<string> {
      return String(fake.history);
    },
    async changes(from: string, page?: string): Promise<MailboxChanges> {
      if (fake.gone) throw new HistoryGone("too old");
      const after = log.filter((l) => l.history > Number(from));
      const offset = page ? Number(page) : 0;
      const slice = after.slice(offset, offset + fake.pageSize);
      return { added: slice.map((l) => ({ id: l.id, threadId: l.threadId })), historyId: String(fake.history), next: offset + fake.pageSize < after.length ? String(offset + fake.pageSize) : undefined };
    },
    async threads(query: string, max: number): Promise<{ id: string }[]> {
      fake.queries.push(query);
      return threads.slice(-max).reverse().map((t) => ({ id: t.id }));
    },
    async thread(id: string): Promise<GmailThread> {
      fake.opened.push(id);
      const thread = threads.find((t) => t.id === id);
      if (!thread) throw new Error("Not found");
      return structuredClone(thread);
    },
    async events() {
      return { timeZone: "America/New_York", items: events };
    },
    /** What was sent, written out, and into which thread. */
    sent: [] as { raw: string; threadId?: string }[],
    async send(raw: string, threadId?: string): Promise<{ id: string; threadId: string }> {
      fake.sent.push({ raw, threadId });
      return { id: `sent${fake.sent.length}`, threadId: threadId ?? `new${fake.sent.length}` };
    },
    updated: [] as [string, NewEvent][],
    deleted: [] as string[],
    answered: [] as [string, string][],
    async updateEvent(id: string, e: NewEvent): Promise<CalendarEvent> {
      fake.updated.push([id, e]);
      return { id, status: "confirmed", summary: e.title, organizer: { email, self: true }, start: { dateTime: new Date(e.start).toISOString() }, end: { dateTime: new Date(e.end).toISOString() }, attendees: e.guests.map((g) => ({ email: g, responseStatus: "needsAction" })) };
    },
    async deleteEvent(id: string): Promise<void> {
      fake.deleted.push(id);
    },
    async respond(id: string, answer: "accepted" | "tentative" | "declined"): Promise<CalendarEvent> {
      fake.answered.push([id, answer]);
      const invite = events.find((e) => e.id === id)!;
      return { ...invite, attendees: (invite.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: answer } : a)) };
    },
    added: [] as NewEvent[],
    async addEvent(e: NewEvent): Promise<CalendarEvent> {
      fake.added.push(e);
      return { id: `ev${fake.added.length}`, status: "confirmed", summary: e.title, start: { dateTime: new Date(e.start).toISOString() }, end: { dateTime: new Date(e.end).toISOString() }, htmlLink: "https://calendar.google.com/event?eid=new", ...(e.meet ? { hangoutLink: "https://meet.google.com/new-meet-abc" } : {}), attendees: e.guests.map((email) => ({ email, responseStatus: "needsAction" })) };
    },
  } satisfies GoogleApi & Record<string, unknown>;
  return fake;
}

const opener = (...fakes: ReturnType<typeof fakeGoogle>[]) => async (email: string) => fakes.find((f) => f.email === email)!;

/** A pretend Google for the login and the API: answers by address, and remembers what it was asked. */
function googleSays(routes: Record<string, (body: URLSearchParams, url: URL, headers: Headers, method: string) => [number, unknown]>) {
  const calls: { url: string; body: URLSearchParams; headers: Headers; text: string; method: string }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), body, headers, text: typeof init?.body === "string" ? init.body : "", method: init?.method ?? "GET" });
    const route = routes[`${url.origin}${url.pathname}`];
    if (!route) throw new Error(`Unexpected request in a test: ${url}`);
    const [status, answer] = route(body, url, headers, init?.method ?? "GET");
    // A delete is answered with 204 and nothing in it, as Google does.
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

// ---------- Reading an email ----------

describe("reading an email", () => {
  it("reads names and addresses, with commas inside a quoted name", () => {
    expect(parseAddress('"Whitfield, Dana" <Dana@Example.com>')).toEqual({ name: "Whitfield, Dana", email: "dana@example.com" });
    expect(parseAddress("sam@example.com")).toEqual({ name: "sam@example.com", email: "sam@example.com" });
    expect(parseAddresses('"Whitfield, Dana" <dana@example.com>, Sam Ortiz <sam@example.com>, not an address').map((a) => a.email)).toEqual(["dana@example.com", "sam@example.com"]);
  });

  it("turns an HTML email into its words, with its paragraphs", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Hi Jeremy,</p><p>Can we move <b>Thursday</b> to 3pm?&nbsp;It&#39;s fine &amp; easy.</p><ul><li>Deck</li><li>Budget</li></ul><br>Dana</body></html>";
    expect(htmlToText(html)).toBe("Hi Jeremy,\nCan we move Thursday to 3pm? It's fine & easy.\n\n• Deck\n• Budget\n\nDana");
  });

  it("keeps the new part of a reply and leaves the quoted history out", () => {
    expect(withoutQuoted("Sounds good, see you then.\n\nOn Mon, Oct 12, 2026 at 9:01 AM Dana Whitfield <dana@example.com> wrote:\n> Can we meet Thursday?\n> Dana")).toBe("Sounds good, see you then.");
    expect(withoutQuoted("Yes.\n\nOn Mon, Oct 12, 2026 at 9:01 AM Dana Whitfield <dana@example.com>\nwrote:\n> Thursday?")).toBe("Yes.");
    expect(withoutQuoted("Done.\n\nFrom: Dana Whitfield\nSent: Monday, October 12, 2026 9:01 AM\nTo: Jeremy\nSubject: Thursday")).toBe("Done.");
    // A forwarded email is the point of the message, so it is kept.
    expect(withoutQuoted("See below.\n\n---------- Forwarded message ---------\nFrom: Sam Ortiz\nThe numbers")).toContain("The numbers");
  });

  it("reads one message: who, to whom, the text, the files it came with, and its Gmail tab", () => {
    const email = readEmail(mail("m1", "t1", { from: DANA, cc: "Sam Ortiz <sam@example.com>", subject: "Thursday", text: "Can we move it to 3pm?\n\nOn Sun, Dana wrote:\n> old", html: "<p>ignored when there is a plain version</p>", at: NOW, files: ["deck.pdf"] }), JEREMY_MAIL);
    expect(email).toMatchObject({
      id: "m1", threadId: "t1", at: NOW, from: { name: "Dana Whitfield", email: "dana@example.com" }, to: [{ email: JEREMY_MAIL }], cc: [{ email: "sam@example.com" }],
      subject: "Thursday", text: "Can we move it to 3pm?\n\n(attached: deck.pdf)", me: false, unread: true, bulk: false, tab: "primary",
    });
    expect(readEmail(mail("m2", "t1", { from: DANA, html: "<p>Only <i>HTML</i></p>", at: NOW }), JEREMY_MAIL).text).toBe("Only HTML");
    expect(readEmail(mail("m3", "t1", { from: JEREMY, text: "Mine", at: NOW, labels: ["SENT"] }), JEREMY_MAIL).me).toBe(true);
    expect(readEmail(mail("m4", "t1", { from: DANA, text: "Sale", at: NOW, labels: ["INBOX", "CATEGORY_PROMOTIONS"] }), JEREMY_MAIL).tab).toBe("promotions");
  });

  it("tells a newsletter or an automatic email from a person writing", () => {
    const bulk = (o: Partial<Parameters<typeof mail>[2]>) => readEmail(mail("m", "t", { from: DANA, text: "x", at: NOW, ...o }), JEREMY_MAIL).bulk;
    expect(bulk({})).toBe(false);
    expect(bulk({ headers: [["List-Unsubscribe", "<https://example.com/unsubscribe>"]] })).toBe(true);
    expect(bulk({ headers: [["Precedence", "bulk"]] })).toBe(true);
    expect(bulk({ from: "Billing <no-reply@example.com>" })).toBe(true);
    expect(bulk({ from: "notifications+abc@example.com" })).toBe(true);
  });
});

// ---------- The switch ----------

describe("the setup guide", () => {
  it("tells the person to allow exactly what Connect Google asks for", () => {
    expect(GOOGLE_PERMISSIONS.map(([scope]) => scope)).toEqual(GOOGLE_SCOPES);
  });
});

describe("where Google may be used", () => {
  it("needs its app keys, and with a hosted database also the server's say-so", () => {
    expect(googleBlocked()).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
    process.env.GOOGLE_CLIENT_ID = "not-a-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "x";
    expect(googleBlocked()).toMatch(/ends with \.apps\.googleusercontent\.com/);
    withKeys();
    expect(googleBlocked()).toBeNull();
    process.env.DATABASE_URL = HOSTED;
    expect(googleBlocked()).toBe(GOOGLE_OFF_HERE);
    process.env.GOOGLE_HOSTED = " 'true' ";
    expect(googleBlocked()).toBeNull();
  });

  it("takes no notice of saved logins on a server that may not use Google", async () => {
    await connected();
    process.env.DATABASE_URL = HOSTED;
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.googleAvailable, state.connections.google.connected, state.googleAccounts, state.googleAllows]).toEqual([false, false, [], { gmail: false, send: false, calendar: false, addEvents: false }]);
    const run = await runJob(db, "gmail-pull", OWNER_ID, NOW);
    expect([run.ok, run.message]).toEqual([false, GOOGLE_OFF_HERE]);
  });
});

// ---------- Connecting ----------

describe("connecting Google", () => {
  const signedIn = () => {
    process.env.LOGIN_EMAIL = "jeremy@example.com";
    process.env.LOGIN_PASSWORD = "correct horse battery";
    return `${SESSION_COOKIE}=${createSession("jeremy@example.com")}`;
  };
  const visit = (path: string, cookies: string[], site: "same-origin" | "cross-site" = "same-origin") =>
    new Request(`${SITE}${path}`, { headers: { host: "127.0.0.1:3000", cookie: cookies.filter(Boolean).join("; "), "sec-fetch-site": site } });
  const loginCookieOf = (res: Response) => /cc_google_login=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")![1];
  const googleFor = (email: string, scope = `openid ${GMAIL_SCOPE} ${CALENDAR_SCOPE}`) =>
    googleSays({
      [TOKEN]: (body) => (body.get("code") === "good-code" ? [200, { access_token: "access-1", refresh_token: `refresh-${email}`, expires_in: 3599, scope, token_type: "Bearer" }] : [400, { error: "invalid_grant" }]),
      [PROFILE]: () => [200, { emailAddress: email.toUpperCase(), historyId: "12345" }],
      [REVOKE]: () => [200, {}],
    });
  /** The whole trip: the Connect button, Google's page, and the way back. */
  async function connect(email: string, session = signedIn()) {
    withKeys();
    const start = googleLoginRedirect(visit("/api/google/start", [session]), NOW);
    const asked = new URL(start.headers.get("location")!).searchParams;
    const google = googleFor(email);
    const back = await googleCallback(visit(`/api/google/callback?state=${asked.get("state")}&code=good-code&scope=x`, [session, `cc_google_login=${loginCookieOf(start)}`], "cross-site"), { db, fetchImpl: google.fetchImpl, now: NOW + MINUTE, firstRead: false });
    return { start, asked, google, back };
  }

  it("sends the person to Google's own page, asking for a lasting, read-only login and the account chooser", () => {
    withKeys();
    const res = googleLoginRedirect(visit("/api/google/start", [signedIn()]), NOW);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: "1234-abcd.apps.googleusercontent.com", redirect_uri: `${SITE}/api/google/callback`, response_type: "code",
      scope: `${GMAIL_SCOPE} ${GMAIL_SEND_SCOPE} ${CALENDAR_EDIT_SCOPE}`, access_type: "offline", prompt: "consent select_account", code_challenge_method: "S256",
    });
    expect(res.headers.get("set-cookie")).toMatch(/^cc_google_login=[^;]+; Path=\/api\/google; HttpOnly; SameSite=Lax; Max-Age=600$/);
  });

  it("asks Google to send the person back to the https address of the live site, even when the request reaches the app as http", () => {
    withKeys();
    const request = new Request("http://spm-command-center.vercel.app/api/google/start", { headers: { host: "spm-command-center.vercel.app", cookie: signedIn(), "sec-fetch-site": "same-origin", "x-forwarded-proto": "https" } });
    const res = googleLoginRedirect(request, NOW);
    expect(new URL(res.headers.get("location")!).searchParams.get("redirect_uri")).toBe("https://spm-command-center.vercel.app/api/google/callback");
    expect(res.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("starts only from the dashboard's own button, for someone signed in, on a server that may use Google", () => {
    withKeys();
    const back = (res: Response) => [res.status, new URL(res.headers.get("location")!).searchParams.get("google_error")];
    expect(back(googleLoginRedirect(visit("/api/google/start", [signedIn()], "cross-site")))).toEqual([302, "Click Connect Google on this page to connect."]);
    expect(back(googleLoginRedirect(visit("/api/google/start", [])))).toEqual([302, "Please sign in, then click Connect Google again."]);
    process.env.DATABASE_URL = HOSTED;
    expect(back(googleLoginRedirect(visit("/api/google/start", [signedIn()])))).toEqual([302, GOOGLE_OFF_HERE]);
  });

  it("swaps Google's code for a lasting login, keeps it sealed with where the mailbox stood, and goes back to Connections", async () => {
    const { asked, google, back } = await connect(JEREMY_MAIL);
    expect([back.status, back.headers.get("location")]).toEqual([302, `${SITE}/connections?google=connected&account=jeremy%40example.com`]);
    expect(back.headers.get("set-cookie")).toMatch(/^cc_google_login=; Path=\/api\/google; HttpOnly; SameSite=Lax; Max-Age=0$/);
    // The code was swapped with the secret half of the challenge, from the same address.
    const swap = google.calls.find((c) => c.url === TOKEN)!.body;
    expect(crypto.createHash("sha256").update(swap.get("code_verifier")!).digest("base64url")).toBe(asked.get("code_challenge"));
    expect([swap.get("redirect_uri"), swap.get("grant_type"), swap.get("client_secret")]).toEqual([`${SITE}/api/google/callback`, "authorization_code", "GOCSPX-not-a-real-secret"]);

    const [row] = await db.query<{ email: string; secret: string; scopes: string; start_history: string; connected_at: number }>("select * from google_accounts");
    expect([row.email, JSON.parse(unseal(row.secret)), row.scopes, row.start_history, Number(row.connected_at)]).toEqual([JEREMY_MAIL, { refresh: "refresh-jeremy@example.com" }, `${GMAIL_SCOPE},${CALENDAR_SCOPE}`, "12345", NOW + MINUTE]);
    expect(row.secret).not.toContain("refresh-");
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.connections.google, state.googleAccounts, state.googleAllows]).toEqual([
      { connected: true, connectedAt: NOW + MINUTE, label: JEREMY_MAIL },
      [{ email: JEREMY_MAIL, connectedAt: NOW + MINUTE, gmail: true, send: false, calendar: true, addEvents: false }],
      { gmail: true, send: false, calendar: true, addEvents: false },
    ]);
  });

  it("connects a second account beside the first, and connecting one again replaces only its own login", async () => {
    const session = signedIn();
    await connect(JEREMY_MAIL, session);
    await connect(OPS_MAIL, session);
    await connect(JEREMY_MAIL, session);
    expect((await db.query<{ email: string }>("select email from google_accounts order by email")).map((r) => r.email)).toEqual([JEREMY_MAIL, OPS_MAIL]);
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.connections.google.label, state.googleAccounts.map((a) => a.email).sort()]).toEqual(["2 accounts", [JEREMY_MAIL, OPS_MAIL]]);
  });

  it("will not take an answer that did not start here, is too old, or was refused", async () => {
    withKeys();
    const session = signedIn();
    const start = googleLoginRedirect(visit("/api/google/start", [session]), NOW);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cookie = `cc_google_login=${loginCookieOf(start)}`;
    const google = googleFor(JEREMY_MAIL);
    const error = async (query: string, cookies: string[], now = NOW + MINUTE) =>
      new URL((await googleCallback(visit(`/api/google/callback?${query}`, cookies), { db, fetchImpl: google.fetchImpl, now, firstRead: false })).headers.get("location")!).searchParams.get("google_error");
    const again = "That Google login has timed out or did not start here. Click Connect Google again.";

    expect(await error(`state=someone-else&code=good-code`, [session, cookie])).toBe(again);
    expect(await error(`state=${state}&code=good-code`, [session])).toBe(again);
    expect(await error(`state=${state}&code=good-code`, [session, cookie], NOW + 11 * MINUTE)).toBe(again);
    expect(await error(`state=${state}&error=access_denied`, [session, cookie])).toBe("Google was not allowed in, so nothing was connected.");
    expect(await error(`state=${state}&code=good-code`, [cookie])).toBe("Please sign in, then click Connect Google again.");
    expect(google.calls).toEqual([]);
    expect(await db.query("select email from google_accounts")).toEqual([]);
  });

  it("keeps what was allowed when only one box was ticked, and keeps nothing when neither was", async () => {
    withKeys();
    const pending = (now: number) => {
      const { url, cookie } = startGoogleLogin(SITE, false, now);
      return { state: new URL(url).searchParams.get("state")!, cookie: /cc_google_login=([^;]*)/.exec(cookie)![1] };
    };
    const onlyCalendar = googleSays({
      [TOKEN]: () => [200, { access_token: "a", refresh_token: "r", scope: CALENDAR_SCOPE }],
      [EVENTS]: () => [200, { summary: JEREMY_MAIL, items: [] }],
    });
    const one = pending(NOW);
    expect(await finishGoogleLogin(db, OWNER_ID, new URLSearchParams({ state: one.state, code: "c" }), one.cookie, onlyCalendar.fetchImpl, NOW)).toEqual({ email: JEREMY_MAIL, scopes: [CALENDAR_SCOPE] });
    expect((await loadState(db, OWNER_ID, new Date(NOW))).googleAllows).toEqual({ gmail: false, send: false, calendar: true, addEvents: false });
    // Gmail's check says why it does not run, without asking Google anything.
    const run = await runJob(db, "gmail-pull", OWNER_ID, NOW);
    expect([run.ok, run.message]).toEqual([false, "Gmail was not allowed for any connected Google account. Connect the account again and tick Gmail."]);

    const nothing = googleSays({ [TOKEN]: () => [200, { access_token: "a", refresh_token: "r2", scope: "openid" }], [REVOKE]: () => [200, {}] });
    const two = pending(NOW);
    await expect(finishGoogleLogin(db, OWNER_ID, new URLSearchParams({ state: two.state, code: "c" }), two.cookie, nothing.fetchImpl, NOW)).rejects.toThrow("Neither Gmail nor Calendar was allowed");
    // The login Google handed over is ended straight away.
    expect(nothing.calls.find((c) => c.url === REVOKE)!.body.get("token")).toBe("r2");
  });

  it("says which API is not switched on in the Google Cloud project, and keeps nothing", async () => {
    withKeys();
    const { url, cookie } = startGoogleLogin(SITE, false, NOW);
    const google = googleSays({
      [TOKEN]: () => [200, { access_token: "a", refresh_token: "r3", scope: `${GMAIL_SCOPE} ${CALENDAR_EDIT_SCOPE}` }],
      [PROFILE]: () => [403, { error: { message: "Gmail API has not been used in project 1234 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=1234 then retry.", errors: [{ reason: "accessNotConfigured" }] } }],
      [REVOKE]: () => [200, {}],
    });
    const sealed = /cc_google_login=([^;]*)/.exec(cookie)![1];
    await expect(finishGoogleLogin(db, OWNER_ID, new URLSearchParams({ state: new URL(url).searchParams.get("state")!, code: "c" }), sealed, google.fetchImpl, NOW)).rejects.toThrow(
      "The Gmail API is not switched on in the Google Cloud project. Do part 2 of the setup guide (Turn on Gmail and Calendar), then click Connect Google again.",
    );
    expect(google.calls.find((c) => c.url === REVOKE)!.body.get("token")).toBe("r3");
    expect(await db.query("select email from google_accounts")).toEqual([]);
  });

  it("keeps each attempt to connect, and why one failed, without the account's address", async () => {
    const session = signedIn();
    await connect(JEREMY_MAIL, session);
    withKeys();
    await googleCallback(visit("/api/google/callback?state=wrong&code=good-code", [session, "cc_google_login=nope"]), { db, fetchImpl: googleFor(JEREMY_MAIL).fetchImpl, now: NOW + 2 * MINUTE, firstRead: false });
    const attempts = await db.query<{ ok: boolean; message: string }>("select ok, message from job_runs where job_id = 'google-connect' order by started_at");
    expect(attempts).toEqual([
      { ok: true, message: `an account @example.com connected, allowing ${["gmail.readonly", "calendar.events.readonly"].join(" ")}` },
      { ok: false, message: "That Google login has timed out or did not start here. Click Connect Google again." },
    ]);
    expect(JSON.stringify(attempts)).not.toContain("jeremy@");
  });

  it("says plainly when the address or the keys are not the ones set up in Google Cloud", async () => {
    withKeys();
    for (const [error, said] of [["redirect_uri_mismatch", `Add ${SITE}/api/google/callback to the OAuth client's Authorized redirect URIs`], ["invalid_client", "Google did not accept the app keys"]]) {
      const { url, cookie } = startGoogleLogin(SITE, false, NOW);
      const google = googleSays({ [TOKEN]: () => [400, { error }] });
      const sealed = /cc_google_login=([^;]*)/.exec(cookie)![1];
      await expect(finishGoogleLogin(db, OWNER_ID, new URLSearchParams({ state: new URL(url).searchParams.get("state")!, code: "c" }), sealed, google.fetchImpl, NOW)).rejects.toThrow(said);
    }
  });
});

// ---------- Reading with a saved login ----------

describe("the Google the checks use", () => {
  it("gets a fresh access token from the account's saved login and reads with it", async () => {
    await connected();
    const google = googleSays({
      [TOKEN]: (body) => (body.get("refresh_token") === "refresh-jeremy@example.com" && body.get("grant_type") === "refresh_token" ? [200, { access_token: "access-2" }] : [400, { error: "invalid_grant" }]),
      "https://gmail.googleapis.com/gmail/v1/users/me/history": (_body, url, headers) =>
        headers.get("authorization") !== "Bearer access-2" ? [401, {}] : url.searchParams.get("startHistoryId") === "1" ? [404, { error: { message: "Requested entity was not found." } }] : [200, { history: [{ messagesAdded: [{ message: { id: "m9", threadId: "t9" } }] }], historyId: "120" }],
    });
    const api = await googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl);
    expect([api.email, await api.changes("100")]).toEqual([JEREMY_MAIL, { added: [{ id: "m9", threadId: "t9" }], historyId: "120", next: undefined }]);
    expect(Object.fromEntries(new URL(google.calls[1].url).searchParams)).toMatchObject({ startHistoryId: "100", historyTypes: "messageAdded", labelId: "INBOX" });
    await expect(api.changes("1")).rejects.toBeInstanceOf(HistoryGone);
  });

  it("forgets only the account whose login Google has ended, and says to connect it again", async () => {
    await connected(JEREMY_MAIL);
    await connected(OPS_MAIL);
    const google = googleSays({ [TOKEN]: () => [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }] });
    await expect(googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl)).rejects.toThrow(new GoogleSaid("Google has signed jeremy@example.com out. Connect it again."));
    expect((await db.query<{ email: string }>("select email from google_accounts")).map((r) => r.email)).toEqual([OPS_MAIL]);
  });

  it("waits when Google says it is asked too often", async () => {
    await connected();
    const google = googleSays({
      [TOKEN]: () => [200, { access_token: "a" }],
      "https://gmail.googleapis.com/gmail/v1/users/me/threads": () => [429, { error: { message: "Too many requests", errors: [{ reason: "rateLimitExceeded" }] } }],
    });
    const api = await googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl);
    await expect(api.threads("in:inbox", 5)).rejects.toBeInstanceOf(RateLimited);
  });
});

// ---------- The Gmail check ----------

describe("Gmail check", () => {
  /** A mailbox with mail from before it was connected, then four new emails. */
  function mailbox() {
    const google = fakeGoogle();
    google.already(mail("old1", "old", { from: DANA, subject: "Last month", text: "Before you connected", at: NOW - 30 * DAY }));
    google.deliver(mail("m1", "t1", { from: DANA, subject: "Thursday", text: "Can we move it to 3pm?", at: NOW - 30 * MINUTE }));
    google.deliver(mail("n1", "t2", { from: "Sam Ortiz <sam@example.com>", to: "team@example.com", cc: JEREMY, subject: "Q4 numbers", text: "See attached.", at: NOW - 20 * MINUTE, files: ["q4.pdf"] }));
    google.deliver(mail("x1", "t3", { from: "News <news@example.com>", subject: "This week", text: "Read more", at: NOW - 10 * MINUTE, headers: [["List-Unsubscribe", "<https://example.com/u>"]] }));
    google.deliver(mail("p1", "t4", { from: "Shop <shop@example.com>", subject: "50% off", text: "Today only", at: NOW - 5 * MINUTE, labels: ["INBOX", "CATEGORY_PROMOTIONS"] }));
    return google;
  }
  const gmailRows = async () => (await loadState(db, OWNER_ID, new Date(NOW))).inbox.filter((c) => c.source === "gmail");

  it("brings in every email that arrived after the account was connected, and nothing from before", async () => {
    const google = mailbox();
    const result = await gmailPull(ctx(), [account()], opener(google));
    expect(result).toMatchObject({ items: 4, message: "4 new emails in 4 threads", cursor: { accounts: { [JEREMY_MAIL]: { history: "104", pending: [], at: NOW } } } });
    expect(google.opened).toEqual(["t1", "t2", "t3", "t4"]);

    const rows = await gmailRows();
    expect(rows.map((c) => c.id).sort()).toEqual(["t1", "t2", "t3", "t4"].map((t) => `gmail:${JEREMY_MAIL}:${t}`));
    expect(rows.find((c) => c.id.endsWith(":t1"))).toMatchObject({ from: "Dana Whitfield", ctx: "Thursday", direct: true, text: "Can we move it to 3pm?" });
    expect(rows.find((c) => c.id.endsWith(":t2"))).toMatchObject({ from: "Sam Ortiz", ctx: "Q4 numbers", direct: false, text: "See attached.\n\n(attached: q4.pdf)" });

    // Written to the owner by a person sorts like a direct message. Copied in, a newsletter or a promotion sorts low.
    await resortInbox(db, OWNER_ID);
    const sorted = await gmailRows();
    expect(["t1", "t2", "t3", "t4"].map((t) => sorted.find((c) => c.id.endsWith(`:${t}`))!.pri)).toEqual(["mid", "low", "low", "low"]);
  });

  it("reads only what arrived since the last run, and a thread again when a new email comes to it", async () => {
    const google = mailbox();
    const first = await gmailPull(ctx(), [account()], opener(google));
    google.opened.length = 0;
    expect(await gmailPull(ctx(first.cursor, NOW + 15 * MINUTE), [account()], opener(google))).toMatchObject({ items: 0, message: "0 new emails in 0 threads" });
    expect(google.opened).toEqual([]);

    google.deliver(mail("m2", "t1", { from: JEREMY, subject: "Re: Thursday", text: "Yes, works.", at: NOW + MINUTE, labels: ["SENT", "INBOX"] }));
    google.deliver(mail("m3", "t1", { from: DANA, subject: "Re: Thursday", text: "Great, sending the deck.\n\nOn Mon, Jeremy wrote:\n> Yes, works.", at: NOW + 2 * MINUTE }));
    const again = await gmailPull(ctx(first.cursor, NOW + 15 * MINUTE), [account()], opener(google));
    expect(again).toMatchObject({ items: 2, message: "2 new emails in 1 thread", cursor: { accounts: { [JEREMY_MAIL]: { history: "106" } } } });
    const dana = (await gmailRows()).find((c) => c.id.endsWith(":t1"))!;
    expect(dana).toMatchObject({ text: "Great, sending the deck.", replied: false });
    expect(dana.thread.map((m) => [m.me, m.text])).toEqual([[false, "Can we move it to 3pm?"], [true, "Yes, works."], [false, "Great, sending the deck."]]);
  });

  it("misses nothing when a lot arrives: the history is read page by page, and what does not fit in one run comes in the next", async () => {
    const google = fakeGoogle();
    google.pageSize = 7;
    for (let i = 1; i <= 53; i++) google.deliver(mail(`m${i}`, `t${i}`, { from: DANA, subject: `Note ${i}`, text: `Number ${i}`, at: NOW - 60 * MINUTE + i * 1000 }));
    const first = await gmailPull(ctx(), [account()], opener(google));
    expect(first).toMatchObject({ items: 50, message: "50 new emails in 50 threads. 3 more threads next time" });
    const second = await gmailPull(ctx(first.cursor, NOW + 15 * MINUTE), [account()], opener(google));
    expect(second).toMatchObject({ items: 3, message: "3 new emails in 3 threads", cursor: { accounts: { [JEREMY_MAIL]: { history: "153", pending: [] } } } });
    expect((await gmailRows()).length).toBe(53);
  });

  it("after a gap longer than Gmail keeps its history, looks by date from the last run", async () => {
    const google = mailbox();
    google.gone = true;
    const result = await gmailPull(ctx({ accounts: { [JEREMY_MAIL]: { history: "3", at: NOW - 9 * DAY } } }), [account()], opener(google));
    expect(google.queries).toEqual([`in:inbox after:${Math.floor((NOW - 9 * DAY - 10 * MINUTE) / 1000)}`]);
    expect(result).toMatchObject({ cursor: { accounts: { [JEREMY_MAIL]: { history: "104" } } } });
  });

  it("an account connected without Gmail's starting point begins from now", async () => {
    const google = mailbox();
    const result = await gmailPull(ctx(), [account(JEREMY_MAIL, { startHistory: null })], opener(google));
    expect(result).toMatchObject({ items: 0, cursor: { accounts: { [JEREMY_MAIL]: { history: "104" } } } });
    expect(google.opened).toEqual([]);
  });

  it("reads each connected account from its own mailbox, and keeps their rows apart", async () => {
    const mine = mailbox();
    const ops = fakeGoogle(OPS_MAIL);
    ops.deliver(mail("o1", "t1", { from: DANA, to: OPS_MAIL, subject: "Invoice", text: "Attached", at: NOW - MINUTE }));
    const result = await gmailPull(ctx(), [account(), account(OPS_MAIL)], opener(mine, ops));
    expect(result).toMatchObject({ items: 5, message: "5 new emails in 5 threads" });
    const rows = await gmailRows();
    expect(rows.filter((c) => c.id.endsWith(":t1")).map((c) => [c.id, c.ctx, c.direct]).sort()).toEqual([
      [`gmail:${JEREMY_MAIL}:t1`, "Thursday", true],
      [`gmail:${OPS_MAIL}:t1`, "Invoice", true],
    ]);
  });

  it("goes on with the other accounts when one has been signed out", async () => {
    const ops = fakeGoogle(OPS_MAIL);
    ops.deliver(mail("o1", "t1", { from: DANA, to: OPS_MAIL, text: "Hello", at: NOW }));
    const open = async (email: string) => {
      if (email === JEREMY_MAIL) throw new GoogleSaid("Google has signed jeremy@example.com out. Connect it again.");
      return ops;
    };
    const result = await gmailPull(ctx(), [account(), account(OPS_MAIL)], open);
    expect(result).toMatchObject({ items: 1, message: `1 new email in 1 thread. connect again: ${JEREMY_MAIL}` });
    expect(Object.keys(result.cursor!.accounts as object)).toEqual([OPS_MAIL]);
  });

  it("brings a cleared thread back when someone writes again", async () => {
    const google = mailbox();
    const first = await gmailPull(ctx(), [account()], opener(google));
    await applyAction(db, "markConversationDone", [`gmail:${JEREMY_MAIL}:t1`], OWNER_ID, new Date(NOW));
    google.deliver(mail("m5", "t1", { from: DANA, text: "One more thing", at: NOW + MINUTE }));
    await gmailPull(ctx(first.cursor, NOW + 5 * MINUTE), [account()], opener(google));
    expect((await gmailRows()).find((c) => c.id.endsWith(":t1"))).toMatchObject({ done: false, text: "One more thing" });
  });

  it("answers an email by email, never through Slack, whichever reply box is used", async () => {
    await connected();
    await gmailPull(ctx(), [account()], opener(mailbox()));
    await applyAction(db, "sendReply", [`gmail:${JEREMY_MAIL}:t1`, "Thanks", false, null], OWNER_ID, new Date(NOW));
    expect(await db.query("select source, target from outbox")).toEqual([{ source: "gmail", target: `${JEREMY_MAIL}:t1` }]);
  });
});

// ---------- The Calendar check ----------

describe("Calendar check", () => {
  const at = (ms: number) => ({ dateTime: new Date(ms).toISOString(), timeZone: "America/New_York" });
  const event = (id: string, start: number, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
    id, status: "confirmed", eventType: "default", summary: `Meeting ${id}`, start: at(start), end: at(start + 30 * MINUTE), htmlLink: `https://calendar.google.com/event?eid=${id}`, ...more,
  });
  const week = (): CalendarEvent[] => [
    event("call", NOW + HOUR, {
      summary: "Q4 review", hangoutLink: "https://meet.google.com/abc-defg-hij",
      attendees: [{ email: JEREMY_MAIL, self: true, responseStatus: "accepted" }, { email: "dana@example.com", displayName: "Dana Whitfield", responseStatus: "accepted" }, { email: OPS_MAIL, responseStatus: "accepted" }, { email: "room-1@resource.calendar.google.com", resource: true }],
    }),
    event("zoom", NOW + 26 * HOUR, { summary: "Podcast", location: "https://us02web.zoom.us/j/123", attendees: [{ email: JEREMY_MAIL, self: true, responseStatus: "tentative" }] }),
    event("focus", NOW + 4 * HOUR, { eventType: "focusTime", summary: "Deep work" }),
    { id: "trip", status: "confirmed", eventType: "outOfOffice", summary: "Away", start: { date: "2026-10-09" }, end: { date: "2026-10-11" } },
    event("declined", NOW + 2 * HOUR, { attendees: [{ email: JEREMY_MAIL, self: true, responseStatus: "declined" }] }),
    event("cancelled", NOW + 3 * HOUR, { status: "cancelled" }),
    { id: "bday", eventType: "birthday", summary: "Birthday", start: { date: "2026-10-09" }, end: { date: "2026-10-10" } },
    event("over", NOW - 2 * DAY),
  ];

  it("keeps what Google Calendar shows: meetings, all-day events, focus time and days away", () => {
    expect(week().filter(isShown).map((e) => e.id)).toEqual(["call", "zoom", "focus", "trip", "over"]);
    expect(toRows(JEREMY_MAIL, week()).find((r) => r.id === "trip")).toMatchObject({ all_day: true, kind: "outOfOffice", start_at: Date.parse("2026-10-09T00:00:00Z"), end_at: Date.parse("2026-10-11T00:00:00Z") });
    expect([joinLink(week()[0]), placeOf(joinLink(week()[0]), undefined)]).toEqual(["https://meet.google.com/abc-defg-hij", "Google Meet"]);
    expect([joinLink(week()[1]), placeOf(joinLink(week()[1]), week()[1].location)]).toEqual(["https://us02web.zoom.us/j/123", "Zoom"]);
    expect(placeOf(null, "Room 4, Main St")).toBe("Room 4, Main St");
  });

  it("keeps every connected calendar from last week to three weeks ahead, and a shared meeting once", async () => {
    await connected(JEREMY_MAIL);
    await connected(OPS_MAIL);
    const shared = event("call", NOW + HOUR, { summary: "Q4 review" });
    const result = await calendarPull(ctx(), [account(), account(OPS_MAIL)], opener(fakeGoogle(JEREMY_MAIL, week()), fakeGoogle(OPS_MAIL, [shared])));
    expect(result).toEqual({ items: 5, message: "5 events from 2 calendars, 2 meetings in the next two days. 3 left out: declined, cancelled and birthdays" });
    const { calendar } = await loadState(db, OWNER_ID, new Date(NOW));
    expect(calendar.map((e) => [e.title, e.kind, e.allDay, e.accounts])).toEqual([
      ["Meeting over", "meeting", false, [JEREMY_MAIL]],
      ["Q4 review", "meeting", false, [JEREMY_MAIL, OPS_MAIL]],
      ["Deep work", "focus", false, [JEREMY_MAIL]],
      ["Away", "away", true, [JEREMY_MAIL]],
      ["Podcast", "meeting", false, [JEREMY_MAIL]],
    ]);
    // The owner's other connected account is not listed as someone else in the meeting.
    expect(calendar.find((e) => e.title === "Q4 review")).toMatchObject({ who: "Dana Whitfield", where: "Google Meet", link: "https://meet.google.com/abc-defg-hij", response: "accepted", at: NOW + HOUR, end: NOW + HOUR + 30 * MINUTE });
  });

  it("replaces what it kept: a meeting that was cancelled or moved away is gone", async () => {
    await connected();
    await calendarPull(ctx(), [account()], opener(fakeGoogle(JEREMY_MAIL, week())));
    await calendarPull(ctx(), [account()], opener(fakeGoogle(JEREMY_MAIL, [week()[1]])));
    expect((await loadState(db, OWNER_ID, new Date(NOW))).calendar.map((m) => m.title)).toEqual(["Podcast"]);
  });

  it("says Now, Today or Tomorrow in the timezone of whoever is looking", () => {
    const now = new Date(2026, 9, 15, 10, 0);
    const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();
    expect(upcomingDay({ at: local(15, 9), end: local(15, 11) }, now)).toBe("Now");
    expect(upcomingDay({ at: local(15, 23), end: local(16, 0) }, now)).toBe("Today");
    expect(upcomingDay({ at: local(16, 8), end: local(16, 9) }, now)).toBe("Tomorrow");
    expect(upcomingDay({ at: local(17, 8), end: local(17, 9) }, now)).toBeNull();
  });
});

// ---------- The week view ----------

describe("the week view", () => {
  const item = (id: string, at: number, end: number, more: Partial<CalendarItem> = {}): CalendarItem => ({ id, accounts: [JEREMY_MAIL], title: id, at, end, allDay: false, kind: "meeting", who: "", where: "", eventId: id, mine: true, recurring: false, guests: [], ...more });
  const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

  it("starts each week on Sunday and names it", () => {
    // Thursday 15 October 2026.
    const start = weekStart(new Date(2026, 9, 15, 13, 30));
    expect([start.getDay(), start.getDate(), start.getHours()]).toEqual([0, 11, 0]);
    expect(weekDays(start).map((d) => d.getDate())).toEqual([11, 12, 13, 14, 15, 16, 17]);
    expect(weekTitle(start)).toBe("Oct 11 – 17, 2026");
    expect(weekTitle(new Date(2026, 8, 27))).toBe("Sep 27 – Oct 3, 2026");
    expect(weekTitle(new Date(2026, 11, 27))).toBe("Dec 27, 2026 – Jan 2, 2027");
  });

  it("puts meetings that overlap side by side, and the rest full width", () => {
    const day = new Date(2026, 9, 15);
    const placed = layDay([item("a", local(15, 9), local(15, 10)), item("b", local(15, 9, 30), local(15, 11)), item("c", local(15, 10), local(15, 10, 30)), item("d", local(15, 14), local(15, 15))], day);
    expect(placed.map((p) => [p.item.id, p.top, p.height, p.col, p.cols])).toEqual([
      ["a", 540, 60, 0, 2],
      ["b", 570, 90, 1, 2],
      ["c", 600, 30, 0, 2],
      ["d", 840, 60, 0, 1],
    ]);
  });

  it("cuts a meeting that crosses midnight at the end of each day, and shows all-day events on each of their days", () => {
    const late = item("late", local(15, 23), local(16, 1));
    expect(layDay([late], new Date(2026, 9, 15)).map((p) => [p.top, p.height, p.goesOn])).toEqual([[1380, 60, true]]);
    expect(layDay([late], new Date(2026, 9, 16)).map((p) => [p.top, p.height, p.fromBefore])).toEqual([[0, 60, true]]);
    const trip = item("trip", Date.parse("2026-10-15T00:00:00Z"), Date.parse("2026-10-17T00:00:00Z"), { allDay: true });
    expect([14, 15, 16, 17].map((d) => allDayOn([trip], new Date(2026, 9, d)).length)).toEqual([0, 1, 1, 0]);
    expect(layDay([trip], new Date(2026, 9, 15))).toEqual([]);
  });
});

// ---------- Disconnecting ----------

describe("disconnecting Google", () => {
  it("ends one account's login, forgets its place in the mailbox and its calendar, and with forget its emails too", async () => {
    await connected(JEREMY_MAIL);
    await connected(OPS_MAIL);
    const mine = fakeGoogle();
    mine.deliver(mail("m1", "t1", { from: DANA, text: "Hello", at: NOW }));
    const ops = fakeGoogle(OPS_MAIL, [{ id: "e1", status: "confirmed", summary: "Ops call", start: { dateTime: new Date(NOW + HOUR).toISOString() }, end: { dateTime: new Date(NOW + 2 * HOUR).toISOString() } }]);
    ops.deliver(mail("o1", "t1", { from: DANA, to: OPS_MAIL, text: "Hi ops", at: NOW }));
    const both = [account(), account(OPS_MAIL)];
    const read = await gmailPull(ctx(), both, opener(mine, ops));
    await db.run("update jobs set cursor = $2::jsonb where owner_id = $1 and job_id = 'gmail-pull'", [OWNER_ID, JSON.stringify(read.cursor)]);
    await calendarPull(ctx(), both, opener(fakeGoogle(JEREMY_MAIL, [{ id: "e2", status: "confirmed", summary: "My call", start: { dateTime: new Date(NOW + HOUR).toISOString() }, end: { dateTime: new Date(NOW + 2 * HOUR).toISOString() } }]), ops));

    const google = googleSays({ [REVOKE]: () => [200, {}] });
    await forgetGoogle(db, OWNER_ID, OPS_MAIL, false, google.fetchImpl);
    // Ended on Google's side too, for that account only.
    expect(google.calls.map((c) => [c.url, c.body.get("token")])).toEqual([[REVOKE, "refresh-ops@example.com"]]);
    expect((await db.query<{ email: string }>("select email from google_accounts")).map((r) => r.email)).toEqual([JEREMY_MAIL]);
    const [job] = await db.query<{ cursor: { accounts: Record<string, unknown> } }>("select cursor from jobs where job_id = 'gmail-pull'");
    expect(Object.keys(job.cursor.accounts)).toEqual([JEREMY_MAIL]);
    expect((await db.query<{ title: string }>("select title from calendar_events")).map((r) => r.title)).toEqual(["My call"]);
    expect((await db.query("select id from conversations where source = 'gmail'")).length).toBe(2);

    await forgetGoogle(db, OWNER_ID, JEREMY_MAIL, true, google.fetchImpl);
    expect((await db.query<{ id: string }>("select id from conversations where source = 'gmail'")).map((r) => r.id)).toEqual([`gmail:${OPS_MAIL}:t1`]);
    expect(await db.query("select id from messages where conversation_id like 'gmail:jeremy%'")).toEqual([]);
  });
});

// ---------- Sending email ----------

/** The written-out email, read back: its headers and its text. */
function readRaw(raw: string) {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const [head, body] = text.split("\r\n\r\n");
  const headers = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
  return { headers, lines: head.split("\r\n"), body: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8") };
}

describe("writing an email out", () => {
  it("writes plain text in UTF-8, with names quoted and other letters encoded, and no From for Gmail to fill in", () => {
    const out = readRaw(rawEmail({ to: [{ name: "Whitfield, Dana", email: "dana@example.com" }], cc: [{ name: "sam@example.com", email: "sam@example.com" }], subject: "Re: Café plans ☕", body: "Yes, 3pm.\nSee you." }));
    expect(out.headers).toMatchObject({ To: '"Whitfield, Dana" <dana@example.com>', Cc: "sam@example.com", Subject: `=?UTF-8?B?${Buffer.from("Re: Café plans ☕").toString("base64")}?=`, "Content-Type": 'text/plain; charset="UTF-8"' });
    expect(out.headers.From).toBeUndefined();
    expect(out.body).toBe("Yes, 3pm.\r\nSee you.");
  });

  it("keeps what was typed on one line, so it can never add a header of its own", () => {
    const out = readRaw(rawEmail({ to: [{ name: "Dana\r\nBcc: someone@example.com", email: "dana@example.com" }], cc: [], subject: "Hello\r\nBcc: someone@example.com", body: "Hi" }));
    expect(out.lines.filter((l) => l.startsWith("Bcc"))).toEqual([]);
    expect(out.headers.Subject).toBe("Hello Bcc: someone@example.com");
  });
});

describe("answering and writing email", () => {
  /** Two emails read into the inbox, from an account that may send. */
  async function inboxWithEmail() {
    await connected();
    const google = fakeGoogle();
    google.deliver(mail("m1", "t1", { from: DANA, subject: "Thursday", text: "Can we move it to 3pm?", at: NOW - 30 * MINUTE }));
    google.deliver(mail("n1", "t2", { from: "Sam Ortiz <sam@example.com>", to: "Team <team@example.com>, Jeremy Moser <jeremy@example.com>", cc: "Ines Marsh <ines@example.com>", subject: "Q4 numbers", text: "See attached.", at: NOW - 20 * MINUTE }));
    await gmailPull(ctx(), [account()], opener(google));
    return google;
  }
  const waiting = () => db.query<{ source: string; target: string; to_name: string; body: string; details: Record<string, unknown> }>("select source, target, to_name, body, details from outbox order by created_at");

  it("answers whoever wrote last, in the same thread, with Re: and the headers that keep it there", async () => {
    await inboxWithEmail();
    await applyAction(db, "replyEmail", [`gmail:${JEREMY_MAIL}:t1`, "Yes, 3pm works.", false, false], OWNER_ID, new Date(NOW));
    expect(await waiting()).toEqual([{
      source: "gmail", target: `${JEREMY_MAIL}:t1`, to_name: "Dana Whitfield", body: "Yes, 3pm works.",
      details: { account: JEREMY_MAIL, threadId: "t1", to: [{ name: "Dana Whitfield", email: "dana@example.com" }], cc: [], subject: "Re: Thursday", inReplyTo: "<m1@mail.example.com>", references: "<m1@mail.example.com>" },
    }]);
    const row = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === `gmail:${JEREMY_MAIL}:t1`)!;
    expect([row.replied, row.thread.at(-1)]).toMatchObject([true, { me: true, text: "Yes, 3pm works.", status: "queued" }]);
  });

  it("with Reply all, also copies everyone else the email was to, but not the owner's own account", async () => {
    await inboxWithEmail();
    await applyAction(db, "replyEmail", [`gmail:${JEREMY_MAIL}:t2`, "Thanks Sam", true, true], OWNER_ID, new Date(NOW));
    const [out] = await waiting();
    expect([out.to_name, out.details.to, out.details.cc]).toEqual(["Sam Ortiz and 2 more", [{ name: "Sam Ortiz", email: "sam@example.com" }], [{ name: "Team", email: "team@example.com" }, { name: "Ines Marsh", email: "ines@example.com" }]]);
  });

  it("goes out from the account into its thread once sending is on, and is not brought in a second time", async () => {
    const google = await inboxWithEmail();
    await applyAction(db, "replyEmail", [`gmail:${JEREMY_MAIL}:t1`, "Yes, 3pm works.", false, false], OWNER_ID, new Date(NOW));
    expect(await outboxSend(ctx(), null, null, opener(google))).toMatchObject({ items: 0, message: "1 waiting. Sending is switched off." });
    expect(google.sent).toEqual([]);

    process.env.SENDING_ENABLED = "true";
    expect(await outboxSend(ctx(), null, null, opener(google))).toMatchObject({ items: 1, message: "Sent 1 of 1" });
    expect(google.sent.map((s) => s.threadId)).toEqual(["t1"]);
    expect(readRaw(google.sent[0].raw)).toMatchObject({ headers: { To: '"Dana Whitfield" <dana@example.com>', Subject: "Re: Thursday", "In-Reply-To": "<m1@mail.example.com>" }, body: "Yes, 3pm works." });

    // Gmail now has the reply in the thread, under the id it gave it.
    google.deliver(mail("sent1", "t1", { from: JEREMY, subject: "Re: Thursday", text: "Yes, 3pm works.", at: NOW + MINUTE, labels: ["SENT", "INBOX"] }));
    await gmailPull(ctx((await db.query<{ cursor: Record<string, unknown> }>("select cursor from jobs where job_id = 'gmail-pull'"))[0].cursor, NOW + 5 * MINUTE), [account()], opener(google));
    const thread = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === `gmail:${JEREMY_MAIL}:t1`)!.thread;
    expect(thread.map((m) => [m.me, m.text, m.status ?? null])).toEqual([[false, "Can we move it to 3pm?", null], [true, "Yes, 3pm works.", "sent"]]);
  });

  it("writes a new email from a chosen account, and checks every address first", async () => {
    await connected();
    await expect(applyAction(db, "composeEmail", [JEREMY_MAIL, "dana@example.com, not-an-address", "", "Hi", "Hello"], OWNER_ID, new Date(NOW))).rejects.toThrow('"not-an-address" is not an email address.');
    await expect(applyAction(db, "composeEmail", [JEREMY_MAIL, "", "", "Hi", "Hello"], OWNER_ID, new Date(NOW))).rejects.toThrow("Who is it to?");
    await applyAction(db, "composeEmail", [JEREMY_MAIL, "Dana Whitfield <dana@example.com>; sam@example.com", "ines@example.com", "Q4 plan", "Draft attached soon."], OWNER_ID, new Date(NOW));
    const [out] = await waiting();
    expect(out).toMatchObject({ source: "gmail", target: JEREMY_MAIL, to_name: "Dana Whitfield and 2 more", details: { account: JEREMY_MAIL, subject: "Q4 plan", cc: [{ email: "ines@example.com" }] } });

    process.env.SENDING_ENABLED = "true";
    const google = fakeGoogle();
    await outboxSend(ctx(), null, null, opener(google));
    expect(google.sent.map((s) => [s.threadId, readRaw(s.raw).headers.To, readRaw(s.raw).headers.Cc])).toEqual([[undefined, '"Dana Whitfield" <dana@example.com>, sam@example.com', "ines@example.com"]]);
  });

  it("will not send from an account that did not allow sending", async () => {
    await connected(JEREMY_MAIL, [GMAIL_SCOPE, CALENDAR_SCOPE]);
    await expect(applyAction(db, "composeEmail", [JEREMY_MAIL, "dana@example.com", "", "Hi", "Hello"], OWNER_ID, new Date(NOW))).rejects.toThrow("Sending was not allowed for jeremy@example.com");
    await expect(applyAction(db, "composeEmail", [OPS_MAIL, "dana@example.com", "", "Hi", "Hello"], OWNER_ID, new Date(NOW))).rejects.toThrow("ops@example.com is not connected");
  });

  it("sends through Gmail's API, into the thread", async () => {
    await connected();
    const google = googleSays({
      [TOKEN]: () => [200, { access_token: "a" }],
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send": (_b, _u, headers) => [headers.get("content-type") === "application/json" ? 200 : 400, { id: "g1", threadId: "t1" }],
    });
    const api = await googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl);
    expect(await api.send("cmF3", "t1")).toEqual({ id: "g1", threadId: "t1" });
    expect([google.calls[1].headers.get("authorization"), JSON.parse(google.calls[1].text)]).toEqual(["Bearer a", { raw: "cmF3", threadId: "t1" }]);
  });
});

// ---------- Adding events ----------

describe("adding a calendar event", () => {
  const form = (more: Record<string, unknown> = {}) => ({ account: JEREMY_MAIL, title: "Podcast prep", start: NOW + 2 * HOUR, end: NOW + 2 * HOUR + 30 * MINUTE, timeZone: "America/New_York", guests: "dana@example.com, Jeremy@Example.com, dana@example.com", meet: true, description: "Talking points", ...more });

  it("adds it to the chosen calendar with its guests and a Meet link, and shows it straight away", async () => {
    await connected();
    process.env.SENDING_ENABLED = "true";
    const google = fakeGoogle();
    expect(await addCalendarEvent(db, OWNER_ID, form(), opener(google), NOW)).toEqual({ title: "Podcast prep", link: "https://meet.google.com/new-meet-abc" });
    // The owner is not invited to their own event, and nobody twice.
    expect(google.added).toEqual([{ title: "Podcast prep", start: NOW + 2 * HOUR, end: NOW + 2 * HOUR + 30 * MINUTE, timeZone: "America/New_York", guests: ["dana@example.com"], meet: true, description: "Talking points" }]);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).calendar).toMatchObject([{ title: "Podcast prep", where: "Google Meet", link: "https://meet.google.com/new-meet-abc", accounts: [JEREMY_MAIL] }]);
  });

  it("says what is wrong before anything reaches Google", async () => {
    await connected();
    process.env.SENDING_ENABLED = "true";
    const google = fakeGoogle();
    await expect(addCalendarEvent(db, OWNER_ID, form({ title: "  " }), opener(google))).rejects.toThrow("Give the event a title.");
    await expect(addCalendarEvent(db, OWNER_ID, form({ end: NOW }), opener(google))).rejects.toThrow("The event has to end after it starts.");
    await expect(addCalendarEvent(db, OWNER_ID, form({ guests: "dana@example" }), opener(google))).rejects.toThrow('"dana@example" is not an email address.');
    expect(google.added).toEqual([]);
  });

  it("needs sending switched on, and an account that allowed adding events", async () => {
    await connected(JEREMY_MAIL, [GMAIL_SCOPE, CALENDAR_SCOPE]);
    const google = fakeGoogle();
    await expect(addCalendarEvent(db, OWNER_ID, form(), opener(google))).rejects.toThrow("Sending is switched off");
    process.env.SENDING_ENABLED = "true";
    await expect(addCalendarEvent(db, OWNER_ID, form(), opener(google))).rejects.toThrow("Changing events was not allowed for jeremy@example.com");
    expect(google.added).toEqual([]);
  });

  it("asks Google for a Meet link and to send the invitations", async () => {
    await connected();
    const google = googleSays({
      [TOKEN]: () => [200, { access_token: "a" }],
      [EVENTS]: (_b, url) => [url.searchParams.get("conferenceDataVersion") === "1" && url.searchParams.get("sendUpdates") === "all" ? 200 : 400, { id: "e9", summary: "Call" }],
    });
    const api = await googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl);
    expect(await api.addEvent({ title: "Call", start: NOW, end: NOW + HOUR, timeZone: "UTC", guests: ["dana@example.com"], meet: true })).toMatchObject({ id: "e9" });
    const sent = JSON.parse(google.calls[1].text);
    expect([sent.summary, sent.attendees, sent.start, sent.conferenceData.createRequest.conferenceSolutionKey]).toEqual(["Call", [{ email: "dana@example.com" }], { dateTime: new Date(NOW).toISOString(), timeZone: "UTC" }, { type: "hangoutsMeet" }]);
  });
});

// ---------- Tags ----------

describe("email tags", () => {
  const tags = (o: { subject?: string; text?: string; senders?: string[]; bulk?: boolean; tab?: string }) =>
    emailTags({ subject: o.subject ?? "Hello", texts: [o.text ?? "Hi there"], senders: o.senders ?? ["dana@example.com"], bulk: o.bulk ?? false, tab: o.tab });

  it("tags payments by the subject, by a payment service sending it, or by money in a payment email", () => {
    expect(tags({ subject: "Your receipt from Harbor Realty" })).toEqual(["payment"]);
    expect(tags({ subject: "Invoice #1042 is due" })).toEqual(["payment"]);
    expect(tags({ senders: ["receipts@stripe.com"], bulk: true })).toEqual(["payment"]);
    expect(tags({ senders: ["service@intl.paypal.com"] })).toEqual(["payment"]);
    expect(tags({ subject: "Quick update", text: "The payment of $1,200.00 went through this morning." })).toEqual(["payment"]);
    // Money alone, or the word alone in the text, is not enough.
    expect(tags({ subject: "Quick update", text: "Tickets are $20 at the door." })).toEqual([]);
    expect(tags({ subject: "Quick update", text: "We talked about payment terms." })).toEqual([]);
  });

  it("tags subscriptions, but not a newsletter for saying where to unsubscribe", () => {
    expect(tags({ subject: "Your subscription renews on Nov 1" })).toEqual(["subscription"]);
    expect(tags({ subject: "Your free trial ends in 3 days" })).toEqual(["subscription"]);
    expect(tags({ subject: "Heads up", text: "Your plan will automatically renew next week." })).toEqual(["subscription"]);
    const footer = "This week's top stories.\nYou are receiving this because you subscribed. Manage your subscription or unsubscribe here.";
    expect(tags({ subject: "The weekly digest", text: footer, bulk: true })).toEqual(["newsletter"]);
    // A renewal receipt is both, and not a newsletter.
    expect(tags({ subject: "Receipt for your subscription renewal", bulk: true })).toEqual(["payment", "subscription"]);
  });

  it("tags newsletters: mailings, and Gmail's Promotions, Social and Forums tabs", () => {
    expect(tags({ bulk: true })).toEqual(["newsletter"]);
    expect(tags({ tab: "promotions" })).toEqual(["newsletter"]);
    expect(tags({ tab: "updates" })).toEqual([]);
    expect(tags({})).toEqual([]);
  });

  it("shows the tags on each email row", async () => {
    await connected();
    const google = fakeGoogle();
    google.deliver(mail("r1", "t1", { from: "Stripe <receipts@stripe.com>", subject: "Your receipt from Acme", text: "Amount paid $49.00", at: NOW - 3 * MINUTE }));
    google.deliver(mail("s1", "t2", { from: "Tools <billing@example.com>", subject: "Your free trial ends tomorrow", text: "Pick a plan", at: NOW - 2 * MINUTE }));
    google.deliver(mail("n1", "t3", { from: "News <news@example.com>", subject: "This week", text: "Read more\nUnsubscribe", at: NOW - MINUTE, headers: [["List-Unsubscribe", "<https://example.com/u>"]] }));
    google.deliver(mail("d1", "t4", { from: DANA, subject: "Thursday", text: "Can we move it?", at: NOW }));
    await gmailPull(ctx(), [account()], opener(google));
    const rows = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.filter((c) => c.source === "gmail");
    expect(["t1", "t2", "t3", "t4"].map((t) => rows.find((c) => c.id.endsWith(`:${t}`))!.tags)).toEqual([["payment"], ["subscription"], ["newsletter"], []]);
    // Chats carry no email tags.
    expect((await loadState(db, OWNER_ID, new Date(NOW))).inbox.filter((c) => c.source !== "gmail").every((c) => c.tags === undefined)).toBe(true);
  });
});

// ---------- Changing, deleting and answering events ----------

describe("changing, deleting and answering events", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const own = (): CalendarEvent => ({ id: "mine1", status: "confirmed", summary: "Team sync", organizer: { email: JEREMY_MAIL, self: true }, description: "Agenda", start: { dateTime: iso(NOW + HOUR) }, end: { dateTime: iso(NOW + 2 * HOUR) }, attendees: [{ email: JEREMY_MAIL, self: true, responseStatus: "accepted" }, { email: "dana@example.com", displayName: "Dana Whitfield", responseStatus: "accepted" }] });
  const invite = (): CalendarEvent => ({ id: "inv1", status: "confirmed", summary: "Podcast", organizer: { email: "sam@example.com", displayName: "Sam Ortiz" }, recurringEventId: "series1", start: { dateTime: iso(NOW + 3 * HOUR) }, end: { dateTime: iso(NOW + 4 * HOUR) }, attendees: [{ email: JEREMY_MAIL, self: true, responseStatus: "needsAction" }, { email: "sam@example.com", organizer: true, responseStatus: "accepted" }] });
  const form = (more: Record<string, unknown> = {}) => ({ account: JEREMY_MAIL, title: "Team sync, moved", start: NOW + 5 * HOUR, end: NOW + 6 * HOUR, timeZone: "UTC", guests: "dana@example.com, ines@example.com", meet: false, description: "New agenda", ...more });
  async function calendar() {
    await connected();
    process.env.SENDING_ENABLED = "true";
    const google = fakeGoogle(JEREMY_MAIL, [own(), invite()]);
    await calendarPull(ctx(), [account()], opener(google));
    return google;
  }
  const item = async (title: string) => (await loadState(db, OWNER_ID, new Date(NOW))).calendar.find((e) => e.title === title);

  it("knows which events the owner made, which are invitations, and which repeat", async () => {
    await calendar();
    expect(await item("Team sync")).toMatchObject({ eventId: "mine1", mine: true, recurring: false, description: "Agenda", guests: ["dana@example.com"] });
    expect(await item("Podcast")).toMatchObject({ eventId: "inv1", mine: false, recurring: true, response: "needsAction", organizer: "Sam Ortiz" });
  });

  it("changes an event the owner made, and shows the change straight away", async () => {
    const google = await calendar();
    expect(await updateCalendarEvent(db, OWNER_ID, "mine1", form(), opener(google), NOW)).toEqual({ title: "Team sync, moved" });
    expect(google.updated).toEqual([["mine1", { title: "Team sync, moved", start: NOW + 5 * HOUR, end: NOW + 6 * HOUR, timeZone: "UTC", guests: ["dana@example.com", "ines@example.com"], meet: false, description: "New agenda" }]]);
    expect(await item("Team sync, moved")).toMatchObject({ at: NOW + 5 * HOUR, mine: true });
    await expect(updateCalendarEvent(db, OWNER_ID, "inv1", form(), opener(google))).rejects.toThrow("Only whoever made an event can change it.");
  });

  it("deletes an event the owner made, but never someone else's", async () => {
    const google = await calendar();
    await expect(deleteCalendarEvent(db, OWNER_ID, JEREMY_MAIL, "inv1", opener(google))).rejects.toThrow("Only whoever made an event can delete it.");
    expect(await deleteCalendarEvent(db, OWNER_ID, JEREMY_MAIL, "mine1", opener(google))).toEqual({ title: "Team sync" });
    expect([google.deleted, await item("Team sync")]).toEqual([["mine1"], undefined]);
  });

  it("answers an invitation; one declined leaves the calendar here", async () => {
    const google = await calendar();
    await respondToEvent(db, OWNER_ID, JEREMY_MAIL, "inv1", "accepted", opener(google), NOW);
    expect((await item("Podcast"))?.response).toBe("accepted");
    await respondToEvent(db, OWNER_ID, JEREMY_MAIL, "inv1", "declined", opener(google), NOW);
    expect([google.answered, await item("Podcast")]).toEqual([[["inv1", "accepted"], ["inv1", "declined"]], undefined]);
    await expect(respondToEvent(db, OWNER_ID, JEREMY_MAIL, "mine1", "accepted", opener(google))).rejects.toThrow("This is an event you made");
  });

  it("does nothing while sending is switched off, since the guests or the organizer would be told", async () => {
    const google = await calendar();
    delete process.env.SENDING_ENABLED;
    await expect(deleteCalendarEvent(db, OWNER_ID, JEREMY_MAIL, "mine1", opener(google))).rejects.toThrow("Sending is switched off");
    await expect(respondToEvent(db, OWNER_ID, JEREMY_MAIL, "inv1", "accepted", opener(google))).rejects.toThrow("Sending is switched off");
    expect([google.deleted, google.answered]).toEqual([[], []]);
  });

  it("asks Google to change, delete and answer in the right way", async () => {
    await connected();
    const url = (id: string) => `https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`;
    const google = googleSays({
      [TOKEN]: () => [200, { access_token: "a" }],
      [url("mine1")]: (_b, u, _h, method) => (method === "GET" ? [200, own()] : method === "DELETE" ? [204, {}] : [u.searchParams.get("sendUpdates") === "all" ? 200 : 400, { id: "mine1" }]),
      [url("inv1")]: (_b, _u, _h, method) => (method === "GET" ? [200, invite()] : [200, { id: "inv1" }]),
      [url("alone")]: () => [200, { id: "alone", attendees: [] }],
    });
    const api = await googleApi(db, OWNER_ID, JEREMY_MAIL, google.fetchImpl);
    await api.updateEvent("mine1", { title: "Moved", start: NOW, end: NOW + HOUR, timeZone: "UTC", guests: ["dana@example.com", "ines@example.com"], meet: true });
    const change = JSON.parse(google.calls.find((c) => c.method === "PATCH")!.text);
    // The owner stays, Dana keeps her answer, Ines is added, and a Meet link is asked for.
    expect([change.summary, change.attendees, Boolean(change.conferenceData)]).toEqual(["Moved", [{ email: JEREMY_MAIL, self: true, responseStatus: "accepted" }, { email: "dana@example.com", displayName: "Dana Whitfield", responseStatus: "accepted" }, { email: "ines@example.com" }], true]);
    await api.deleteEvent("mine1");
    expect(google.calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).searchParams.get("sendUpdates"))).toEqual(["all"]);
    await api.respond("inv1", "tentative");
    const answer = JSON.parse(google.calls.filter((c) => c.method === "PATCH").at(-1)!.text);
    expect(answer.attendees).toEqual([{ email: JEREMY_MAIL, self: true, responseStatus: "tentative" }, { email: "sam@example.com", organizer: true, responseStatus: "accepted" }]);
    await expect(api.respond("alone", "accepted")).rejects.toThrow("This is an event you made");
  });
});
