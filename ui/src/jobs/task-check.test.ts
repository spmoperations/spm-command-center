// The AI check, against a pretend model: what it is sent, what it keeps, what it sets aside, and
// that a person can put back what it set aside.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TaskCheck, Verdict } from "@/server/ai";
import type { Db } from "@/server/db";
import { applyAction, loadState, OWNER_ID } from "@/server/repo";
import { NOW, reset, seed, testDb } from "@/server/testing";
import type { JobContext } from "./runner";
import { taskCheck } from "./task-check";

let db: Db;
const ctx = (): JobContext => ({ db, ownerId: OWNER_ID, now: NOW, cursor: {} });
const now = new Date(NOW);

async function flagged(id: string, conversation: string, messageId: string) {
  await db.run(
    "insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, dedupe_key, mode, created_at) values ($1, $2, 'Reply to someone', 'Operations', '', 'mid', '2026-10-09', 'They asked and are still waiting for your reply.', 'message', $3, $4, 'professional', $5)",
    [id, OWNER_ID, conversation, `ask:${messageId}`, NOW],
  );
}

const verdict = (over: Partial<Verdict> & { id: string }): Verdict => ({ is_task: true, confidence: 90, title: "", summary: "", for_whom: "owner", already_done: false, done_evidence: "", ...over });

/** A model that remembers what it was asked and answers from `answer`. */
function model(answer: (input: TaskCheck) => Verdict[]) {
  const asked: TaskCheck[] = [];
  return { asked, check: async (input: TaskCheck) => (asked.push(input), answer(input)) };
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  process.env.LOGIN_EMAIL = "jeremy@example.com";
  process.env.LOGIN_PASSWORD = "the owner's password";
  await reset(db);
  await seed(db);
  // Around Maya's request: a hello before it, Jeremy's answer after it, and a key that must never reach the model.
  await db.run(
    "insert into messages (id, conversation_id, owner_id, external_id, sender_name, body, at) values ('slack:D1:0.5', 'slack:D1', $1, '0.5', 'Maya Chen', 'Hi! My login is xoxp-1234567890-abcdefghijkl', $2)",
    [OWNER_ID, NOW - 120_000],
  );
  await db.run(
    "insert into messages (id, conversation_id, owner_id, external_id, sender_name, me, body, at) values ('slack:D1:2.0', 'slack:D1', $1, '2.0', 'Jeremy Moser', true, 'Done, swapped it this morning.', $2)",
    [OWNER_ID, NOW - 30_000],
  );
  await flagged("s_real", "slack:D1", "slack:D1:1.0");
  await flagged("s_chat", "slack:C1", "slack:C1:1.0");
  await flagged("s_gone", "slack:D1", "slack:D1:9.9");
});

describe("the AI check", () => {
  it("sends each flagged message with the conversation around it, keys taken out, and nothing else", async () => {
    const m = model(() => []);
    await taskCheck(ctx(), m.check);
    expect(m.asked).toHaveLength(1);
    const input = m.asked[0];
    expect([input.ownerName, input.team]).toEqual(["Jeremy Moser", ["Jeremy Moser", "Luis Ramos", "Rene Park"]]);
    // Oldest first; flagged at the same moment, in the order of their ids.
    expect(input.candidates.map((c) => c.id)).toEqual(["s_chat", "s_real"]);
    expect(input.candidates.find((c) => c.id === "s_real")).toEqual({
      id: "s_real",
      where: "Slack, direct message with Maya Chen",
      flagged: { who: "Maya Chen", text: "Can we swap the hook on clip 4 before Friday?" },
      before: [{ who: "Maya Chen", text: "Hi! My login is [key removed]" }],
      after: [{ who: "Jeremy Moser", text: "Done, swapped it this morning." }],
    });
    expect(input.candidates.find((c) => c.id === "s_chat")!.where).toBe("Slack, #sales");
    // The model answered for none of them: they are all tried again. The one whose message is gone is not.
    expect(await db.query("select id, checked_at is not null as checked from suggestions order by id")).toEqual([
      { id: "s_chat", checked: false },
      { id: "s_gone", checked: true },
      { id: "s_real", checked: false },
    ]);
  });

  it("keeps a real task with the model's title, summary and person, and sets aside what is not one", async () => {
    const m = model(() => [
      verdict({
        id: "s_real",
        confidence: 92,
        title: "Swap the hook on clip 4",
        summary: "Maya asked Jeremy to swap the hook on clip 4 before Friday.",
        for_whom: "Luis Ramos",
        already_done: true,
        done_evidence: "Jeremy replied that he swapped it this morning.",
      }),
      verdict({ id: "s_chat", is_task: false, confidence: 15 }),
      // Not one that was sent: ignored.
      verdict({ id: "s_other", confidence: 99, title: "Made up" }),
    ]);
    expect(await taskCheck(ctx(), m.check)).toMatchObject({ items: 2, message: "Checked 2: 1 task, 1 set aside" });
    const s = await loadState(db, OWNER_ID, now);
    const real = s.review.find((g) => g.id === "s_real")!;
    expect([real.title, real.why, real.forName, real.assignee, real.confidence, real.unchecked, real.looksDone]).toEqual([
      "Swap the hook on clip 4",
      "Maya asked Jeremy to swap the hook on clip 4 before Friday.",
      "Luis Ramos",
      "member:u_luis",
      92,
      false,
      "Jeremy replied that he swapped it this morning.",
    ]);
    expect(s.review.some((g) => g.id === "s_chat")).toBe(false);
    expect(s.setAside.map((g) => [g.id, g.confidence])).toEqual([["s_chat", 15]]);
    expect(await db.query("select status, reason from suggestions where id = 's_chat'")).toEqual([{ status: "dismissed", reason: "not_task" }]);
    // Nothing is asked twice.
    const again = model(() => []);
    expect(await taskCheck(ctx(), again.check)).toMatchObject({ items: 0, message: "Nothing new to check" });
    expect(again.asked).toEqual([]);
  });

  it("sets aside a task the model is not sure of, and lets anyone put it back for good", async () => {
    await applyAction(db, "addTeamLogin", ["Alex", "alex@example.com", "a long enough password"], OWNER_ID, now);
    const alex = (await db.query<{ id: string }>("select id from users where login_email = 'alex@example.com'"))[0].id;
    await taskCheck(ctx(), model(() => [verdict({ id: "s_real", confidence: 40 }), verdict({ id: "s_chat", confidence: 80 })]).check);
    expect((await loadState(db, alex, now)).setAside.map((g) => g.id)).toEqual(["s_real"]);
    await applyAction(db, "restoreSuggestion", ["s_real"], alex, now);
    const back = (await loadState(db, OWNER_ID, now)).review.find((g) => g.id === "s_real")!;
    expect([back.confidence, back.unchecked]).toEqual([null, false]);
    expect((await loadState(db, OWNER_ID, now)).setAside).toEqual([]);
  });

  it("leaves everything to be tried again when the model cannot be reached, and says why", async () => {
    const broken = async () => {
      throw new Error("Your credit balance is too low to access the Anthropic API.");
    };
    await expect(taskCheck(ctx(), broken)).rejects.toThrow("credit balance is too low");
    expect(await db.query("select count(*)::int as n from suggestions where checked_at is null")).toEqual([{ n: 2 }]);
    // Still on the Review tab, marked as not checked.
    expect(
      (await loadState(db, OWNER_ID, now)).review
        .filter((g) => g.unchecked)
        .map((g) => g.id)
        .sort(),
    ).toEqual(["s_chat", "s_real"]);
  });
});
