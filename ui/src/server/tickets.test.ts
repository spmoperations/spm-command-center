// The team's board and the review: shared by everyone with a login, a ticket for each thing
// worth doing, and its person told on Slack or Telegram from the account of whoever assigned it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TicketInput } from "@/core/types";
import type { Db } from "./db";
import { applyAction, loadState, OWNER_ID } from "./repo";
import { seal } from "./secrets";
import { NOW, reset, seed, testDb } from "./testing";

let db: Db;
const now = new Date(NOW);
let alex = "";

const act = (who: string, type: string, ...args: unknown[]) => applyAction(db, type, args, who, now);
const refused = (who: string, type: string, ...args: unknown[]) =>
  act(who, type, ...args).then(
    () => "done",
    (e: Error) => e.message,
  );

/** A suggestion as the checks write one: a request in the owner's chat with Maya, unless told otherwise. */
async function suggestion(
  id: string,
  over: {
    owner?: string;
    title?: string;
    mode?: string;
    key?: string;
    src?: [string, string];
  } = {},
) {
  const [type, src] = over.src ?? ["message", "slack:D1"];
  await db.run(
    "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, mode, created_at) values ($1, $2, $3, 'Operations', 'Harbor Realty', 'high', '2026-10-09', 'Maya asked and is still waiting.', $4, $5, $6, $7, $8)",
    [id, over.owner ?? OWNER_ID, over.title ?? "Reply to Maya Chen: swap the hook", type, src, over.key ?? `ask:${src}:1.0`, over.mode ?? "professional", NOW],
  );
}

const ticket = (input: Partial<TicketInput>): TicketInput => ({
  title: "Chase the invoices",
  description: "",
  assignee: null,
  client: "",
  due: "2026-10-10",
  status: "open",
  ...input,
});

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
  await seed(db);
  await act(OWNER_ID, "addTeamLogin", "Alex", "alex@example.com", "a long enough password");
  alex = (await db.query<{ id: string }>("select id from users where login_email = 'alex@example.com'"))[0].id;
});

describe("the review", () => {
  it("shows everyone on the team every work suggestion, with the line it came from, and never a personal one", async () => {
    await suggestion("s_owner");
    await suggestion("s_personal", {
      title: "Book the dentist",
      mode: "personal",
      key: "ask:dentist",
    });
    await db.run(
      "insert into conversations (id, owner_id, source, external_id, from_name, ctx, last_text, last_at) values ('slack:D7', $1, 'slack', 'D7', 'Priya', 'Direct message', 'Can you send the deck?', $2)",
      [alex, NOW],
    );
    await db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, body, at) values ('slack:D7:1.0', 'slack:D7', $1, '1.0', 'Priya', 'Can you send the deck?', $2)", [
      alex,
      NOW,
    ]);
    await suggestion("s_alex", {
      owner: alex,
      title: "Reply to Priya: send the deck",
      src: ["message", "slack:D7"],
    });

    const hers = (await loadState(db, alex, now)).review;
    expect(hers.map((g) => [g.id, g.source.label, g.source.quote, g.source.from, g.assignee, g.mine]).sort()).toEqual([
      ["s_alex", "Slack · Priya", "Can you send the deck?", "Alex", `user:${alex}`, true],
      ["s_owner", "Slack · Maya Chen", "Can we swap the hook on clip 4 before Friday?", "Jeremy Moser", `user:${OWNER_ID}`, false],
    ]);
    expect(hers[0].source.link).toMatch(/^https:\/\/slack\.com\/app_redirect\?channel=D/);
    // The owner sees Alex's too, and his own personal one.
    expect((await loadState(db, OWNER_ID, now)).review.map((g) => g.id).sort()).toEqual(["s_alex", "s_owner", "s_personal"]);
    // Everyone a ticket can be for: the logins first, then the team list.
    expect((await loadState(db, alex, now)).people.map((p) => [p.id, p.name, p.slack])).toEqual([
      [`user:${OWNER_ID}`, "Jeremy Moser", false],
      [`user:${alex}`, "Alex", false],
      ["member:u_luis", "Luis Ramos", true],
      ["member:u_rene", "Rene Park", false],
    ]);
  });

  it("makes a numbered ticket of a suggestion for whoever it is for, keeping where it came from and what happened", async () => {
    await suggestion("s_owner");
    await act(alex, "acceptSuggestion", "s_owner", {
      title: "Swap the hook on clip 4",
      assignee: `user:${alex}`,
      client: "Harbor Realty",
      status: "in_progress",
      due: "2026-10-12",
    });
    // A second click makes nothing more.
    await act(alex, "acceptSuggestion", "s_owner");
    for (const who of [alex, OWNER_ID]) {
      const t = (await loadState(db, who, now)).tasks.find((x) => x.title === "Swap the hook on clip 4")!;
      expect([t.number, t.status, t.assignee, t.assigneeName, t.project, t.due, t.createdBy]).toEqual([1, "in_progress", `user:${alex}`, "Alex", "Harbor Realty", "2026-10-12", "Alex"]);
      expect(t.source).toEqual({
        label: "Slack · Maya Chen",
        quote: "Can we swap the hook on clip 4 before Friday?",
        link: "https://slack.com/app_redirect?channel=D1",
        from: "Jeremy Moser",
      });
      expect(t.theirs).toBe(who === alex ? true : undefined);
      expect(t.history!.map((e) => [e.by, e.what])).toEqual([
        ["Alex", "Made a ticket from Slack · Maya Chen, Jeremy Moser's"],
        ["Alex", "Assigned to Alex"],
      ]);
    }
    expect(await db.query("select status, ticket_id is not null as linked from suggestions where id = 's_owner'")).toEqual([{ status: "accepted", linked: true }]);
    expect((await loadState(db, alex, now)).review).toEqual([]);
    // The request-finder sees the ticket: no second suggestion for the same chat.
    expect((await db.query("select count(*)::int as n from tasks where owner_id = $1 and coalesce(source_owner, owner_id) = $1 and src_id = 'slack:D1' and not done", [OWNER_ID]))[0].n).toBe(1);
  });

  it("turns suggestions down with a reason, takes many at once, and merges one into a ticket", async () => {
    for (const id of ["s_1", "s_2", "s_3", "s_4"]) await suggestion(id, { title: `Thing ${id}`, key: `ask:${id}` });
    await act(alex, "rejectSuggestion", "s_1", "chit_chat");
    expect(await refused(alex, "rejectSuggestion", "s_2", "because")).toBe("Why is it not a ticket?");
    await act(alex, "reviewMany", ["s_2", "s_3"], "accept");
    expect(await db.query("select id, status, reason from suggestions order by id")).toEqual([
      { id: "s_1", status: "dismissed", reason: "chit_chat" },
      { id: "s_2", status: "accepted", reason: null },
      { id: "s_3", status: "accepted", reason: null },
      { id: "s_4", status: "new", reason: null },
    ]);
    const tickets = (await loadState(db, alex, now)).tasks.filter((t) => t.number);
    expect(tickets.map((t) => [t.number, t.title, t.assignee]).sort()).toEqual(
      [
        [1, "Thing s_2", `user:${OWNER_ID}`],
        [2, "Thing s_3", `user:${OWNER_ID}`],
      ].sort(),
    );
    // Nobody is messaged when many are taken at once.
    expect(await db.query("select id from outbox")).toEqual([]);

    const into = tickets.find((t) => t.title === "Thing s_2")!;
    await act(alex, "mergeSuggestion", "s_4", into.id);
    const merged = (await loadState(db, alex, now)).tasks.find((t) => t.id === into.id)!;
    expect(merged.description).toBe("Maya asked and is still waiting.\n\nAlso raised in Slack · Maya Chen (Jeremy Moser's):\nCan we swap the hook on clip 4 before Friday?");
    expect(merged.history!.at(-1)!.what).toBe("Merged in: Thing s_4");
    expect((await loadState(db, alex, now)).review).toEqual([]);
  });
});

describe("the board", () => {
  it("moves a ticket across the columns, keeping done in step whichever way it is ticked", async () => {
    await act(alex, "createTicket", ticket({ assignee: `user:${alex}` }));
    const id = (await db.query<{ id: string }>("select id from tasks where title = 'Chase the invoices'"))[0].id;
    const state = async () => (await loadState(db, OWNER_ID, now)).tasks.find((t) => t.id === id)!;
    await act(alex, "updateTicket", id, {
      status: "waiting",
      due: "2026-10-14",
      client: "Harbor Realty",
    });
    expect([(await state()).status, (await state()).done]).toEqual(["waiting", false]);
    await act(OWNER_ID, "updateTicket", id, { status: "done" });
    expect([(await state()).status, (await state()).done, Boolean((await state()).doneAt)]).toEqual(["done", true, true]);
    await act(alex, "toggleTask", id, false);
    expect([(await state()).status, (await state()).done]).toEqual(["open", false]);
    expect((await state()).history!.map((e) => `${e.by}: ${e.what}`)).toEqual([
      "Alex: Created",
      "Alex: Assigned to Alex",
      "Alex: Client: Harbor Realty · Due Wed, Oct 14 · Status: Waiting",
      "Jeremy Moser: Status: Done",
      "Alex: Status: Open",
    ]);
    expect(await refused(alex, "updateTicket", id, { status: "someday" })).toBe("That is not a status on the board.");
    expect(await refused(alex, "updateTicket", id, { title: "  " })).toBe("Give the ticket a title.");
    expect(await refused(alex, "createTicket", ticket({ assignee: "user:nobody" }))).toBe("That person is not on the team.");
  });

  it("tells a team member on Slack and Telegram from the account of whoever assigned it, and withdraws what has not gone", async () => {
    await db.run("update team_members set telegram_id = '555' where id = 'u_luis'");
    expect(await refused(alex, "createTicket", ticket({ assignee: "member:u_luis", notify: ["slack"] }))).toBe("Connect your own Slack first, to tell Luis Ramos there. Or untick it.");
    for (const provider of ["slack", "telegram"])
      await db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, $2, $3, 'Alex', $4)", [alex, provider, seal("a-login"), NOW]);
    await act(
      alex,
      "createTicket",
      ticket({
        assignee: "member:u_luis",
        notify: ["slack", "telegram"],
        description: "The three from September.",
      }),
    );
    const id = (await db.query<{ id: string }>("select id from tasks where title = 'Chase the invoices'"))[0].id;
    const [row] = await db.query<{ number: number }>("select number from tasks where id = $1", [id]);
    expect(await db.query("select owner_id, source, target, ctx, body from outbox order by source")).toEqual([
      {
        owner_id: alex,
        source: "slack",
        target: "ULUIS",
        ctx: "Direct message",
        body: `New task for you: Chase the invoices (SPM-${row.number})\nDue Sat, Oct 10 · Medium priority\n\nThe three from September.`,
      },
      {
        owner_id: alex,
        source: "telegram",
        target: "555",
        ctx: "Telegram",
        body: `New task for you: Chase the invoices (SPM-${row.number})\nDue Sat, Oct 10 · Medium priority\n\nThe three from September.`,
      },
    ]);
    const t = (await loadState(db, OWNER_ID, now)).tasks.find((x) => x.id === id)!;
    expect([t.assignee, t.assigneeName, t.history!.at(-1)!.what]).toEqual(["member:u_luis", "Luis Ramos", "Assigned to Luis Ramos, told on Slack and Telegram"]);
    // Given to someone else before the messages went: they are withdrawn.
    await act(alex, "updateTicket", id, { assignee: `user:${OWNER_ID}` });
    expect(await db.query("select id from outbox")).toEqual([]);
    expect((await loadState(db, alex, now)).tasks.find((x) => x.id === id)!.assigneeName).toBe("Jeremy Moser");
  });
});

describe("the words of a suggestion", () => {
  it("name whose reply or action item it is for everyone but that person, and on the ticket", async () => {
    await db.run(
      "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, mode, created_at) values ('s_why', $1, 'Reply to Maya', 'Operations', '', 'mid', '2026-10-09', 'Maya Chen asked in a direct message and is still waiting for your reply.', 'message', 'slack:D1', 'ask:slack:D1:1.0', 'professional', $2)",
      [OWNER_ID, NOW],
    );
    expect((await loadState(db, OWNER_ID, now)).review[0].why).toBe("Maya Chen asked in a direct message and is still waiting for your reply.");
    expect((await loadState(db, alex, now)).review[0].why).toBe("Maya Chen asked in a direct message and is still waiting for Jeremy Moser's reply.");
    await act(alex, "acceptSuggestion", "s_why");
    expect((await loadState(db, OWNER_ID, now)).tasks.find((t) => t.title === "Reply to Maya")!.description).toBe("Maya Chen asked in a direct message and is still waiting for Jeremy Moser's reply.");
  });
});

describe("who a ticket can be for", () => {
  it("is anyone in Slack or in the assigner's Telegram chats too, who then join the team list and are told there", async () => {
    await db.run("insert into slack_users (owner_id, id, name, is_bot, deleted) values ($1, 'UMAYA', 'Maya Chen', false, false)", [OWNER_ID]);
    await db.run(
      "insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, last_text, last_at) values ('telegram:42', $1, 'telegram', '42', 'Dana Whitfield', 'Direct message', true, 'Hi', $2)",
      [alex, NOW],
    );
    for (const provider of ["slack", "telegram"])
      await db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, $2, $3, 'Alex', $4)", [alex, provider, seal("a-login"), NOW]);

    // Alex picks Maya from the team's Slack, and Dana from her own Telegram.
    await act(alex, "createTicket", ticket({ title: "Send the brand assets", assignee: "slack:UMAYA", notify: ["slack"] }));
    await act(alex, "createTicket", ticket({ title: "Confirm the shoot", assignee: "telegram:42", notify: ["telegram"] }));
    expect(await db.query("select name, slack_user_id, telegram_id from team_members where owner_id = $1 and name in ('Maya Chen', 'Dana Whitfield') order by name", [OWNER_ID])).toEqual([
      { name: "Dana Whitfield", slack_user_id: null, telegram_id: "42" },
      { name: "Maya Chen", slack_user_id: "UMAYA", telegram_id: null },
    ]);
    expect(
      (await db.query<{ source: string; target: string; to_name: string }>("select source, target, to_name from outbox where owner_id = $1 order by source", [alex])).map((o) => [
        o.source,
        o.target,
        o.to_name,
      ]),
    ).toEqual([
      ["slack", "UMAYA", "Maya Chen"],
      ["telegram", "42", "Dana Whitfield"],
    ]);
    // Picked again, they are the same row: nobody is on the list twice.
    await act(alex, "createTicket", ticket({ title: "And the logo", assignee: "slack:UMAYA" }));
    expect((await db.query("select id from team_members where owner_id = $1 and slack_user_id = 'UMAYA'", [OWNER_ID])).length).toBe(1);
    expect(await refused(alex, "createTicket", ticket({ assignee: "telegram:99" }))).toBe("That person is not one of your Telegram chats.");
    expect(await refused(alex, "createTicket", ticket({ assignee: "slack:UNOBODY" }))).toBe("That person is no longer in Slack.");
  });

  it("starts a call's action item with the person Fathom named when they are in Slack", async () => {
    await db.run("insert into slack_users (owner_id, id, name, is_bot, deleted) values ($1, 'UMAYA', 'Maya Chen', false, false)", [OWNER_ID]);
    await db.run("insert into meetings (id, owner_id, external_id, title, started_at, action_items) values ('fathom:7', $1, '7', 'Weekly', $2, $3)", [
      OWNER_ID,
      NOW,
      JSON.stringify([{ text: "Send the assets", who: "Maya Chen", mine: false, done: false }]),
    ]);
    await suggestion("s_call", { title: "Send the assets", src: ["meeting", "fathom:7"], key: "fathom:7:action:0" });
    expect((await loadState(db, alex, now)).review.map((g) => [g.forName, g.assignee])).toEqual([["Maya Chen", "slack:UMAYA"]]);
  });
});

describe("when a suggestion was raised", () => {
  it("is when the message was sent or the call started, not when the check found it", async () => {
    await suggestion("s_msg");
    await db.run("insert into meetings (id, owner_id, external_id, title, started_at, action_items) values ('fathom:8', $1, '8', 'Weekly', $2, $3)", [
      OWNER_ID,
      NOW - 3 * 86_400_000,
      JSON.stringify([{ text: "Send the assets", who: "Jeremy Moser", mine: true, done: false }]),
    ]);
    await suggestion("s_call", { title: "Send the assets", src: ["meeting", "fathom:8"], key: "fathom:8:action:0" });
    const raised = Object.fromEntries((await loadState(db, alex, now)).review.map((g) => [g.id, g.raisedAt]));
    // The seeded message from Maya was sent a minute before NOW; the call started three days before.
    expect(raised).toEqual({ s_msg: NOW - 60_000, s_call: NOW - 3 * 86_400_000 });
  });
});

describe("the team's clients", () => {
  it("keeps a client typed in once for the whole team, whatever its capitals, next to those tickets already name", async () => {
    await act(alex, "addClient", "  Northwind   Labs ");
    await act(OWNER_ID, "addClient", "northwind labs");
    expect(await refused(alex, "addClient", "   ")).toBe("Type the client's name.");
    await act(alex, "createTicket", ticket({ client: "Acme Co" }));
    // Harbor Realty is the seeded task's; Northwind Labs was added by hand, once; Acme Co is on a ticket.
    for (const who of [OWNER_ID, alex]) expect((await loadState(db, who, now)).clients).toEqual(["Acme Co", "Harbor Realty", "Northwind Labs"]);
    expect(await db.query("select name from clients where owner_id = $1", [OWNER_ID])).toEqual([{ name: "Northwind Labs" }]);
  });
});
