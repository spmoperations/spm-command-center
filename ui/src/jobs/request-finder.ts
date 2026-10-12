// Finds messages that ask the owner for something and suggests a task for each conversation
// still waiting on them. Plain rules and no AI: see `core/requests`. Nothing becomes a task
// until the owner accepts the suggestion.
import { PERSONAL } from "@/core/config";
import { looksLikeRequest, requestDue, requestSummary, whereAsked } from "@/core/requests";
import type { Mode, Priority } from "@/core/types";
import { uid } from "@/server/repo";
import type { JobContext, JobResult } from "./runner";

/** Messages looked at per run, oldest first. A backlog is worked through over a few runs. */
const MAX_MESSAGES = 2000;

interface Fresh {
  id: string; conversation_id: string; sender_name: string; body: string; at: number;
  direct: boolean; ctx: string; pri: Priority; mode: Mode; project: string; replied: boolean; done: boolean;
}

export async function requestFinder({ db, ownerId, now }: JobContext): Promise<JobResult> {
  // A request the owner has since answered or cleared is no longer waiting.
  const settled = await db.run(
    `update suggestions s set status = 'dismissed'
     where s.owner_id = $1 and s.status = 'new' and s.dedupe_key like 'ask:%'
       and exists (select 1 from conversations c where c.id = s.src_id and (c.replied or c.done))`,
    [ownerId],
  );

  const fresh = await db.query<Fresh>(
    `select m.id, m.conversation_id, m.sender_name, m.body, m.at, c.direct, c.ctx, c.pri, c.mode, c.project, c.replied, c.done
     from messages m join conversations c on c.id = m.conversation_id
     where m.owner_id = $1 and not m.asked and not m.me order by m.at limit $2`,
    [ownerId, MAX_MESSAGES],
  );
  if (!fresh.length) return { items: 0, message: settled ? `${settled} answered` : "No new messages" };

  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const tag = `@${owner?.name ?? ""}`;
  const lastReply = new Map(
    (await db.query<{ conversation_id: string; at: number }>("select conversation_id, max(at) as at from messages where owner_id = $1 and me group by conversation_id", [ownerId])).map((r) => [r.conversation_id, Number(r.at)]),
  );

  // The newest request in each conversation that the owner has not answered yet. In a channel
  // only a message that tags the owner counts; notifications from apps never do.
  const waiting = new Map<string, Fresh>();
  for (const m of fresh) {
    if (m.replied || m.done || m.ctx === "App notification") continue;
    if (Number(m.at) <= (lastReply.get(m.conversation_id) ?? 0)) continue;
    if (!(m.direct || (tag.length > 1 && m.body.includes(tag)))) continue;
    if (looksLikeRequest(m.body)) waiting.set(m.conversation_id, m);
  }

  let added = 0;
  for (const m of waiting.values()) {
    // One open suggestion or task per conversation is enough.
    const [{ n }] = await db.query<{ n: number }>(
      `select (select count(*) from suggestions where owner_id = $1 and src_type = 'message' and src_id = $2 and status = 'new')::int
            + (select count(*) from tasks where owner_id = $1 and src_type = 'message' and src_id = $2 and not done)::int as n`,
      [ownerId, m.conversation_id],
    );
    if (n > 0) continue;
    const personal = m.mode === "personal";
    added += await db.run(
      `insert into suggestions (id, owner_id, title, dept, project, pri, due, why, src_type, src_id, delegable, dedupe_key, mode, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'message', $9, true, $10, $11, $12) on conflict (owner_id, dedupe_key) do nothing`,
      [
        uid("s"), ownerId, `Reply to ${m.sender_name}: ${requestSummary(m.body, tag)}`, personal ? PERSONAL : "Operations", personal ? PERSONAL : m.project, m.pri,
        requestDue(m.body, new Date(now)), `${m.sender_name} asked ${whereAsked(m.ctx)} and is still waiting for your reply.`, m.conversation_id, `ask:${m.id}`, m.mode, now,
      ],
    );
  }
  await db.run("update messages set asked = true where id in (select jsonb_array_elements_text($1::jsonb))", [JSON.stringify(fresh.map((m) => m.id))]);

  const found = `${added} ${added === 1 ? "request" : "requests"} found`;
  return { items: added, message: settled ? `${found}, ${settled} answered` : found };
}
