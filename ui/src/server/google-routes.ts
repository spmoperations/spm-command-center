// The two stops of connecting Google, kept here so the tests can run them with a pretend
// Google: the Connect button, which sends the person to Google, and the way back.
//
// Both are ordinary page visits (GET), not requests from the page: Google's page can only
// send the person back with a link. Each ends on the Connections page, which says how it went.
import { after } from "next/server";
import { runNow } from "@/jobs/runner";
import { ready } from "./boot";
import type { Db } from "./db";
import { clearedGoogleCookie, finishGoogleLogin, GOOGLE_LOGIN_COOKIE, GoogleSaid, startGoogleLogin } from "./google";
import { cookieValue, sameSite, signedInAs, siteOf } from "./http";
import { isHttps } from "./session";
import type { Fetch } from "./slack";

/** Back to the Connections page, with how it went in the address for the page to show. */
function backToConnections(request: Request, outcome: { account: string } | { error: string }, cookie?: string): Response {
  const to = new URL("/connections", siteOf(request));
  if ("error" in outcome) to.searchParams.set("google_error", outcome.error);
  else {
    to.searchParams.set("google", "connected");
    to.searchParams.set("account", outcome.account);
  }
  const headers = new Headers({ location: to.toString(), "cache-control": "no-store" });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

const said = (error: unknown) => (error instanceof GoogleSaid ? error.message : `Google could not be connected: ${error instanceof Error ? error.message : String(error)}`);

export async function googleLoginRedirect(request: Request, now = Date.now(), given?: Db): Promise<Response> {
  const owner = await signedInAs(request, given);
  if (!owner) return backToConnections(request, { error: "Please sign in, then click Connect Google again." });
  // Only the dashboard's own button starts a login.
  if (!sameSite(request)) return backToConnections(request, { error: "Click Connect Google on this page to connect." });
  try {
    const { url, cookie } = await startGoogleLogin(given ?? (await ready()), owner, siteOf(request), isHttps(request), now);
    return new Response(null, { status: 302, headers: { location: url, "set-cookie": cookie, "cache-control": "no-store" } });
  } catch (error) {
    return backToConnections(request, { error: said(error) });
  }
}

/** The tests hand in their own database and a pretend Google, and skip the first read. */
interface Options {
  db?: Db;
  fetchImpl?: Fetch;
  now?: number;
  firstRead?: boolean;
}

/**
 * Each attempt to connect is kept with the checks' runs, as "google-connect", and written to the
 * host's log: a failure happens on the person's screen, and this is how it can be looked at later.
 * Only the account's domain is kept, not its address.
 */
async function noteAttempt(db: Db | null, ownerId: string | null, now: number, ok: boolean, message: string): Promise<void> {
  console[ok ? "log" : "error"](`[command-center] google connect ${ok ? "worked" : "failed"}: ${message}`);
  if (!db || !ownerId) return;
  await db
    .run("insert into job_runs (owner_id, job_id, started_at, finished_at, ok, items, message) values ($1, 'google-connect', $2, $2, $3, $4, $5)", [ownerId, now, ok, ok ? 1 : 0, message.slice(0, 500)])
    .catch(() => {});
}

export async function googleCallback(request: Request, { db: given, fetchImpl = fetch, now = Date.now(), firstRead = true }: Options = {}): Promise<Response> {
  const cleared = clearedGoogleCookie(isHttps(request));
  let db: Db | null = given ?? null;
  let owner: string | null = null;
  try {
    db ??= await ready();
    owner = await signedInAs(request, db);
    if (!owner) {
      await noteAttempt(null, null, now, false, "not signed in to the dashboard on the way back from Google");
      return backToConnections(request, { error: "Please sign in, then click Connect Google again." }, cleared);
    }
    const { email, scopes } = await finishGoogleLogin(db, owner, new URL(request.url).searchParams, cookieValue(request, GOOGLE_LOGIN_COOKIE) ?? undefined, fetchImpl, now);
    await noteAttempt(db, owner, now, true, `an account @${email.split("@")[1] ?? "?"} connected, allowing ${scopes.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(" ")}`);
    const connected = db;
    const forOwner = owner;
    // The first read runs once the person is on their way back, so they are not kept waiting.
    if (firstRead) {
      after(async () => {
        for (const job of ["calendar-pull", "gmail-pull"] as const) {
          await runNow(connected, job, forOwner).catch((error) => console.error(`[command-center] first ${job} failed:`, (error as Error).message));
        }
      });
    }
    return backToConnections(request, { account: email }, cleared);
  } catch (error) {
    const message = said(error);
    await noteAttempt(db, owner, now, false, message);
    return backToConnections(request, { error: message }, cleared);
  }
}
