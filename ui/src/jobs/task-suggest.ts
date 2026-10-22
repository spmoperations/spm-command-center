// The only job that uses an AI model. It reads new messages from other people, in the
// conversations the sorting rules already marked as worth attention, and suggests tasks.
// Plain code decides what is sent; the model only reads that and proposes.
import { SOURCE_NAME } from "@/core/config";
import { addDays, isoDay } from "@/core/dates";
import { redactSecrets } from "@/core/slack-text";
import { aiKeys, describeAiError, findTasks, type FoundTask, type TaskSearch } from "@/server/ai";
import { uid } from "@/server/repo";
import type { Source } from "@/core/types";
import type { JobContext, JobResult } from "./runner";

/** Conversations per run. Keeps one request small and its cost predictable. Set AI_MAX_CONVERSATIONS to lower it. */
const MAX_CONVERSATIONS = Number(process.env.AI_MAX_CONVERSATIONS ?? 25);
const LINES_PER_CONVERSATION = 6;
const MAX_LINE_LENGTH = 600;
/** "ok", "thanks" and the like are not worth a request. */
const MIN_MESSAGE_LENGTH = 12;

type Finder = (input: TaskSearch) => Promise<FoundTask[]>;

const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** The model, with this person's AI key: their own, else the team's (see app-keys.ts). */
const withKeyOf = (db: JobContext["db"], ownerId: string): Finder => async (input) => {
  const keys = await aiKeys(db, ownerId);
  if (!keys) throw new Error("The AI key is not set");
  return findTasks(input, keys);
};

export async function taskSuggest({ db, ownerId, now }: JobContext, finder: Finder = withKeyOf(db, ownerId)): Promise<JobResult> {
  const today = isoDay(new Date(now));
  // Pre-filter in plain code: unread messages from others, in conversations that are a direct
  // message, tag the owner, or that the rules rated above Low.
  const fresh = await db.query<{ conversation_id: string }>(
    `select m.conversation_id, max(m.at) as latest from messages m join conversations c on c.owner_id = m.owner_id and c.id = m.conversation_id
     where m.owner_id = $1 and not m.scanned and not m.me and length(m.body) >= $2
       and not c.done and (c.direct or c.tagged or c.pri in ('high', 'mid'))
     group by m.conversation_id order by latest desc limit $3`,
    [ownerId, MIN_MESSAGE_LENGTH, MAX_CONVERSATIONS],
  );
  const ids = fresh.map((r) => r.conversation_id);
  if (!ids.length) {
    await db.run("update messages set scanned = true where owner_id = $1 and not scanned", [ownerId]);
    return { items: 0, message: "No new messages worth reading" };
  }

  // A list of ids travels as JSON text, which every Postgres driver sends the same way.
  const idList = JSON.stringify(ids);
  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const conversations = await db.query<{ id: string; source: string; ctx: string; from_name: string }>("select id, source, ctx, from_name from conversations where owner_id = $2 and id in (select jsonb_array_elements_text($1::jsonb))", [idList, ownerId]);
  const lines = await db.query<{ conversation_id: string; sender_name: string; me: boolean; body: string }>("select conversation_id, sender_name, me, body from messages where owner_id = $2 and conversation_id in (select jsonb_array_elements_text($1::jsonb)) order by at", [idList, ownerId]);
  const known = [
    ...(await db.query<{ title: string }>("select title from tasks where owner_id = $1 and (not done or done_at > $2)", [ownerId, now - 7 * 86_400_000])),
    ...(await db.query<{ title: string }>("select title from suggestions where owner_id = $1 and created_at > $2", [ownerId, now - 14 * 86_400_000])),
  ].map((r) => r.title);

  let found: FoundTask[];
  try {
    found = await finder({
      ownerName: owner?.name ?? "the owner",
      today,
      weekday: new Date(now).toLocaleDateString("en-US", { weekday: "long" }),
      known,
      sources: conversations.map((c) => ({
        id: c.id,
        where: c.source === "gmail" ? `Email from ${c.from_name}, subject "${c.ctx}"` : `${SOURCE_NAME[c.source as Source] ?? "Slack"} conversation with ${c.from_name} (${c.ctx})`,
        lines: lines.filter((l) => l.conversation_id === c.id).slice(-LINES_PER_CONVERSATION).map((l) => ({ who: l.me ? (owner?.name ?? "Owner") : l.sender_name, text: redactSecrets(l.body).slice(0, MAX_LINE_LENGTH) })),
      })),
    });
  } catch (error) {
    // Nothing is marked as read, so the same messages are tried again on the next run.
    throw new Error(describeAiError(error));
  }

  let added = 0;
  for (const task of found) {
    // The model's answer is checked before it is stored: it must point at a conversation we sent.
    if (!ids.includes(task.source_id) || !task.title.trim()) continue;
    const fallbackDays = task.priority === "high" ? 1 : task.priority === "mid" ? 3 : 7;
    const due = validDay(task.due) && task.due >= today ? task.due : addDays(new Date(now), fallbackDays);
    added += await db.run(
      `insert into suggestions (id, owner_id, title, dept, pri, due, why, src_type, src_id, delegable, dedupe_key, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'message', $8, $9, $10, $11) on conflict (owner_id, dedupe_key) do nothing`,
      [uid("s"), ownerId, task.title.trim().slice(0, 120), task.dept, task.priority, due, task.why.slice(0, 240), task.source_id, task.delegable, `${task.source_id}:${task.title.trim().toLowerCase()}`, now],
    );
  }
  await db.run("update messages set scanned = true where owner_id = $1 and conversation_id in (select jsonb_array_elements_text($2::jsonb))", [ownerId, idList]);
  return { items: added, message: `Read ${ids.length} ${ids.length === 1 ? "conversation" : "conversations"}, suggested ${added} ${added === 1 ? "task" : "tasks"}` };
}
