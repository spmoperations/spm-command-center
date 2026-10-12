// Sign-in for the dashboard. For now there is one fixed login, set in `.env.local` as
// LOGIN_EMAIL and LOGIN_PASSWORD. A person who signs in gets a signed cookie that lasts a
// week; every page and every API route checks it. Nothing here depends on the database.
import crypto from "node:crypto";

export const SESSION_COOKIE = "cc_session";
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 86_400_000;

/** The signing key, derived from the server's secret so the cookie cannot be forged. */
function signingKey(): Buffer {
  const secret = process.env.SESSION_SECRET || process.env.SECRETS_KEY;
  if (!secret) throw new Error("SECRETS_KEY is not set, so nobody can sign in.");
  return Buffer.from(crypto.hkdfSync("sha256", secret, "", "command-center-session", 32));
}

const sign = (payload: string) => crypto.createHmac("sha256", signingKey()).update(payload).digest();

/** Compares two strings without leaking, through timing, how much of them matched. */
function same(a: string, b: string): boolean {
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}

export const loginConfigured = () => Boolean(process.env.LOGIN_EMAIL && process.env.LOGIN_PASSWORD);

export function checkLogin(email: string, password: string): boolean {
  if (!loginConfigured()) return false;
  // Both are always compared, so a wrong email takes as long as a wrong password.
  const emailOk = same(email.trim().toLowerCase(), process.env.LOGIN_EMAIL!.trim().toLowerCase());
  const passwordOk = same(password, process.env.LOGIN_PASSWORD!);
  return emailOk && passwordOk;
}

export function createSession(email: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ email, exp: now + SESSION_MS })).toString("base64url");
  return `${payload}.${sign(payload).toString("base64url")}`;
}

/** Who a session cookie belongs to, or null when it is missing, forged or expired. */
export function readSession(token: string | null | undefined, now = Date.now()): { email: string } | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const given = Buffer.from(signature, "base64url");
    const expected = sign(payload);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown; exp?: unknown };
    if (typeof data.email !== "string" || typeof data.exp !== "number" || data.exp <= now) return null;
    return { email: data.email };
  } catch {
    return null;
  }
}

/** Reads the session from a request's Cookie header. */
export function sessionOf(request: Request, now = Date.now()): { email: string } | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === SESSION_COOKIE) return readSession(part.slice(at + 1).trim(), now);
  }
  return null;
}

const cookie = (value: string, maxAge: number, secure: boolean) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

/** `secure` is true on https, so the cookie is never sent over a plain connection there. */
export const sessionCookie = (token: string, secure: boolean) => cookie(token, SESSION_DAYS * 86_400, secure);
export const clearedCookie = (secure: boolean) => cookie("", 0, secure);

export const isHttps = (request: Request) => new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";

// ---------- Guessing protection ----------

const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; until: number }>();

/** Seconds a caller must wait after too many wrong passwords, or 0 when they may try. */
export function lockedFor(who: string, now = Date.now()): number {
  const entry = failures.get(who);
  if (!entry || entry.until <= now) return 0;
  return entry.count >= MAX_FAILURES ? Math.ceil((entry.until - now) / 1000) : 0;
}

export function recordFailure(who: string, now = Date.now()): void {
  const entry = failures.get(who);
  if (!entry || entry.until <= now) failures.set(who, { count: 1, until: now + WINDOW_MS });
  else entry.count += 1;
  // Old entries are dropped so the list cannot grow without end.
  if (failures.size > 5000) for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
}

export const clearFailures = (who: string) => void failures.delete(who);
