import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as login } from "@/app/api/login/route";
import { POST as logout } from "@/app/api/logout/route";
import { proxy } from "@/proxy";
import { fromDashboard, fromScheduler, signedIn } from "./http";
import {
  checkLogin, clearedCookie, clearFailures, createSession, isHttps, lockedFor, loginConfigured, readSession, recordFailure, SESSION_COOKIE, sessionCookie, sessionOf,
} from "./session";

const NOW = Date.parse("2026-10-12T09:00:00Z");
const DAY = 86_400_000;

beforeEach(() => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.LOGIN_EMAIL = "Jeremy@Example.com";
  process.env.LOGIN_PASSWORD = "correct horse battery";
  delete process.env.SESSION_SECRET;
});

describe("sign-in", () => {
  it("accepts only the right email and password", () => {
    expect(checkLogin("jeremy@example.com", "correct horse battery")).toBe(true);
    expect(checkLogin("  JEREMY@example.com ", "correct horse battery")).toBe(true);
    expect(checkLogin("jeremy@example.com", "Correct horse battery")).toBe(false);
    expect(checkLogin("someone@example.com", "correct horse battery")).toBe(false);
    expect(checkLogin("", "")).toBe(false);
  });

  it("lets nobody in while no login is set", () => {
    delete process.env.LOGIN_PASSWORD;
    expect(loginConfigured()).toBe(false);
    expect(checkLogin("jeremy@example.com", "")).toBe(false);
  });

  it("reads back its own session for a week, and refuses a changed, cut or foreign one", () => {
    const token = createSession("jeremy@example.com", NOW);
    expect(readSession(token, NOW + 6 * DAY)).toEqual({ email: "jeremy@example.com" });
    expect(readSession(token, NOW + 7 * DAY)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "intruder@example.com", exp: NOW + 365 * DAY })).toString("base64url");
    expect(readSession(`${forged}.${signature}`, NOW)).toBeNull();
    expect(readSession(`${payload}.${signature.slice(0, -2)}`, NOW)).toBeNull();
    expect(readSession(payload, NOW)).toBeNull();
    expect(readSession(`${token}.extra`, NOW)).toBeNull();
    expect(readSession("", NOW)).toBeNull();
    process.env.SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(readSession(token, NOW)).toBeNull();
  });

  it("finds the session among a request's cookies", () => {
    const token = createSession("jeremy@example.com");
    const request = (cookie: string) => new Request("http://127.0.0.1:3210/api/state", { headers: { cookie } });
    expect(sessionOf(request(`theme=dark; ${SESSION_COOKIE}=${token}; other=1`))).toEqual({ email: "jeremy@example.com" });
    expect(signedIn(request(`${SESSION_COOKIE}=${token}`))).toBe(true);
    expect(signedIn(request(`x${SESSION_COOKIE}=${token}`))).toBe(false);
    expect(signedIn(new Request("http://127.0.0.1:3210/api/state"))).toBe(false);
  });

  it("keeps the cookie away from scripts, and from plain connections when the site is on https", () => {
    expect(sessionCookie("abc", false)).toBe(`${SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    expect(sessionCookie("abc", true)).toMatch(/; Secure$/);
    expect(clearedCookie(false)).toContain("Max-Age=0");
    expect(isHttps(new Request("https://app.example.com/api/login"))).toBe(true);
    expect(isHttps(new Request("http://10.0.0.5/api/login", { headers: { "x-forwarded-proto": "https" } }))).toBe(true);
    expect(isHttps(new Request("http://127.0.0.1:3210/api/login"))).toBe(false);
  });

  it("makes a caller wait after too many wrong passwords, then lets them try again", () => {
    clearFailures("10.0.0.9");
    for (let k = 0; k < 7; k++) recordFailure("10.0.0.9", NOW);
    expect(lockedFor("10.0.0.9", NOW)).toBe(0);
    recordFailure("10.0.0.9", NOW);
    expect(lockedFor("10.0.0.9", NOW + 60_000)).toBe(540);
    expect(lockedFor("10.0.0.8", NOW)).toBe(0);
    expect(lockedFor("10.0.0.9", NOW + 10 * 60_000)).toBe(0);
  });
});

describe("the gate in front of every page", () => {
  const visit = (path: string, token?: string) =>
    proxy(new NextRequest(`http://127.0.0.1:3210${path}`, { headers: { host: "127.0.0.1:3210", ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) } }));
  const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("sends a visitor who is not signed in to the login page, remembering where they were going", () => {
    expect(visit("/inbox").headers.get("location")).toBe("http://127.0.0.1:3210/login?next=%2Finbox");
    expect(visit("/").headers.get("location")).toBe("http://127.0.0.1:3210/login");
    expect(visit("/inbox", "not-a-session").headers.get("location")).toContain("/login");
  });

  it("answers the API with a plain refusal, not a redirect", async () => {
    const res = visit("/api/state");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Please sign in." });
  });

  it("leaves the login page and the login request open", () => {
    expect(passes(visit("/login"))).toBe(true);
    expect(passes(visit("/api/login"))).toBe(true);
  });

  it("lets the host's scheduler through to its own route, which checks its own secret", () => {
    expect(passes(visit("/api/cron"))).toBe(true);
    expect(visit("/api/cron/extra").status).toBe(401);
  });

  it("lets a signed-in person through, and straight past the login page", () => {
    const token = createSession("jeremy@example.com");
    expect(passes(visit("/inbox", token))).toBe(true);
    expect(passes(visit("/api/state", token))).toBe(true);
    expect(visit("/login", token).headers.get("location")).toBe("http://127.0.0.1:3210/");
  });
});

describe("requests that change something", () => {
  it("must come from the dashboard's own pages", () => {
    const post = (headers: Record<string, string>) => new Request("http://127.0.0.1:3210/api/login", { method: "POST", headers: { host: "127.0.0.1:3210", ...headers } });
    expect(fromDashboard(post({ "content-type": "application/json", origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(fromDashboard(post({ "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(fromDashboard(post({ "content-type": "text/plain" }))).toBe(false);
  });
});

describe("the login request", () => {
  const SITE = "http://127.0.0.1:3210";
  const json = (body: unknown, from = SITE) =>
    new Request(`${SITE}/api/login`, { method: "POST", headers: { host: "127.0.0.1:3210", origin: from, "content-type": "application/json", "x-forwarded-for": "10.1.1.1" }, body: JSON.stringify(body) });
  const form = (fields: Record<string, string>, from = SITE) =>
    new Request(`${SITE}/api/login`, { method: "POST", headers: { host: "127.0.0.1:3210", origin: from, "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "10.1.1.2" }, body: new URLSearchParams(fields).toString() });
  const right = { email: "jeremy@example.com", password: "correct horse battery" };
  beforeEach(() => ["10.1.1.1", "10.1.1.2", "everyone"].forEach(clearFailures));

  it("signs in with the right email and password, and hands back a session that works", async () => {
    const res = await login(json(right));
    expect(res.status).toBe(200);
    const token = res.headers.get("set-cookie")!.match(/cc_session=([^;]+)/)![1];
    expect(readSession(token)).toEqual({ email: "jeremy@example.com" });
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("refuses a wrong password without saying which part was wrong, and sets no cookie", async () => {
    const res = await login(json({ ...right, password: "nope" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "That email and password do not match." });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await login(json({ email: 5 }))).status).toBe(401);
  });

  it("also takes the plain form a browser sends before the page's script has loaded", async () => {
    const ok = await login(form(right));
    expect([ok.status, ok.headers.get("location")]).toEqual([303, "/"]);
    expect(ok.headers.get("set-cookie")).toContain("cc_session=");
    const bad = await login(form({ ...right, password: "nope" }));
    expect([bad.status, bad.headers.get("location"), bad.headers.get("set-cookie")]).toEqual([303, "/login?error=wrong", null]);
  });

  it("refuses a login sent from another website", async () => {
    expect((await login(json(right, "https://evil.example"))).status).toBe(403);
    expect((await login(form(right, "https://evil.example"))).status).toBe(403);
  });

  it("stops answering after eight wrong tries in a row", async () => {
    for (let k = 0; k < 8; k++) expect((await login(json({ ...right, password: `guess-${k}` }))).status).toBe(401);
    const locked = await login(json(right));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("says so when no login has been set up", async () => {
    delete process.env.LOGIN_EMAIL;
    expect((await login(json(right))).status).toBe(503);
  });

  it("signs out by clearing the cookie", async () => {
    const res = await logout(new Request(`${SITE}/api/logout`, { method: "POST", headers: { host: "127.0.0.1:3210", origin: SITE, "content-type": "application/json" }, body: "{}" }));
    expect(res.headers.get("set-cookie")).toContain("cc_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  });
});

describe("the scheduler's route", () => {
  const sent = (authorization?: string) => fromScheduler(new Request("https://app.example.com/api/cron", authorization ? { headers: { authorization } } : undefined));

  it("lets nobody through while no secret is set", () => {
    delete process.env.CRON_SECRET;
    expect([sent(), sent("Bearer "), sent("Bearer undefined")]).toEqual([false, false, false]);
  });

  it("lets through only a request that carries the secret the way the host sends it", () => {
    process.env.CRON_SECRET = "a-long-random-secret";
    try {
      expect(sent("Bearer a-long-random-secret")).toBe(true);
      expect([sent(), sent("Bearer nope"), sent("a-long-random-secret"), sent("bearer a-long-random-secret")]).toEqual([false, false, false, false]);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });
});

