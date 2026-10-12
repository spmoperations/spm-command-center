// Slack jobs. Read-only: they list people and channels, and bring in new messages.
//
// The owner is in hundreds of conversations, so asking each one "anything new?" every hour
// would be hundreds of requests. Instead `slack-pull` asks Slack's search once for everything
// newer than its bookmark, which costs a request per hundred messages.
import { attachmentText, channelKind, contextLabel, mentionedIds, mentionsUser, slackToText, slackTsToMs, type SlackKind } from "@/core/slack-text";
import type { Db } from "@/server/db";
import { RateLimited, type SlackClient } from "@/server/slack";
import type { JobContext, JobResult } from "./runner";

interface SlackUser { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; profile?: { real_name?: string; display_name?: string; email?: string } }
interface SlackChannel { id: string; name?: string; user?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean }

export async function slackDirectorySync({ db, ownerId }: JobContext, slack: SlackClient): Promise<JobResult> {
  const me = await slack.call<{ user_id: string }>("auth.test");
  const users = await slack.list<SlackUser>("users.list", "members", { limit: 200 });
  // Saved in one statement: a workspace has hundreds of people and conversations, and one
  // trip to the database each would take minutes.
  const people = new Map(
    users.map((u) => [u.id, {
      id: u.id,
      name: u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || u.id,
      email: u.profile?.email ?? null,
      is_bot: Boolean(u.is_bot || u.is_app_user) || u.id === "USLACKBOT",
      deleted: Boolean(u.deleted),
    }]),
  );
  await db.run(
    `insert into slack_users (owner_id, id, name, email, is_bot, deleted)
     select $1, r.id, r.name, r.email, r.is_bot, r.deleted
     from jsonb_to_recordset($2::jsonb) as r(id text, name text, email text, is_bot boolean, deleted boolean)
     on conflict (owner_id, id) do update set name = excluded.name, email = excluded.email, is_bot = excluded.is_bot, deleted = excluded.deleted`,
    [ownerId, JSON.stringify([...people.values()])],
  );
  const self = users.find((u) => u.id === me.user_id);
  await db.run("update users set slack_user_id = $1, name = coalesce($2, name), email = coalesce(email, $3) where id = $4", [me.user_id, self?.profile?.real_name ?? self?.real_name ?? null, self?.profile?.email ?? null, ownerId]);

  const channels = await slack.list<SlackChannel>("users.conversations", "channels", { types: "public_channel,private_channel,mpim,im", exclude_archived: true, limit: 200 });
  const places = new Map(channels.map((c) => [c.id, { id: c.id, name: c.name ?? c.user ?? c.id, kind: channelKind(c), user_id: c.user ?? null }]));
  // `selected` is the owner's choice, so an update never touches it.
  await db.run(
    `insert into slack_channels (owner_id, id, name, kind, user_id)
     select $1, r.id, r.name, r.kind, r.user_id
     from jsonb_to_recordset($2::jsonb) as r(id text, name text, kind text, user_id text)
     on conflict (owner_id, id) do update set name = excluded.name, kind = excluded.kind, user_id = excluded.user_id`,
    [ownerId, JSON.stringify([...places.values()])],
  );
  return { items: users.length + channels.length, message: `${users.length} people, ${channels.length} conversations` };
}

interface SearchMatch {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  files?: unknown[];
  attachments?: unknown;
  channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean };
}
interface HistoryMessage { ts: string; text?: string; user?: string; username?: string; subtype?: string; bot_id?: string; user_profile?: { real_name?: string; display_name?: string }; files?: unknown[]; attachments?: unknown }

// How far back the first read goes, and how many pages of 100 messages one run may read.
// Both can be turned down in the environment while developing.
const BACKFILL_DAYS = Number(process.env.SLACK_BACKFILL_DAYS ?? 2);
const MAX_PAGES = Number(process.env.SLACK_MAX_PAGES ?? 20);
const CONTEXT_MESSAGES = 8;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Lookup {
  myId: string;
  names: Map<string, string>;
  /** Accounts that are apps or bots, not people. */
  apps: Set<string>;
  channels: Map<string, { kind: SlackKind; name: string; userId: string | null; selected: boolean }>;
}

async function lookup(db: Db, ownerId: string): Promise<Lookup> {
  const [owner] = await db.query<{ slack_user_id: string | null }>("select slack_user_id from users where id = $1", [ownerId]);
  if (!owner?.slack_user_id) throw new Error("The Slack people and channel list has not been read yet. Run that check first.");
  const users = await db.query<{ id: string; name: string; is_bot: boolean }>("select id, name, is_bot from slack_users where owner_id = $1", [ownerId]);
  const channels = await db.query<{ id: string; name: string; kind: SlackKind; user_id: string | null; selected: boolean }>("select id, name, kind, user_id, selected from slack_channels where owner_id = $1", [ownerId]);
  return {
    myId: owner.slack_user_id,
    names: new Map(users.map((u) => [u.id, u.name])),
    apps: new Set(users.filter((u) => u.is_bot).map((u) => u.id)),
    channels: new Map(channels.map((c) => [c.id, { kind: c.kind, name: c.name, userId: c.user_id, selected: c.selected }])),
  };
}

/** Which messages belong in the inbox: direct and group messages, ticked channels, and anywhere the owner is tagged. */
export function wanted(kind: SlackKind, selected: boolean, rawText: string, myId: string): boolean {
  return kind === "im" || kind === "mpim" || selected || mentionsUser(rawText, myId);
}

/**
 * People from other companies in shared channels are not in the workspace's member list.
 * They are looked up once, the first time they appear, and remembered.
 */
async function learnName(db: Db, ownerId: string, look: Lookup, slack: SlackClient, userId: string | undefined): Promise<void> {
  if (!userId || look.names.has(userId)) return;
  let name = "Someone";
  try {
    const { user } = await slack.call<{ user: SlackUser }>("users.info", { user: userId });
    name = user.profile?.real_name || user.real_name || user.profile?.display_name || user.name || name;
    const app = Boolean(user.is_bot || user.is_app_user);
    await db.run("insert into slack_users (owner_id, id, name, is_bot) values ($1, $2, $3, $4) on conflict (owner_id, id) do update set name = excluded.name", [ownerId, userId, name, app]);
    if (app) look.apps.add(userId);
  } catch (error) {
    // A person Slack will not describe is shown as "Someone"; a rate limit still stops the job.
    if (error instanceof RateLimited) throw error;
  }
  look.names.set(userId, name);
}

async function storeMessage(db: Db, ownerId: string, conversationId: string, look: Lookup, m: { ts: string; text?: string; user?: string; username?: string; user_profile?: { real_name?: string; display_name?: string }; files?: unknown[]; attachments?: unknown }): Promise<boolean> {
  const me = m.user === look.myId;
  const sender = (m.user && look.names.get(m.user)) || m.user_profile?.real_name || m.user_profile?.display_name || m.username || "Someone";
  const text = slackToText(m.text || attachmentText(m.attachments), (id) => look.names.get(id)) || (m.files?.length ? "(sent a file)" : "(sent something that has no text)");
  const added = await db.run(
    `insert into messages (id, conversation_id, owner_id, external_id, sender_name, me, body, at, scanned)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing`,
    [`${conversationId}:${m.ts}`, conversationId, ownerId, m.ts, sender, me, text, slackTsToMs(m.ts), me],
  );
  return added > 0;
}

/**
 * Brings a conversation's summary in line with its messages: who it is from, the latest
 * message, whether the owner has answered, and whether they are tagged since they last spoke.
 */
export async function refreshConversation(db: Db, conversationId: string, look: { kind: SlackKind; partner: string | null }, rawTagged: boolean): Promise<void> {
  const messages = await db.query<{ sender_name: string; me: boolean; body: string; at: number }>("select sender_name, me, body, at from messages where conversation_id = $1 order by at desc limit 40", [conversationId]);
  if (!messages.length) return;
  const last = messages[0];
  const lastIncoming = messages.find((m) => !m.me);
  const [before] = await db.query<{ last_at: number; done: boolean; tagged: boolean }>("select last_at, done, tagged from conversations where id = $1", [conversationId]);
  const newIncoming = Boolean(lastIncoming && Number(lastIncoming.at) > Number(before?.last_at ?? 0));
  await db.run(
    `update conversations set from_name = $1, last_text = $2, last_at = $3, replied = $4, tagged = $5, done = $6 where id = $7`,
    [
      look.kind === "im" ? (look.partner ?? lastIncoming?.sender_name ?? "Someone") : (lastIncoming?.sender_name ?? last.sender_name),
      (lastIncoming ?? last).body,
      Number((lastIncoming ?? last).at),
      last.me,
      // A tag stays until the owner answers.
      last.me ? false : rawTagged || Boolean(before?.tagged),
      // Something new from someone else reopens a cleared conversation.
      newIncoming ? false : Boolean(before?.done),
      conversationId,
    ],
  );
}

export async function slackPull({ db, ownerId, now, cursor }: JobContext, slack: SlackClient): Promise<JobResult> {
  const look = await lookup(db, ownerId);
  const lastTs = typeof cursor.lastTs === "string" ? cursor.lastTs : String((now - BACKFILL_DAYS * 86_400_000) / 1000);
  // Search works in whole days, so ask from the day before the bookmark and drop what is already stored.
  const query = `after:${day(Number(lastTs) * 1000 - 2 * 86_400_000)}`;

  const touched = new Map<string, { kind: SlackKind; partner: string | null; tagged: boolean; isNew: boolean; firstTs: string; channelId: string }>();
  let newest = lastTs;
  let stored = 0;
  let leftOut = 0;
  let pages = 1;
  let caughtUp = false;
  // Newest first, so the job can stop as soon as it reaches what it has already seen.
  for (let page = 1; page <= Math.min(pages, MAX_PAGES) && !caughtUp; page++) {
    const res = await slack.call<{ messages: { matches: SearchMatch[]; paging?: { pages?: number } } }>("search.messages", { query, sort: "timestamp", sort_dir: "desc", count: 100, page });
    pages = res.messages.paging?.pages ?? 1;
    for (const m of res.messages.matches) {
      if (Number(m.ts) <= Number(lastTs)) {
        caughtUp = true;
        continue;
      }
      if (m.user === "USLACKBOT") continue;
      const known = look.channels.get(m.channel.id);
      const kind = known?.kind ?? channelKind(m.channel);
      const raw = m.text ?? "";
      if (!wanted(kind, known?.selected ?? false, raw, look.myId)) {
        leftOut++;
        continue;
      }

      const conversationId = `slack:${m.channel.id}`;
      const partnerId = kind === "im" ? (known?.userId ?? m.channel.name ?? "") : "";
      const partner = kind === "im" ? (look.names.get(partnerId) ?? null) : null;
      // A direct message from an app (Notion, Slack's own notices) is a notification, not a person writing.
      const fromApp = kind === "im" && look.apps.has(partnerId);
      let entry = touched.get(conversationId);
      if (!entry) {
        const created = await db.run(
          `insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, last_at) values ($1, $2, 'slack', $3, $4, $5, $6, 0)
           on conflict (id) do nothing`,
          [conversationId, ownerId, m.channel.id, partner ?? "Someone", fromApp ? "App notification" : contextLabel(kind, known?.name ?? m.channel.name ?? "channel"), !fromApp && (kind === "im" || kind === "mpim")],
        );
        entry = { kind, partner, tagged: false, isNew: created > 0, firstTs: m.ts, channelId: m.channel.id };
        touched.set(conversationId, entry);
      }
      // Names of the sender and of anyone tagged, so the text reads "@Maya Chen" and not an id.
      for (const id of [m.user, ...mentionedIds(raw)]) await learnName(db, ownerId, look, slack, id);
      if (Number(m.ts) < Number(entry.firstTs)) entry.firstTs = m.ts;
      if (m.user !== look.myId && mentionsUser(raw, look.myId)) entry.tagged = true;
      if (await storeMessage(db, ownerId, conversationId, look, m)) stored++;
      if (Number(m.ts) > Number(newest)) newest = m.ts;
    }
  }

  for (const [conversationId, entry] of touched) {
    if (entry.isNew) {
      // A conversation seen for the first time gets a little earlier context, so the thread reads properly.
      const history = await slack.call<{ messages: HistoryMessage[] }>("conversations.history", { channel: entry.channelId, latest: entry.firstTs, limit: CONTEXT_MESSAGES, inclusive: false });
      for (const m of history.messages) {
        if (m.subtype && m.subtype !== "thread_broadcast") continue;
        for (const id of [m.user, ...mentionedIds(m.text ?? "")]) await learnName(db, ownerId, look, slack, id);
        await storeMessage(db, ownerId, conversationId, look, m);
        // Earlier context is background, not something to search for tasks.
        await db.run("update messages set scanned = true where id = $1", [`${conversationId}:${m.ts}`]);
      }
    }
    await refreshConversation(db, conversationId, entry, entry.tagged);
  }

  return {
    items: stored,
    cursor: { lastTs: newest },
    // Saying what was left out answers "why did nothing come in?" on the Timers page.
    message: `${stored} new ${stored === 1 ? "message" : "messages"} in ${touched.size} ${touched.size === 1 ? "conversation" : "conversations"}${leftOut ? `. ${leftOut} in channels that are not ticked in Settings were left out` : ""}${!caughtUp && pages > MAX_PAGES ? ". There was more than one run can read, so the oldest were skipped." : ""}`,
  };
}
