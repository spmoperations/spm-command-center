// Sign in with Google, for task logins (see task-logins.ts). Google only says which account the
// person picked: it asks for the address alone, reads nothing from the account and keeps none of
// Google's login.
//
// It uses the team's Google app (the owner's keys) and the way back from Google that Connect
// Google already uses (/api/google/callback), so nothing new is set up in Google Cloud. The
// cookie of a sign-in in progress tells that way back which of the two it is.
import crypto from "node:crypto";
import { hostedProblem, keysById, keysForNew, teamGoogleDomain } from "./app-keys";
import type { Db } from "./db";
import { cookieValue, sameSite, siteOf } from "./http";
import { OWNER_ID } from "./owner";
import { seal, unseal } from "./secrets";
import { createSession, isHttps, sessionCookie } from "./session";
import type { Fetch } from "./slack";
import { memberByGoogle, signedInNow } from "./task-logins";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The cookie that carries a sign-in from the login page to Google's answer. On the same path as Connect Google's, so it reaches the same way back. */
export const GOOGLE_SIGN_IN_COOKIE = "cc_google_sign_in";
/** How long the person has on Google's page. */
const MINUTES = 10;

/** Why the login page sends someone back, as the page puts it in words (see app/login/page.tsx). */
export type SignInProblem = "google-off" | "google-none" | "google-login" | "google-again" | "google-denied" | "google-failed";

/** True where the login page offers Sign in with Google: Google may be used on this server, and the team has its keys. */
export async function googleSignInOffered(db: Db): Promise<boolean> {
  return hostedProblem("google") === null && (await keysForNew(db, OWNER_ID, "google")) !== null;
}

interface Pending {
  v: 1;
  state: string;
  verifier: string;
  nonce: string;
  redirect: string;
  at: number;
  keyId: string | null;
  /** The page asked for before signing in, such as a ticket's link. */
  next: string;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const cookie = (value: string, maxAge: number, secure: boolean) => `${GOOGLE_SIGN_IN_COOKIE}=${value}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
/** One of our own pages, never another site: "//elsewhere" and the like fall back to their tasks. */
function ownPage(next: string | null, site: string): string {
  if (!next?.startsWith("/")) return "/my-tasks";
  const to = new URL(next.slice(0, 500), site);
  return to.origin === new URL(site).origin ? `${to.pathname}${to.search}` : "/my-tasks";
}

function pendingOf(request: Request, now: number): Pending | null {
  try {
    const pending = JSON.parse(unseal(cookieValue(request, GOOGLE_SIGN_IN_COOKIE) ?? "")) as Pending;
    return pending.v === 1 && now >= pending.at && now - pending.at <= MINUTES * 60_000 ? pending : null;
  } catch {
    return null;
  }
}

const sameText = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** True when this way back from Google is a sign-in and not Connect Google: it answers the sign-in's own request. */
export function isGoogleSignIn(request: Request, now = Date.now()): boolean {
  const pending = pendingOf(request, now);
  return Boolean(pending && sameText(new URL(request.url).searchParams.get("state") ?? "", pending.state));
}

/** Back to the login page, saying why. */
function backToLogin(request: Request, problem: SignInProblem): Response {
  const to = new URL("/login", siteOf(request));
  to.searchParams.set("error", problem);
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store", "set-cookie": cookie("", 0, isHttps(request)) } });
}

/** The login page's Sign in with Google button: sends the person to Google's page to pick their account. */
export async function googleSignInRedirect(request: Request, db: Db, now = Date.now()): Promise<Response> {
  // Only the login page's own button starts a sign-in.
  if (!sameSite(request)) return backToLogin(request, "google-again");
  const keys = hostedProblem("google") ? null : await keysForNew(db, OWNER_ID, "google");
  if (!keys) return backToLogin(request, "google-off");
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const nonce = b64url(crypto.randomBytes(16));
  const redirect = `${siteOf(request)}/api/google/callback`;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: keys.keys.clientId,
    redirect_uri: redirect,
    response_type: "code",
    // Which account it is, and nothing more: no mailbox, no calendar, no lasting login.
    scope: "openid email",
    prompt: "select_account",
    state,
    nonce,
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  }).toString();
  const pending: Pending = { v: 1, state, verifier, nonce, redirect, at: now, keyId: keys.id, next: ownPage(new URL(request.url).searchParams.get("next"), siteOf(request)) };
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookie(seal(JSON.stringify(pending)), MINUTES * 60, isHttps(request)), "cache-control": "no-store" } });
}

/** The parts of Google's answer about who signed in that are checked. */
interface IdToken {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  email?: unknown;
  email_verified?: unknown;
  nonce?: unknown;
  /** The Google Workspace the account belongs to. Only Workspace accounts have one. */
  hd?: unknown;
}

/**
 * The account Google says the person picked, from the one-time code. The answer comes straight
 * from Google's token address over https, for this app's own keys, so its signature need not be
 * checked again (OpenID Connect Core, 3.1.3.7); what it says is still checked.
 */
async function accountOf(db: Db, pending: Pending, code: string, fetchImpl: Fetch, now: number): Promise<{ email: string; teamAccount: boolean }> {
  const keys = await keysById(db, OWNER_ID, "google", pending.keyId);
  if (!keys) throw new Error("the keys the sign-in started with are gone");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: keys.keys.clientId, client_secret: keys.keys.clientSecret, redirect_uri: pending.redirect, grant_type: "authorization_code", code_verifier: pending.verifier }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (res.status !== 200 || typeof body.id_token !== "string") throw new Error(`Google answered ${res.status}${body.error ? ` (${String(body.error)})` : ""}`);
  let claims: IdToken;
  try {
    claims = JSON.parse(Buffer.from(body.id_token.split(".")[1] ?? "", "base64url").toString("utf8")) as IdToken;
  } catch {
    throw new Error("Google's answer could not be read");
  }
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") throw new Error("the answer is not from Google");
  if (claims.aud !== keys.keys.clientId) throw new Error("the answer is for another app");
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) throw new Error("the answer has run out");
  if (typeof claims.nonce !== "string" || !sameText(claims.nonce, pending.nonce)) throw new Error("the answer is for another sign-in");
  if (typeof claims.email !== "string" || claims.email_verified !== true) throw new Error("Google did not confirm the account's address");
  const email = claims.email.trim().toLowerCase();
  // In the team's Workspace by Google's own word, not only by how the address ends.
  const domain = teamGoogleDomain();
  return { email, teamAccount: typeof claims.hd === "string" && claims.hd.toLowerCase() === domain && email.endsWith(`@${domain}`) };
}

/** The tests hand in their own database and a pretend Google. */
interface Options {
  fetchImpl?: Fetch;
  now?: number;
}

/**
 * Google's answer: signs in the person on the team list whose task login is that account, or who
 * that account is in the team's own Workspace and Slack, and takes them to their tasks.
 */
export async function googleSignInCallback(request: Request, db: Db, { fetchImpl = fetch, now = Date.now() }: Options = {}): Promise<Response> {
  const pending = pendingOf(request, now);
  const answer = new URL(request.url).searchParams;
  if (!pending || !sameText(answer.get("state") ?? "", pending.state)) return backToLogin(request, "google-again");
  if (answer.get("error")) return backToLogin(request, answer.get("error") === "access_denied" ? "google-denied" : "google-failed");
  if (hostedProblem("google")) return backToLogin(request, "google-off");
  let account: { email: string; teamAccount: boolean };
  try {
    account = await accountOf(db, pending, answer.get("code") ?? "", fetchImpl, now);
  } catch (error) {
    console.error(`[command-center] google sign-in failed: ${(error as Error).message}`);
    return backToLogin(request, "google-failed");
  }
  const who = await memberByGoogle(db, account.email, account.teamAccount, now);
  if (who === "login") return backToLogin(request, "google-login");
  if (!who) return backToLogin(request, "google-none");
  await signedInNow(db, who.member.id, now);
  const secure = isHttps(request);
  const site = siteOf(request);
  const headers = new Headers({ location: new URL(ownPage(pending.next, site), site).toString(), "cache-control": "no-store" });
  headers.append("set-cookie", cookie("", 0, secure));
  headers.append("set-cookie", sessionCookie(createSession(who.member.email, now, who.mark, true), secure));
  return new Response(null, { status: 302, headers });
}
