// The AI check. The request finder's plain rules flag every message that asks something; this
// reads each one, with the conversation around it, and keeps only real tasks. What it keeps gets
// a clear title, a summary, who it is for and how sure the model is. What it sets aside is turned
// down with the reason "not_task" and kept, so anyone can put it back. See prompts/task-check.ts.
//
// Plain code decides what is sent: only what the rules flagged, cut to a few messages around it,
// with keys and passwords taken out. The model only judges.
import { SOURCE_NAME } from "@/core/config";
import { isoDay } from "@/core/dates";
import { redactSecrets } from "@/core/slack-text";
import type { Source } from "@/core/types";
import type { Candidate } from "@/prompts/task-check";
import { aiKeys, checkCandidates, describeAiError, type TaskCheck, type Verdict } from "@/server/ai";
import { teamPeople } from "@/server/tickets";
import type { JobContext, JobResult } from "./runner";

/** Messages judged in one request: keeps each request small and its cost predictable. Set AI_CHECK_BATCH to lower it. */
const BATCH = Number(process.env.AI_CHECK_BATCH ?? 20);
/** How much of the conversation goes with each message: what came before it, and what came after. */
const BEFORE = 6;
const AFTER = 4;
const MAX_LINE_LENGTH = 600;
/** Below this the model is not sure enough that it is a real task, and it is set aside. */
export const MIN_CONFIDENCE = 60;

type Checker = (input: TaskCheck) => Promise<Verdict[]>;

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

export async function taskCheck({ db, ownerId, now }: JobContext, checker: Checker = withKeyOf(db, ownerId)): Promise<JobResult> {
  // What the rules flagged and nobody has checked: the oldest first, so a backlog is worked through.
  const waiting = await db.query<{ id: string; src_id: string; dedupe_key: string }>(
    "select id, src_id, dedupe_key from suggestions where owner_id = $1 and status = 'new' and src_type = 'message' and dedupe_key like 'ask:%' and checked_at is null order by created_at, id limit $2",
    [ownerId, BATCH],
  );
  if (!waiting.length) return { items: 0, message: "Nothing new to check" };

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

  const team = (await teamPeople(db)).map((p) => p.name);
  let verdicts: Verdict[];
  try {
    verdicts = await checker({ ownerName: me, today: isoDay(new Date(now)), weekday: new Date(now).toLocaleDateString("en-US", { weekday: "long" }), team, candidates });
  } catch (error) {
    // Nothing is marked as checked, so the same messages are tried again on the next run.
    throw new Error(describeAiError(error));
  }

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
  // Anything the model did not answer for is tried again on the next run.
  return { items: kept + setAside, message: `Checked ${kept + setAside}: ${kept} ${kept === 1 ? "task" : "tasks"}, ${setAside} set aside${sent.size ? `, ${sent.size} to try again` : ""}` };
}
