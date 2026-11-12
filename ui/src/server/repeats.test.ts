// Repeating tasks: set up on the board, made at 6:00 CET on their days, one a day, assigned and
// told on Slack from the account of whoever set them up, as when a ticket is assigned.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RepeatInput } from "@/core/types";
import type { Db } from "./db";
import { applyAction, loadState, OWNER_ID } from "./repo";
import { makeRepeats } from "./repeats";
import { seal } from "./secrets";
import { NOW, reset, seed, testDb } from "./testing";

let db: Db;
let alex = "";
// NOW is Thursday 8 Oct 2026, 14:00 in Berlin (summer time, UTC+2).
const setUpAt = new Date(NOW);
const monday = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00+02:00`);
const thursday = (hhmm: string) => new Date(`2026-10-15T${hhmm}:00+02:00`);

const act = (who: string, type: string, ...args: unknown[]) => applyAction(db, type, args, who, setUpAt);
const actAt = (when: Date, who: string, type: string, ...args: unknown[]) => applyAction(db, type, args, who, when);
const refused = (who: string, type: string, ...args: unknown[]) =>
  act(who, type, ...args).then(
    () => "done",
    (e: Error) => e.message,
  );
const repeat = (input: Partial<RepeatInput> = {}): RepeatInput => ({
  title: "Check in with the editors",
  description: "Where each video is.",
  client: "Harbor Realty",
  pri: "high",
  line: "agency",
  assignee: "member:u_luis",
  days: [1, 4],
  notify: ["slack"],
  ...input,
});
const slackFor = (who: string) => db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, 'slack', $2, 'Slack', $3)", [who, seal("a-login"), NOW]);
const made = () =>
  db.query<{ title: string; due: string; status: string; delegated_to: string | null; created_by: string; src_label: string; repeat_id: string | null; project: string; pri: string; line: string | null }>(
    "select title, due, status, delegated_to, created_by, src_label, repeat_id, project, pri, line from tasks where repeat_id is not null order by number",
  );
const outbox = () => db.query<{ owner_id: string; target: string; body: string }>("select owner_id, target, body from outbox order by created_at, id");
const theRepeat = async () => (await db.query<{ id: string; last_day: string | null; problem: string | null; set_by: string; active: boolean }>("select id, last_day, problem, set_by, active from repeating_tasks"))[0];

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

describe("repeating tasks", () => {
  it("is set up only with a title, a day, someone it is for, and the Slack it is told from", async () => {
    expect(await refused(alex, "addRepeat", repeat({ title: "  " }))).toBe("Give the task a title.");
    expect(await refused(alex, "addRepeat", repeat({ days: [] }))).toBe("Pick at least one day of the week.");
    expect(await refused(alex, "addRepeat", repeat({ days: [0, 9] }))).toBe("Pick at least one day of the week.");
    expect(await refused(alex, "addRepeat", repeat({ assignee: "" }))).toBe("Who should it be for?");
    expect(await refused(alex, "addRepeat", repeat({ assignee: "member:nobody" }))).toBe("That person is no longer on the team list.");
    expect(await refused(alex, "addRepeat", repeat({ assignee: "user:nobody" }))).toBe("That person is not on the team.");
    expect(await refused(alex, "addRepeat", repeat({ line: "marketing" as never }))).toBe("That is not Agency, Consulting or Sales.");
    expect(await refused(alex, "addRepeat", repeat())).toBe("Connect your own Slack first, to tell them there each time. Or untick it.");
    // Not told anywhere needs no Slack.
    expect(await refused(alex, "addRepeat", repeat({ notify: [] }))).toBe("done");
    expect(await db.query("select count(*)::int as n from repeating_tasks")).toEqual([{ n: 1 }]);
  });

  it("makes the task at 6:00 CET on its days, with no due date, assigned and told on Slack from the account that set it up", async () => {
    await slackFor(alex);
    await act(alex, "addRepeat", repeat());
    // Set up on Thursday afternoon: today's 6:00 has passed, so the first comes on Monday.
    expect((await theRepeat()).last_day).toBe("2026-10-08");
    expect(await makeRepeats(db, setUpAt)).toEqual({ made: 0, failed: 0 });
    expect(await makeRepeats(db, new Date("2026-10-11T09:00:00+02:00"))).toEqual({ made: 0, failed: 0 });
    expect(await makeRepeats(db, monday("05:59"))).toEqual({ made: 0, failed: 0 });

    expect(await makeRepeats(db, monday("06:00"))).toEqual({ made: 1, failed: 0 });
    const [first] = await made();
    expect(first).toEqual({
      title: "Check in with the editors",
      due: "",
      status: "open",
      delegated_to: "u_luis",
      created_by: alex,
      src_label: "Repeats every Mon and Thu",
      repeat_id: (await theRepeat()).id,
      project: "Harbor Realty",
      pri: "high",
      line: "agency",
    });
    const [{ number }] = await db.query<{ number: number }>("select number from tasks where repeat_id is not null");
    expect(await outbox()).toEqual([{ owner_id: alex, target: "ULUIS", body: `<@ULUIS> new task for you: Check in with the editors (SPM-${number})\nHigh priority · Harbor Realty\n\nWhere each video is.` }]);
    const [{ id }] = await db.query<{ id: string }>("select id from tasks where repeat_id is not null");
    expect((await db.query<{ by_user: string; what: string }>("select by_user, what from ticket_events where task_id = $1 order by id", [id])).map((e) => [e.by_user === alex, e.what])).toEqual([
      [true, "Created: repeats every Mon and Thu"],
      [true, "Assigned to Luis Ramos, told on Slack"],
    ]);

    // Once a day: the next check, and one running at the same time, make nothing more.
    expect(await Promise.all([makeRepeats(db, monday("06:05")), makeRepeats(db, monday("06:05"))])).toEqual([
      { made: 0, failed: 0 },
      { made: 0, failed: 0 },
    ]);
    // Thursday: a new one, though Monday's is not done.
    expect(await makeRepeats(db, thursday("06:00"))).toEqual({ made: 1, failed: 0 });
    expect((await made()).map((t) => [t.title, t.status])).toEqual([
      ["Check in with the editors", "open"],
      ["Check in with the editors", "open"],
    ]);
    expect(await outbox()).toHaveLength(2);
  });

  it("is on the board for the whole team, with the last task it made", async () => {
    await act(alex, "addRepeat", repeat({ notify: [] }));
    await makeRepeats(db, monday("06:00"));
    const [r] = (await loadState(db, OWNER_ID, monday("07:00"))).repeats;
    const [{ id, number }] = await db.query<{ id: string; number: number }>("select id, number from tasks where repeat_id is not null");
    expect(r).toMatchObject({
      title: "Check in with the editors",
      client: "Harbor Realty",
      assignee: "member:u_luis",
      days: [1, 4],
      notify: [],
      active: true,
      setBy: { id: alex, name: "Alex" },
      lastDay: "2026-10-12",
      last: { id, number, status: "open" },
      made: 1,
      problem: null,
    });
    await applyAction(db, "updateTicket", [id, { status: "done" }], OWNER_ID, monday("08:00"));
    expect((await loadState(db, alex, monday("09:00"))).repeats[0].last?.status).toBe("done");
  });

  it("pauses, starts again from the next 6:00, and changes hands to whoever edits it", async () => {
    await act(alex, "addRepeat", repeat({ notify: [] }));
    const { id } = await theRepeat();
    await act(alex, "pauseRepeat", id, true);
    expect(await makeRepeats(db, monday("06:00"))).toEqual({ made: 0, failed: 0 });
    // Started again on Monday at 10:00: not made straight away for Monday, but on Thursday.
    await actAt(monday("10:00"), alex, "pauseRepeat", id, false);
    expect(await makeRepeats(db, monday("10:05"))).toEqual({ made: 0, failed: 0 });
    expect(await makeRepeats(db, thursday("06:00"))).toEqual({ made: 1, failed: 0 });

    // Jeremy changes it to Tuesdays, told on Slack: it needs his Slack, and is told from it from now on.
    expect(await refused(OWNER_ID, "editRepeat", id, repeat({ days: [2], title: "Weekly check-in" }))).toBe("Connect your own Slack first, to tell them there each time. Or untick it.");
    await slackFor(OWNER_ID);
    await act(OWNER_ID, "editRepeat", id, repeat({ days: [2], title: "Weekly check-in" }));
    expect(await theRepeat()).toMatchObject({ set_by: OWNER_ID, active: true });
    expect(await makeRepeats(db, new Date("2026-10-20T06:00:00+02:00"))).toEqual({ made: 1, failed: 0 });
    expect((await outbox()).map((o) => [o.owner_id, o.target])).toEqual([[OWNER_ID, "ULUIS"]]);
    expect(await refused(alex, "editRepeat", "r_gone", repeat())).toBe("That repeating task no longer exists.");
  });

  it("is removed, and the tasks it made stay on the board", async () => {
    await act(alex, "addRepeat", repeat({ notify: [] }));
    await makeRepeats(db, monday("06:00"));
    await act(alex, "removeRepeat", (await theRepeat()).id);
    expect(await db.query("select count(*)::int as n from repeating_tasks")).toEqual([{ n: 0 }]);
    expect(await made()).toHaveLength(1);
    expect(await makeRepeats(db, thursday("06:00"))).toEqual({ made: 0, failed: 0 });
  });

  it("says what went wrong, and tries again only on its next day", async () => {
    await slackFor(alex);
    await act(alex, "addRepeat", repeat());
    // The Slack it is told from was disconnected: the task is still made, and the board says why nobody was told.
    await db.run("delete from connections where owner_id = $1", [alex]);
    expect(await makeRepeats(db, monday("06:00"))).toEqual({ made: 1, failed: 0 });
    expect(await outbox()).toEqual([]);
    expect((await theRepeat()).problem).toBe("Not told on Slack: connect it again in Connections.");

    // Taken off the team list: nothing is made, it says so, and it is not tried again every few minutes.
    await db.run("delete from team_members where id = 'u_luis'");
    expect(await makeRepeats(db, thursday("06:00"))).toEqual({ made: 0, failed: 1 });
    expect(await theRepeat()).toMatchObject({ last_day: "2026-10-15", problem: "That person is no longer on the team list." });
    expect(await makeRepeats(db, thursday("06:05"))).toEqual({ made: 0, failed: 0 });
    expect(await made()).toHaveLength(1);
  });

  it("puts someone picked straight from Slack on the team list, as the board does", async () => {
    await db.run("insert into slack_users (owner_id, id, name, is_bot, deleted) values ($1, 'UMIA', 'Mia Torres', false, false)", [OWNER_ID]);
    await act(alex, "addRepeat", repeat({ assignee: "slack:UMIA", notify: [] }));
    const [{ assignee }] = await db.query<{ assignee: string }>("select assignee from repeating_tasks");
    const [member] = await db.query<{ id: string; name: string; slack_user_id: string }>("select id, name, slack_user_id from team_members where slack_user_id = 'UMIA'");
    expect(member).toMatchObject({ name: "Mia Torres", slack_user_id: "UMIA" });
    expect(assignee).toBe(`member:${member.id}`);
  });
});
