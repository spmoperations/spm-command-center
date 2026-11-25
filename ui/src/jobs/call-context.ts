// "Writes what each task from a call is about, with AI". Fathom lists a call's action items in a
// line each; whoever does the task was often not on the call and cannot open the recording. Right
// after the Fathom check, this reads each new call's action items with what was said around them
// (core/call-context.ts finds that part, by plain rules) and has the model write what to do, why,
// and the details said (prompts/call-context.ts). The write-up goes on the Review tab, and becomes
// the task's description when it is made a task.
//
// What it may spend is capped. One request per call, for all its action items, with only the part
// of the call around each one and the call's notes, shortened. It starts with the newest few calls
// (`MOST_CALLS`) and from then on takes only new ones: older calls are never read. At most
// `MOST_CALLS` calls a run and `dailyLimit()` a day, and each run says what it used and roughly
// what that cost (Settings, Timers).
import { excerptFor, LONG_TITLE, shortTitle, writeupText, type TranscriptLine } from "@/core/call-context";
import { isoDay } from "@/core/dates";
import { redactSecrets } from "@/core/slack-text";
import type { ActionItem } from "@/core/types";
import type { CallContext } from "@/prompts/call-context";
import { AI_MODEL, aiKeys, describeAiError, NoVerdicts, roughCost, writeCallContext, type AiUsage, type CallContextResult } from "@/server/ai";
import { setting } from "@/server/app-keys";
import { eventId, TEAM, whyFor } from "@/server/tickets";
import type { JobContext, JobResult } from "./runner";

/** Calls written up in one run, and the newest calls the first run starts from. */
export const MOST_CALLS = 4;
/** The most of a call's notes sent with it. */
const MOST_NOTES_CHARS = 4000;

/** The most calls written up in a day for one login: a ceiling if a flood arrives or something goes wrong. Set AI_CALL_CONTEXT_DAILY to change it; 0 switches it off. */
export function dailyLimit(): number {
  const set = setting("AI_CALL_CONTEXT_DAILY");
  if (set) return Math.max(0, Math.floor(Number(set)) || 0);
  return process.env.VERCEL ? 20 : 4;
}

type Writer = (input: CallContext) => Promise<CallContextResult>;

/** The model, with this person's AI key: their own, else the team's (see app-keys.ts). */
const withKeyOf =
  (db: JobContext["db"], ownerId: string): Writer =>
  async (input) => {
    const keys = await aiKeys(db, ownerId);
    if (!keys) throw new Error("The AI key is not set");
    return writeCallContext(input, keys);
  };

interface CallRow {
  id: string;
  title: string;
  started_at: number;
  who: string;
  url: string | null;
  summary: string;
  transcript: TranscriptLine[];
  action_items: ActionItem[];
}

interface ItemRow {
  id: string;
  title: string;
  dedupe_key: string;
  for_name: string | null;
  status: string;
  ticket_id: string | null;
  why: string;
  from_name: string;
}

const actionIndex = (key: string) => Number(/:action:(\d+)$/.exec(key)?.[1] ?? -1);
const dollars = (usage: AiUsage) => {
  const cost = roughCost(usage, AI_MODEL);
  return cost === null ? "" : `, about $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
};

export async function callContext({ db, ownerId, now, cursor }: JobContext, writer: Writer = withKeyOf(db, ownerId)): Promise<JobResult> {
  const day = isoDay(new Date(now));
  const sentToday = cursor.day === day ? Number(cursor.calls ?? 0) : 0;
  // Where it starts: the first run takes the newest few calls with tasks to write up, and nothing older ever.
  let since = typeof cursor.since === "number" ? cursor.since : null;
  if (since === null) {
    const newest = await db.query<{ started_at: number }>(
      `select mt.started_at from meetings mt where mt.owner_id = $1
         and exists (select 1 from suggestions s where s.owner_id = mt.owner_id and s.src_type = 'meeting' and s.src_id = mt.id and s.status <> 'dismissed')
       order by mt.started_at desc limit $2`,
      [ownerId, MOST_CALLS],
    );
    since = newest.length ? Number(newest[newest.length - 1].started_at) : now;
  }
  const keep = (calls: number) => ({ since, day, calls: sentToday + calls });
  const room = Math.min(MOST_CALLS, dailyLimit() - sentToday);
  if (room <= 0) return { items: 0, message: dailyLimit() ? `Today's limit of ${dailyLimit()} calls is reached; the rest wait for tomorrow.` : "Switched off (AI_CALL_CONTEXT_DAILY is 0)", cursor: keep(0) };

  // Calls from then on with action items still to write up, the oldest first.
  const calls = await db.query<CallRow>(
    `select mt.id, mt.title, mt.started_at, mt.who, mt.url, mt.summary, mt.transcript, mt.action_items from meetings mt
     where mt.owner_id = $1 and mt.started_at >= $2::bigint
       and exists (select 1 from suggestions s where s.owner_id = mt.owner_id and s.src_type = 'meeting' and s.src_id = mt.id and s.status <> 'dismissed' and s.context is null)
     order by mt.started_at, mt.id limit $3`,
    [ownerId, since, room],
  );
  if (!calls.length) return { items: 0, message: "No new calls to write up", cursor: keep(0) };

  const used: AiUsage = { input: 0, output: 0 };
  let written = 0;
  let updated = 0;
  let sent = 0;
  const problems: string[] = [];
  for (const call of calls) {
    const items = await db.query<ItemRow>(
      `select s.id, s.title, s.dedupe_key, s.for_name, s.status, s.ticket_id, s.why, u.name as from_name from suggestions s join users u on u.id = s.owner_id
       where s.owner_id = $1 and s.src_type = 'meeting' and s.src_id = $2 and s.status <> 'dismissed' and s.context is null order by s.dedupe_key`,
      [ownerId, call.id],
    );
    const transcript = (call.transcript ?? []).map(([who, text, at]): TranscriptLine => [who, redactSecrets(text), at]);
    const asked = items.map((s) => {
      const item = call.action_items?.[actionIndex(s.dedupe_key)];
      return { row: s, item, excerpt: item ? excerptFor(transcript, item) : [] };
    });
    const notes = redactSecrets(call.summary ?? "").slice(0, MOST_NOTES_CHARS);
    // Nothing to read on the call: noted, so it is not tried again.
    const readable = asked.filter((a) => a.item && (a.excerpt.length || notes.trim()));
    const none = asked.filter((a) => !readable.includes(a));
    if (none.length) await db.run("update suggestions set context = '' where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))", [ownerId, JSON.stringify(none.map((a) => a.row.id))]);
    if (!readable.length) continue;

    const when = new Date(Number(call.started_at));
    let result: CallContextResult;
    try {
      sent++;
      result = await writer({
        title: call.title,
        day: when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }),
        who: call.who,
        notes,
        items: readable.map((a) => ({ id: a.row.id, task: a.item!.text, forWhom: a.row.for_name ?? (a.item!.mine ? "the owner" : "nobody in particular"), excerpt: a.excerpt })),
      });
    } catch (error) {
      if (error instanceof NoVerdicts) {
        // Declined or unreadable: what it used is paid for, and the call is not sent again.
        used.input += error.usage.input;
        used.output += error.usage.output;
        await db.run("update suggestions set context = '' where owner_id = $1 and id in (select jsonb_array_elements_text($2::jsonb))", [ownerId, JSON.stringify(readable.map((a) => a.row.id))]);
        problems.push(error.message);
        continue;
      }
      // The AI service could not be reached or refused the key: the call is tried again on the next run.
      problems.push(describeAiError(error));
      break;
    }
    used.input += result.usage.input;
    used.output += result.usage.output;
    for (const a of readable) {
      const w = result.items.find((x) => x.id === a.row.id);
      const text = w && w.what.trim() ? writeupText(w, { title: call.title, at: Number(call.started_at), who: call.who, link: a.item!.link ?? call.url }) : "";
      // Fathom's line, when it is long, gives way to the short title written from the call. Its words stay on the card as the quote.
      const title = text && a.row.title.length > LONG_TITLE && w!.title.trim() ? shortTitle(w!.title, 100) : null;
      await db.run("update suggestions set context = $3, title = coalesce($4, title) where owner_id = $1 and id = $2", [ownerId, a.row.id, text, title]);
      if (!text) continue;
      written++;
      // Already a task: its description becomes the write-up, unless a person has written their own; its title too, unless someone renamed it.
      if (a.row.status === "accepted" && a.row.ticket_id) {
        const described = await db.run("update tasks set description = $3, updated_at = $6 where owner_id = $1 and id = $2 and (description = $4 or description = $5)", [
          TEAM,
          a.row.ticket_id,
          text,
          a.row.why,
          whyFor(a.row.why, a.row.from_name),
          now,
        ]);
        const renamed = title ? await db.run("update tasks set title = $3, updated_at = $5 where owner_id = $1 and id = $2 and title = $4", [TEAM, a.row.ticket_id, title, a.row.title, now]) : 0;
        if (described || renamed) {
          updated++;
          await db.run("insert into ticket_events (id, owner_id, task_id, at, by_user, by_name, what) values ($1, $2, $3, $4, null, 'Command Center', $5)", [
            eventId(),
            TEAM,
            a.row.ticket_id,
            now,
            described && renamed ? "Title and description written from the call" : described ? "Description written from the call" : "Title written from the call",
          ]);
        }
      }
    }
  }
  const spent = used.input || used.output ? ` (${used.input.toLocaleString("en-US")} tokens read, ${used.output.toLocaleString("en-US")} written${dollars(used)})` : "";
  const done = `${written} ${written === 1 ? "task" : "tasks"} written up from ${sent} ${sent === 1 ? "call" : "calls"}${updated ? `, ${updated} on the board updated` : ""}${spent}`;
  if (problems.length && !written) throw new Error(`${problems[0]}${spent}`);
  return { items: written, message: problems.length ? `${done}. ${problems[0]}` : done, cursor: keep(sent) };
}
