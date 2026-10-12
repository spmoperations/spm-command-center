import { describe, expect, it } from "vitest";
import { formatInline, formatMessage, hueFor, initials, plainPreview, shortUrl } from "./message-format";
import { attachmentText, mentionedIds, slackToText } from "./slack-text";

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
