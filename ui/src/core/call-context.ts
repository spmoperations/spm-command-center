// What a task from a call is about (see jobs/call-context.ts). Plain code finds the part of the
// call where each action item was said, and lays out the write-up as the task's description; the
// AI only writes the words (prompts/call-context.ts).

/** One line of a transcript as it is kept: [speaker, line, when in the call ("00:05:32")]. */
export type TranscriptLine = [string, string, string?];

/** Seconds into the call, from "HH:MM:SS". Null when it is not a time. */
export function secondsOf(time: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(time ?? "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/** How much of the call goes with each action item: this long before it was said, and a little after. */
export const BEFORE_SECONDS = 150;
export const AFTER_SECONDS = 30;
/** Without times: this many lines before the line that matches best, and after it. */
const BEFORE_LINES = 15;
const AFTER_LINES = 4;
/** The most of the call sent for one action item, so each request stays small and its cost known. */
export const MOST_EXCERPT_CHARS = 3000;

const SMALL_WORDS = new Set(
  "the and for with that this from have will your you our are was were they them then than what when where which who whom about into onto over just also need needs make sure send get got can could would should shall let lets going able".split(" "),
);
const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9']{4,}/g) ?? []).filter((w) => !SMALL_WORDS.has(w)));

/**
 * The part of the call where an action item was said. With the time Fathom gives it: the lines from
 * a couple of minutes before to just after. Without one (calls read before November 2026): around
 * the line that shares the most words with it. Cut to `MOST_EXCERPT_CHARS`, keeping the lines
 * nearest the moment.
 */
export function excerptFor(transcript: TranscriptLine[], item: { text: string; at?: string | null }): { who: string; text: string }[] {
  if (!transcript.length) return [];
  let lines: TranscriptLine[] = [];
  const at = secondsOf(item.at);
  if (at !== null && transcript.some((l) => secondsOf(l[2]) !== null)) {
    lines = transcript.filter((l) => {
      const t = secondsOf(l[2]);
      return t !== null && t >= at - BEFORE_SECONDS && t <= at + AFTER_SECONDS;
    });
  }
  if (!lines.length) {
    const wanted = wordsOf(item.text);
    let best = -1;
    let bestScore = 0;
    transcript.forEach((l, k) => {
      const have = wordsOf(l[1]);
      let score = 0;
      for (const w of wanted) if (have.has(w)) score++;
      // A later line wins a tie: action items are usually agreed after they are talked through.
      if (score > 0 && score >= bestScore) {
        best = k;
        bestScore = score;
      }
    });
    if (best < 0) return [];
    lines = transcript.slice(Math.max(0, best - BEFORE_LINES), best + AFTER_LINES + 1);
  }
  const out = lines.map(([who, text]) => ({ who, text: text.trim() }));
  // Too long: the oldest lines go first, as the moment itself matters most.
  while (out.length > 1 && out.reduce((n, l) => n + l.who.length + l.text.length + 3, 0) > MOST_EXCERPT_CHARS) out.shift();
  return out;
}

/** A Fathom action item is a line, sometimes a long one: this cuts it at a word, with "…", instead of in the middle of one. */
export function shortTitle(text: string, most = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= most) return clean;
  const cut = clean.slice(0, most - 1);
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > most / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:/–-]+$/, "")}…`;
}

/** Fathom's line is kept as the title up to this long; past it, the short title written from the call is used (see jobs/call-context). */
export const LONG_TITLE = 80;

/** What the AI wrote for one action item. */
export interface Writeup {
  what: string;
  why: string;
  details: string[];
}

/** The call a task came from, as its description names it. */
export interface CallNote {
  title: string;
  /** When the call started, in epoch milliseconds. */
  at: number;
  who: string;
  /** The recording at the moment it was said, or the call's recording. Only the logins see it (see `withoutRecordings`). */
  link: string | null;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** The task's description: what to do, why, the details said, and the call it came from. */
export function writeupText(w: Writeup, call: CallNote): string {
  const day = new Date(call.at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const details = w.details.map(clean).filter(Boolean);
  return [
    `What to do: ${clean(w.what)}`,
    clean(w.why) && `Why: ${clean(w.why)}`,
    details.length && `Details from the call:\n${details.map((d) => `- ${d}`).join("\n")}`,
    `From the call "${clean(call.title)}" on ${day}${call.who ? ` with ${clean(call.who)}` : ""}.${call.link ? `\nWATCH: ${call.link}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
