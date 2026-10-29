// Task logins: someone on the team list signs in, with Google or a password, and sees only the
// tickets given to them. Nothing else of the dashboard opens for them, and nobody else's login changes.
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as googleCallbackRoute } from "@/app/api/google/callback/route";
import { POST as login } from "@/app/api/login/route";
import type { MyTask, TicketInput } from "@/core/types";
import { proxy } from "@/proxy";
import { saveKeys } from "./app-keys";
import type { Db } from "./db";
import { GOOGLE_SIGN_IN_COOKIE, googleSignInCallback, googleSignInOffered, googleSignInRedirect } from "./google-sign-in";
import { signedInAs } from "./http";
import { moveMyTask, myTasks as myTasksOf } from "./my-tasks";
import { applyAction, loadState, OWNER_ID, stateStamps } from "./repo";
import { clearFailures, createSession, readSession, SESSION_COOKIE } from "./session";
import type { Fetch } from "./slack";
import { memberOfSession } from "./task-logins";
import { NOW, reset, routesUse, seed, testDb } from "./testing";

let db: Db;
let alex = "";
const now = new Date(NOW);
const SITE = "http://127.0.0.1:3100";
const GOOGLE_APP = { clientId: "1234-test.apps.googleusercontent.com", clientSecret: "the-team-app-secret" };
const LUIS = { email: "luis@team.example.com", password: "luis long password" };

const myTasks = (request: Request) => myTasksOf(request, db);
const moveMine = (request: Request) => moveMyTask(request, db);
const act = (who: string, type: string, ...args: unknown[]) => applyAction(db, type, args, who, now);
const refused = (who: string, type: string, ...args: unknown[]) =>
  act(who, type, ...args).then(
    () => "done",
    (e: Error) => e.message,
  );
const ticket = (input: Partial<TicketInput>): TicketInput => ({ title: "Chase the invoices", description: "", assignee: null, client: "", due: "2026-10-10", status: "open", ...input });

/** The cookie a response sets, as a request sends it back. */
const cookieFrom = (res: Response, name: string) => new RegExp(`${name}=[^;]*`).exec(res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "")?.[0] ?? "";
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

const signIn = (email: string, password: string) =>
  login(new Request(`${SITE}/api/login`, { method: "POST", headers: { host: "127.0.0.1:3100", origin: SITE, "content-type": "application/json", "x-forwarded-for": "10.2.2.2" }, body: JSON.stringify({ email, password }) }));

const get = (path: string, cookie: string, site = "same-origin") => new Request(`${SITE}${path}`, { headers: { host: "127.0.0.1:3100", cookie, "sec-fetch-site": site } });
const post = (path: string, cookie: string, body: unknown, origin = SITE) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { host: "127.0.0.1:3100", cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

/** Luis on the team list (from the seed) can sign in to see his tasks. */
async function luisCookie(password = LUIS.password): Promise<string> {
  await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, password);
  const res = await signIn(LUIS.email, LUIS.password);
  expect(res.status).toBe(200);
  return cookieFrom(res, SESSION_COOKIE);
}

beforeAll(async () => {
  db = await testDb();
  routesUse(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  ["10.2.2.2", "everyone"].forEach(clearFailures);
  await reset(db);
  await seed(db);
  await act(OWNER_ID, "addTeamLogin", "Alex", "alex@example.com", "a long enough password");
  alex = (await db.query<{ id: string }>("select id from users where login_email = 'alex@example.com'"))[0].id;
});
afterEach(() => {
  for (const k of ["DATABASE_URL", "GOOGLE_HOSTED", "TEAM_GOOGLE_DOMAIN"]) delete process.env[k];
});

describe("giving someone on the team list a task login", () => {
  it("is the owner's alone, and checks the email and password", async () => {
    expect(await refused(alex, "setTaskLogin", "u_luis", LUIS.email, LUIS.password)).toBe("Only the owner can change who signs in.");
    expect(await refused(OWNER_ID, "setTaskLogin", "u_luis", "luis", LUIS.password)).toBe("That email address does not look right.");
    expect(await refused(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "short")).toMatch("at least 10 characters, or none for Google only");
    expect(await refused(OWNER_ID, "setTaskLogin", "u_nobody", LUIS.email, LUIS.password)).toBe("That person is no longer on the team list.");
    // Never the owner's own email, Alex's, or someone else's on the list.
    expect(await refused(OWNER_ID, "setTaskLogin", "u_luis", "Jeremy@Example.com", LUIS.password)).toBe("That is your own login.");
    expect(await refused(OWNER_ID, "setTaskLogin", "u_luis", "ALEX@example.com", LUIS.password)).toBe("Someone already signs in with that email.");
    await act(OWNER_ID, "setTaskLogin", "u_rene", "rene@example.com", "");
    expect(await refused(OWNER_ID, "setTaskLogin", "u_luis", "rene@example.com", LUIS.password)).toBe("Someone already signs in with that email.");
    // Nor can a team login be made on a task login's email.
    expect(await refused(OWNER_ID, "addTeamLogin", "Rene", "rene@example.com", "a long enough password")).toBe("Someone already signs in with that email.");
  });

  it("shows the owner, and only the owner, how each person signs in, never the password", async () => {
    await act(OWNER_ID, "setTaskLogin", "u_luis", " Luis@Team.Example.com ", LUIS.password);
    await act(OWNER_ID, "setTaskLogin", "u_rene", "rene@example.com", "");
    const owner = await loadState(db, OWNER_ID, now);
    expect(owner.team.map((p) => [p.name, p.taskLogin])).toEqual([
      ["Luis Ramos", { email: LUIS.email, password: true, lastIn: null }],
      ["Rene Park", { email: "rene@example.com", password: false, lastIn: null }],
    ]);
    expect(JSON.stringify(owner)).not.toMatch(/scrypt|luis long password/);
    expect((await loadState(db, alex, now)).team.some((p) => p.taskLogin)).toBe(false);
  });

  it("changes the owner's fingerprint of the small part, so their page shows it", async () => {
    const before = (await stateStamps(db, OWNER_ID, now)).rest;
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "");
    expect((await stateStamps(db, OWNER_ID, now)).rest).not.toBe(before);
  });

  it("goes when the person is taken off the team list", async () => {
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, LUIS.password);
    await act(OWNER_ID, "removePerson", "u_luis");
    expect(await db.query("select * from task_logins")).toEqual([]);
  });
});

describe("signing in with a password", () => {
  it("opens a session that is a task login's, and notes when", async () => {
    const cookie = await luisCookie();
    expect(readSession(tokenOf(cookie))).toMatchObject({ email: LUIS.email, member: true });
    expect(await memberOfSession(db, readSession(tokenOf(cookie)))).toEqual({ id: "u_luis", name: "Luis Ramos", email: LUIS.email });
    expect((await db.query<{ last_in: number }>("select last_in from task_logins"))[0].last_in).not.toBeNull();
  });

  it("refuses a wrong password, and any password for a Google-only login", async () => {
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, LUIS.password);
    expect((await signIn(LUIS.email, "not his password")).status).toBe(401);
    await act(OWNER_ID, "setTaskLogin", "u_rene", "rene@example.com", "");
    expect((await signIn("rene@example.com", "")).status).toBe(401);
    expect((await signIn("rene@example.com", "anything at all")).status).toBe(401);
  });

  it("leaves the owner's and Alex's sign-in as they were", async () => {
    await luisCookie();
    const owner = await signIn("jeremy@example.com", "the owner's password");
    expect(readSession(tokenOf(cookieFrom(owner, SESSION_COOKIE)))).toEqual({ email: "jeremy@example.com" });
    const hers = await signIn("alex@example.com", "a long enough password");
    expect(readSession(tokenOf(cookieFrom(hers, SESSION_COOKIE)))).not.toHaveProperty("member");
  });

  it("ends every session made before, when the login is changed or taken away", async () => {
    const cookie = await luisCookie();
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "a new long password");
    expect((await myTasks(get("/api/my-tasks", cookie))).status).toBe(401);
    const again = await luisCookie();
    await act(OWNER_ID, "removeTaskLogin", "u_luis");
    expect((await myTasks(get("/api/my-tasks", again))).status).toBe(401);
  });
});

describe("what a task login can open", () => {
  const visit = (path: string, token?: string) => proxy(new NextRequest(`${SITE}${path}`, { headers: { host: "127.0.0.1:3100", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) } }));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("is its own tasks and signing out; any other page opens its tasks, keeping a ticket's link", async () => {
    const token = tokenOf(await luisCookie());
    expect([passes(visit("/my-tasks", token)), passes(visit("/api/my-tasks", token)), passes(visit("/api/logout", token))]).toEqual([true, true, true]);
    expect(visit("/inbox", token).headers.get("location")).toBe(`${SITE}/my-tasks`);
    expect(visit("/tasks?task=SPM-3", token).headers.get("location")).toBe(`${SITE}/my-tasks?task=SPM-3`);
    expect(visit("/login", token).headers.get("location")).toBe(`${SITE}/my-tasks`);
    for (const api of ["/api/state", "/api/action", "/api/media", "/api/conversation", "/api/keys"]) expect(visit(api, token).status).toBe(403);
  });

  it("is refused by the routes themselves too, as nobody's", async () => {
    const cookie = await luisCookie();
    expect(await signedInAs(get("/api/state", cookie), db)).toBeNull();
  });

  it("is not where the owner goes: their page is the whole board", () => {
    expect(visit("/my-tasks", createSession("jeremy@example.com")).headers.get("location")).toBe(`${SITE}/tasks`);
    expect(visit("/my-tasks").headers.get("location")).toBe(`${SITE}/login?next=%2Fmy-tasks`);
    // A ticket's link still opens that ticket after signing in.
    expect(visit("/tasks?task=SPM-3").headers.get("location")).toBe(`${SITE}/login?next=%2Ftasks%3Ftask%3DSPM-3`);
  });

  it("never passes for a forged task session, nor one with no mark", async () => {
    const bare = Buffer.from(JSON.stringify({ email: LUIS.email, exp: Date.now() + 60_000, member: true })).toString("base64url");
    expect(readSession(`${bare}.forged`)).toBeNull();
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, LUIS.password);
    expect(await memberOfSession(db, { email: LUIS.email, member: true })).toBeNull();
    expect(await memberOfSession(db, { email: LUIS.email, mark: "made-up", member: true })).toBeNull();
  });
});

describe("their own tasks", () => {
  const listed = async (cookie: string) => (await (await myTasks(get("/api/my-tasks", cookie))).json()) as { name: string; tasks: MyTask[] };

  it("are the work tickets given to them, with who gave each and nothing about where it came from", async () => {
    await act(alex, "createTicket", ticket({ title: "Cut the Harbor reel", description: "Use the second take.", client: "Harbor Realty", assignee: "member:u_luis" }));
    await act(OWNER_ID, "createTicket", ticket({ title: "Pay the editors", assignee: "member:u_rene" }));
    await act(OWNER_ID, "createTicket", ticket({ title: "For nobody yet" }));
    await db.run("update tasks set src_quote = 'a private line', src_label = 'Slack · Maya', src_link = 'https://slack.example' where title = 'Cut the Harbor reel'");
    // A personal ticket is never shown, even when it is his.
    await db.run("insert into tasks (id, owner_id, title, dept, project, pri, due, created_at, mode, delegated_to) values ('t_home', $1, 'Pick up the dry cleaning', 'Operations', '', 'low', '2026-10-09', $2, 'personal', 'u_luis')", [OWNER_ID, NOW]);
    const mine = await listed(await luisCookie());
    expect(mine.name).toBe("Luis Ramos");
    expect(mine.tasks).toEqual([
      { id: expect.any(String), ticket: expect.stringMatching(/^SPM-\d+$/), title: "Cut the Harbor reel", description: "Use the second take.", client: "Harbor Realty", pri: "mid", due: "2026-10-10", status: "open", from: "Alex", doneAt: null },
    ]);
    expect(JSON.stringify(mine)).not.toMatch(/private line|slack\.example|Maya/);
  });

  it("move along the board under their name, and only their own", async () => {
    await act(OWNER_ID, "createTicket", ticket({ assignee: "member:u_luis" }));
    await act(OWNER_ID, "createTicket", ticket({ title: "Rene's", assignee: "member:u_rene" }));
    const [his, renes] = await db.query<{ id: string }>("select id from tasks where title in ('Chase the invoices', 'Rene''s') order by title");
    const cookie = await luisCookie();
    const res = await moveMine(post("/api/my-tasks", cookie, { id: his.id, status: "in_progress" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tasks: MyTask[] }).tasks[0].status).toBe("in_progress");
    const board = (await loadState(db, OWNER_ID, now)).tasks.find((t) => t.id === his.id)!;
    expect([board.status, board.history?.at(-1)]).toEqual(["in_progress", { at: expect.any(Number), by: "Luis Ramos", what: "Status: In progress" }]);
    // Done, and back.
    await moveMine(post("/api/my-tasks", cookie, { id: his.id, status: "done" }));
    expect((await db.query<{ done: boolean }>("select done from tasks where id = $1", [his.id]))[0].done).toBe(true);
    // Not someone else's, not a made-up status, not from another site.
    expect(await (await moveMine(post("/api/my-tasks", cookie, { id: renes.id, status: "done" }))).json()).toEqual({ error: "That task is no longer yours. Reload the page." });
    expect((await moveMine(post("/api/my-tasks", cookie, { id: his.id, status: "deleted" }))).status).toBe(400);
    expect((await moveMine(post("/api/my-tasks", cookie, { id: his.id, status: "open" }, "https://evil.example"))).status).toBe(403);
    expect((await db.query<{ status: string }>("select status from tasks where id = $1", [renes.id]))[0].status).toBe("open");
  });

  it("never show a call's recording, nor why the dashboard found the task; the board keeps both", async () => {
    // A call's action item, accepted for Luis with a note, as the Review tab fills it in.
    const why = 'Fathom listed this for Luis Ramos on "SPM Ops".';
    await db.run(
      "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, created_at) values ('s_call', $1, 'Cut the reel', 'Operations', '', 'mid', '2026-10-10', $2, 'meeting', 'fathom:1', 'fathom:1:action:0', $3)",
      [OWNER_ID, why, NOW],
    );
    const written = `${why}\n\nUse the second take. WATCH: https://fathom.video/calls/876?timestamp=12.5\nAlso https://fathom.video/share/abc`;
    await act(OWNER_ID, "acceptSuggestion", "s_call", { assignee: "member:u_luis", description: written });
    const mine = await listed(await luisCookie());
    expect(mine.tasks.map((t) => [t.title, t.description])).toEqual([["Cut the reel", "Use the second take.\nAlso"]]);
    expect(JSON.stringify(mine)).not.toMatch(/fathom|SPM Ops/i);
    // Jeremy's board still has all of it.
    expect((await loadState(db, OWNER_ID, now)).tasks.find((t) => t.title === "Cut the reel")!.description).toBe(written);
  });

  it("keep what they finished for two weeks", async () => {
    await act(OWNER_ID, "createTicket", ticket({ assignee: "member:u_luis", status: "done" }));
    await db.run("update tasks set done_at = $1", [Date.now() - 13 * 86_400_000]);
    const cookie = await luisCookie();
    expect((await listed(cookie)).tasks.map((t) => t.status)).toEqual(["done"]);
    await db.run("update tasks set done_at = $1", [Date.now() - 15 * 86_400_000]);
    expect((await listed(cookie)).tasks).toEqual([]);
  });
});

describe("signing in with Google", () => {
  /** A Google that answers the code swap with who signed in, and remembers what it was asked. */
  function googleSays(claims: Record<string, unknown> | ((nonce: string) => Record<string, unknown>), status = 200) {
    const asked: URLSearchParams[] = [];
    let nonce = "";
    const fetchImpl: Fetch = async (input, init) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      asked.push(new URLSearchParams(String(init?.body)));
      const body = typeof claims === "function" ? claims(nonce) : claims;
      const idToken = ["header", Buffer.from(JSON.stringify(body)).toString("base64url"), "signature"].join(".");
      return new Response(JSON.stringify(status === 200 ? { id_token: idToken, access_token: "short-lived" } : { error: "invalid_grant" }), { status });
    };
    return { fetchImpl, asked, use: (n: string) => (nonce = n) };
  }
  const good = (email: string) => (nonce: string) => ({ iss: "https://accounts.google.com", aud: GOOGLE_APP.clientId, exp: Math.floor(Date.now() / 1000) + 3600, email, email_verified: true, nonce });

  /** Presses the button: Google's page, the sign-in's cookie, and its state and nonce. */
  async function start(next = "/my-tasks") {
    const res = await googleSignInRedirect(get(`/api/login/google?next=${encodeURIComponent(next)}`, ""), db);
    const url = new URL(res.headers.get("location")!);
    return { res, url, cookie: cookieFrom(res, GOOGLE_SIGN_IN_COOKIE), state: url.searchParams.get("state") ?? "", nonce: url.searchParams.get("nonce") ?? "" };
  }
  const back = (res: Response) => res.headers.get("location");

  it("is offered only once the team has Google's keys, and only where Google may be used", async () => {
    const offered = () => googleSignInOffered(db);
    expect(await offered()).toBe(false);
    expect(back((await start()).res)).toBe(`${SITE}/login?error=google-off`);
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    expect(await offered()).toBe(true);
    // A developer's machine pointed at the hosted database.
    process.env.DATABASE_URL = "postgres://hosted.example/db";
    expect(await offered()).toBe(false);
    process.env.GOOGLE_HOSTED = "true";
    expect(await offered()).toBe(true);
  });

  it("asks Google for the account's address alone, and comes back the way Connect Google does", async () => {
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    const { res, url, cookie } = await start();
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(["client_id", "redirect_uri", "scope", "prompt", "code_challenge_method"].map((k) => [k, url.searchParams.get(k)]))).toEqual({
      client_id: GOOGLE_APP.clientId,
      redirect_uri: `${SITE}/api/google/callback`,
      scope: "openid email",
      prompt: "select_account",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("access_type")).toBe(false);
    expect(cookie).not.toContain(GOOGLE_APP.clientSecret);
    expect(res.headers.get("set-cookie")).toMatch(/Path=\/api\/google; HttpOnly; SameSite=Lax; Max-Age=600$/);
    // Only from the login page's own button.
    expect(back(await googleSignInRedirect(get("/api/login/google", "", "cross-site"), db))).toBe(`${SITE}/login?error=google-again`);
  });

  it("signs in the person whose task login is that account, and keeps nothing of Google's", async () => {
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "");
    const { cookie, state, nonce } = await start("/tasks?task=SPM-3");
    const google = googleSays(good("Luis@Team.Example.com"));
    google.use(nonce);
    const res = await googleSignInCallback(get(`/api/google/callback?state=${state}&code=one-time`, cookie, "cross-site"), db, { fetchImpl: google.fetchImpl });
    expect(back(res)).toBe(`${SITE}/tasks?task=SPM-3`);
    const session = readSession(tokenOf(cookieFrom(res, SESSION_COOKIE)));
    expect(session).toMatchObject({ email: LUIS.email, member: true });
    expect(await memberOfSession(db, session)).toMatchObject({ id: "u_luis" });
    expect(cookieFrom(res, GOOGLE_SIGN_IN_COOKIE)).toBe(`${GOOGLE_SIGN_IN_COOKIE}=`);
    // The code went with the team's keys, the same way back and the sign-in's own check.
    expect(Object.fromEntries(["client_id", "client_secret", "redirect_uri", "code"].map((k) => [k, google.asked[0].get(k)]))).toEqual({
      client_id: GOOGLE_APP.clientId,
      client_secret: GOOGLE_APP.clientSecret,
      redirect_uri: `${SITE}/api/google/callback`,
      code: "one-time",
    });
    expect(google.asked[0].get("code_verifier")).toBeTruthy();
    expect(await db.query("select * from google_accounts")).toEqual([]);
  });

  it("goes through Google's way back, which still connects Google as before when it is not a sign-in", async () => {
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "");
    const { cookie, state } = await start();
    // The real route, with the real Google out of reach: the swap fails, and it says so on the login page.
    const failing = await googleCallbackRoute(get(`/api/google/callback?state=${state}&error=access_denied`, cookie, "cross-site"));
    expect(back(failing)).toBe(`${SITE}/login?error=google-denied`);
    // No sign-in cookie, or another state: Connect Google's own answer.
    const connect = await googleCallbackRoute(get(`/api/google/callback?state=other&code=x`, cookie, "cross-site"));
    expect(back(connect)).toMatch(/\/connections\?google_error=/);
  });

  it("turns away an account with no task login, and anything Google did not plainly say", async () => {
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "");
    const answer = async (claims: (nonce: string) => Record<string, unknown>, status = 200) => {
      const { cookie, state, nonce } = await start();
      const google = googleSays(claims, status);
      google.use(nonce);
      const res = await googleSignInCallback(get(`/api/google/callback?state=${state}&code=c`, cookie, "cross-site"), db, { fetchImpl: google.fetchImpl });
      expect(cookieFrom(res, SESSION_COOKIE)).toBe("");
      return back(res)?.replace(`${SITE}/login?error=`, "");
    };
    // Jeremy and Alex sign in with their email and password, as before.
    expect(await answer(good("jeremy@example.com"))).toBe("google-login");
    expect(await answer(good("alex@example.com"))).toBe("google-login");
    expect(await answer(good("someone@team.example.com"))).toBe("google-none");
    expect(await answer((n) => ({ ...good(LUIS.email)(n), email_verified: false }))).toBe("google-failed");
    expect(await answer((n) => ({ ...good(LUIS.email)(n), aud: "another-app" }))).toBe("google-failed");
    expect(await answer((n) => ({ ...good(LUIS.email)(n), iss: "https://evil.example" }))).toBe("google-failed");
    expect(await answer((n) => ({ ...good(LUIS.email)(n), nonce: `${n}x` }))).toBe("google-failed");
    expect(await answer((n) => ({ ...good(LUIS.email)(n), exp: 1 }))).toBe("google-failed");
    expect(await answer(good(LUIS.email), 400)).toBe("google-failed");
    // An old or stolen cookie, or none.
    const { state } = await start();
    expect(back(await googleSignInCallback(get(`/api/google/callback?state=${state}&code=c`, "", "cross-site"), db))).toBe(`${SITE}/login?error=google-again`);
    const late = await start();
    expect(back(await googleSignInCallback(get(`/api/google/callback?state=${late.state}&code=c`, late.cookie), db, { now: Date.now() + 11 * 60_000 }))).toBe(`${SITE}/login?error=google-again`);
  });

  it("never sends the person to another site afterwards", async () => {
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    await act(OWNER_ID, "setTaskLogin", "u_luis", LUIS.email, "");
    for (const next of ["//evil.example", "/\t/evil.example", "https://evil.example", "/\\evil.example"]) {
      const { cookie, state, nonce } = await start(next);
      const google = googleSays(good(LUIS.email));
      google.use(nonce);
      const res = await googleSignInCallback(get(`/api/google/callback?state=${state}&code=c`, cookie), db, { fetchImpl: google.fetchImpl });
      expect(new URL(back(res)!).origin).toBe(SITE);
    }
  });
});

describe("signing in with a Google account of the team's own Workspace", () => {
  const TEAM_DOMAIN = "team.example.com";
  /** Google's answer for an account; `hd` is the Workspace Google says it belongs to. */
  const claims = (email: string, hd: string | null, nonce: string) => ({ iss: "https://accounts.google.com", aud: GOOGLE_APP.clientId, exp: Math.floor(Date.now() / 1000) + 3600, email, email_verified: true, nonce, ...(hd ? { hd } : {}) });

  /** Signs in with Google as that account, end to end against a pretend Google. Answers where it ended and the session. */
  async function viaGoogle(email: string, hd: string | null = TEAM_DOMAIN) {
    const started = await googleSignInRedirect(get("/api/login/google", ""), db);
    const url = new URL(started.headers.get("location")!);
    const fetchImpl: Fetch = async () => new Response(JSON.stringify({ id_token: ["h", Buffer.from(JSON.stringify(claims(email, hd, url.searchParams.get("nonce")!))).toString("base64url"), "s"].join(".") }), { status: 200 });
    const res = await googleSignInCallback(get(`/api/google/callback?state=${url.searchParams.get("state")}&code=c`, cookieFrom(started, GOOGLE_SIGN_IN_COOKIE), "cross-site"), db, { fetchImpl });
    const session = readSession(tokenOf(cookieFrom(res, SESSION_COOKIE)));
    return { to: res.headers.get("location")!.replace(SITE, ""), session, member: await memberOfSession(db, session) };
  }

  beforeEach(async () => {
    process.env.TEAM_GOOGLE_DOMAIN = TEAM_DOMAIN;
    await saveKeys(db, OWNER_ID, "google", GOOGLE_APP, NOW);
    // The team's Slack: Luis (on the team list, from the seed), Dana (not on it yet), and the owner.
    await db.run(
      `insert into slack_users (owner_id, id, name, email) values ($1, 'ULUIS', 'Luis Ramos', 'Luis@Team.Example.com'), ($1, 'UDANA', 'Dana Okafor', 'dana@team.example.com'),
       ($1, 'UME', 'Jeremy Moser', 'jeremy@example.com'), ($1, 'UGONE', 'Gone Person', 'gone@team.example.com')`,
      [OWNER_ID],
    );
    await db.run("update slack_users set deleted = true where id = 'UGONE'");
  });

  it("needs no login given first: someone on the team list, by their Slack account's address", async () => {
    const first = await viaGoogle("luis@team.example.com");
    expect([first.to, first.session?.member, first.member]).toEqual(["/my-tasks", true, { id: "u_luis", name: "Luis Ramos", email: "luis@team.example.com" }]);
    // Kept like any other login, for Google only, and shown to the owner.
    const owner = await loadState(db, OWNER_ID, now);
    expect(owner.team.find((p) => p.id === "u_luis")?.taskLogin).toEqual({ email: "luis@team.example.com", password: false, lastIn: expect.any(Number) });
    // The next time, the same login.
    expect((await viaGoogle("luis@team.example.com")).member?.id).toBe("u_luis");
    expect(await db.query("select member_id from task_logins")).toEqual([{ member_id: "u_luis" }]);
  });

  it("adds someone on the team's Slack who is not on the team list yet, as picking them from Slack does", async () => {
    const dana = await viaGoogle("dana@team.example.com");
    expect(dana.member?.name).toBe("Dana Okafor");
    expect(await db.query("select name, role, slack_user_id from team_members where id = $1", [dana.member!.id])).toEqual([{ name: "Dana Okafor", role: "Team member", slack_user_id: "UDANA" }]);
    // A ticket given to her from Slack is hers.
    await act(OWNER_ID, "createTicket", ticket({ title: "Dana's", assignee: "slack:UDANA" }));
    const mine = (await (await myTasks(get("/api/my-tasks", `${SESSION_COOKIE}=${createSession(dana.session!.email, Date.now(), dana.session!.mark, true)}`))).json()) as { tasks: MyTask[] };
    expect(mine.tasks.map((t) => t.title)).toEqual(["Dana's"]);
  });

  it("is only for the team's Workspace by Google's word, someone on its Slack, and never Jeremy's or Alex's own address", async () => {
    const people = async () => (await db.query<{ n: number }>("select count(*)::int as n from team_members"))[0].n;
    const before = await people();
    // The right address, but Google does not say it is the team's Workspace.
    expect((await viaGoogle("luis@team.example.com", null)).to).toBe("/login?error=google-none");
    // Another Workspace.
    expect((await viaGoogle("luis@team.example.com", "elsewhere.example.com")).to).toBe("/login?error=google-none");
    // In the Workspace but not on the team's Slack, or gone from it.
    expect((await viaGoogle("nobody@team.example.com")).to).toBe("/login?error=google-none");
    expect((await viaGoogle("gone@team.example.com")).to).toBe("/login?error=google-none");
    // The owner's address, even in the Workspace and on Slack: the password, as before.
    process.env.TEAM_GOOGLE_DOMAIN = "example.com";
    expect((await viaGoogle("jeremy@example.com", "example.com")).to).toBe("/login?error=google-login");
    expect((await viaGoogle("alex@example.com", "example.com")).to).toBe("/login?error=google-login");
    expect([await people(), await db.query("select * from task_logins")]).toEqual([before, []]);
  });

  it("signs in someone given a login of their own before with it, and leaves it as it was", async () => {
    await act(OWNER_ID, "setTaskLogin", "u_luis", "luis.home@example.org", LUIS.password);
    const login = () => db.query("select member_id, email, password_hash, since from task_logins");
    const [kept] = await login();
    const luis = await viaGoogle("luis@team.example.com");
    expect([luis.member?.id, luis.session?.email]).toEqual(["u_luis", "luis.home@example.org"]);
    expect(await login()).toEqual([kept]);
  });

  it("can be taken away by the owner, which signs them out until they sign in with Google again", async () => {
    const luis = await viaGoogle("luis@team.example.com");
    await act(OWNER_ID, "removeTaskLogin", "u_luis");
    expect(await memberOfSession(db, luis.session)).toBeNull();
    expect((await viaGoogle("luis@team.example.com")).member?.id).toBe("u_luis");
  });
});
