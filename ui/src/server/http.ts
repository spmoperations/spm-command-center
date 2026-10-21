// Shared pieces for the API routes.
import crypto from "node:crypto";
import { ready } from "./boot";
import type { Db } from "./db";
import { clearedCookie, isHttps, sessionOf } from "./session";
import { ownerOfSession } from "./team";

/**
 * Requests that change something must come from the dashboard itself. This stops another
 * website open in the same browser from quietly posting to the local server.
 */
export function fromDashboard(request: Request): boolean {
  return sameSite(request) && (request.headers.get("content-type") ?? "").startsWith("application/json");
}

/** True when the browser says the request was made by one of the dashboard's own pages. */
export function sameSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.get("origin");
  return !origin || new URL(origin).host === request.headers.get("host");
}

export const refused = () => Response.json({ error: "This request did not come from the dashboard." }, { status: 403 });

/** True when the request carries a signed session that has not run out. Who it is for is `signedInAs`. */
export const signedIn = (request: Request) => sessionOf(request) !== null;

/**
 * Whose data this request reads and changes: the owner, or a team member. Null when nobody is
 * signed in, or the session's login has been turned off or given a new password since.
 * Every route that reads or changes data asks this first, and uses only that person's rows.
 */
export async function signedInAs(request: Request, db?: Db): Promise<string | null> {
  const session = sessionOf(request);
  if (!session) return null;
  return ownerOfSession(() => (db ? Promise.resolve(db) : ready()), session);
}

/**
 * Not signed in, or the session no longer belongs to anyone (a team login turned off, given a
 * new password, or removed). The cookie is cleared as well, so the login page is shown and stays.
 */
export const signInFirst = (request?: Request) =>
  Response.json({ error: "Please sign in." }, { status: 401, headers: request ? { "Set-Cookie": clearedCookie(isHttps(request)) } : undefined });

/**
 * True when the request carries the host scheduler's secret (CRON_SECRET), which Vercel sends
 * as "Authorization: Bearer <secret>". With no secret set, nobody gets through.
 */
export function fromScheduler(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

/** One cookie from the request, or null. */
export function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/**
 * The address the dashboard was opened at, such as "http://127.0.0.1:3000", as the person typed
 * it. On a host the scheme comes from the header it adds ("x-forwarded-proto"), since the
 * request can reach the app as plain http behind it. Google's return address depends on this.
 */
export function siteOf(request: Request): string {
  const url = new URL(request.url);
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const scheme = forwarded === "https" || forwarded === "http" ? forwarded : url.protocol.replace(":", "");
  return `${scheme}://${request.headers.get("host") ?? url.host}`;
}

export const failed = (error: unknown, status = 400) => Response.json({ error: error instanceof Error ? error.message : String(error) }, { status });
