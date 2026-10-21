// Team members: their own login and their own data, beside the owner's, which never changes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/login/route";
import { POST as actionRoute } from "@/app/api/action/route";
import { slackPull } from "@/jobs/slack";
import type { Db } from "./db";
import { applyAction, loadState, OWNER_ID } from "./repo";
import { createSession, SESSION_COOKIE } from "./session";
import { hashPassword, ownerOfSession, passwordMark, passwordMatches, scheduledOwners, signInAs, teamLogins } from "./team";
import { fakeSlack, NOW, reset, routesUse, seed, testDb } from "./testing";

let db: Db;
const now = new Date(NOW);
const open = () => Promise.resolve(db);
/** The owner's sign-in and session must never need the database. */
const noDatabase = () => Promise.reject(new Error("The owner's login looked in the database"));
const ALEX = { name: "Alex Novak", email: "alex@example.com", password: "a long enough password" };

async function addAlex(): Promise<string> {
  await applyAction(db, "addTeamLogin", [ALEX.name, ALEX.email, ALEX.password], OWNER_ID, now);
  const [row] = await db.query<{ id: string }>("select id from users where login_email = $1", [ALEX.email]);
  return row.id;
}

beforeAll(async () => {
  db = await testDb();
  routesUse(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
  await seed(db);
});

describe("passwords", () => {
  it("are kept as a salted hash that checks the right password only", () => {
    const stored = hashPassword(ALEX.password);
    expect(stored).not.toContain(ALEX.password);
    expect(hashPassword(ALEX.password)).not.toBe(stored);
    expect(passwordMatches(ALEX.password, stored)).toBe(true);
    expect(passwordMatches("a long enough Password", stored)).toBe(false);
    expect(passwordMatches(ALEX.password, "not a hash")).toBe(false);
  });
});

describe("team logins", () => {
  it("are added by the owner, with their own checks and starting rules, and listed for the owner only", async () => {
    const alex = await addAlex();
    expect(alex).toMatch(/^u_/);
    expect((await db.query("select job_id from jobs where owner_id = $1", [alex])).length).toBeGreaterThan(5);
    expect((await db.query("select id from rules where owner_id = $1", [alex])).length).toBe(2);
    expect(await teamLogins(db)).toEqual([{ id: alex, name: ALEX.name, email: ALEX.email, active: true, createdAt: NOW }]);
    const owner = await loadState(db, OWNER_ID, now);
    expect([owner.me, owner.logins.map((l) => l.email)]).toEqual([{ id: OWNER_ID, isOwner: true }, [ALEX.email]]);
    const hers = await loadState(db, alex, now);
    expect([hers.me, hers.logins, hers.owner.name]).toEqual([{ id: alex, isOwner: false }, [], ALEX.name]);
  });

  it("refuse a missing name, a wrong address, a short password, the owner's own email and an email already used", async () => {
    const add = (name: string, email: string, password: string) => applyAction(db, "addTeamLogin", [name, email, password], OWNER_ID, now);
    await expect(add("", ALEX.email, ALEX.password)).rejects.toThrow("Write their name.");
    await expect(add(ALEX.name, "alex", ALEX.password)).rejects.toThrow("does not look right");
    await expect(add(ALEX.name, ALEX.email, "short")).rejects.toThrow("at least 10 characters");
    await expect(add(ALEX.name, "Jeremy@Example.com", ALEX.password)).rejects.toThrow("That is your own login.");
    await addAlex();
    await expect(add("Alex again", "ALEX@example.com", ALEX.password)).rejects.toThrow("already signs in with that email");
  });

  it("can be changed only by the owner, never by a team member, and never the owner's own", async () => {
    const alex = await addAlex();
    await expect(applyAction(db, "addTeamLogin", ["Sam", "sam@example.com", ALEX.password], alex, now)).rejects.toThrow("Only the owner can change team logins.");
    await expect(applyAction(db, "setTeamPassword", [alex, "another long password"], alex, now)).rejects.toThrow("Only the owner");
    await expect(applyAction(db, "turnOffTeamLogin", [alex], alex, now)).rejects.toThrow("Only the owner");
    await expect(applyAction(db, "setTeamPassword", [OWNER_ID, "another long password"], OWNER_ID, now)).rejects.toThrow("no longer exists");
    await applyAction(db, "turnOffTeamLogin", [OWNER_ID], OWNER_ID, now);
    expect(await db.query("select password_hash from users where id = $1", [OWNER_ID])).toEqual([{ password_hash: null }]);
  });
});

describe("signing in", () => {
  it("lets the owner in with LOGIN_EMAIL as before, without looking in the database", async () => {
    expect(await signInAs(noDatabase, "Jeremy@Example.com", "the owner's password")).toEqual({ ownerId: OWNER_ID });
    // The session the owner already has goes on working.
    expect(await ownerOfSession(noDatabase, { email: "jeremy@example.com" })).toBe(OWNER_ID);
  });

  it("lets a team member in with their own email and password, and nobody with a wrong one", async () => {
    const alex = await addAlex();
    const ok = await signInAs(open, " Alex@Example.com ", ALEX.password);
    expect(ok).toEqual({ ownerId: alex, mark: expect.any(String) });
    expect(await signInAs(open, ALEX.email, "the owner's password")).toBeNull();
    expect(await signInAs(open, "nobody@example.com", ALEX.password)).toBeNull();
    expect(await ownerOfSession(open, { email: ALEX.email, mark: ok!.mark })).toBe(alex);
  });

  it("ends a team member's sessions when their password changes or their login is turned off", async () => {
    const alex = await addAlex();
    const { mark } = (await signInAs(open, ALEX.email, ALEX.password))!;
    await applyAction(db, "setTeamPassword", [alex, "a brand new password"], OWNER_ID, now);
    expect(await ownerOfSession(open, { email: ALEX.email, mark })).toBeNull();
    const fresh = await signInAs(open, ALEX.email, "a brand new password");
    expect(fresh?.ownerId).toBe(alex);
    await applyAction(db, "turnOffTeamLogin", [alex], OWNER_ID, now);
    expect(await ownerOfSession(open, { email: ALEX.email, mark: fresh!.mark })).toBeNull();
    expect(await signInAs(open, ALEX.email, "a brand new password")).toBeNull();
    // Her data stays, for when it is turned on again with a new password.
    expect((await db.query("select id from users where id = $1", [alex])).length).toBe(1);
  });

  it("never treats a session that claims the owner's email with a team mark as the owner", async () => {
    await addAlex();
    expect(await ownerOfSession(open, { email: "jeremy@example.com", mark: passwordMark(hashPassword("x")) })).toBeNull();
    expect(await ownerOfSession(open, { email: ALEX.email })).toBeNull();
  });

  it("works through the login and action requests: each person gets their own Command Center", async () => {
    const alex = await addAlex();
    const signIn = (email: string, password: string) =>
      login(new Request("http://127.0.0.1:3100/api/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ email, password }) }));
    const res = await signIn(ALEX.email, ALEX.password);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!.split(";")[0];
    // A change that changes nothing answers with that person's state, as every change does.
    const state = async (c: string) =>
      (await actionRoute(new Request("http://127.0.0.1:3100/api/action", { method: "POST", headers: { cookie: c, "content-type": "application/json", host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ type: "editConversations", args: [[], {}] }) }))).json();
    const hers = await state(cookie);
    expect([hers.me, hers.inbox.length, hers.tasks.length]).toEqual([{ id: alex, isOwner: false }, 0, 0]);
    // The owner's session, as it was before team logins existed, still opens the owner's.
    const mine = await state(`${SESSION_COOKIE}=${createSession("jeremy@example.com")}`);
    expect([mine.me.isOwner, mine.inbox.map((c: { id: string }) => c.id).sort(), mine.tasks.length]).toEqual([true, ["slack:C1", "slack:D1"], 1]);
    expect((await signIn(ALEX.email, "wrong password!!")).status).toBe(401);
    // Once her login is removed, her session is refused and its cookie cleared, so the login page stays.
    await applyAction(db, "removeTeamLogin", [alex], OWNER_ID, now);
    const refused = await actionRoute(new Request("http://127.0.0.1:3100/api/action", { method: "POST", headers: { cookie, "content-type": "application/json", host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ type: "editConversations", args: [[], {}] }) }));
    expect([refused.status, refused.headers.get("set-cookie")]).toEqual([401, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
  });
});

describe("each person's data", () => {
  it("keeps two people in the same Slack chat apart: same ids, separate rows, the owner's untouched", async () => {
    const alex = await addAlex();
    await db.run("update users set slack_user_id = 'UALEX' where id = $1", [alex]);
    const ownerBefore = await db.query("select * from conversations where owner_id = $1 order by id", [OWNER_ID]);
    const ownerMessages = await db.query("select * from messages where owner_id = $1 order by id", [OWNER_ID]);
    const T = Math.floor(NOW / 1000);
    // Alex's own direct message with Maya happens to be D1, the same id as the owner's.
    const slack = fakeSlack({
      "search.messages": () => ({ messages: { matches: [{ ts: `${T}.000100`, channel: { id: "D1", is_im: true }, user: "UMAYA", text: "Alex, can you chase the invoices?" }], paging: { pages: 1 } } }),
      "conversations.history": () => ({ messages: [] }),
      "users.info": () => ({ user: { id: "UMAYA", real_name: "Maya Chen" } }),
    });
    await slackPull({ db, ownerId: alex, now: NOW, cursor: {} }, slack);
    expect(await db.query("select * from conversations where owner_id = $1 order by id", [OWNER_ID])).toEqual(ownerBefore);
    expect(await db.query("select * from messages where owner_id = $1 order by id", [OWNER_ID])).toEqual(ownerMessages);
    const hers = await loadState(db, alex, now);
    expect(hers.inbox.map((c) => [c.id, c.text])).toEqual([["slack:D1", "Alex, can you chase the invoices?"]]);
    expect((await loadState(db, OWNER_ID, now)).inbox.find((c) => c.id === "slack:D1")!.text).toBe("Can we swap the hook on clip 4 before Friday?");
  });

  it("lets a team member change only their own rows, even when they send the owner's ids", async () => {
    const alex = await addAlex();
    const act = (type: string, ...args: unknown[]) => applyAction(db, type, args, alex, now);
    const ownerRows = async () => db.query("select id, done, pri from conversations where owner_id = $1 order by id", [OWNER_ID]);
    const before = await ownerRows();
    await act("editConversations", ["slack:D1", "slack:C1"], { done: true });
    await act("editConversations", ["slack:D1"], { pri: "low" });
    await expect(act("markConversationDone", "slack:D1")).resolves.toBeUndefined();
    await expect(act("sendReply", "slack:D1", "Hello", false)).rejects.toThrow("no longer exists");
    await act("toggleTask", "t_hook", true);
    await act("removePerson", "u_luis");
    expect(await ownerRows()).toEqual(before);
    expect(await db.query("select done from tasks where id = 't_hook'")).toEqual([{ done: false }]);
    expect((await db.query("select id from team_members where owner_id = $1", [OWNER_ID])).length).toBe(2);
    expect(await db.query("select id from outbox")).toEqual([]);
  });

  it("removes a team member with everything of theirs, and never the owner", async () => {
    const alex = await addAlex();
    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, last_text, last_at) values ('slack:D1', $1, 'slack', 'D1', 'Maya', 'Direct message', 'Hi', $2)", [alex, NOW]);
    const ownerBefore = await db.query("select id from conversations where owner_id = $1 order by id", [OWNER_ID]);
    await expect(applyAction(db, "removeTeamLogin", [OWNER_ID], OWNER_ID, now)).rejects.toThrow("your own login");
    await expect(applyAction(db, "removeTeamLogin", [alex], alex, now)).rejects.toThrow("Only the owner");
    await applyAction(db, "removeTeamLogin", [alex], OWNER_ID, now);
    expect(await db.query("select id from users order by id")).toEqual([{ id: OWNER_ID }]);
    expect(await db.query("select count(*)::int as n from jobs where owner_id = $1", [alex])).toEqual([{ n: 0 }]);
    expect(await db.query("select id from conversations where owner_id = $1 order by id", [OWNER_ID])).toEqual(ownerBefore);
  });

  it("runs the scheduled checks for the owner first, then each team member who can sign in", async () => {
    expect(await scheduledOwners(db)).toEqual([OWNER_ID]);
    const alex = await addAlex();
    expect(await scheduledOwners(db)).toEqual([OWNER_ID, alex]);
    await applyAction(db, "turnOffTeamLogin", [alex], OWNER_ID, now);
    expect(await scheduledOwners(db)).toEqual([OWNER_ID]);
  });
});

describe("the database change", () => {
  it("removes the stop-gap indexes made where 0018 was run before its code, so two people can share an id", async () => {
    const { migrate } = await import("./db");
    for (const t of ["conversations", "messages", "meetings"]) await db.run(`create unique index if not exists ${t}_id_once on ${t} (id)`);
    await db.run("delete from schema_migrations where name = '0019_team_ids.sql'");
    expect(await migrate(db)).toEqual(["0019_team_ids.sql"]);
    expect(await db.query("select indexname from pg_indexes where indexname like '%_id_once'")).toEqual([]);
  });
});

describe("every query", () => {
  // Tables holding one person's rows. Picking one out by id alone could reach someone else's.
  const OWNED = "connections|jobs|slack_users|slack_channels|conversations|messages|meetings|team_members|tasks|suggestions|rules|metrics|metric_logs|focus_items|quick_links|outbox|media|telegram_chats|calendar_events|important|google_accounts";

  it("names whose rows it reads or changes", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "testing.ts") files.push(full);
      }
    };
    walk(path.join(process.cwd(), "src"));
    const unscoped: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const m of source.matchAll(/["`]((?:select|update|insert|delete|with)\b[^"`]*?)["`]/gi)) {
        const sql = m[1];
        if (!new RegExp(`\\b(from|update|into|join)\\s+(${OWNED})\\b`, "i").test(sql) || sql.includes("owner_id")) continue;
        unscoped.push(`${path.relative(process.cwd(), file)}: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(unscoped).toEqual([]);
  });
});
