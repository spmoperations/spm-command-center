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
    due?: string;
  } = {},
) {
  const [type, src] = over.src ?? ["message", "slack:D1"];
  await db.run(
    "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, mode, created_at) values ($1, $2, $3, 'Operations', 'Harbor Realty', 'high', $9, 'Maya asked and is still waiting.', $4, $5, $6, $7, $8)",
    [id, over.owner ?? OWNER_ID, over.title ?? "Reply to Maya Chen: swap the hook", type, src, over.key ?? `ask:${src}:1.0`, over.mode ?? "professional", NOW, over.due ?? "2026-10-09"],
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
    // Everyone a ticket can be for: the logins first, then the team list. Jeremy's Slack is known, so he can be told there.
    expect((await loadState(db, alex, now)).people.map((p) => [p.id, p.name, p.slack])).toEqual([
      [`user:${OWNER_ID}`, "Jeremy Moser", true],
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
        // Tagged, so Slack notifies Luis of a mention.
        body: `<@ULUIS> new task for you: Chase the invoices (SPM-${row.number})\nDue Sat, Oct 10 · Medium priority\n\nThe three from September.`,
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

describe("no due date", () => {
  it("stays empty from the review to the board, where it can be set and cleared again", async () => {
    await suggestion("s_none", { title: "Send the deck link to Sam", src: ["meeting", "fathom:42"], key: "fathom:42:action:0", due: "" });
    expect((await loadState(db, OWNER_ID, now)).review.find((g) => g.id === "s_none")?.due).toBe("");
    await act(OWNER_ID, "acceptSuggestion", "s_none");
    const t = () => loadState(db, OWNER_ID, now).then((s) => s.tasks.find((x) => x.title === "Send the deck link to Sam")!);
    expect((await t()).due).toBe("");
    const { id } = await t();
    await act(OWNER_ID, "updateTicket", id, { due: "2026-10-12" });
    await act(OWNER_ID, "updateTicket", id, { due: "" });
    expect((await t()).history!.map((e) => e.what).slice(-2)).toEqual(["Due Mon, Oct 12", "No due date"]);
    await act(OWNER_ID, "createTicket", ticket({ title: "Undated by hand", due: "" }));
    expect((await loadState(db, OWNER_ID, now)).tasks.find((x) => x.title === "Undated by hand")?.due).toBe("");
    expect(await refused(OWNER_ID, "createTicket", ticket({ title: "Wrong", due: "soon" }))).toBe("Pick a due date, or leave it empty.");
  });
});

describe("a login told on Slack", () => {
  const outbox = () => db.query<{ owner_id: string; target: string; to_name: string; body: string }>("select owner_id, target, to_name, body from outbox order by created_at, id");
  const slackFor = (who: string) => db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, 'slack', $2, 'Slack', $3)", [who, seal("a-login"), NOW]);
  const notTold = async (viewer: string) => (await loadState(db, viewer, now)).people.filter((p) => p.login).map((p) => [p.name, p.slack, Boolean(p.notTold)]);

  it("tags Jeremy and Alex in a direct message when the other gives them a task, and nobody about their own", async () => {
    await slackFor(OWNER_ID);
    await slackFor(alex);
    await db.run("update users set slack_user_id = 'UALEX' where id = $1", [alex]);
    // Each one's board offers to tell the other, ticked, and never themselves.
    expect(await notTold(OWNER_ID)).toEqual([["Jeremy Moser", true, true], ["Alex", true, false]]);
    expect(await notTold(alex)).toEqual([["Jeremy Moser", true, false], ["Alex", true, true]]);

    await act(OWNER_ID, "createTicket", ticket({ assignee: `user:${alex}`, notify: ["slack"] }));
    const [first] = await db.query<{ id: string; number: number }>("select id, number from tasks where title = 'Chase the invoices'");
    expect(await outbox()).toEqual([{ owner_id: OWNER_ID, target: "UALEX", to_name: "Alex", body: `<@UALEX> new task for you: Chase the invoices (SPM-${first.number})\nDue Sat, Oct 10 · Medium priority` }]);
    expect((await loadState(db, OWNER_ID, now)).tasks.find((t) => t.id === first.id)!.history!.at(-1)!.what).toBe("Assigned to Alex, told on Slack");

    // Alex to Jeremy, from her own Slack.
    await db.run("delete from outbox");
    await act(alex, "createTicket", ticket({ title: "Sign the contract", assignee: `user:${OWNER_ID}`, notify: ["slack"] }));
    expect((await outbox()).map((o) => [o.owner_id, o.target, o.body.split("\n")[0]])).toEqual([[alex, "UME", expect.stringMatching(/^<@UME> new task for you: Sign the contract/)]]);

    // Nobody about their own task, whatever was ticked, and however they were picked.
    await db.run("delete from outbox");
    await act(alex, "createTicket", ticket({ title: "Book the studio", assignee: `user:${alex}`, notify: ["slack"] }));
    await act(OWNER_ID, "createTicket", ticket({ title: "Call the bank", assignee: `user:${OWNER_ID}`, notify: ["slack"] }));
    await db.run("insert into slack_users (owner_id, id, name) values ($1, 'UME', 'Jeremy Moser')", [OWNER_ID]);
    await act(OWNER_ID, "createTicket", ticket({ title: "Review the deck", assignee: "slack:UME", notify: ["slack"] }));
    expect(await outbox()).toEqual([]);
    // Someone on the team list is still told by whoever gives them the task.
    await act(alex, "createTicket", ticket({ title: "Cut the trailer", assignee: "member:u_luis", notify: ["slack"] }));
    expect((await outbox()).map((o) => [o.owner_id, o.target])).toEqual([[alex, "ULUIS"]]);
  });

  it("lays the Slack message out, with the task's name linked to it for everyone told", async () => {
    process.env.SITE_URL = "https://board.example.com";
    try {
      await slackFor(OWNER_ID);
      await db.run("update users set slack_user_id = 'UALEX' where id = $1", [alex]);
      await act(OWNER_ID, "createTicket", ticket({ assignee: `user:${alex}`, notify: ["slack"], client: "Harbor Realty" }));
      // Luis has no login of any kind: the link takes him to sign in, and to the ticket once he can.
      await act(OWNER_ID, "createTicket", ticket({ title: "Cut the trailer", assignee: "member:u_luis", notify: ["slack"] }));
      const rows = await db.query<{ target: string; details: { blocks: { type: string; text?: { text: string }; elements?: { text: string }[] }[] } }>("select target, details from outbox order by created_at, id");
      const facts = (target: string) => rows.find((r) => r.target === target)!.details.blocks.at(-1)!.elements![0].text;
      const task = (target: string) => rows.find((r) => r.target === target)!.details.blocks[1].text!.text;
      expect(rows.find((r) => r.target === "UALEX")!.details.blocks[0].text!.text).toBe("<@UALEX> *New task for you*");
      expect(facts("UALEX")).toMatch(/^\*SPM-\d+\*  ·  Due \*Sat, Oct 10\*  ·  Medium priority  ·  Harbor Realty$/);
      expect(task("UALEX")).toMatch(/^\*<https:\/\/board\.example\.com\/tasks\?task=SPM-\d+\|Chase the invoices>\*$/);
      expect(task("ULUIS")).toMatch(/^\*<https:\/\/board\.example\.com\/tasks\?task=SPM-\d+\|Cut the trailer>\*$/);
    } finally {
      delete process.env.SITE_URL;
    }
    // Where the site's address is not known, such as on a developer's machine, the name is plain.
    await db.run("delete from outbox");
    await act(OWNER_ID, "createTicket", ticket({ title: "Plain", assignee: "member:u_luis", notify: ["slack"] }));
    const [plain] = await db.query<{ details: { blocks: { text?: { text: string } }[] } }>("select details from outbox");
    expect(plain.details.blocks[1].text!.text).toBe("*Plain*");
  });

  it("leaves out why the dashboard found the task, and keeps what a person wrote", async () => {
    await slackFor(OWNER_ID);
    await slackFor(alex);
    await db.run("update users set slack_user_id = 'UALEX' where id = $1", [alex]);
    await db.run("update users set slack_user_id = 'UME' where id = $1", [OWNER_ID]);
    const add = (id: string, why: string) =>
      db.run(
        "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, mode, created_at) values ($1, $2, $3, 'Operations', '', 'mid', '2026-10-10', $4, 'message', 'slack:D1', $5, 'professional', $6)",
        [id, OWNER_ID, `Send access ${id}`, why, `ask:${id}`, NOW],
      );
    await add("s_for", 'Fathom listed this for Alex on "SPM - Operations".');
    await add("s_mine", 'Fathom listed this as your action item on "SPM - Operations".');
    // As the Review tab sends it: the reason, as each of them was shown it, in the description.
    await act(OWNER_ID, "acceptSuggestion", "s_for", { assignee: `user:${alex}`, notify: ["slack"], description: 'Fathom listed this for Alex on "SPM - Operations".' });
    await act(alex, "acceptSuggestion", "s_mine", {
      assignee: `user:${OWNER_ID}`,
      notify: ["slack"],
      description: `Fathom listed this as Jeremy Moser's action item on "SPM - Operations".\n\nUse the shared login.`,
    });
    const sent = await db.query<{ target: string; body: string; details: { blocks: { text?: { text: string } }[] } }>("select target, body, details from outbox");
    expect(sent.map((o) => [o.target, o.body.includes("Fathom"), o.details.blocks[1].text!.text]).sort()).toEqual([
      ["UALEX", false, "*Send access s_for*"],
      ["UME", false, "*Send access s_mine*\nUse the shared login."],
    ]);
    // The board keeps it.
    expect((await loadState(db, OWNER_ID, now)).tasks.find((t) => t.title === "Send access s_for")!.description).toBe('Fathom listed this for Alex on "SPM - Operations".');
  });

  it("tells someone on the team list without a call's recording, and a login with it", async () => {
    await slackFor(OWNER_ID);
    await db.run("update users set slack_user_id = 'UALEX' where id = $1", [alex]);
    const note = "Use the second take: https://fathom.video/calls/876?timestamp=12";
    await act(OWNER_ID, "createTicket", ticket({ title: "For Luis", description: note, assignee: "member:u_luis", notify: ["slack"] }));
    await act(OWNER_ID, "createTicket", ticket({ title: "For Alex", description: note, assignee: `user:${alex}`, notify: ["slack"] }));
    const told = await db.query<{ target: string; body: string }>("select target, body from outbox order by created_at, id");
    expect(told.find((o) => o.target === "ULUIS")!.body).not.toContain("fathom");
    expect(told.find((o) => o.target === "ULUIS")!.body).toContain("Use the second take:");
    expect(told.find((o) => o.target === "UALEX")!.body).toContain("https://fathom.video/calls/876?timestamp=12");
  });

  it("tells no login about a task another login gives them, when neither is Jeremy", async () => {
    await act(OWNER_ID, "addTeamLogin", "Sam", "sam@example.com", "a long enough password");
    const sam = (await db.query<{ id: string }>("select id from users where login_email = 'sam@example.com'"))[0].id;
    await db.run("update users set slack_user_id = 'USAM' where id = $1", [sam]);
    await slackFor(alex);
    expect((await loadState(db, alex, now)).people.find((p) => p.name === "Sam")!.notTold).toBe(true);
    await act(alex, "createTicket", ticket({ assignee: `user:${sam}`, notify: ["slack"] }));
    expect(await outbox()).toEqual([]);
  });

  it("finds a login who never connected Slack by their email in the team's Slack, and asks Jeremy to connect his first", async () => {
    await db.run("insert into slack_users (owner_id, id, name, email) values ($1, 'UALEX2', 'Alex Z', 'Alex@Example.com')", [OWNER_ID]);
    expect((await loadState(db, OWNER_ID, now)).people.find((p) => p.name === "Alex")!.slack).toBe(true);
    expect(await refused(OWNER_ID, "createTicket", ticket({ assignee: `user:${alex}`, notify: ["slack"] }))).toBe("Connect your own Slack first, to tell Alex there. Or untick it.");
    await slackFor(OWNER_ID);
    await act(OWNER_ID, "createTicket", ticket({ assignee: `user:${alex}`, notify: ["slack"] }));
    expect((await outbox()).map((o) => o.target)).toEqual(["UALEX2"]);
    // Unticked, nobody is told.
    await act(OWNER_ID, "createTicket", ticket({ title: "Quietly", assignee: `user:${alex}`, notify: [] }));
    expect(await outbox()).toHaveLength(1);
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

describe("Agency, Consulting or Sales", () => {
  const pick = (who: string, source: string, kind: string, id: string, name: string, line: string | null) => act(who, "setChatLine", source, kind, id, name, line);
  const lineOnBoard = async (title: string, viewer = OWNER_ID) => {
    const t = (await loadState(db, viewer, now)).tasks.find((x) => x.title === title)!;
    return [t.line ?? null, t.chatLine ?? null];
  };

  it("are picked for chats and people by anyone with a login, once for the whole team", async () => {
    await pick(alex, "slack", "chat", "C1", "#sales", "sales");
    await pick(OWNER_ID, "telegram", "person", "555", "Dana", "consulting");
    for (const who of [OWNER_ID, alex]) {
      expect((await loadState(db, who, now)).chatLines).toEqual([
        { source: "slack", kind: "chat", id: "C1", name: "#sales", line: "sales" },
        { source: "telegram", kind: "person", id: "555", name: "Dana", line: "consulting" },
      ]);
    }
    // Picked again, it changes; taken away, it goes.
    await pick(OWNER_ID, "slack", "chat", "C1", "#sales", "agency");
    await pick(alex, "telegram", "person", "555", "Dana", null);
    expect((await loadState(db, alex, now)).chatLines.map((l) => [l.id, l.line])).toEqual([["C1", "agency"]]);
    expect(await refused(alex, "setChatLine", "slack", "chat", "C1", "#sales", "marketing")).toBe("That is not Agency, Consulting or Sales.");
    expect(await refused(alex, "setChatLine", "gmail", "chat", "C1", "#sales", "sales")).toBe("That is not a chat or a person.");
  });

  it("are picked from the owner's channels and people, by Alex too, while everything else shows Alex her own", async () => {
    await db.run("insert into slack_channels (owner_id, id, name, kind) values ($1, 'C_OPS', 'ops', 'public'), ($2, 'C_ALEX', 'alex-only', 'public')", [OWNER_ID, alex]);
    await db.run("insert into slack_users (owner_id, id, name) values ($1, 'UMAYA', 'Maya Chen'), ($2, 'UALEXFRIEND', 'Alex Friend')", [OWNER_ID, alex]);
    const state = await loadState(db, alex, now);
    const hers = state.ownerChats!;
    expect([hers.channels.map((c) => c.id), hers.slackPeople.map((p) => p.id)]).toEqual([["C_OPS"], ["UMAYA"]]);
    // Everywhere else (Important, Channels, the team list's pickers) she has her own lists.
    expect([state.channels.map((c) => c.id), state.slackPeople.map((p) => p.id)]).toEqual([["C_ALEX"], ["UALEXFRIEND"]]);
    // The owner picks from their own lists, which they already have.
    const his = await loadState(db, OWNER_ID, now);
    expect([his.ownerChats, his.channels.map((c) => c.id)]).toEqual([null, ["C_OPS"]]);
  });

  it("label a task with its chat's line, those made before the pick too, and the review card before it is a task", async () => {
    await suggestion("s_sales", { title: "Send Priya the call notes", src: ["message", "slack:C1"], key: "ask:slack:C1:1.0" });
    expect((await loadState(db, alex, now)).review.find((g) => g.id === "s_sales")?.line).toBeNull();
    await pick(OWNER_ID, "slack", "chat", "C1", "#sales", "sales");
    expect((await loadState(db, alex, now)).review.find((g) => g.id === "s_sales")?.line).toBe("sales");
    await act(alex, "acceptSuggestion", "s_sales");
    expect(await lineOnBoard("Send Priya the call notes", alex)).toEqual([null, "sales"]);
    // Picked otherwise later: the task follows.
    await pick(alex, "slack", "chat", "C1", "#sales", "consulting");
    expect(await lineOnBoard("Send Priya the call notes")).toEqual([null, "consulting"]);
  });

  it("take a direct chat's line from the person in it, and a channel's own pick first", async () => {
    // The owner's direct chat with Maya on Slack (seeded as slack:D1), and Alex's own Telegram chat with Dana.
    await db.run("insert into slack_channels (owner_id, id, name, kind, user_id) values ($1, 'D1', 'Maya Chen', 'im', 'UMAYA')", [OWNER_ID]);
    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, tagged, last_text, last_at) values ('telegram:555', $1, 'telegram', '555', 'Dana', 'Direct message', true, false, 'Can you call me?', $2)", [alex, NOW]);
    await suggestion("s_maya", { title: "Swap the hook for Maya", src: ["message", "slack:D1"] });
    await suggestion("s_dana", { owner: alex, title: "Call Dana back", src: ["message", "telegram:555"], key: "ask:telegram:555:1" });
    await act(OWNER_ID, "acceptSuggestion", "s_maya");
    await act(alex, "acceptSuggestion", "s_dana");
    await pick(OWNER_ID, "slack", "person", "UMAYA", "Maya Chen", "agency");
    await pick(alex, "telegram", "person", "555", "Dana", "consulting");
    expect(await lineOnBoard("Swap the hook for Maya")).toEqual([null, "agency"]);
    expect(await lineOnBoard("Call Dana back")).toEqual([null, "consulting"]);
    // Someone picked does not label a channel they write in: only their direct chat counts.
    await suggestion("s_chan", { title: "From the sales channel", src: ["message", "slack:C1"], key: "ask:slack:C1:2.0" });
    await act(OWNER_ID, "acceptSuggestion", "s_chan");
    expect(await lineOnBoard("From the sales channel")).toEqual([null, null]);
  });

  it("can be set on a task by hand, which wins, and goes in its history", async () => {
    await pick(OWNER_ID, "slack", "chat", "C1", "#sales", "sales");
    await suggestion("s_hand", { title: "Book the studio", src: ["message", "slack:C1"], key: "ask:slack:C1:3.0" });
    await act(OWNER_ID, "acceptSuggestion", "s_hand", { line: "agency" });
    expect(await lineOnBoard("Book the studio")).toEqual(["agency", "sales"]);
    const [t] = await db.query<{ id: string }>("select id from tasks where title = 'Book the studio'");
    await act(alex, "updateTicket", t.id, { line: "consulting" });
    await act(alex, "updateTicket", t.id, { line: null });
    expect(await lineOnBoard("Book the studio")).toEqual([null, "sales"]);
    const history = (await loadState(db, OWNER_ID, now)).tasks.find((x) => x.id === t.id)!.history!.map((e) => e.what);
    expect(history.slice(-2)).toEqual(["Line: Consulting", "Line: as its chat"]);
    // A task made by hand has a line only when one is picked.
    await act(OWNER_ID, "createTicket", ticket({ title: "By hand", line: "sales" }));
    await act(OWNER_ID, "createTicket", ticket({ title: "By hand, no line" }));
    expect([await lineOnBoard("By hand"), await lineOnBoard("By hand, no line")]).toEqual([
      ["sales", null],
      [null, null],
    ]);
    expect(await refused(OWNER_ID, "createTicket", ticket({ title: "Wrong", line: "marketing" as never }))).toBe("That is not Agency, Consulting or Sales.");
  });
});
