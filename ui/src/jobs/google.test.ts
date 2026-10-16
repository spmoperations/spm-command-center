import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allDayOn, layDay, weekDays, weekStart, weekTitle } from "@/core/calendar";
import { upcomingDay } from "@/core/dates";
import type { CalendarItem } from "@/core/types";
import type { Db } from "@/server/db";
import { htmlToText, parseAddress, parseAddresses, readEmail, withoutQuoted, type GmailMessage, type GmailThread } from "@/server/gmail";
import {
  CALENDAR_SCOPE, finishGoogleLogin, GMAIL_SCOPE, GOOGLE_OFF_HERE, GOOGLE_SCOPES, googleApi, googleBlocked, GoogleSaid, HistoryGone, startGoogleLogin,
  type CalendarEvent, type GoogleAccount, type GoogleApi, type MailboxChanges,
} from "@/server/google";
import { googleCallback, googleLoginRedirect } from "@/server/google-routes";
import { applyAction, forgetGoogle, loadState, OWNER_ID, resortInbox } from "@/server/repo";
import { seal, unseal } from "@/server/secrets";
import { createSession, SESSION_COOKIE } from "@/server/session";
import { RateLimited, type Fetch } from "@/server/slack";
import { NOW, reset, testDb } from "@/server/testing";
import { calendarPull, isShown, joinLink, placeOf, toRows } from "./calendar";
import { gmailPull } from "./gmail";
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
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_HOSTED", "DATABASE_URL", "LOGIN_EMAIL", "LOGIN_PASSWORD"]) delete process.env[name];
});

// ---------- A pretend Gmail ----------

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** One Gmail message as the API returns it with format=full. */
function mail(id: string, threadId: string, o: { from: string; to?: string; cc?: string; subject?: string; text?: string; html?: string; at: number; labels?: string[]; headers?: [string, string][]; files?: string[] }): GmailMessage {
  const headers = [["From", o.from], ["To", o.to ?? "Jeremy Moser <jeremy@example.com>"], ["Subject", o.subject ?? "Thursday"], ...(o.cc ? [["Cc", o.cc]] : []), ...(o.headers ?? [])].map(([name, value]) => ({ name, value }));
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
  } satisfies GoogleApi & Record<string, unknown>;
  return fake;
}

const opener = (...fakes: ReturnType<typeof fakeGoogle>[]) => async (email: string) => fakes.find((f) => f.email === email)!;

/** A pretend Google for the login and the API: answers by address, and remembers what it was asked. */
function googleSays(routes: Record<string, (body: URLSearchParams, url: URL, headers: Headers) => [number, unknown]>) {
  const calls: { url: string; body: URLSearchParams; headers: Headers }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    calls.push({ url: url.toString(), body, headers });
    const route = routes[`${url.origin}${url.pathname}`];
    if (!route) throw new Error(`Unexpected request in a test: ${url}`);
    const [status, answer] = route(body, url, headers);
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
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
    expect([state.googleAvailable, state.connections.google.connected, state.googleAccounts, state.googleAllows]).toEqual([false, false, [], { gmail: false, calendar: false }]);
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
      scope: `${GMAIL_SCOPE} ${CALENDAR_SCOPE}`, access_type: "offline", prompt: "consent select_account", code_challenge_method: "S256",
    });
    expect(res.headers.get("set-cookie")).toMatch(/^cc_google_login=[^;]+; Path=\/api\/google; HttpOnly; SameSite=Lax; Max-Age=600$/);
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
      [{ email: JEREMY_MAIL, connectedAt: NOW + MINUTE, gmail: true, calendar: true }],
      { gmail: true, calendar: true },
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
    expect((await loadState(db, OWNER_ID, new Date(NOW))).googleAllows).toEqual({ gmail: false, calendar: true });
    // Gmail's check says why it does not run, without asking Google anything.
    const run = await runJob(db, "gmail-pull", OWNER_ID, NOW);
    expect([run.ok, run.message]).toEqual([false, "Gmail was not allowed for any connected Google account. Connect the account again and tick Gmail."]);

    const nothing = googleSays({ [TOKEN]: () => [200, { access_token: "a", refresh_token: "r2", scope: "openid" }], [REVOKE]: () => [200, {}] });
    const two = pending(NOW);
    await expect(finishGoogleLogin(db, OWNER_ID, new URLSearchParams({ state: two.state, code: "c" }), two.cookie, nothing.fetchImpl, NOW)).rejects.toThrow("Neither Gmail nor Calendar was allowed");
    // The login Google handed over is ended straight away.
    expect(nothing.calls.find((c) => c.url === REVOKE)!.body.get("token")).toBe("r2");
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

  it("is read-only: a reply to an email is refused, and the thread opens in Gmail instead", async () => {
    await gmailPull(ctx(), [account()], opener(mailbox()));
    await expect(applyAction(db, "sendReply", [`gmail:${JEREMY_MAIL}:t1`, "Thanks", false, null], OWNER_ID, new Date(NOW))).rejects.toThrow("Open it in Gmail to answer");
    expect(await db.query("select id from outbox")).toEqual([]);
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
  const item = (id: string, at: number, end: number, more: Partial<CalendarItem> = {}): CalendarItem => ({ id, accounts: [JEREMY_MAIL], title: id, at, end, allDay: false, kind: "meeting", who: "", where: "", ...more });
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
