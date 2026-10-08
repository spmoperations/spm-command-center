import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptSuggestion, addRule, conversationToTask, delegateConversation, delegateTask, getApp, resetSampleData,
  sendReply, setConversationPriority, setJobInterval, undelegateTask,
} from "./store";

const state = () => getApp().state;
const conversation = (id: string) => state().inbox.find((c) => c.id === id)!;

beforeEach(() => {
  getApp();
  resetSampleData();
});

describe("inbox actions", () => {
  it("queues a reply for the conversation's own app and marks it replied", () => {
    sendReply("m2", "Resending the link now.", false);
    const c = conversation("m2");
    expect(c.replied).toBe(true);
    expect(c.done).toBe(false);
    expect(c.thread.at(-1)).toMatchObject({ me: true, text: "Resending the link now.", status: "queued" });
    expect(state().outbox).toEqual([expect.objectContaining({ source: "telegram", to: "Derek Lin", conversationId: "m2", status: "queued" })]);
  });

  it("clears the conversation when the reply is sent with mark done", () => {
    sendReply("m1", "Sounds good.", true);
    expect(conversation("m1").done).toBe(true);
    expect(getApp().ui.openConversation).toBeNull();
  });

  it("turns a message into a task linked back to it", () => {
    conversationToTask("m9", getApp().today);
    const task = state().tasks.at(-1)!;
    expect(task).toMatchObject({ project: "Harbor Realty", pri: "high", due: getApp().today, src: { type: "message", id: "m9" } });
    expect(conversation("m9").done).toBe(true);
  });

  it("delegates a message: one task for the teammate and one Slack message to them", () => {
    delegateConversation("m1", "u4", "Swap the hook on clip 4 before Friday.", getApp().today);
    const task = state().tasks.at(-1)!;
    expect(task.delegatedTo).toMatchObject({ personId: "u4", name: "Luis Ramos", note: "Swap the hook on clip 4 before Friday." });
    expect(task.dept).toBe("Client Sales");
    expect(conversation("m1").done).toBe(true);
    expect(state().outbox).toEqual([expect.objectContaining({ source: "slack", to: "Luis Ramos", ctx: "Direct message", taskId: task.id })]);
  });

  it("keeps a hand-set priority when the rules change", () => {
    expect(conversation("m11").pri).toBe("low");
    setConversationPriority("m11", "high");
    addRule("priorityRules", { source: "slack", when: "ctx", op: "is", value: "#sales", pri: "mid" });
    expect(conversation("m11").pri).toBe("high");
  });

  it("re-sorts the inbox when a rule is added", () => {
    expect(conversation("m12").pri).toBe("low");
    addRule("priorityRules", { source: "telegram", when: "from", op: "is", value: "Creator Ops", pri: "high" });
    expect(conversation("m12").pri).toBe("high");
  });
});

describe("task actions", () => {
  it("delegates a task with a note and can take it back", () => {
    delegateTask("t11", "u4", "Use the neighborhood-first hook.", "2026-10-12");
    const task = state().tasks.find((t) => t.id === "t11")!;
    expect(task).toMatchObject({ due: "2026-10-12", delegatedTo: { name: "Luis Ramos" } });
    expect(state().outbox.at(-1)!.text).toContain("New task for you: Swap hook on Harbor clip #4 (due 2026-10-12)");
    undelegateTask("t11");
    expect(state().tasks.find((t) => t.id === "t11")!.delegatedTo).toBeNull();
  });

  it("adds a suggestion as a task only when it is accepted", () => {
    const before = state().tasks.length;
    acceptSuggestion("s1");
    expect(state().tasks).toHaveLength(before + 1);
    expect(state().tasks.at(-1)).toMatchObject({ title: "Send Brightline Coaching a 3-tier proposal with a sample clip", src: { type: "meeting", id: "mt2" } });
    expect(state().suggestions.find((g) => g.id === "s1")!.status).toBe("accepted");
  });
});

describe("timers", () => {
  it("never saves a timer faster than the job allows", () => {
    setJobInterval("slack-pull", 1);
    setJobInterval("telegram-pull", 45);
    expect(state().jobs.find((j) => j.id === "slack-pull")!.intervalMin).toBe(5);
    expect(state().jobs.find((j) => j.id === "telegram-pull")!.intervalMin).toBe(45);
  });
});
