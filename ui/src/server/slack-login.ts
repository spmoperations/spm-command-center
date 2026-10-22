// Connecting Slack with one click, through one Slack app for the whole team: the person goes to
// Slack's own page, allows the app, and comes back with a token of their own (a user token,
// xoxp-), so their messages are read and their replies sent as them. The token is then checked and
// kept exactly as a pasted one is (see connections.ts). Pasting a token still works as before.
//
// The app's Client ID and Client Secret are app keys (see app-keys.ts): the owner's, which
// everyone uses. The app's OAuth & Permissions page must list the address Slack sends people
// back to, ending /api/slack/callback, on https.
//
// Both stops are page visits (GET): the button, and the way back from Slack.
import crypto from "node:crypto";
import { after } from "next/server";
import { SLACK_USER_SCOPES } from "@/core/providers";
import { runNow } from "@/jobs/runner";
import { keysById, keysForNew, type SlackKeys } from "./app-keys";
import { ready } from "./boot";
import { connect, ConnectionError } from "./connections";
import type { Db } from "./db";
import { cookieValue, sameSite, signedInAs, siteOf } from "./http";
import { seal, unseal } from "./secrets";
import { isHttps } from "./session";
import type { Fetch } from "./slack";

export const SLACK_LOGIN_COOKIE = "cc_slack_login";
const AUTHORIZE = "https://slack.com/oauth/v2/authorize";
const ACCESS = "https://slack.com/api/oauth.v2.access";
const LOGIN_MINUTES = 10;
const AGAIN = "That Slack login has timed out or did not start here. Click Connect Slack again.";

/** Something already put in words for the person. */
export class SlackSaid extends Error {}

const callbackOf = (site: string) => `${site}/api/slack/callback`;

async function oauthAccess(fetchImpl: Fetch, keys: SlackKeys, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchImpl(ACCESS, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: keys.clientId, client_secret: keys.clientSecret, ...fields }).toString(),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Slack names wrong keys only when a real code comes with them: with a made-up one it says the
 * code is wrong whatever the keys, so keys cannot be checked before they are saved. A wrong Client
 * ID or Secret shows on the first Connect Slack instead, in plain words.
 */
const wrongKeys = (error: unknown) => error === "invalid_client_id" || error === "bad_client_secret" || error === "invalid_client";

/** Where to send the person to connect, and the cookie that remembers this login until Slack sends them back. */
export async function startSlackLogin(db: Db, ownerId: string, site: string, secure: boolean, now = Date.now()): Promise<{ url: string; cookie: string }> {
  const keys = await keysForNew(db, ownerId, "slack");
  if (!keys) throw new SlackSaid("Connecting Slack with one click is not set up yet. Paste a token instead, as the steps on the Connections page say.");
  const state = crypto.randomBytes(24).toString("base64url");
  const redirect = callbackOf(site);
  const url = new URL(AUTHORIZE);
  // Only a user token: the app acts as the person, never as a bot.
  url.search = new URLSearchParams({ client_id: keys.keys.clientId, user_scope: SLACK_USER_SCOPES.join(","), redirect_uri: redirect, state }).toString();
  const cookie = `${SLACK_LOGIN_COOKIE}=${seal(JSON.stringify({ v: 1, state, redirect, at: now, owner: ownerId, keyId: keys.id }))}; Path=/api/slack; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_MINUTES * 60}${secure ? "; Secure" : ""}`;
  return { url: url.toString(), cookie };
}

export const clearedSlackCookie = (secure: boolean) => `${SLACK_LOGIN_COOKIE}=; Path=/api/slack; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

/** Slack's answer: the one-time code is swapped for the person's own token, which is checked and kept. */
export async function finishSlackLogin(db: Db, ownerId: string, answer: URLSearchParams, cookie: string | undefined, fetchImpl: Fetch = fetch, now = Date.now()): Promise<{ label: string }> {
  let pending: { v: number; state: string; redirect: string; at: number; owner?: string; keyId?: string | null };
  try {
    pending = JSON.parse(unseal(cookie ?? ""));
  } catch {
    throw new SlackSaid(AGAIN);
  }
  if (pending.v !== 1 || now - pending.at > LOGIN_MINUTES * 60_000 || now < pending.at || pending.owner !== ownerId) throw new SlackSaid(AGAIN);
  const state = answer.get("state") ?? "";
  if (state.length !== pending.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) throw new SlackSaid(AGAIN);
  const refused = answer.get("error");
  if (refused) throw new SlackSaid(refused === "access_denied" ? "Slack was not allowed in, so nothing was connected." : `Slack did not connect: ${refused}.`);
  const code = answer.get("code");
  if (!code) throw new SlackSaid(AGAIN);
  const keys = await keysById(db, ownerId, "slack", pending.keyId);
  if (!keys) throw new SlackSaid(AGAIN);

  const body = await oauthAccess(fetchImpl, keys.keys, { code, redirect_uri: pending.redirect });
  if (body.ok !== true) {
    if (wrongKeys(body.error)) throw new SlackSaid("Slack did not accept the app's keys. The owner can check the Client ID and Client Secret.");
    if (body.error === "bad_redirect_uri") throw new SlackSaid(`Slack does not know this address. In the Slack app, under OAuth & Permissions, Redirect URLs, add ${pending.redirect}`);
    if (body.error === "invalid_team_for_non_distributed_app") throw new SlackSaid("That Slack app belongs to another workspace. Pick the Social Profit Media Clients workspace at the top right of Slack's page.");
    throw new SlackSaid(`Slack did not connect (${String(body.error ?? "no answer")}). Click Connect Slack again.`);
  }
  const user = (body.authed_user ?? {}) as { access_token?: unknown; token_type?: unknown };
  if (typeof user.access_token !== "string" || !user.access_token.startsWith("xoxp-")) throw new SlackSaid("Slack did not hand over a token for you. Click Connect Slack again, and click Allow.");
  try {
    return await connect(db, ownerId, "slack", user.access_token, fetchImpl);
  } catch (error) {
    throw new SlackSaid(error instanceof ConnectionError ? error.message : `Slack could not be connected: ${(error as Error).message}`);
  }
}

/** Back to the Connections page, with how it went in the address for the page to show. */
function backToConnections(request: Request, outcome: { label: string } | { error: string }, cookie?: string): Response {
  const to = new URL("/connections", siteOf(request));
  if ("error" in outcome) to.searchParams.set("slack_error", outcome.error);
  else to.searchParams.set("slack", "connected");
  to.hash = "slack";
  const headers = new Headers({ location: to.toString(), "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

const said = (error: unknown) => (error instanceof SlackSaid ? error.message : `Slack could not be connected: ${error instanceof Error ? error.message : String(error)}`);

/** The Connect Slack button: sends the person to Slack's own page. */
export async function slackLoginRedirect(request: Request, now = Date.now(), given?: Db): Promise<Response> {
  const owner = await signedInAs(request, given);
  if (!owner) return backToConnections(request, { error: "Please sign in, then click Connect Slack again." });
  if (!sameSite(request)) return backToConnections(request, { error: "Click Connect Slack on this page to connect." });
  try {
    const { url, cookie } = await startSlackLogin(given ?? (await ready()), owner, siteOf(request), isHttps(request), now);
    return new Response(null, { status: 302, headers: { location: url, "set-cookie": cookie, "cache-control": "no-store" } });
  } catch (error) {
    return backToConnections(request, { error: said(error) });
  }
}

/** Where Slack sends the person back to. The tests hand in their own database and a pretend Slack, and skip the first read. */
export async function slackCallback(request: Request, { db: given, fetchImpl = fetch, now = Date.now(), firstRead = true }: { db?: Db; fetchImpl?: Fetch; now?: number; firstRead?: boolean } = {}): Promise<Response> {
  const cleared = clearedSlackCookie(isHttps(request));
  try {
    const db = given ?? (await ready());
    const owner = await signedInAs(request, db);
    if (!owner) return backToConnections(request, { error: "Please sign in, then click Connect Slack again." }, cleared);
    const { label } = await finishSlackLogin(db, owner, new URL(request.url).searchParams, cookieValue(request, SLACK_LOGIN_COOKIE) ?? undefined, fetchImpl, now);
    // The first read runs once the person is on their way back, as after pasting a token.
    if (firstRead) {
      after(async () => {
        for (const job of ["slack-directory-sync", "slack-pull"] as const) await runNow(db, job, owner).catch((error) => console.error(`[command-center] first ${job} failed:`, (error as Error).message));
      });
    }
    return backToConnections(request, { label }, cleared);
  } catch (error) {
    return backToConnections(request, { error: said(error) }, cleared);
  }
}
