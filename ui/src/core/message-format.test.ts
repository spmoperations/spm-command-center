import { describe, expect, it } from "vitest";
import { formatInline, formatMessage, hueFor, initials, plainPreview, shortUrl } from "./message-format";
import { attachmentText, mentionedIds, slackToText, threadOf } from "./slack-text";
import { groupByThread, threadToAnswer } from "./threads";
import type { ThreadMessage } from "./types";

const kinds = (text: string) => formatInline(text).map((p) => [p.kind, p.text]);

describe("message formatting", () => {
  it("reads bold, italics, strike-through and code the way Slack writes them", () => {
    expect(kinds("*Total* was _high_, ~not~ `x = 1`")).toEqual([
      ["bold", "Total"], ["text", " was "], ["italic", "high"], ["text", ", "], ["strike", "not"], ["text", " "], ["code", "x = 1"],
    ]);
  });

  it("leaves stars and underscores inside ordinary text alone", () => {
    expect(kinds("2 * 3 * 4 and snake_case_name")).toEqual([["text", "2 * 3 * 4 and snake_case_name"]]);
  });

  it("turns an address into a short link and keeps the sentence's full stop out of it", () => {
    const [before, link, after] = formatInline("see https://docs.google.com/spreadsheets/d/1V3sm0E08_kK_long_id/edit?gid=903700674.");
    expect(before).toEqual({ kind: "text", text: "see " });
    expect(link).toEqual({ kind: "link", href: "https://docs.google.com/spreadsheets/d/1V3sm0E08_kK_long_id/edit?gid=903700674", text: "docs.google.com/spreadsheets/d/1V3sm0E08_kK…" });
    expect(after).toEqual({ kind: "text", text: "." });
  });

  it("shows a named link by its name", () => {
    expect(formatInline("[the doc](https://a.co/x)")).toEqual([{ kind: "link", text: "the doc", href: "https://a.co/x" }]);
  });

  it("splits a message into paragraphs, a list, a quote and code", () => {
    const blocks = formatMessage("Here is the breakdown:\n- Sales cost: $17k\n- Workfee: $15k\n\n> as agreed\n```\nconst a = 1;\n```\nThanks");
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "quote", "code", "paragraph"]);
    expect(blocks[1]).toMatchObject({ items: [[{ text: "Sales cost: $17k" }], [{ text: "Workfee: $15k" }]] });
    expect(blocks[3]).toEqual({ kind: "code", text: "const a = 1;" });
  });

  it("keeps the lines of one paragraph apart", () => {
    expect(formatMessage("line one\nline two")).toEqual([{ kind: "paragraph", lines: [[{ kind: "text", text: "line one" }], [{ kind: "text", text: "line two" }]] }]);
  });

  it("makes a one-line preview with no marks and no line breaks", () => {
    expect(plainPreview("*Request* to add people\n- one\n- two https://example.com/a/very/long/path")).toBe("Request to add people one two example.com/a/very/long/path");
    expect(plainPreview("word ".repeat(100), 20)).toBe("word word word word…");
  });

  it("gives a person steady initials and color", () => {
    expect([initials("Maya Chen"), initials("Dana"), initials("Dr. Aisha Grant"), initials("  ")]).toEqual(["MC", "DA", "DG", "?"]);
    expect(hueFor("Maya Chen")).toBe(hueFor("Maya Chen"));
    expect(hueFor("Maya Chen")).not.toBe(hueFor("Dana"));
    expect(shortUrl("https://www.example.com/")).toBe("example.com");
  });
});

describe("Slack text clean-up", () => {
  it("shows real emoji, and drops custom ones and skin-tone markers", () => {
    expect(slackToText("great call :raised_hands: :spm_custom: thanks :+1::skin-tone-3:")).toBe("great call 🙌 thanks 👍");
  });

  it("keeps a link's address, and its name when it has one", () => {
    expect(slackToText("see <https://a.co/x|the doc>")).toBe("see [the doc](https://a.co/x)");
    expect(slackToText("<https://docs.google.com/spreadsheets/d/abc123456789/edit|docs.google.com/spreadsheets/d/abc12…>")).toBe("https://docs.google.com/spreadsheets/d/abc123456789/edit");
    expect(slackToText("mail <mailto:jan@example.com|jan@example.com>")).toBe("mail jan@example.com");
    expect(slackToText("call <tel:+15550100|+1 555 0100> or <tel:+15550101>")).toBe("call +1 555 0100 or +15550101");
  });

  it("lists everyone tagged in a message", () => {
    expect(mentionedIds("<@U1> and <@U2|maya> cc <!here>")).toEqual(["U1", "U2"]);
  });

  it("reads the description of an app's card when the message has no text", () => {
    expect(attachmentText([{ title: "New comment", text: "Jan replied on Roadmap" }])).toBe("New comment\nJan replied on Roadmap");
    expect(attachmentText([{ fallback: "Build passed" }])).toBe("Build passed");
    expect(attachmentText(undefined)).toBe("");
  });
});

describe("Slack threads", () => {
  it("reads which thread a search result is in from its link", () => {
    expect(threadOf("https://acme.slack.com/archives/C1/p1760000020000100?thread_ts=1760000010.000100")).toBe("1760000010.000100");
    expect(threadOf("https://acme.slack.com/archives/C1/p1760000010000100")).toBeNull();
    expect(threadOf(undefined)).toBeNull();
    expect(threadOf("not a link")).toBeNull();
  });

  const say = (ts: string, at: number, text: string, thread?: string, me = false): ThreadMessage => ({ ts, at, text, thread, me, from: me ? undefined : "Priya" });

  it("puts each reply under the message that started its thread", () => {
    const groups = groupByThread([say("10", 10, "Proposal is ready", "10"), say("15", 15, "Lunch?"), say("20", 20, "Looks good", "10"), say("30", 30, "Approved", "10", true)]);
    expect(groups.map((g) => [g.first?.text, g.replies.map((r) => r.text), g.threaded])).toEqual([
      ["Lunch?", [], false],
      ["Proposal is ready", ["Looks good", "Approved"], true],
    ]);
  });

  it("orders by the newest message in each group, so a fresh reply to an old thread comes last", () => {
    const groups = groupByThread([say("10", 10, "Old thread", "10"), say("50", 50, "Newer message"), say("99", 99, "Late reply", "10")]);
    expect(groups.map((g) => g.first?.text)).toEqual(["Newer message", "Old thread"]);
  });

  it("keeps replies together when the message that started the thread has not been read", () => {
    const [group] = groupByThread([say("20", 20, "Looks good", "10"), say("30", 30, "Agreed", "10")]);
    expect([group.first, group.replies.length, group.threaded]).toEqual([null, 2, true]);
  });

  it("keeps a reply that has not been sent yet in its thread, and one outside a thread on its own", () => {
    const unsent = (text: string, thread?: string): ThreadMessage => ({ at: 99, text, thread, me: true, status: "queued" });
    const groups = groupByThread([say("10", 10, "Proposal is ready", "10"), unsent("In the thread", "10"), unsent("In the chat")]);
    expect(groups.find((g) => g.first?.text === "Proposal is ready")!.replies.map((r) => r.text)).toEqual(["In the thread"]);
    expect(groups.some((g) => g.first?.text === "In the chat" && !g.threaded)).toBe(true);
  });

  it("answers in the thread the latest message from someone else is in", () => {
    expect(threadToAnswer([say("10", 10, "Proposal is ready", "10"), say("20", 20, "Looks good", "10")])).toBe("10");
    expect(threadToAnswer([say("10", 10, "Proposal is ready", "10"), say("50", 50, "Lunch?")])).toBeNull();
    expect(threadToAnswer([say("10", 10, "Hi"), say("20", 20, "On it", "10", true)])).toBeNull();
  });
});

