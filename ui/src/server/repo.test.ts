import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "@/core/jobs";
import { connect, secretFor } from "./connections";
import fs from "node:fs";
import type { Db } from "./db";
import { databaseHome, describeDbError, migrate, openDb, openRemote, splitStatements } from "./db";
import { ageOutInbox, applyAction, loadState, OWNER_ID } from "./repo";
import { seal, unseal } from "./secrets";
import { NOW, reset, seed, testDb } from "./testing";

let db: Db;
const now = new Date(NOW);
const act = (type: string, ...args: unknown[]) => applyAction(db, type, args, OWNER_ID, now);
const state = () => loadState(db, OWNER_ID, now);

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  await reset(db);
  await seed(db);
});

describe("database", () => {
  it("applies each migration once and records it", async () => {
    expect(await db.query("select name from schema_migrations order by name")).toEqual([{ name: "0001_init.sql" }, { name: "0002_row_level_security.sql" }, { name: "0003_personal_and_requests.sql" }, { name: "0004_threads.sql" }, { name: "0005_slack_pictures.sql" }, { name: "0006_pictures_and_reactions.sql" }, { name: "0007_media.sql" }, { name: "0008_thread_items.sql" }, { name: "0009_inbox_age.sql" }, { name: "0010_task_description.sql" }, { name: "0011_outbox_thread_reply.sql" }, { name: "0012_telegram_chats.sql" }, { name: "0013_google.sql" }, { name: "0014_google_accounts.sql" }]);
    expect(await migrate(db)).toEqual([]);
  });

  it("locks every table, so the hosted database's public API returns nothing", async () => {
    const open = await db.query<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity");
    expect(open).toEqual([]);
  });

  it("names where the data lives without the password, and refuses an address a password has broken", async () => {
    const before = process.env.DATABASE_URL;
    try {
      delete process.env.DATABASE_URL;
      expect(databaseHome()).toBe("This computer (development database)");
      process.env.DATABASE_URL = "postgres://postgres.abcd:s3cret@aws-0-eu.pooler.supabase.com:5432/postgres";
      expect(databaseHome()).toBe("aws-0-eu.pooler.supabase.com");
      process.env.DATABASE_URL = "postgres://postgres:p@ss#w/rd@db.example.com:5432/postgres";
      expect(databaseHome()).toBe("Hosted database (the address is not valid)");
      await expect(openRemote(process.env.DATABASE_URL)).rejects.toThrow("Invalid URL");
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  });

  it("says what to do when the database cannot be opened", () => {
    expect(describeDbError({ code: "28P01", message: 'password authentication failed for user "postgres"' })).toMatch(/refused the password/);
    expect(describeDbError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND db.abcd.supabase.co" })).toMatch(/Session pooler/);
    expect(describeDbError({ code: "CONNECT_TIMEOUT", message: "write CONNECT_TIMEOUT" })).toMatch(/did not answer/);
    expect(describeDbError(new TypeError("Invalid URL"))).toMatch(/percent-encoded/);
    expect(describeDbError(new Error("relation does not exist"))).toBe("relation does not exist");
  });

  it("accepts a first schema that was run by hand, then applies what came after", async () => {
    const fresh = await openDb(undefined, { migrate: false });
    for (const statement of splitStatements(fs.readFileSync("db/migrations/0001_init.sql", "utf8"))) await fresh.run(statement);
    expect(await migrate(fresh)).toEqual(["0002_row_level_security.sql", "0003_personal_and_requests.sql", "0004_threads.sql", "0005_slack_pictures.sql", "0006_pictures_and_reactions.sql", "0007_media.sql", "0008_thread_items.sql", "0009_inbox_age.sql", "0010_task_description.sql", "0011_outbox_thread_reply.sql", "0012_telegram_chats.sql", "0013_google.sql", "0014_google_accounts.sql"]);
    expect(await fresh.query("select name from schema_migrations order by name")).toEqual([{ name: "0001_init.sql" }, { name: "0002_row_level_security.sql" }, { name: "0003_personal_and_requests.sql" }, { name: "0004_threads.sql" }, { name: "0005_slack_pictures.sql" }, { name: "0006_pictures_and_reactions.sql" }, { name: "0007_media.sql" }, { name: "0008_thread_items.sql" }, { name: "0009_inbox_age.sql" }, { name: "0010_task_description.sql" }, { name: "0011_outbox_thread_reply.sql" }, { name: "0012_telegram_chats.sql" }, { name: "0013_google.sql" }, { name: "0014_google_accounts.sql" }]);
    expect(await fresh.query("select relrowsecurity from pg_class where relname = 'messages'")).toEqual([{ relrowsecurity: true }]);
    await fresh.close();
  });

  it("accepts every schema file run by hand before the app has ever connected", async () => {
    const fresh = await openDb(undefined, { migrate: false });
    for (const file of fs.readdirSync("db/migrations").sort()) {
      for (const statement of splitStatements(fs.readFileSync(`db/migrations/${file}`, "utf8"))) await fresh.run(statement);
    }
    await migrate(fresh);
    expect(await fresh.query("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity")).toEqual([]);
    expect(await fresh.query("select name from schema_migrations order by name")).toEqual([{ name: "0001_init.sql" }, { name: "0002_row_level_security.sql" }, { name: "0003_personal_and_requests.sql" }, { name: "0004_threads.sql" }, { name: "0005_slack_pictures.sql" }, { name: "0006_pictures_and_reactions.sql" }, { name: "0007_media.sql" }, { name: "0008_thread_items.sql" }, { name: "0009_inbox_age.sql" }, { name: "0010_task_description.sql" }, { name: "0011_outbox_thread_reply.sql" }, { name: "0012_telegram_chats.sql" }, { name: "0013_google.sql" }, { name: "0014_google_accounts.sql" }]);
    expect(await fresh.query("select mode, asked from messages m join conversations c on c.id = m.conversation_id")).toEqual([]);
    await fresh.close();
  });

  it("splits a migration file into statements and drops comments", () => {
    expect(splitStatements("-- note\ncreate table a (id text);\n\ncreate index b on a (id);\n")).toEqual(["create table a (id text)", "create index b on a (id)"]);
  });

  it("gives a new owner every job, the two starting rules and the starting targets", async () => {
    const s = await state();
    expect(s.jobs.map((j) => j.id)).toEqual(JOBS.map((j) => j.id));
    expect(s.priorityRules.map((r) => [r.when, r.pri])).toEqual([["tagged", "high"], ["direct", "mid"]]);
    expect(s.metrics.filter((m) => !m.parent).map((m) => m.name)).toEqual(["Calls Booked", "Client Cash Collected", "Overall Agency Revenue"]);
    expect(s.connections).toEqual({ slack: { connected: false }, telegram: { connected: false }, fathom: { connected: false }, google: { connected: false } });
  });
});

describe("inbox actions", () => {
  describe("a conversation with nothing new for three days", () => {
    const DAY = 86_400_000;
    const lastAt = (id: string, at: number) => db.run("update conversations set last_at = $1 where id = $2", [at, id]);
    const row = async (id: string) => (await state()).inbox.find((c) => c.id === id)!;

    it("is cleared by itself, and a newer one is left alone", async () => {
      await lastAt("slack:D1", NOW - 3 * DAY - 1000);
      await lastAt("slack:C1", NOW - 3 * DAY + 60_000);
      expect(await ageOutInbox(db, OWNER_ID, NOW)).toBe(1);
      expect([(await row("slack:D1")).done, (await row("slack:D1")).autoCleared, (await row("slack:C1")).done, (await row("slack:C1")).autoCleared]).toEqual([true, true, false, undefined]);
      expect(await ageOutInbox(db, OWNER_ID, NOW)).toBe(0);
    });

    it("stays once it is put back by hand, for three more days", async () => {
      await lastAt("slack:D1", NOW - 10 * DAY);
      await ageOutInbox(db, OWNER_ID, NOW);
      await act("restoreConversation", "slack:D1");
      expect(await row("slack:D1")).toMatchObject({ done: false });
      expect((await row("slack:D1")).autoCleared).toBeUndefined();
      // Its three days count from when it was put back, not from its last message.
      await ageOutInbox(db, OWNER_ID, NOW + 2 * DAY);
      expect((await row("slack:D1")).done).toBe(false);
      await ageOutInbox(db, OWNER_ID, NOW + 3 * DAY + 1000);
      expect(await row("slack:D1")).toMatchObject({ done: true, autoCleared: true });
    });

    it("is cleared by the owner, not by age, once they mark it done or answer and close it", async () => {
      await lastAt("slack:D1", NOW - 10 * DAY);
      await lastAt("slack:C1", NOW - 10 * DAY);
      await ageOutInbox(db, OWNER_ID, NOW);
      await act("markConversationDone", "slack:D1");
      await act("sendReply", "slack:C1", "On it.", true);
      expect([(await row("slack:D1")).autoCleared, (await row("slack:C1")).autoCleared]).toEqual([undefined, undefined]);
      expect([(await row("slack:D1")).done, (await row("slack:C1")).done]).toEqual([true, true]);
    });
  });

  it("puts one cleared conversation back in the inbox, and leaves the other cleared ones where they are", async () => {
    await applyAction(db, "markConversationDone", ["slack:D1"], OWNER_ID, new Date(NOW));
    await applyAction(db, "markConversationDone", ["slack:C1"], OWNER_ID, new Date(NOW));
    const cleared = async () => (await loadState(db)).inbox.filter((c) => c.done).map((c) => c.id).sort();
    expect(await cleared()).toEqual(["slack:C1", "slack:D1"]);
    await applyAction(db, "restoreConversation", ["slack:D1"], OWNER_ID, new Date(NOW));
    expect(await cleared()).toEqual(["slack:C1"]);
    // Restoring everything at once is gone: a chat comes back only when it is picked.
    await expect(applyAction(db, "restoreInbox", [], OWNER_ID, new Date(NOW))).rejects.toThrow();
    expect(await cleared()).toEqual(["slack:C1"]);
  });

  it("saves a reply in the thread and queues it for the same Slack conversation", async () => {
    await act("sendReply", "slack:D1", "Sounds good, swapping it today.", false);
    const s = await state();
    const c = s.inbox.find((x) => x.id === "slack:D1")!;
    expect(c).toMatchObject({ replied: true, done: false });
    expect(c.thread.at(-1)).toMatchObject({ me: true, text: "Sounds good, swapping it today.", status: "queued" });
    expect(await db.query("select source, target, to_name, status from outbox")).toEqual([{ source: "slack", target: "D1", to_name: "Maya Chen", status: "queued" }]);
  });

  it("clears the conversation when the reply is sent with mark done", async () => {
    await act("sendReply", "slack:D1", "On it.", true);
    expect((await state()).inbox.find((x) => x.id === "slack:D1")!.done).toBe(true);
  });

  it("turns a message into a task linked back to it", async () => {
    await act("conversationToTask", "slack:D1", "2026-10-08");
    const s = await state();
    expect(s.tasks.find((t) => t.src?.id === "slack:D1")).toMatchObject({ title: "Reply to Maya Chen: Can we swap the hook on clip 4 before Friday?", due: "2026-10-08" });
    expect(s.inbox.find((x) => x.id === "slack:D1")!.done).toBe(true);
  });

  it("delegates a message: a task for the teammate and a direct message addressed to their Slack account", async () => {
    await act("delegateConversation", "slack:D1", "u_luis", "Swap the hook before Friday.", "2026-10-09");
    const task = (await state()).tasks.find((t) => t.src?.id === "slack:D1")!;
    expect(task).toMatchObject({ dept: "Client Sales", delegatedTo: { personId: "u_luis", name: "Luis Ramos", note: "Swap the hook before Friday." } });
    const [message] = await db.query<{ target: string; body: string; task_id: string }>("select target, body, task_id from outbox");
    expect(message).toMatchObject({ target: "ULUIS", task_id: task.id });
    expect(message.body).toContain("Swap the hook before Friday.");
  });

  it("keeps a hand-set priority when a rule would change it", async () => {
    await act("setConversationPriority", "slack:C1", "high");
    await act("addRule", "priorityRules", { source: "slack", when: "ctx", op: "is", value: "#sales", pri: "mid" });
    expect((await state()).inbox.find((x) => x.id === "slack:C1")).toMatchObject({ pri: "high", manualPri: true });
    await act("clearManualPriorities");
    expect((await state()).inbox.find((x) => x.id === "slack:C1")!.pri).toBe("mid");
  });

  it("re-sorts the inbox when a rule is added, moved or deleted", async () => {
    const pri = async () => (await state()).inbox.find((x) => x.id === "slack:D1")!.pri;
    await act("clearManualPriorities");
    expect(await pri()).toBe("mid"); // a direct message
    await act("addRule", "priorityRules", { source: "any", when: "from", op: "is", value: "Maya Chen", pri: "high" });
    expect(await pri()).toBe("mid"); // the new rule is last, so "direct" still wins
    const rule = (await state()).priorityRules.at(-1)!;
    await act("moveRule", "priorityRules", rule.id, -1);
    expect(await pri()).toBe("high");
    await act("deleteRule", "priorityRules", rule.id);
    expect(await pri()).toBe("mid");
  });
});

describe("task actions", () => {
  it("keeps a description with a task, lets it be changed, and sends the whole task when it is assigned", async () => {
    await act("addTask", { title: "Book the venue", description: "  Shortlist is in the doc.\nNeeds a deposit by Friday.  ", dept: "Operations", project: "Launch", pri: "high", due: "2026-10-09" });
    const task = async () => (await state()).tasks.find((t) => t.title === "Book the venue")!;
    expect((await task()).description).toBe("Shortlist is in the doc.\nNeeds a deposit by Friday.");

    await act("setTaskDescription", (await task()).id, "Deposit is paid. Confirm the date.");
    expect((await task()).description).toBe("Deposit is paid. Confirm the date.");
    await act("setTaskDescription", (await task()).id, "   ");
    expect((await task()).description).toBe("");
    await expect(act("setTaskDescription", "t_missing", "x")).rejects.toThrow("That task no longer exists.");
    // A task made without one has an empty description, not a missing one.
    expect((await state()).tasks.find((t) => t.id === "t_hook")!.description).toBe("");

    // Making a task only makes it: nobody is told anything, whatever else is sent along.
    await act("addTask", { title: "Draft the invite", description: "Use last year's as the base.", dept: "Operations", project: "Launch", pri: "mid", due: "2026-10-09", assignTo: "u_luis" });
    const invite = async () => (await state()).tasks.find((t) => t.title === "Draft the invite")!;
    expect([(await invite()).delegatedTo, await db.query("select body from outbox")]).toEqual([null, []]);
    // Assigning it is the next step. The message says what and when, with the note. The description waits to go under it, in its thread.
    await act("delegateTask", (await invite()).id, "u_luis", "Send me a draft first.", "2026-10-09");
    const queued = await db.query<{ id: string; body: string; after_id: string | null; target: string; thread_ts: string | null }>("select id, body, after_id, target, thread_ts from outbox order by created_at");
    expect(queued.map((o) => [o.body, o.target, o.thread_ts])).toEqual([
      ["New task for you: Draft the invite\nDue Fri, Oct 9 · Medium priority · Launch\n\nSend me a draft first.", "ULUIS", null],
      ["Use last year's as the base.", "ULUIS", null],
    ]);
    expect([queued[0].after_id, queued[1].after_id]).toEqual([null, queued[0].id]);
    expect((await invite()).delegatedTo).toMatchObject({ name: "Luis Ramos", note: "Send me a draft first." });
    expect((await state()).outbox.map((o) => o.inThread).sort()).toEqual([true, undefined].sort());
    // Taken back before it was sent, both are withdrawn.
    await act("undelegateTask", (await invite()).id);
    expect(await db.query("select id from outbox")).toEqual([]);
  });

  it("delegates a task and takes it back, withdrawing the unsent message", async () => {
    await act("delegateTask", "t_hook", "u_luis", "Use the neighborhood-first hook.", "2026-10-12");
    expect((await state()).tasks.find((t) => t.id === "t_hook")).toMatchObject({ due: "2026-10-12", delegatedTo: { name: "Luis Ramos" } });
    expect(await db.query("select count(*)::int as n from outbox")).toEqual([{ n: 1 }]);
    await act("undelegateTask", "t_hook");
    expect((await state()).tasks.find((t) => t.id === "t_hook")!.delegatedTo).toBeNull();
    expect(await db.query("select count(*)::int as n from outbox")).toEqual([{ n: 0 }]);
  });

  it("queues a delegation with no address when the teammate has no Slack account linked", async () => {
    await act("delegateTask", "t_hook", "u_rene", "Please take this.", "2026-10-12");
    expect(await db.query("select target from outbox")).toEqual([{ target: null }]);
  });

  it("adds a suggestion as a task only when it is accepted, and only once", async () => {
    await db.run("insert into suggestions (id, owner_id, title, dept, pri, due, src_type, src_id, dedupe_key, created_at) values ('s1', $1, 'Send the proposal', 'SPM Sales', 'high', '2026-10-09', 'meeting', 'fathom:1', 'k1', $2)", [OWNER_ID, NOW]);
    const before = (await state()).tasks.length;
    await act("editSuggestion", "s1", { pri: "mid" });
    await act("acceptSuggestion", "s1");
    await act("acceptSuggestion", "s1");
    const s = await state();
    expect(s.tasks).toHaveLength(before + 1);
    expect(s.tasks.find((t) => t.title === "Send the proposal")).toMatchObject({ pri: "mid", src: { type: "meeting", id: "fathom:1" } });
    expect(s.suggestions.find((g) => g.id === "s1")!.status).toBe("accepted");
  });

  it("marks a task done with the time, and undone again", async () => {
    await act("toggleTask", "t_hook", true);
    expect((await state()).tasks.find((t) => t.id === "t_hook")).toMatchObject({ done: true, doneAt: NOW });
    await act("toggleTask", "t_hook", false);
    expect((await state()).tasks.find((t) => t.id === "t_hook")).toMatchObject({ done: false, doneAt: null });
  });
});

describe("settings and targets", () => {
  it("never saves a timer faster than the job allows", async () => {
    await act("setJobInterval", "slack-pull", 1);
    await act("setJobInterval", "telegram-pull", 45);
    const jobs = (await state()).jobs;
    expect(jobs.find((j) => j.id === "slack-pull")!.intervalMin).toBe(5);
    expect(jobs.find((j) => j.id === "telegram-pull")!.intervalMin).toBe(45);
  });

  it("logs a day's number, replaces it, and clears it", async () => {
    await act("saveLogs", 8, { calls: 3 });
    await act("saveLogs", 8, { calls: 5 });
    expect((await state()).logs.calls).toEqual({ 8: 5 });
    await act("saveLogs", 8, { calls: null });
    expect((await state()).logs.calls).toBeUndefined();
  });

  it("changes a target and ignores a number that is not positive", async () => {
    await act("saveTargets", { calls: 80, cash: 0 });
    const metrics = (await state()).metrics;
    expect(metrics.find((m) => m.id === "calls")!.target).toBe(80);
    expect(metrics.find((m) => m.id === "cash")!.target).toBe(85000);
  });

  it("edits the team: departments, responsibilities, a new person linked to Slack", async () => {
    await act("togglePersonDept", "u_luis", "Operations");
    await act("addHandle", "u_luis", "Captions");
    await act("addHandle", "u_luis", "captions");
    await act("removeHandle", "u_luis", 0);
    await act("addPerson", { name: "Dana", role: "Ops", depts: ["Operations"], handles: [], slackUserId: "UDANA" });
    const team = (await state()).team;
    expect(team.find((p) => p.id === "u_luis")).toMatchObject({ depts: ["Client Sales", "Operations"], handles: ["Captions"] });
    expect(team.find((p) => p.name === "Dana")).toMatchObject({ slackUserId: "UDANA" });
  });

  it("keeps focus items and quick links", async () => {
    await act("addFocus", "day", "2026-10-08", "Ship the inbox");
    await act("addLink", "Drive", "https://drive.google.com/");
    let s = await state();
    const item = s.focus.professional.day["2026-10-08"][0];
    expect(item).toMatchObject({ text: "Ship the inbox", done: false });
    await act("toggleFocus", "day", "2026-10-08", item.id, true);
    await act("removeLink", s.links[0].id);
    s = await state();
    expect(s.focus.professional.day["2026-10-08"][0].done).toBe(true);
    expect(s.links).toEqual([]);
  });

  it("refuses an action it does not know", async () => {
    await expect(act("dropEverything")).rejects.toThrow("Unknown action");
  });
});

describe("connections and secrets", () => {
  const slackSays = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 });

  it("encrypts a secret so the stored text is not the key, and reads it back", () => {
    const sealed = seal("xoxp-secret-token");
    expect(sealed).not.toContain("xoxp-secret-token");
    expect(unseal(sealed)).toBe("xoxp-secret-token");
    expect(() => unseal(sealed.slice(0, -4) + "AAAA")).toThrow();
  });

  it("checks a Slack token with Slack, then stores it encrypted with whose it is", async () => {
    await connect(db, OWNER_ID, "slack", " xoxp-good ", slackSays({ ok: true, user: "jeremy", user_id: "U1", team: "SPM", team_id: "T1" }));
    expect((await state()).connections.slack).toMatchObject({ connected: true, label: "jeremy · SPM" });
    const [row] = await db.query<{ secret: string }>("select secret from connections where provider = 'slack'");
    expect(row.secret).not.toContain("xoxp-good");
    expect(await secretFor(db, OWNER_ID, "slack")).toBe("xoxp-good");
    await act("disconnectProvider", "slack");
    expect(await secretFor(db, OWNER_ID, "slack")).toBeNull();
  });

  it("refuses a bot token and a token Slack rejects, and stores nothing", async () => {
    await expect(connect(db, OWNER_ID, "slack", "xoxb-bot", slackSays({ ok: true, user: "bot", user_id: "U2", team: "SPM", team_id: "T1", bot_id: "B1" }))).rejects.toThrow("bot token");
    await expect(connect(db, OWNER_ID, "slack", "xoxp-bad", slackSays({ ok: false, error: "invalid_auth" }))).rejects.toThrow("invalid_auth");
    expect(await secretFor(db, OWNER_ID, "slack")).toBeNull();
  });
});

describe("personal and professional", () => {
  const chat = async (id: string) => (await state()).inbox.find((c) => c.id === id)!;

  it("says when each task was added", async () => {
    await act("addTask", { title: "Plan November", dept: "Operations", project: "", pri: "mid", due: "2026-10-20" });
    expect((await state()).tasks.find((x) => x.title === "Plan November")!.createdAt).toBe(now.getTime());
  });

  it("starts everything on the Professional side", async () => {
    const s = await state();
    expect(s.inbox.map((c) => c.mode)).toEqual(["professional", "professional"]);
    expect(s.tasks.map((t) => t.mode)).toEqual(["professional"]);
  });

  it("moves a chat to Personal by hand, keeps it there when rules change, and takes its task along", async () => {
    await act("setConversationMode", "slack:D1", "personal");
    await act("addRule", "labelRules", { source: "any", when: "any", op: "is", value: "", mode: "professional", line: "consulting" });
    expect(await chat("slack:D1")).toMatchObject({ mode: "personal", manualMode: true });
    expect(await chat("slack:C1")).toMatchObject({ mode: "professional", line: "consulting" });
    await act("conversationToTask", "slack:D1", "2026-10-08");
    expect((await state()).tasks.find((t) => t.src?.id === "slack:D1")).toMatchObject({ mode: "personal", dept: "Personal", project: "Personal" });
    await act("clearManualPriorities");
    expect((await chat("slack:D1")).manualMode).toBeUndefined();
  });

  it("files a chat under Personal by rule, and back again when the rule is deleted", async () => {
    await act("addRule", "labelRules", { source: "any", when: "from", op: "is", value: "Maya Chen", mode: "personal" });
    expect((await chat("slack:D1")).mode).toBe("personal");
    expect((await chat("slack:C1")).mode).toBe("professional");
    const [rule] = (await state()).labelRules;
    expect(rule).toMatchObject({ mode: "personal", when: "from", value: "Maya Chen" });
    await act("deleteRule", "labelRules", rule.id);
    expect((await chat("slack:D1")).mode).toBe("professional");
  });

  it("gives each side its own focus list and quick links", async () => {
    await act("addFocus", "day", "2026-10-08", "Call the dentist", "personal");
    await act("addFocus", "day", "2026-10-08", "Ship the inbox");
    await act("addLink", "Bank", "https://bank.example/", "personal");
    const s = await state();
    expect(s.focus.personal.day["2026-10-08"].map((f) => f.text)).toEqual(["Call the dentist"]);
    expect(s.focus.professional.day["2026-10-08"].map((f) => f.text)).toEqual(["Ship the inbox"]);
    expect(s.links).toMatchObject([{ label: "Bank", mode: "personal" }]);
  });

  it("files a personal task without a department, and treats an unknown side as Professional", async () => {
    await act("addTask", { title: "Renew passport", dept: "Operations", project: "Harbor Realty", pri: "mid", due: "2026-10-10", mode: "personal" });
    await act("addTask", { title: "Odd one", dept: "Operations", project: "", pri: "mid", due: "2026-10-10", mode: "nonsense" });
    const tasks = (await state()).tasks;
    expect(tasks.find((t) => t.title === "Renew passport")).toMatchObject({ mode: "personal", dept: "Personal", project: "Personal" });
    expect(tasks.find((t) => t.title === "Odd one")).toMatchObject({ mode: "professional", dept: "Operations" });
  });
});

describe("assigning to anyone on Slack", () => {
  beforeEach(async () => {
    await db.run("insert into slack_users (owner_id, id, name, is_bot, deleted) values ($1, 'UDANA', 'Dana Okafor', false, false), ($1, 'ULUIS', 'Luis Ramos', false, false), ($1, 'UBOT', 'Deploy Bot', true, false)", [OWNER_ID]);
  });
  const outbox = () => db.query<{ target: string | null; to_name: string; body: string }>("select target, to_name, body from outbox order by created_at, id");

  it("assigns a task to someone who is not on the team list yet, and adds them to it once", async () => {
    await act("delegateTask", "t_hook", "slack:UDANA", "", "2026-10-12");
    await act("undelegateTask", "t_hook");
    await act("delegateTask", "t_hook", "slack:UDANA", "Use the new hook.", "2026-10-13");
    const s = await state();
    expect(s.tasks.find((x) => x.id === "t_hook")).toMatchObject({ due: "2026-10-13", delegatedTo: { name: "Dana Okafor", role: "Team member", note: "Use the new hook." } });
    expect(s.team.filter((p) => p.slackUserId === "UDANA")).toMatchObject([{ name: "Dana Okafor", depts: [], handles: [] }]);
    expect(await outbox()).toEqual([{ target: "UDANA", to_name: "Dana Okafor", body: "New task for you: Swap hook on Harbor clip 4\nDue Tue, Oct 13 · High priority · Harbor Realty\n\nUse the new hook." }]);
  });

  it("uses the team member when the Slack person is on the list already, and leaves the note out when there is none", async () => {
    await act("delegateTask", "t_hook", "slack:ULUIS", "", "2026-10-12");
    const s = await state();
    expect(s.tasks.find((x) => x.id === "t_hook")!.delegatedTo).toMatchObject({ personId: "u_luis", name: "Luis Ramos", role: "Lead editor" });
    expect(s.team.filter((p) => p.slackUserId === "ULUIS")).toHaveLength(1);
    expect((await outbox())[0].body).toBe("New task for you: Swap hook on Harbor clip 4\nDue Mon, Oct 12 · High priority · Harbor Realty");
  });

  it("refuses an app or someone who is not in Slack, and changes nothing", async () => {
    await expect(act("delegateTask", "t_hook", "slack:UBOT", "", "2026-10-12")).rejects.toThrow("no longer in Slack");
    await expect(act("delegateTask", "t_hook", "slack:UNOBODY", "", "2026-10-12")).rejects.toThrow("no longer in Slack");
    expect((await state()).tasks.find((x) => x.id === "t_hook")!.delegatedTo).toBeNull();
    expect(await outbox()).toEqual([]);
  });

  it("assigns a new task to someone from Slack once it has been made", async () => {
    await act("addTask", { title: "Draft the proposal", dept: "SPM Sales", project: "", pri: "mid", due: "2026-10-14" });
    const proposal = async () => (await state()).tasks.find((x) => x.title === "Draft the proposal")!;
    expect((await proposal()).delegatedTo).toBeNull();
    await act("delegateTask", (await proposal()).id, "slack:UDANA", "", "2026-10-14");
    expect((await proposal()).delegatedTo).toMatchObject({ name: "Dana Okafor" });
    expect((await outbox()).map((o) => o.body)).toEqual(["New task for you: Draft the proposal\nDue Wed, Oct 14 · Medium priority"]);
  });

  it("assigns a message to someone from Slack as a task for them", async () => {
    await act("delegateConversation", "slack:D1", "slack:UDANA", "Please handle.", "2026-10-09");
    const s = await state();
    expect(s.tasks.find((x) => x.src?.id === "slack:D1")).toMatchObject({ dept: "Operations", delegatedTo: { name: "Dana Okafor" } });
    expect(s.inbox.find((x) => x.id === "slack:D1")!.done).toBe(true);
  });
});

describe("clicking twice", () => {
  const fromChat = async (id: string) => (await state()).tasks.filter((x) => x.src?.id === id);

  it("makes one task from a conversation however many times Make task is clicked", async () => {
    await Promise.all([act("conversationToTask", "slack:D1", "2026-10-08"), act("conversationToTask", "slack:D1", "2026-10-08"), act("conversationToTask", "slack:D1", "2026-10-08")]);
    await act("conversationToTask", "slack:D1", "2026-10-08");
    expect(await fromChat("slack:D1")).toHaveLength(1);
  });

  it("makes a new task for the same chat once the earlier one is done", async () => {
    await act("conversationToTask", "slack:D1", "2026-10-08");
    await act("toggleTask", (await fromChat("slack:D1"))[0].id, true);
    await act("conversationToTask", "slack:D1", "2026-10-09");
    expect((await fromChat("slack:D1")).map((x) => x.done).sort()).toEqual([false, true]);
  });

  it("leaves the owner's own tag and any link out of the task's name", async () => {
    await db.run("update conversations set last_text = $1 where id = 'slack:C1'", ["https://docs.google.com/spreadsheets/d/abc/edit @Jeremy Moser could you send Dana the contract please"]);
    await act("conversationToTask", "slack:C1", "2026-10-08");
    expect((await fromChat("slack:C1"))[0].title).toBe("Reply to Priya: could you send Dana the contract please");
  });

  it("assigns a conversation once: one task, one message", async () => {
    await act("delegateConversation", "slack:D1", "u_luis", "Please take it.", "2026-10-09");
    await act("delegateConversation", "slack:D1", "u_rene", "Please take it.", "2026-10-09");
    expect(await fromChat("slack:D1")).toMatchObject([{ delegatedTo: { name: "Luis Ramos" } }]);
    expect(await db.query("select to_name from outbox")).toEqual([{ to_name: "Luis Ramos" }]);
  });

  it("assigns the task a chat already has, in place of making a second one", async () => {
    await act("conversationToTask", "slack:D1", "2026-10-08");
    await act("delegateConversation", "slack:D1", "u_luis", "", "2026-10-09");
    expect(await fromChat("slack:D1")).toMatchObject([{ title: "Reply to Maya Chen: Can we swap the hook on clip 4 before Friday?", delegatedTo: { name: "Luis Ramos" } }]);
  });

  it("assigns a task once, and adds a suggested task once", async () => {
    await act("delegateTask", "t_hook", "u_luis", "", "2026-10-12");
    await act("delegateTask", "t_hook", "u_rene", "", "2026-10-12");
    expect((await state()).tasks.find((x) => x.id === "t_hook")!.delegatedTo).toMatchObject({ name: "Luis Ramos" });
    expect(await db.query("select count(*)::int as n from outbox")).toEqual([{ n: 1 }]);
    await db.run("insert into suggestions (id, owner_id, title, dept, pri, due, dedupe_key, created_at) values ('s_one', $1, 'Plan November', 'Operations', 'mid', '2026-10-20', 'k_one', $2)", [OWNER_ID, now.getTime()]);
    await Promise.all([act("acceptSuggestion", "s_one"), act("acceptSuggestion", "s_one")]);
    expect((await state()).tasks.filter((x) => x.title === "Plan November")).toHaveLength(1);
  });
});

describe("assigning in the chat", () => {
  const outbox = () => db.query<{ target: string | null; ctx: string; body: string; conversation_id: string | null; task_id: string | null }>("select target, ctx, body, conversation_id, task_id from outbox order by created_at, id");
  const chat = async (id: string) => (await state()).inbox.find((c) => c.id === id)!;

  it("posts in the channel the request came from, tagging the person, and shows it in that thread", async () => {
    await act("delegateConversation", "slack:C1", "u_luis", "Before Friday please.", "2026-10-09", "chat");
    const [task] = (await state()).tasks.filter((x) => x.src?.id === "slack:C1");
    expect(task).toMatchObject({ title: "From Priya: Booked 2 more discovery calls for tomorrow.", delegatedTo: { name: "Luis Ramos", note: "Before Friday please." } });
    expect(await outbox()).toEqual([{ target: "C1", ctx: "#sales", conversation_id: "slack:C1", task_id: task.id, body: "<@ULUIS> new task for you: From Priya: Booked 2 more discovery calls for tomorrow.\nDue Fri, Oct 9 · Low priority\n\nBefore Friday please." }]);
    const c = await chat("slack:C1");
    expect(c).toMatchObject({ done: true, replied: true });
    expect(c.thread.at(-1)).toMatchObject({ me: true, status: "queued", text: "@Luis Ramos new task for you: From Priya: Booked 2 more discovery calls for tomorrow.\nDue Fri, Oct 9 · Low priority\n\nBefore Friday please." });
  });

  it("uses the person's name when they have no Slack account to tag", async () => {
    await act("delegateConversation", "slack:C1", "u_rene", "", "2026-10-09", "chat");
    expect((await outbox())[0].body).toBe("Rene Park new task for you: From Priya: Booked 2 more discovery calls for tomorrow.\nDue Fri, Oct 9 · Low priority");
  });

  it("takes the unsent chat message back with the task", async () => {
    await act("delegateConversation", "slack:C1", "u_luis", "", "2026-10-09", "chat");
    const [task] = (await state()).tasks.filter((x) => x.src?.id === "slack:C1");
    await act("undelegateTask", task.id);
    expect(await outbox()).toEqual([]);
    const c = await chat("slack:C1");
    expect(c.replied).toBe(false);
    expect(c.thread.map((m) => m.me)).toEqual([false]);
  });

  it("assigns an existing task in the chat it came from", async () => {
    await act("conversationToTask", "slack:C1", "2026-10-08");
    const [task] = (await state()).tasks.filter((x) => x.src?.id === "slack:C1");
    await act("delegateTask", task.id, "u_luis", "", "2026-10-10", "chat");
    expect((await outbox())[0]).toMatchObject({ target: "C1", body: "<@ULUIS> new task for you: Reply to Priya: Booked 2 more discovery calls for tomorrow.\nDue Sat, Oct 10 · Low priority" });
  });

  it("refuses a one-to-one chat and a task that came from nowhere, and changes nothing", async () => {
    await expect(act("delegateConversation", "slack:D1", "u_luis", "", "2026-10-09", "chat")).rejects.toThrow("direct message");
    await expect(act("delegateTask", "t_hook", "u_luis", "", "2026-10-09", "chat")).rejects.toThrow("direct message");
    const s = await state();
    expect(s.tasks.map((x) => x.id)).toEqual(["t_hook"]);
    expect(s.tasks[0].delegatedTo).toBeNull();
    expect(s.inbox.find((c) => c.id === "slack:D1")!.done).toBe(false);
    expect(await outbox()).toEqual([]);
  });
});

describe("assigning in a Slack channel", () => {
  beforeEach(async () => {
    await db.run("insert into slack_channels (owner_id, id, name, kind, selected) values ($1, 'C1', 'sales', 'public', true), ($1, 'C7', 'ops-team', 'private', false)", [OWNER_ID]);
  });
  const outbox = () => db.query<{ target: string | null; to_name: string; ctx: string; body: string; conversation_id: string | null }>("select target, to_name, ctx, body, conversation_id from outbox order by created_at, id");
  const hook = async () => (await state()).tasks.find((x) => x.id === "t_hook")!;

  it("posts a task to any channel with nobody tagged: the channel takes it", async () => {
    await act("delegateTask", "t_hook", "", "Whoever is free.", "2026-10-12", "channel:C7");
    expect((await hook()).delegatedTo).toMatchObject({ personId: "channel:C7", name: "#ops-team", role: "Slack channel", note: "Whoever is free." });
    expect(await outbox()).toEqual([{ target: "C7", to_name: "#ops-team", ctx: "#ops-team", conversation_id: null, body: "New task: Swap hook on Harbor clip 4\nDue Mon, Oct 12 · High priority · Harbor Realty\n\nWhoever is free." }]);
    await act("undelegateTask", "t_hook");
    expect((await hook()).delegatedTo).toBeNull();
    expect(await outbox()).toEqual([]);
  });

  it("tags the person when one is picked, and the task is theirs", async () => {
    await act("delegateTask", "t_hook", "u_luis", "", "2026-10-12", "channel:C7");
    expect((await hook()).delegatedTo).toMatchObject({ personId: "u_luis", name: "Luis Ramos" });
    expect((await outbox())[0]).toMatchObject({ target: "C7", to_name: "Luis Ramos", body: "<@ULUIS> new task for you: Swap hook on Harbor clip 4\nDue Mon, Oct 12 · High priority · Harbor Realty" });
  });

  it("shows the post in the thread when the dashboard follows that channel", async () => {
    await act("delegateTask", "t_hook", "", "", "2026-10-12", "channel:C1");
    expect((await outbox())[0]).toMatchObject({ target: "C1", conversation_id: "slack:C1" });
    expect((await state()).inbox.find((c) => c.id === "slack:C1")!.thread.at(-1)).toMatchObject({ me: true, status: "queued", text: "New task: Swap hook on Harbor clip 4\nDue Mon, Oct 12 · High priority · Harbor Realty" });
  });

  it("assigns a conversation to a channel without picking anyone", async () => {
    await act("delegateConversation", "slack:D1", "", "", "2026-10-09", "channel:C7");
    const [task] = (await state()).tasks.filter((x) => x.src?.id === "slack:D1");
    expect(task).toMatchObject({ dept: "Operations", delegatedTo: { name: "#ops-team" } });
    expect((await outbox())[0].body).toBe("New task: From Maya Chen: Can we swap the hook on clip 4 before Friday?\nDue Fri, Oct 9 · Low priority");
  });

  it("posts a new task into a channel once it has been made, description and all", async () => {
    await act("addTask", { title: "Draft the proposal", description: "Two pages, pricing on the second.", dept: "SPM Sales", project: "", pri: "mid", due: "2026-10-14" });
    const proposal = async () => (await state()).tasks.find((x) => x.title === "Draft the proposal")!;
    await act("delegateTask", (await proposal()).id, "", "", "2026-10-14", "channel:C7");
    expect((await proposal()).delegatedTo).toMatchObject({ name: "#ops-team" });
    expect((await outbox()).map((o) => o.body)).toEqual(["New task: Draft the proposal\nDue Wed, Oct 14 · Medium priority", "Two pages, pricing on the second."]);
  });

  it("needs a person for a direct message, and a channel from the owner's own list", async () => {
    await expect(act("delegateTask", "t_hook", "", "", "2026-10-12")).rejects.toThrow("Pick who should get the direct message");
    await expect(act("delegateTask", "t_hook", "", "", "2026-10-12", "channel:CNOTMINE")).rejects.toThrow("not on your channel list");
    expect((await hook()).delegatedTo).toBeNull();
    expect(await outbox()).toEqual([]);
  });
});

describe("reading the inbox", () => {
  it("shows the newest 30 messages of a long conversation, oldest first", async () => {
    for (let k = 0; k < 40; k++) {
      await db.run("insert into messages (id, conversation_id, owner_id, sender_name, body, at) values ($1, 'slack:C1', $2, 'Priya', $3, $4)", [`m_long_${k}`, OWNER_ID, `update ${k}`, now.getTime() + k]);
    }
    const inbox = (await state()).inbox;
    const long = inbox.find((c) => c.id === "slack:C1")!.thread;
    expect(long).toHaveLength(30);
    expect([long[0].text, long.at(-1)!.text]).toEqual(["update 10", "update 39"]);
    expect(inbox.find((c) => c.id === "slack:D1")!.thread).toHaveLength(1);
  });
});

describe("profile pictures", () => {
  it("hands the screens each person's picture by the name on their messages, preferring someone current", async () => {
    await db.run(
      `insert into slack_users (owner_id, id, name, is_bot, deleted, image) values
         ($1, 'U1', 'Maya Chen', false, false, 'https://pics.example/maya.png'),
         ($1, 'U2', 'Priya', false, true, 'https://pics.example/priya-who-left.png'),
         ($1, 'U3', 'Priya', false, false, 'https://pics.example/priya.png'),
         ($1, 'U4', 'Luis Ramos', false, false, null)`,
      [OWNER_ID],
    );
    expect((await state()).avatars).toEqual({ "Maya Chen": "https://pics.example/maya.png", Priya: "https://pics.example/priya.png" });
  });
});

describe("Slack threads", () => {
  const T0 = 1_760_000_000;
  const ts = (k: number) => `${T0 + k}.000100`;
  const put = (k: number, sender: string, body: string, thread: number | null, me = false) =>
    db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, me, body, at, thread_ts) values ($1, 'slack:C1', $2, $3, $4, $5, $6, $7, $8)", [`slack:C1:${ts(k)}`, OWNER_ID, ts(k), sender, me, body, (T0 + k) * 1000, thread === null ? null : ts(thread)]);
  const sales = async () => (await state()).inbox.find((c) => c.id === "slack:C1")!;

  it("hands the screens each message's own id and the thread it is in", async () => {
    await put(10, "Priya", "Proposal draft is ready", 10);
    await put(20, "Luis Ramos", "Looks good to me", 10);
    // The message that was there already is in no thread.
    const all = (await sales()).thread;
    expect(all.find((m) => m.text === "Booked 2 more discovery calls for tomorrow.")).toMatchObject({ ts: "1.0", thread: undefined });
    const thread = all.filter((m) => m.thread);
    expect(thread.map((m) => [m.text, m.ts === m.thread, m.thread])).toEqual([["Proposal draft is ready", true, ts(10)], ["Looks good to me", false, ts(10)]]);
  });

  it("keeps the first message of a long thread, with its newest replies", async () => {
    await put(10, "Priya", "Who can take the Harbor report?", 10);
    for (let k = 1; k <= 60; k++) await put(10 + k, "Luis Ramos", `reply ${k}`, 10);
    const texts = (await sales()).thread.map((m) => m.text);
    expect(texts).toContain("Who can take the Harbor report?");
    expect(texts).toContain("reply 60");
    expect(texts).not.toContain("reply 1");
    expect(texts.filter((t) => t.startsWith("reply"))).toHaveLength(40);
  });

  it("puts a reply written in the dashboard into the thread it answers, and marks that message as the start of one", async () => {
    await put(10, "Priya", "Can you approve the proposal?", null);
    await act("sendReply", "slack:C1", "Approved.", false, ts(10));
    const thread = (await sales()).thread;
    expect(thread.find((m) => m.text === "Can you approve the proposal?")!.thread).toBe(ts(10));
    expect(thread.at(-1)).toMatchObject({ me: true, text: "Approved.", status: "queued", thread: ts(10) });
    expect(await db.query("select target, thread_ts, body from outbox")).toEqual([{ target: "C1", thread_ts: ts(10), body: "Approved." }]);
  });

  it("posts to the chat itself when no thread is picked, and refuses a thread from somewhere else", async () => {
    await act("sendReply", "slack:C1", "Morning all.", false);
    expect(await db.query("select thread_ts from outbox")).toEqual([{ thread_ts: null }]);
    await expect(act("sendReply", "slack:C1", "Hello?", false, "1.000100")).rejects.toThrow("no longer in this conversation");
    expect(await db.query("select count(*)::int as n from outbox")).toEqual([{ n: 1 }]);
  });
});

describe("suggested due dates", () => {
  it("offers today in place of a date that has passed, and adds the task for today", async () => {
    await db.run("insert into suggestions (id, owner_id, title, dept, pri, due, dedupe_key, created_at) values ('s_old', $1, 'Send the September report', 'Operations', 'mid', '2026-10-02', 'k1', $2), ('s_next', $1, 'Plan November', 'Operations', 'mid', '2026-10-20', 'k2', $2)", [OWNER_ID, now.getTime()]);
    const today = (await state()).suggestions;
    expect(today.find((g) => g.id === "s_old")!.due).toBe("2026-10-08");
    expect(today.find((g) => g.id === "s_next")!.due).toBe("2026-10-20");
    await act("acceptSuggestion", "s_old");
    expect((await state()).tasks.find((t) => t.title === "Send the September report")!.due).toBe("2026-10-08");
  });
});

describe("tasks from calls", () => {
  const items = [
    { text: "Send the September report", who: "Jeremy Moser", mine: true, done: false },
    { text: "Share brand assets", who: "Maya Chen", mine: false, done: false },
  ];
  beforeEach(async () => {
    await db.run("insert into meetings (id, owner_id, external_id, title, started_at, project, action_items) values ('fathom:42', $1, '42', 'Weekly check-in', $2, 'Harbor Realty', $3)", [OWNER_ID, now.getTime(), JSON.stringify(items)]);
  });

  it("turns someone else's action item into a follow-up task linked to the call, only once", async () => {
    await act("actionItemToTask", "fathom:42", 1);
    await act("actionItemToTask", "fathom:42", 1);
    const fromCall = (await state()).tasks.filter((t) => t.src?.type === "meeting");
    expect(fromCall).toMatchObject([{ title: "Follow up with Maya Chen: Share brand assets", project: "Harbor Realty", mode: "professional", src: { type: "meeting", id: "fathom:42" } }]);
  });

  it("adds the owner's own action item under its own words, and refuses one that is not there", async () => {
    await act("actionItemToTask", "fathom:42", 0);
    expect((await state()).tasks.map((t) => t.title)).toContain("Send the September report");
    await expect(act("actionItemToTask", "fathom:42", 9)).rejects.toThrow("no longer exists");
  });
});

