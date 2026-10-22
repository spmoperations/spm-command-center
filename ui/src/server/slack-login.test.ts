// Connecting Slack with one click, through the team's Slack app, against a pretend Slack.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adoptSettingsKeys, keysProblem, saveKeys } from "./app-keys";
import type { Db } from "./db";
import { applyAction, loadState, OWNER_ID } from "./repo";
import { unseal } from "./secrets";
import { createSession, SESSION_COOKIE } from "./session";
import { checkSlackKeys, slackCallback, slackLoginRedirect } from "./slack-login";
import type { Fetch } from "./slack";
import { signInAs } from "./team";
import { reset, seed, testDb } from "./testing";

let db: Db;
const SITE = "http://127.0.0.1:3100";
const TEAM_APP = { clientId: "1111111111.2222222222", clientSecret: "0123456789abcdef0123456789abcdef" };
const ALEX = { email: "alex@example.com", password: "a long enough password" };

/** A Slack that answers the token swap and auth.test, and remembers what it was asked. */
function slackSays(access: (body: URLSearchParams) => Record<string, unknown>, who: Record<string, unknown> = { ok: true, user: "alex", user_id: "UALEX", team: "SPM", team_id: "T1" }) {
  const asked: { path: string; body: URLSearchParams; auth: string | null }[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "");
    asked.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    const json = url.pathname === "/api/oauth.v2.access" ? access(body) : url.pathname === "/api/auth.test" ? who : { ok: false, error: "unknown_method" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, asked };
}

const visit = (path: string, cookies: string[], site = "same-origin") => new Request(`${SITE}${path}`, { headers: { cookie: cookies.join("; "), host: "127.0.0.1:3100", "sec-fetch-site": site } });
const back = (res: Response) => {
  const to = new URL(res.headers.get("location")!);
  return { status: res.status, connected: to.searchParams.get("slack"), error: to.searchParams.get("slack_error") };
};

async function alexSession(): Promise<string> {
  await applyAction(db, "addTeamLogin", ["Alex", ALEX.email, ALEX.password], OWNER_ID, new Date());
  const who = await signInAs(() => Promise.resolve(db), ALEX.email, ALEX.password);
  return `${SESSION_COOKIE}=${createSession(ALEX.email, Date.now(), who!.mark)}`;
}

/** Starts a login as that session, and answers with Slack's address and the login cookie. */
async function start(session: string) {
  const res = await slackLoginRedirect(visit("/api/slack/start", [session]), Date.now(), db);
  const url = new URL(res.headers.get("location")!);
  const cookie = /cc_slack_login=[^;]+/.exec(res.headers.get("set-cookie") ?? "")?.[0] ?? "";
  return { res, url, cookie, state: url.searchParams.get("state") ?? "" };
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
  await seed(db);
});
afterEach(() => {
  for (const k of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "DATABASE_URL", "VERCEL"]) delete process.env[k];
});

describe("Connect Slack", () => {
  it("is not offered until the team's Slack app is saved, and sends the person back saying so", async () => {
    const session = await alexSession();
    expect((await loadState(db, OWNER_ID)).appKeys.slack.using).toBeNull();
    const { res } = await start(session);
    expect(back(res).error).toMatch(/not set up yet\. Paste a token instead/);
  });

  it("sends the person to Slack's own page for a user token only, from the team's app", async () => {
    await saveKeys(db, OWNER_ID, "slack", TEAM_APP, Date.now());
    const session = await alexSession();
    const { res, url, cookie } = await start(session);
    expect(res.status).toBe(302);
    expect(`${url.origin}${url.pathname}`).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe(TEAM_APP.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/slack/callback`);
    expect(url.searchParams.get("user_scope")).toContain("search:read");
    // Never a bot.
    expect(url.searchParams.has("scope")).toBe(false);
    expect(cookie).not.toContain(TEAM_APP.clientSecret);
    expect(res.headers.get("set-cookie")).toMatch(/Path=\/api\/slack; HttpOnly; SameSite=Lax; Max-Age=600$/);
    // Only from the dashboard's own button.
    expect(back(await slackLoginRedirect(visit("/api/slack/start", [session], "cross-site"), Date.now(), db)).error).toBe("Click Connect Slack on this page to connect.");
  });

  it("swaps Slack's code for the person's own token, keeps it as theirs, and leaves the owner's Slack as it was", async () => {
    await saveKeys(db, OWNER_ID, "slack", TEAM_APP, Date.now());
    const ownerSlack = await db.query("select * from connections where owner_id = $1", [OWNER_ID]);
    const session = await alexSession();
    const { cookie, state } = await start(session);
    const slack = slackSays(() => ({ ok: true, authed_user: { id: "UALEX", access_token: "xoxp-alex-token", token_type: "user" }, team: { id: "T1", name: "SPM" } }));
    const res = await slackCallback(visit(`/api/slack/callback?state=${state}&code=one-time`, [session, cookie]), { db, fetchImpl: slack.fetchImpl, firstRead: false });
    expect(back(res)).toEqual({ status: 302, connected: "connected", error: null });
    expect(res.headers.get("location")).toMatch(/#slack$/);
    // The code went with the team app's keys and the same address.
    const swap = slack.asked.find((a) => a.path === "/api/oauth.v2.access")!;
    expect([swap.body.get("client_id"), swap.body.get("client_secret"), swap.body.get("code"), swap.body.get("redirect_uri")]).toEqual([TEAM_APP.clientId, TEAM_APP.clientSecret, "one-time", `${SITE}/api/slack/callback`]);
    // The token was checked with Slack as hers, then kept sealed under her login.
    expect(slack.asked.find((a) => a.path === "/api/auth.test")!.auth).toBe("Bearer xoxp-alex-token");
    const alexId = (await db.query<{ id: string }>("select id from users where login_email = $1", [ALEX.email]))[0].id;
    const [row] = await db.query<{ secret: string; label: string }>("select secret, label from connections where owner_id = $1 and provider = 'slack'", [alexId]);
    expect([unseal(row.secret), row.label]).toEqual(["xoxp-alex-token", "alex · SPM"]);
    expect(await db.query("select * from connections where owner_id = $1", [OWNER_ID])).toEqual(ownerSlack);
    expect((await loadState(db, alexId)).connections.slack.connected).toBe(true);
  });

  it("refuses a login that was not started here, or by someone else, or that Slack was not allowed", async () => {
    await saveKeys(db, OWNER_ID, "slack", TEAM_APP, Date.now());
    const session = await alexSession();
    const { cookie, state } = await start(session);
    const slack = slackSays(() => ({ ok: true, authed_user: { access_token: "xoxp-x" } }));
    const answer = (query: string, cookies: string[]) => slackCallback(visit(`/api/slack/callback?${query}`, cookies), { db, fetchImpl: slack.fetchImpl, firstRead: false }).then(back);
    expect((await answer(`state=wrong&code=c`, [session, cookie])).error).toMatch(/timed out or did not start here/);
    expect((await answer(`state=${state}&code=c`, [session])).error).toMatch(/timed out or did not start here/);
    expect((await answer(`state=${state}&error=access_denied`, [session, cookie])).error).toBe("Slack was not allowed in, so nothing was connected.");
    // The owner signed in on the same browser cannot finish Alex's login as their own.
    const owner = `${SESSION_COOKIE}=${createSession("jeremy@example.com")}`;
    expect((await answer(`state=${state}&code=c`, [owner, cookie])).error).toMatch(/timed out or did not start here/);
    expect(slack.asked).toEqual([]);
  });

  it("says plainly when Slack does not know the address or the keys, and keeps nothing", async () => {
    await saveKeys(db, OWNER_ID, "slack", TEAM_APP, Date.now());
    const session = await alexSession();
    for (const [error, said] of [["bad_redirect_uri", "Redirect URLs, add http://127.0.0.1:3100/api/slack/callback"], ["invalid_client_id", "did not accept the app's keys"]]) {
      const { cookie, state } = await start(session);
      const slack = slackSays(() => ({ ok: false, error }));
      const res = await slackCallback(visit(`/api/slack/callback?state=${state}&code=c`, [session, cookie]), { db, fetchImpl: slack.fetchImpl, firstRead: false });
      expect(back(res).error).toContain(said);
    }
    expect((await db.query("select owner_id from connections where provider = 'slack' and owner_id <> $1", [OWNER_ID])).length).toBe(0);
  });
});

describe("the team's Slack app keys", () => {
  it("are checked with Slack before they are saved", async () => {
    const right = slackSays(() => ({ ok: false, error: "invalid_code" }));
    await expect(checkSlackKeys(TEAM_APP, `${SITE}/api/slack/callback`, right.fetchImpl)).resolves.toBeUndefined();
    const wrong = slackSays(() => ({ ok: false, error: "invalid_client_id" }));
    await expect(checkSlackKeys(TEAM_APP, `${SITE}/api/slack/callback`, wrong.fetchImpl)).rejects.toThrow("Slack does not know these keys");
    expect(keysProblem("slack", { clientId: "abc", clientSecret: TEAM_APP.clientSecret })).toMatch(/digits, a dot, digits/);
    expect(keysProblem("slack", { clientId: TEAM_APP.clientId, clientSecret: "short" })).toMatch(/32 letters and digits/);
  });

  it("can come from the server's settings, copied in once as the owner's", async () => {
    process.env.SLACK_CLIENT_ID = TEAM_APP.clientId;
    process.env.SLACK_CLIENT_SECRET = TEAM_APP.clientSecret;
    const notes = await adoptSettingsKeys(db);
    expect(notes.some((n) => n.startsWith("Slack:"))).toBe(true);
    expect((await loadState(db, OWNER_ID)).appKeys.slack).toEqual({ using: "own", label: "Client ID …2222", own: "Client ID …2222" });
  });
});
