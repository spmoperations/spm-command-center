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
import { cookieValue, sameSite, signedIn, siteOf } from "./http";
import { OWNER_ID } from "./repo";
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

export function googleLoginRedirect(request: Request, now = Date.now()): Response {
  if (!signedIn(request)) return backToConnections(request, { error: "Please sign in, then click Connect Google again." });
  // Only the dashboard's own button starts a login.
  if (!sameSite(request)) return backToConnections(request, { error: "Click Connect Google on this page to connect." });
  try {
    const { url, cookie } = startGoogleLogin(siteOf(request), isHttps(request), now);
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

export async function googleCallback(request: Request, { db: given, fetchImpl = fetch, now = Date.now(), firstRead = true }: Options = {}): Promise<Response> {
  const cleared = clearedGoogleCookie(isHttps(request));
  if (!signedIn(request)) return backToConnections(request, { error: "Please sign in, then click Connect Google again." }, cleared);
  try {
    const db = given ?? (await ready());
    const { email } = await finishGoogleLogin(db, OWNER_ID, new URL(request.url).searchParams, cookieValue(request, GOOGLE_LOGIN_COOKIE) ?? undefined, fetchImpl, now);
    // The first read runs once the person is on their way back, so they are not kept waiting.
    if (firstRead) {
      after(async () => {
        for (const job of ["calendar-pull", "gmail-pull"] as const) {
          await runNow(db, job).catch((error) => console.error(`[command-center] first ${job} failed:`, (error as Error).message));
        }
      });
    }
    return backToConnections(request, { account: email }, cleared);
  } catch (error) {
    return backToConnections(request, { error: said(error) }, cleared);
  }
}
