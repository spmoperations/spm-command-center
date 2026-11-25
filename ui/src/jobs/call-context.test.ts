// "Writes what each task from a call is about": the newest few calls first, then only new ones,
// one request per call, and the write-up on the review card and as the task's description.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoDay } from "@/core/dates";
import type { CallContext } from "@/prompts/call-context";
import { NoVerdicts, type CallContextResult } from "@/server/ai";
import type { Db } from "@/server/db";
import { applyAction, loadState, OWNER_ID } from "@/server/repo";
import { memberTickets } from "@/server/tickets";
import { NOW, reset, seed, testDb } from "@/server/testing";
import { callContext, MOST_CALLS } from "./call-context";
import type { JobContext } from "./runner";

let db: Db;
const HOUR = 3_600_000;
const ctx = (cursor: Record<string, unknown> = {}, now = NOW): JobContext => ({ db, ownerId: OWNER_ID, now, cursor });

/** A recorded call `n` hours before NOW, with one action item said at 00:10:45, and its suggestion. */
async function call(n: number, opts: { status?: string; times?: boolean } = {}) {
  const id = `fathom:${n}`;
  const times = opts.times ?? true;
  await db.run(
    `insert into meetings (id, owner_id, external_id, title, started_at, duration_min, who, place, url, summary, transcript, action_items)
     values ($1, $2, $3, $4, $5, 30, 'Maya Chen', 'Zoom', $6, '## Summary\nHooks for Harbor.', $7, $8)`,
    [
      id,
      OWNER_ID,
      String(n),
      `Call ${n}`,
      NOW - n * HOUR,
      `https://fathom.video/share/${n}`,
      JSON.stringify([
        ["Maya Chen", "Hi there.", ...(times ? ["00:00:05"] : [])],
        ["Maya Chen", "Clip 4 opens too slowly.", ...(times ? ["00:09:10"] : [])],
        ["Jeremy Moser", `So swap the hook on clip ${n} by Friday.`, ...(times ? ["00:10:40"] : [])],
      ]),
      JSON.stringify([{ text: `Swap the hook on clip ${n}`, who: "Luis Ramos", mine: false, done: false, ...(times ? { at: "00:10:45", link: `https://fathom.video/calls/${n}?timestamp=645` } : {}) }]),
    ],
  );
  await db.run(
    `insert into suggestions (id, owner_id, title, dept, pri, due, why, src_type, src_id, dedupe_key, created_at, for_name, status)
     values ($1, $2, $3, 'Operations', 'mid', '', $4, 'meeting', $5, $6, $7, 'Luis Ramos', $8)`,
    [`s_${n}`, OWNER_ID, `Swap the hook on clip ${n}`, `Fathom listed this for Luis Ramos on "Call ${n}".`, id, `${id}:action:0`, NOW - n * HOUR, opts.status ?? "new"],
  );
}

/** A pretend model: writes for every action item it is given, and remembers what it was asked. */
function pretend(answer?: (input: CallContext) => CallContextResult | Promise<CallContextResult>) {
  const asked: CallContext[] = [];
  const writer = async (input: CallContext) => {
    asked.push(input);
    if (answer) return answer(input);
    return {
      items: input.items.map((i) => ({ id: i.id, title: `Short: ${i.task.slice(0, 20)}`, what: `Do: ${i.task}.`, why: "Viewers leave early.", details: ["Use the neighborhood shot first"] })),
      usage: { input: 1000, output: 200 },
    };
  };
  return { asked, writer };
}

const contextOf = async (id: string) => (await db.query<{ context: string | null }>("select context from suggestions where id = $1", [id]))[0].context;

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
const savedLimit = process.env.AI_CALL_CONTEXT_DAILY;
beforeEach(async () => {
  // Room for every run here; the day's limit has a test of its own.
  process.env.AI_CALL_CONTEXT_DAILY = "20";
  await reset(db);
  await seed(db);
});
afterEach(() => {
  if (savedLimit === undefined) delete process.env.AI_CALL_CONTEXT_DAILY;
  else process.env.AI_CALL_CONTEXT_DAILY = savedLimit;
});

describe("call write-ups", () => {
  it("starts with the newest few calls, never older ones, one request per call", async () => {
    for (const n of [1, 2, 3, 4, 5, 6]) await call(n);
    const { asked, writer } = pretend();
    const run = await callContext(ctx(), writer);
    // The newest four, the oldest of them first; calls 5 and 6 are older and are never read.
    expect(asked.map((a) => a.title)).toEqual(["Call 4", "Call 3", "Call 2", "Call 1"]);
    expect(run).toMatchObject({ items: 4, cursor: { since: NOW - 4 * HOUR, calls: 4 } });
    expect(run.message).toMatch(/^4 tasks written up from 4 calls \(4,000 tokens read, 800 written, about \$0\.0\d+\)$/);
    expect(await contextOf("s_5")).toBeNull();
    // Nothing new: nothing sent.
    const again = pretend();
    expect(await callContext(ctx(run.cursor!), again.writer)).toMatchObject({ items: 0, message: "No new calls to write up" });
    expect(again.asked).toHaveLength(0);
    // A new call is written up on the next run.
    await call(0);
    const next = pretend();
    await callContext(ctx(run.cursor!), next.writer);
    expect(next.asked.map((a) => a.title)).toEqual(["Call 0"]);
    expect(MOST_CALLS).toBe(4);
  });

  it("sends what was said around each action item, and the call's notes", async () => {
    await call(1);
    const { asked, writer } = pretend();
    await callContext(ctx(), writer);
    expect(asked[0]).toEqual({
      title: "Call 1",
      day: expect.stringMatching(/^\w{3}, \w{3} \d+$/),
      who: "Maya Chen",
      notes: "## Summary\nHooks for Harbor.",
      items: [
        {
          id: "s_1",
          task: "Swap the hook on clip 1",
          forWhom: "Luis Ramos",
          // From two and a half minutes before 00:10:45 to just after: not the greeting at the start.
          excerpt: [
            { who: "Maya Chen", text: "Clip 4 opens too slowly." },
            { who: "Jeremy Moser", text: "So swap the hook on clip 1 by Friday." },
          ],
        },
      ],
    });
  });

  it("puts the write-up on the review card and makes it the task's description, the recording only for logins", async () => {
    await call(1);
    await callContext(ctx(), pretend().writer);
    const written = await contextOf("s_1");
    expect(written).toMatch(/^What to do: Do: Swap the hook on clip 1\.\n\nWhy: Viewers leave early\.\n\nDetails from the call:\n- Use the neighborhood shot first\n\nFrom the call "Call 1" on .+ with Maya Chen\.\nWATCH: https:\/\/fathom\.video\/calls\/1\?timestamp=645$/);
    const review = (await loadState(db, OWNER_ID, new Date(NOW))).review.find((g) => g.id === "s_1");
    expect(review?.context).toBe(written);

    await applyAction(db, "acceptSuggestion", ["s_1", { assignee: "member:u_luis", notify: [] }], OWNER_ID, new Date(NOW));
    const [task] = await db.query<{ description: string }>("select description from tasks where src_id = 'fathom:1'");
    expect(task.description).toBe(written);
    // Luis is on the team list: he gets everything but the recording.
    const [mine] = await memberTickets(db, "u_luis", new Date(NOW));
    expect(mine.description).toContain("What to do: Do: Swap the hook on clip 1.");
    expect(mine.description).not.toContain("fathom.video");
  });

  it("updates a task already made from the newest calls, unless someone wrote its description", async () => {
    await call(1);
    await call(2);
    await applyAction(db, "acceptSuggestion", ["s_1"], OWNER_ID, new Date(NOW));
    await applyAction(db, "acceptSuggestion", ["s_2"], OWNER_ID, new Date(NOW));
    await db.run("update tasks set description = 'Luis knows: use the new cut.' where src_id = 'fathom:2'");
    await callContext(ctx(), pretend().writer);
    const tasks = await db.query<{ src_id: string; description: string; id: string }>("select src_id, description, id from tasks where src_id like 'fathom:%' order by src_id");
    expect(tasks.map((t) => [t.src_id, t.description.split("\n")[0]])).toEqual([
      ["fathom:1", "What to do: Do: Swap the hook on clip 1."],
      ["fathom:2", "Luis knows: use the new cut."],
    ]);
    expect(await db.query("select by_user, by_name, what from ticket_events where task_id = $1 and what like 'Description%'", [tasks[0].id])).toEqual([{ by_user: null, by_name: "Command Center", what: "Description written from the call" }]);
  });

  it("gives a long Fathom line the short title written from the call, unless someone renamed the task", async () => {
    await call(1);
    await call(2);
    await call(3);
    const long = "Build the case studies from the stats doc; 2-3 visuals per client, before and after; leave out the four clients named";
    await db.run("update suggestions set title = $1 where id in ('s_2', 's_3')", [long]);
    await applyAction(db, "acceptSuggestion", ["s_2"], OWNER_ID, new Date(NOW));
    await applyAction(db, "acceptSuggestion", ["s_3"], OWNER_ID, new Date(NOW));
    await db.run("update tasks set title = 'Case studies for the shoot' where src_id = 'fathom:3'");
    await callContext(ctx(), pretend().writer);
    // A short line stays as Fathom wrote it; a long one, still waiting or made a task, takes the short title.
    expect(await db.query("select id, title from suggestions where id in ('s_1', 's_2') order by id")).toEqual([
      { id: "s_1", title: "Swap the hook on clip 1" },
      { id: "s_2", title: "Short: Swap the hook on cli" },
    ]);
    expect(await db.query("select src_id, title from tasks where src_id in ('fathom:2', 'fathom:3') order by src_id")).toEqual([
      { src_id: "fathom:2", title: "Short: Swap the hook on cli" },
      { src_id: "fathom:3", title: "Case studies for the shoot" },
    ]);
    expect((await db.query<{ what: string }>("select what from ticket_events where what like '%written from the call' order by what")).map((e) => e.what)).toEqual([
      "Description written from the call",
      "Title and description written from the call",
    ]);
  });

  it("leaves out what was turned down, and calls read before times were kept still work", async () => {
    await call(1, { status: "dismissed" });
    await call(2, { times: false });
    const { asked, writer } = pretend();
    await callContext(ctx(), writer);
    expect(asked.map((a) => a.title)).toEqual(["Call 2"]);
    // No times: the line that shares the most words with the action item.
    expect(asked[0].items[0].excerpt.at(-1)).toEqual({ who: "Jeremy Moser", text: "So swap the hook on clip 2 by Friday." });
    expect(await contextOf("s_1")).toBeNull();
  });

  it("does not send a call again when the model declines it, and tries again when the service is down", async () => {
    await call(1);
    const declined = pretend(() => {
      throw new NoVerdicts("The model declined to read this call.", "declined", { input: 500, output: 0 });
    });
    await expect(callContext(ctx(), declined.writer)).rejects.toThrow(/^The model declined to read this call\. \(500 tokens read, 0 written/);
    expect(await contextOf("s_1")).toBe("");

    await call(2);
    const down = pretend(() => {
      throw new Error("Could not reach the AI service.");
    });
    await expect(callContext(ctx(), down.writer)).rejects.toThrow("Could not reach the AI service.");
    expect(await contextOf("s_2")).toBeNull();
  });

  it("stops at the day's limit", async () => {
    for (const n of [1, 2]) await call(n);
    const { asked, writer } = pretend();
    process.env.AI_CALL_CONTEXT_DAILY = "4";
    expect(await callContext(ctx({ since: NOW - 10 * HOUR, day: isoDay(new Date(NOW)), calls: 4 }), writer)).toMatchObject({ items: 0, message: "Today's limit of 4 calls is reached; the rest wait for tomorrow." });
    expect(asked).toHaveLength(0);
  });
});
