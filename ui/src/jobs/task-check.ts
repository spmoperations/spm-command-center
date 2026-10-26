// The AI check. The request finder's plain rules flag every message that asks something; this
// reads each one, with the conversation around it, and keeps only real tasks. What it keeps gets
// a clear title, a summary, who it is for and how sure the model is. What it sets aside is turned
// down with the reason "not_task" and kept, so anyone can put it back. See prompts/task-check.ts.
//
// Plain code decides what is sent: only what the rules flagged, cut to a few messages around it,
// with keys and passwords taken out. The model only judges.
//
// What it may spend is capped: at most `dailyLimit()` messages a day for each login, whatever
// arrives, and each run says what it used and roughly what that cost (Settings, Timers).
import { SOURCE_NAME } from "@/core/config";
import { isoDay } from "@/core/dates";
import { redactSecrets } from "@/core/slack-text";
import type { Source } from "@/core/types";
import type { Candidate } from "@/prompts/task-check";
import { AI_MODEL, aiKeys, checkCandidates, describeAiError, NoVerdicts, roughCost, type AiUsage, type CheckResult, type TaskCheck } from "@/server/ai";
import { setting } from "@/server/app-keys";
import { teamPeople } from "@/server/tickets";
import type { JobContext, JobResult } from "./runner";

/** Messages judged in one request: keeps each request small and its cost predictable. Set AI_CHECK_BATCH to lower it. */
const BATCH = Number(process.env.AI_CHECK_BATCH ?? 20);

/**
 * The most messages checked in a day for one login: a ceiling on what the check can spend if a
 * flood arrives or something goes wrong. About 7 a day are flagged now. Set AI_CHECK_DAILY to
 * change it; 0 switches the check off. On the live site 100 (about 25 cents a day at most);
 * anywhere else, such as a developer's machine or a test copy, 20.
 */
export function dailyLimit(): number {
  const set = setting("AI_CHECK_DAILY");
  if (set) return Math.max(0, Math.floor(Number(set)) || 0);
  return process.env.VERCEL ? 100 : 20;
}

/** What the check has sent today, kept in its bookmark. */
interface Today {
  day: string;
  sent: number;
  input: number;
  output: number;
}
/** How much of the conversation goes with each message: what came before it, and what came after. */
const BEFORE = 6;
const AFTER = 4;
const MAX_LINE_LENGTH = 600;
/** Below this the model is not sure enough that it is a real task, and it is set aside. */
export const MIN_CONFIDENCE = 60;

type Checker = (input: TaskCheck) => Promise<CheckResult>;

/** The model, with this person's AI key: their own, else the team's (see app-keys.ts). */
const withKeyOf =
  (db: JobContext["db"], ownerId: string): Checker =>
  async (input) => {
    const keys = await aiKeys(db, ownerId);
    if (!keys) throw new Error("The AI key is not set");
    return checkCandidates(input, keys);
  };

interface Line {
  sender_name: string;
  me: boolean;
  body: string;
  at: number;
}

const where = (c: { source: Source; ctx: string; from_name: string; direct: boolean }) =>
  c.source === "gmail" ? `Gmail, from ${c.from_name}, subject: ${c.ctx}` : `${SOURCE_NAME[c.source]}, ${c.direct ? `direct message with ${c.from_name}` : c.ctx}`;

const dollars = (usage: AiUsage) => {
  const cost = roughCost(usage);
  return cost === null ? "" : `, about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
};
const tokens = (usage: AiUsage) => `${usage.input.toLocaleString("en-US")} tokens read, ${usage.output.toLocaleString("en-US")} written${dollars(usage)}`;

export async function taskCheck({ db, ownerId, now, cursor }: JobContext, checker: Checker = withKeyOf(db, ownerId)): Promise<JobResult> {
  const day = isoDay(new Date(now));
  const before = cursor.today as Today | undefined;
  const today: Today = before?.day === day ? { ...before } : { day, sent: 0, input: 0, output: 0 };
  const room = Math.min(BATCH, dailyLimit() - today.sent);
  // What the rules flagged and nobody has checked: the oldest first, so a backlog is worked through.
  const waiting = await db.query<{ id: string; src_id: string; dedupe_key: string }>(
    "select id, src_id, dedupe_key from suggestions where owner_id = $1 and status = 'new' and src_type = 'message' and dedupe_key like 'ask:%' and checked_at is null order by created_at, id limit $2",
    [ownerId, BATCH],
  );
  if (!waiting.length) return { items: 0, message: "Nothing new to check" };
  if (room <= 0) {
    return { items: 0, message: dailyLimit() ? `Today's limit of ${dailyLimit()} messages is reached; the rest wait for tomorrow. Today: ${tokens(today)}` : "Switched off (AI_CHECK_DAILY is 0)" };
  }

  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const me = owner?.name ?? "Owner";
  const line = (m: Line) => ({ who: m.me ? me : m.sender_name, text: redactSecrets(m.body).slice(0, MAX_LINE_LENGTH) });
  const candidates: Candidate[] = [];
  const gone: string[] = [];
  for (const g of waiting) {
    const [c] = await db.query<{ source: Source; ctx: string; from_name: string; direct: boolean }>("select source, ctx, from_name, direct from conversations where owner_id = $1 and id = $2", [
      ownerId,
      g.src_id,
    ]);
    const [flagged] = c ? await db.query<Line>("select sender_name, me, body, at from messages where owner_id = $1 and id = $2", [ownerId, g.dedupe_key.slice(4)]) : [];
    // Its conversation or message is no longer here: nothing to judge.
    if (!c || !flagged) {
      gone.push(g.id);
      continue;
    }
    const before = await db.query<Line>("select sender_name, me, body, at from messages where owner_id = $1 and conversation_id = $2 and at < $3 order by at desc, id desc limit $4", [
      ownerId,
      g.src_id,
      flagged.at,
      BEFORE,
    ]);
    const after = await db.query<Line>("select sender_name, me, body, at from messages where owner_id = $1 and conversation_id = $2 and at > $3 order by at, id limit $4", [
      ownerId,
      g.src_id,
      flagged.at,
      AFTER,
    ]);
    candidates.push({ id: g.id, where: where(c), flagged: line(flagged), before: before.reverse().map(line), after: after.map(line) });
  }
  if (gone.length) await db.run("update suggestions set checked_at = $3 where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))", [ownerId, JSON.stringify(gone), now]);
  if (!candidates.length) return { items: 0, message: "Nothing new to check" };
  // Only as many as today's limit has room for are sent; the rest wait, unchecked.
  candidates.splice(room);

  const team = (await teamPeople(db)).map((p) => p.name);
  const used: AiUsage = { input: 0, output: 0 };
  const verdicts: CheckResult["verdicts"] = [];
  // Messages the model answered for none of, which are not sent again: they stay on the Review tab for a person.
  const unjudged: string[] = [];
  const ask = async (some: Candidate[]): Promise<void> => {
    try {
      const result = await checker({ ownerName: me, today: day, weekday: new Date(now).toLocaleDateString("en-US", { weekday: "long" }), team, candidates: some });
      used.input += result.usage.input;
      used.output += result.usage.output;
      verdicts.push(...result.verdicts);
    } catch (error) {
      if (!(error instanceof NoVerdicts)) throw error;
      used.input += error.usage.input;
      used.output += error.usage.output;
      // An answer cut short is asked again in two halves. Anything else, or a single message, is not asked again.
      if (error.reason === "cut_short" && some.length > 1) {
        const half = Math.ceil(some.length / 2);
        await ask(some.slice(0, half));
        await ask(some.slice(half));
      } else unjudged.push(...some.map((c) => c.id));
    }
  };
  try {
    await ask(candidates);
  } catch (error) {
    // Nothing is marked as checked, so the same messages are tried again on the next run (an
    // error such as no credit is not charged for).
    throw new Error(describeAiError(error));
  }
  const total: Today = { day, sent: today.sent + candidates.length, input: today.input + used.input, output: today.output + used.output };
  if (unjudged.length) await db.run("update suggestions set checked_at = $3 where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb)) and status = 'new'", [ownerId, JSON.stringify(unjudged), now]);

  let kept = 0;
  let setAside = 0;
  const sent = new Set(candidates.map((c) => c.id));
  for (const v of verdicts) {
    // The answer is checked before it is stored: it must name a message that was sent, once.
    if (!sent.delete(v.id)) continue;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(v.confidence) || 0)));
    if (!v.is_task || confidence < MIN_CONFIDENCE) {
      await db.run("update suggestions set status = 'dismissed', reason = 'not_task', checked_at = $3, confidence = $4 where owner_id = $1 and id = $2 and status = 'new'", [
        ownerId,
        v.id,
        now,
        confidence,
      ]);
      setAside++;
      continue;
    }
    const forName = v.for_whom && v.for_whom !== "owner" && v.for_whom !== "unclear" && team.includes(v.for_whom) ? v.for_whom : null;
    await db.run(
      "update suggestions set title = coalesce(nullif($3, ''), title), why = coalesce(nullif($4, ''), why), for_name = coalesce($5, for_name), looks_done = $6, checked_at = $7, confidence = $8 where owner_id = $1 and id = $2 and status = 'new'",
      [ownerId, v.id, v.title.trim().slice(0, 120), v.summary.trim().slice(0, 400), forName, v.already_done && v.done_evidence.trim() ? v.done_evidence.trim().slice(0, 240) : null, now, confidence],
    );
    kept++;
  }
  // Anything the model left out of its answer is tried again on the next run.
  const parts = [`${kept} ${kept === 1 ? "task" : "tasks"}`, `${setAside} set aside`];
  if (unjudged.length) parts.push(`${unjudged.length} the AI could not judge`);
  for (const id of unjudged) sent.delete(id);
  if (sent.size) parts.push(`${sent.size} to try again`);
  return {
    items: kept + setAside,
    // The model is named, so anyone can see in Settings which one did the work.
    message: `Checked ${kept + setAside} with ${AI_MODEL}: ${parts.join(", ")}. This run: ${tokens(used)}. Today: ${total.sent} ${total.sent === 1 ? "message" : "messages"}, ${tokens(total)}`,
    cursor: { ...cursor, today: total },
  };
}
