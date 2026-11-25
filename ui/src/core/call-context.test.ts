// Finding the part of a call where an action item was said, and laying out what the AI wrote.
import { describe, expect, it } from "vitest";
import { SYSTEM } from "@/prompts/call-context";
import { excerptFor, MOST_EXCERPT_CHARS, secondsOf, shortTitle, writeupText, type TranscriptLine } from "./call-context";

describe("what a task from a call is about", () => {
  it("reads times in the call", () => {
    expect(secondsOf("00:10:45")).toBe(645);
    expect(secondsOf("1:02:03")).toBe(3723);
    expect(secondsOf("")).toBeNull();
    expect(secondsOf(undefined)).toBeNull();
    expect(secondsOf("10:45")).toBeNull();
  });

  it("takes the couple of minutes before the moment it was said, and a little after", () => {
    const transcript: TranscriptLine[] = [
      ["Maya", "Hi, can you hear me?", "00:00:05"],
      ["Jeremy", "Let's talk about the hooks.", "00:08:00"],
      ["Maya", "Clip 4 opens too slowly.", "00:09:10"],
      ["Jeremy", "So swap the hook by Friday.", "00:10:40"],
      ["Maya", "And send me the draft.", "00:11:10"],
      ["Jeremy", "Next, the invoices.", "00:12:00"],
    ];
    expect(excerptFor(transcript, { text: "Swap the hook on clip 4", at: "00:10:45" })).toEqual([
      { who: "Maya", text: "Clip 4 opens too slowly." },
      { who: "Jeremy", text: "So swap the hook by Friday." },
      { who: "Maya", text: "And send me the draft." },
    ]);
  });

  it("without times, finds the line that shares the most words with it", () => {
    const transcript: TranscriptLine[] = Array.from({ length: 40 }, (_, k): TranscriptLine => ["Maya", `Small talk ${k}.`]);
    transcript[30] = ["Jeremy", "We will send the September retention report to Harbor."];
    const got = excerptFor(transcript, { text: "Send the September retention report" });
    expect(got.some((l) => l.text.includes("September retention report"))).toBe(true);
    // Fifteen lines before it, the line, and four after.
    expect(got).toHaveLength(20);
    expect(got[0].text).toBe("Small talk 15.");
    // Nothing in common: nothing.
    expect(excerptFor(transcript, { text: "Book flights" })).toEqual([]);
    expect(excerptFor([], { text: "Anything" })).toEqual([]);
  });

  it("keeps each excerpt short, dropping the oldest lines first", () => {
    const transcript: TranscriptLine[] = Array.from({ length: 60 }, (_, k): TranscriptLine => ["Maya", `${"word ".repeat(40)}${k}`, `00:0${Math.floor(k / 30)}:${String((k * 2) % 60).padStart(2, "0")}`]);
    const got = excerptFor(transcript, { text: "x", at: "00:02:00" });
    expect(got.reduce((n, l) => n + l.who.length + l.text.length + 3, 0)).toBeLessThanOrEqual(MOST_EXCERPT_CHARS);
    expect(got.at(-1)?.text.endsWith("59")).toBe(true);
  });

  it("cuts a long action item at a word, not in the middle of one", () => {
    const long = "Write the onboarding guide from the shared notes; 2-3 screenshots per step before and after; skip the old pricing; check gaps with the lead";
    expect(shortTitle(long, 80)).toBe("Write the onboarding guide from the shared notes; 2-3 screenshots per step…");
    expect(shortTitle(long, 80).length).toBeLessThanOrEqual(80);
    expect(shortTitle("  Send   the report  ")).toBe("Send the report");
    // One long word: cut where it must be.
    expect(shortTitle("x".repeat(200), 50)).toBe(`${"x".repeat(49)}…`);
  });

  it("tells the model to write dates, not today or a weekday on its own, as the task is read days later", () => {
    expect(SYSTEM).toMatch(/Write every day as a date worked out from the call's date/);
    expect(SYSTEM).toMatch(/never "today", "tomorrow"/);
  });

  it("lays out what to do, why, the details and the call it came from", () => {
    const call = { title: "Harbor weekly", at: Date.parse("2026-11-18T15:00:00Z"), who: "Maya Chen", link: "https://fathom.video/calls/42?timestamp=645" };
    expect(writeupText({ what: "Swap the hook on clip 4 by Friday.", why: "Viewers leave in the first seconds.", details: ["Use the neighborhood shot first", "  "] }, call)).toBe(
      'What to do: Swap the hook on clip 4 by Friday.\n\nWhy: Viewers leave in the first seconds.\n\nDetails from the call:\n- Use the neighborhood shot first\n\nFrom the call "Harbor weekly" on Wed, Nov 18 with Maya Chen.\nWATCH: https://fathom.video/calls/42?timestamp=645',
    );
    // Nothing more said, and no recording: only what there is.
    expect(writeupText({ what: "Book the studio.", why: "", details: [] }, { ...call, who: "", link: null })).toBe('What to do: Book the studio.\n\nFrom the call "Harbor weekly" on Wed, Nov 18.');
  });
});
