// The Telegram check. Reads new messages from the connected account's own chats.
//
// The same rule as Slack: a one-to-one chat always comes in; a group only when something in
// it is addressed to the owner (a tag or a reply to them). Channels, bots and Saved Messages
// are left out. So is Telegram's own account: it sends login codes, which are never kept.
//
// Pictures and stickers are kept in the database, and so are the profile pictures of the
// people who wrote. Videos are never fetched.
import { saveTelegramAvatar, saveTelegramPicture, telegramAvatarsDue, type StoredPicture } from "@/server/media";
import { RateLimited } from "@/server/slack";
import type { TelegramApi, TelegramMessage } from "@/server/telegram";
import type { JobContext, JobResult } from "./runner";
import { refreshConversation } from "./slack";

// How far back the first read goes and how much one run may read. Kept small while developing.
const BACKFILL_DAYS = Number(process.env.TELEGRAM_BACKFILL_DAYS ?? 2);
const MAX_CHATS = Number(process.env.TELEGRAM_MAX_CHATS ?? 30);
const MESSAGES_PER_CHAT = 30;
/** Pictures and stickers fetched in one run. Each is a download from Telegram. */
const PICTURES_PER_RUN = Number(process.env.TELEGRAM_MAX_PICTURES ?? 40);
/** Profile pictures fetched in one run. */
const AVATARS_PER_RUN = 30;

/** How many downloads are left in this run. */
interface Budget { pictures: number; avatars: number }

/** A download that fails is skipped: the message still shows, without its picture. "Slow down" still stops the run. */
async function attempt(work: () => Promise<Buffer | null>): Promise<Buffer | null> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RateLimited) throw error;
    return null;
  }
}

/**
 * Stores what was read from one chat. New messages are added. On the ones already here the
 * reactions are brought up to date, since people react long after a message is sent. Then
 * the pictures and stickers that are not kept yet are fetched, and the profile pictures of
 * whoever wrote. Returns the messages that were new, and how many others changed.
 */
async function storeChat(
  { db, ownerId, now }: Pick<JobContext, "db" | "ownerId" | "now">,
  telegram: TelegramApi,
  chat: { id: string; direct: boolean },
  messages: TelegramMessage[],
  ownerName: string,
  budget: Budget,
): Promise<{ fresh: TelegramMessage[]; changed: number }> {
  const conversationId = `telegram:${chat.id}`;
  // In a one-to-one chat the other person is the chat itself.
  const senderOf = (m: TelegramMessage) => (m.out ? null : m.senderId || (chat.direct ? chat.id : null));
  const fresh: TelegramMessage[] = [];
  for (const m of messages) {
    const added = await db.run(
      `insert into messages (id, conversation_id, owner_id, external_id, sender_name, sender_id, me, body, at, scanned, reactions)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) on conflict (id) do nothing`,
      [`${conversationId}:${m.id}`, conversationId, ownerId, String(m.id), m.out ? ownerName : m.sender, senderOf(m), m.out, m.text, m.at, m.out, JSON.stringify(m.reactions)],
    );
    if (added) fresh.push(m);
  }
  let changed = await db.run(
    `update messages m set reactions = r.reactions, sender_id = coalesce(r.sender_id, m.sender_id)
     from jsonb_to_recordset($2::jsonb) as r(id text, reactions jsonb, sender_id text)
     where m.conversation_id = $1 and m.id = r.id and (m.reactions <> r.reactions or (r.sender_id is not null and m.sender_id is distinct from r.sender_id))`,
    [conversationId, JSON.stringify(messages.map((m) => ({ id: `${conversationId}:${m.id}`, reactions: m.reactions, sender_id: senderOf(m) })))],
  );

  // Pictures and stickers, newest first, for the messages that do not have theirs yet.
  const withMedia = messages.filter((m) => m.media);
  if (withMedia.length && budget.pictures > 0) {
    const missing = new Set(
      (await db.query<{ external_id: string }>(
        // "Without a key" covers pictures an earlier version saved as files: they are fetched again.
        "select external_id from messages where conversation_id = $1 and (attachments = '[]'::jsonb or not jsonb_exists(attachments -> 0, 'key')) and external_id in (select jsonb_array_elements_text($2::jsonb))",
        [conversationId, JSON.stringify(withMedia.map((m) => String(m.id)))],
      )).map((r) => r.external_id),
    );
    for (const m of withMedia.filter((x) => missing.has(String(x.id))).reverse()) {
      if (budget.pictures <= 0) break;
      budget.pictures--;
      const bytes = await attempt(() => telegram.download(chat.id, m.id));
      const key = bytes && (await saveTelegramPicture(db, ownerId, chat.id, m.id, bytes, now));
      if (!key) continue;
      const picture: StoredPicture = { kind: m.media!.kind, name: m.media!.name, w: m.media!.w, h: m.media!.h, key };
      changed += await db.run("update messages set attachments = $1::jsonb where id = $2", [JSON.stringify([picture]), `${conversationId}:${m.id}`]);
    }
  }

  // Profile pictures of the people who wrote, asked for once and again after a week.
  const people = new Set(chat.direct ? [chat.id] : messages.map(senderOf).filter((id): id is string => Boolean(id)));
  for (const id of await telegramAvatarsDue(db, ownerId, [...people], now)) {
    if (budget.avatars <= 0) break;
    budget.avatars--;
    await saveTelegramAvatar(db, ownerId, id, await attempt(() => telegram.picture(id)), now);
    changed++;
  }
  return { fresh, changed };
}

export async function telegramPull({ db, ownerId, now, cursor }: JobContext, telegram: TelegramApi): Promise<JobResult> {
  // The bookmark: the newest message already read in each chat.
  const seen: Record<string, number> = { ...((cursor.seen as Record<string, number> | undefined) ?? {}) };
  const since = now - BACKFILL_DAYS * 86_400_000;
  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const budget: Budget = { pictures: PICTURES_PER_RUN, avatars: AVATARS_PER_RUN };

  let stored = 0;
  let touched = 0;
  let leftOut = 0;
  for (const chat of await telegram.chats(MAX_CHATS)) {
    if (chat.kind === "service") {
      // Login codes must not sit in the inbox. This also clears a copy an earlier version read.
      await db.run("delete from conversations where owner_id = $1 and id = $2", [ownerId, `telegram:${chat.id}`]);
      continue;
    }
    if (chat.kind !== "direct" && chat.kind !== "group") continue;
    const last = seen[chat.id] ?? 0;
    if (chat.topId <= last) continue;
    seen[chat.id] = chat.topId;

    // On the very first read of a chat, only the last few days count.
    const fresh = (await telegram.messages(chat.id, { afterId: last, limit: MESSAGES_PER_CHAT })).filter((m) => last > 0 || m.at >= since);
    if (!fresh.length) continue;
    const direct = chat.kind === "direct";
    const tagged = fresh.some((m) => !m.out && m.mentioned);
    // A group with nothing addressed to the owner stays out of the inbox.
    if (!direct && !tagged) {
      leftOut++;
      continue;
    }

    const conversationId = `telegram:${chat.id}`;
    await db.run(
      `insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, last_at) values ($1, $2, 'telegram', $3, $4, $5, $6, 0)
       on conflict (id) do nothing`,
      [conversationId, ownerId, chat.id, chat.name, direct ? "Direct message" : chat.name, direct],
    );
    stored += (await storeChat({ db, ownerId, now }, telegram, { id: chat.id, direct }, fresh, owner?.name ?? "You", budget)).fresh.length;
    touched++;
    await refreshConversation(db, conversationId, { kind: direct ? "im" : "mpim", partner: direct ? chat.name : null }, tagged);
  }

  return {
    items: stored,
    cursor: { seen },
    message: `${stored} new ${stored === 1 ? "message" : "messages"} in ${touched} ${touched === 1 ? "chat" : "chats"}${leftOut ? `. ${leftOut} ${leftOut === 1 ? "group" : "groups"} with nothing addressed to you ${leftOut === 1 ? "was" : "were"} left out` : ""}`,
  };
}

/**
 * Reads one chat again when a person opens it. The hourly check only looks at a chat when
 * it has a new message, and a reaction is not one. This brings in anything written since,
 * and the reactions and pictures on the messages already here as they are now.
 * Returns how many messages were added, and how many already here changed.
 */
export async function telegramRefresh({ db, ownerId, now }: Pick<JobContext, "db" | "ownerId" | "now">, telegram: TelegramApi, conversationId: string): Promise<{ added: number; changed: number }> {
  const [chat] = await db.query<{ external_id: string; from_name: string; direct: boolean; oldest: number | null }>(
    "select c.external_id, c.from_name, c.direct, (select min(m.at) from messages m where m.conversation_id = c.id and m.external_id is not null) as oldest from conversations c where c.owner_id = $1 and c.id = $2 and c.source = 'telegram'",
    [ownerId, conversationId],
  );
  if (!chat) return { added: 0, changed: 0 };
  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  // Only from where the copy here starts: opening a chat must not pull its history in page by page.
  const latest = (await telegram.messages(chat.external_id, { afterId: 0, limit: MESSAGES_PER_CHAT })).filter((m) => m.at >= Number(chat.oldest ?? 0));
  // Enough for every message read here, so one look at a chat brings in all of its pictures.
  const { fresh, changed } = await storeChat({ db, ownerId, now }, telegram, { id: chat.external_id, direct: chat.direct }, latest, owner?.name ?? "You", { pictures: MESSAGES_PER_CHAT, avatars: 10 });
  if (fresh.length) await refreshConversation(db, conversationId, { kind: chat.direct ? "im" : "mpim", partner: chat.direct ? chat.from_name : null }, fresh.some((m) => !m.out && m.mentioned));
  return { added: fresh.length, changed };
}
