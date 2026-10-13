// Slack jobs. Read-only: they list people and channels, and bring in new messages.
//
// The owner is in hundreds of conversations, so asking each one "anything new?" every hour
// would be hundreds of requests. Instead `slack-pull` asks Slack's search once for everything
// newer than its bookmark, which costs a request per hundred messages.
import { attachmentText, channelKind, contextLabel, mentionedIds, mentionsUser, slackReactions, slackToText, slackTsToMs, threadOf, type SlackKind } from "@/core/slack-text";
import type { Db } from "@/server/db";
import type { StoredPicture } from "@/server/media";
import { RateLimited, SLACK_FILES_HOST, type SlackClient } from "@/server/slack";
import type { JobContext, JobResult } from "./runner";

interface SlackUser { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; profile?: { real_name?: string; display_name?: string; email?: string; image_72?: string; image_48?: string } }

/** People outside the workspace whose picture is looked up in one run. Each is one request to Slack. */
const PICTURES_PER_RUN = 60;

/** The address of a person's profile picture, at a size that suits a small round icon. Only https addresses are kept. */
const pictureOf = (u: SlackUser): string | null => {
  const url = u.profile?.image_72 || u.profile?.image_48 || "";
  return url.startsWith("https://") ? url : null;
};
interface SlackChannel { id: string; name?: string; user?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean }

/**
 * Keeps what the token may do, as Slack said in its last answer. Showing pictures needs one
 * permission more than reading messages, and this is how the dashboard knows whether it is
 * there. Returns 1 when that changed.
 */
async function noteScopes(db: Db, ownerId: string, slack: SlackClient): Promise<number> {
  const scopes = slack.scopes?.();
  if (!scopes) return 0;
  return db.run("update connections set scopes = $1 where owner_id = $2 and provider = 'slack' and scopes is distinct from $1", [scopes.join(","), ownerId]);
}

export async function slackDirectorySync({ db, ownerId }: JobContext, slack: SlackClient): Promise<JobResult> {
  const me = await slack.call<{ user_id: string }>("auth.test");
  await noteScopes(db, ownerId, slack);
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
      image: pictureOf(u),
    }]),
  );
  await db.run(
    `insert into slack_users (owner_id, id, name, email, is_bot, deleted, image)
     select $1, r.id, r.name, r.email, r.is_bot, r.deleted, r.image
     from jsonb_to_recordset($2::jsonb) as r(id text, name text, email text, is_bot boolean, deleted boolean, image text)
     on conflict (owner_id, id) do update set name = excluded.name, email = excluded.email, is_bot = excluded.is_bot, deleted = excluded.deleted, image = excluded.image`,
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
  // People from other companies, in shared channels, are not in the member list. They were
  // looked up one at a time when first seen; those still without a picture get another look.
  // An empty address means "asked, and there is none", so nobody is asked about twice.
  const strangers = await db.query<{ id: string }>(
    "select id from slack_users where owner_id = $1 and image is null and not deleted and id not in (select jsonb_array_elements_text($2::jsonb)) limit $3",
    [ownerId, JSON.stringify([...people.keys()]), PICTURES_PER_RUN],
  );
  for (const { id } of strangers) {
    let image = "";
    try {
      image = pictureOf((await slack.call<{ user: SlackUser }>("users.info", { user: id })).user) ?? "";
    } catch (error) {
      if (error instanceof RateLimited) throw error;
    }
    await db.run("update slack_users set image = $1 where owner_id = $2 and id = $3", [image, ownerId, id]);
  }
  return { items: users.length + channels.length, message: `${users.length} people, ${channels.length} conversations` };
}

interface SearchMatch {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  files?: unknown[];
  attachments?: unknown;
  /** The only place search says which thread a message is in: see `threadOf`. */
  permalink?: string;
  channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean };
}
interface HistoryMessage { ts: string; thread_ts?: string; reply_count?: number; latest_reply?: string; text?: string; user?: string; username?: string; subtype?: string; bot_id?: string; user_profile?: { real_name?: string; display_name?: string }; files?: unknown[]; attachments?: unknown; reactions?: unknown }

/** A file on a message, as Slack describes it. Only the parts a picture needs. */
type SlackFile = { name?: string; title?: string; mimetype?: string; mode?: string; url_private?: string; permalink?: string; original_w?: number; original_h?: number } & Record<string, unknown>;

/**
 * The pictures among a message's files. Videos, documents and everything else are left out.
 * Only addresses on Slack's own file server are kept: the dashboard later fetches them with
 * the owner's token, and must never be sent anywhere else with it.
 */
export function slackPictures(files: unknown): StoredPicture[] {
  if (!Array.isArray(files)) return [];
  const onSlack = (v: unknown): v is string => typeof v === "string" && v.startsWith(`https://${SLACK_FILES_HOST}/`);
  const pictures: StoredPicture[] = [];
  for (const f of files as SlackFile[]) {
    if (!f?.mimetype?.startsWith("image/") || f.mimetype === "image/svg+xml" || f.mode === "external") continue;
    // A moving GIF has moving small copies of its own. Otherwise the largest ordinary one.
    const sizes = f.mimetype === "image/gif" ? ["thumb_480_gif", "thumb_360_gif", "thumb_720", "thumb_480", "thumb_360"] : ["thumb_720", "thumb_480", "thumb_360"];
    const thumb = sizes.map((k) => f[k]).find(onSlack);
    const url = onSlack(f.url_private) ? f.url_private : undefined;
    if (!thumb && !url) continue;
    pictures.push({
      kind: "image",
      name: (f.title || f.name || "Picture").slice(0, 120),
      w: Number(f.original_w) || undefined,
      h: Number(f.original_h) || undefined,
      thumb,
      url,
      link: typeof f.permalink === "string" && f.permalink.startsWith("https://") ? f.permalink : undefined,
    });
  }
  return pictures;
}

// How far back the first read goes, and how many pages of 100 messages one run may read.
// Both can be turned down in the environment while developing.
const BACKFILL_DAYS = Number(process.env.SLACK_BACKFILL_DAYS ?? 2);
const MAX_PAGES = Number(process.env.SLACK_MAX_PAGES ?? 20);
const CONTEXT_MESSAGES = 8;
/** Whole threads read in one run. Each is one request to Slack. */
const MAX_THREADS = 40;
/** How far back a thread counts as one the owner is following. */
const FOLLOW_DAYS = 30;

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
    await db.run("insert into slack_users (owner_id, id, name, is_bot, image) values ($1, $2, $3, $4, $5) on conflict (owner_id, id) do update set name = excluded.name, image = excluded.image", [ownerId, userId, name, app, pictureOf(user)]);
    if (app) look.apps.add(userId);
  } catch (error) {
    // A person Slack will not describe is shown as "Someone"; a rate limit still stops the job.
    if (error instanceof RateLimited) throw error;
  }
  look.names.set(userId, name);
}

/** Stores one message. `thread` is the id of the message that started its thread, when it is in one. */
async function storeMessage(db: Db, ownerId: string, conversationId: string, look: Lookup, m: { ts: string; text?: string; user?: string; username?: string; user_profile?: { real_name?: string; display_name?: string }; files?: unknown[]; attachments?: unknown; reactions?: unknown }, thread: string | null = null): Promise<boolean> {
  const me = m.user === look.myId;
  const sender = (m.user && look.names.get(m.user)) || m.user_profile?.real_name || m.user_profile?.display_name || m.username || "Someone";
  const pictures = slackPictures(m.files);
  const text = slackToText(m.text || attachmentText(m.attachments), (id) => look.names.get(id)) || (pictures.length ? "(sent a picture)" : m.files?.length ? "(sent a file)" : "(sent something that has no text)");
  const id = `${conversationId}:${m.ts}`;
  const added = await db.run(
    `insert into messages (id, conversation_id, owner_id, external_id, sender_name, sender_id, me, body, at, scanned, thread_ts, attachments, reactions)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb) on conflict (id) do nothing`,
    [id, conversationId, ownerId, m.ts, sender, m.user ?? null, me, text, slackTsToMs(m.ts), me, thread, JSON.stringify(pictures), JSON.stringify(slackReactions(m.reactions, look.myId))],
  );
  // A message stored before its thread was known is put in its thread now.
  if (!added && thread) await db.run("update messages set thread_ts = $1 where id = $2 and thread_ts is null", [thread, id]);
  return added > 0;
}

/**
 * Brings the pictures and reactions of messages already stored in line with what Slack says
 * now: a reaction is often added long after the message was read, and the search the hourly
 * check uses carries neither. One statement for the whole list. Returns how many changed.
 */
async function saveExtras(db: Db, conversationId: string, myId: string, messages: HistoryMessage[]): Promise<number> {
  const rows = messages
    .filter((m) => !m.subtype || m.subtype === "thread_broadcast")
    .map((m) => ({ id: `${conversationId}:${m.ts}`, attachments: slackPictures(m.files), reactions: slackReactions(m.reactions, myId) }));
  if (!rows.length) return 0;
  return db.run(
    `update messages m set attachments = r.attachments, reactions = r.reactions
     from jsonb_to_recordset($2::jsonb) as r(id text, attachments jsonb, reactions jsonb)
     where m.conversation_id = $1 and m.id = r.id and (m.attachments <> r.attachments or m.reactions <> r.reactions)`,
    [conversationId, JSON.stringify(rows)],
  );
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

/** Messages of an open conversation that are checked for replies, newest first. */
const CHECKED_MESSAGES = 40;
/** Threads read in one check. Each is one request to Slack. */
const CHECKED_THREADS = 10;
/** Threads read again even when nothing in them is new, so reactions on their replies stay current. */
const FRESH_THREADS = 3;

/**
 * Reads the threads under the messages of one conversation, when a person opens it.
 *
 * The hourly check only brings in a thread when the owner is tagged in it or it is in a chat
 * they follow. The other messages on screen may have replies in Slack too. This asks Slack
 * once which of them do, and reads the threads the dashboard does not have in full yet.
 *
 * The same answer carries each message's pictures and reactions as they are now, so those
 * are brought up to date on the way. The threads written in most recently are read again
 * for the same reason.
 * Returns how many messages were added, and how many already here changed.
 */
export async function slackReadThreads({ db, ownerId }: Pick<JobContext, "db" | "ownerId">, slack: SlackClient, conversationId: string): Promise<{ added: number; changed: number }> {
  const [conversation] = await db.query<{ external_id: string }>("select external_id from conversations where owner_id = $1 and id = $2 and source = 'slack'", [ownerId, conversationId]);
  if (!conversation) return { added: 0, changed: 0 };
  // The messages that could have a thread under them, with how many replies are here already.
  const onScreen = await db.query<{ external_id: string; replies: number }>(
    `select m.external_id,
            (select count(*)::int from messages r where r.conversation_id = m.conversation_id and r.thread_ts = m.external_id and r.external_id <> m.external_id) as replies
     from messages m
     where m.conversation_id = $1 and m.external_id is not null and (m.thread_ts is null or m.thread_ts = m.external_id)
     order by m.at desc limit $2`,
    [conversationId, CHECKED_MESSAGES],
  );
  if (!onScreen.length) return { added: 0, changed: 0 };

  const oldest = onScreen.reduce((min, m) => (Number(m.external_id) < Number(min) ? m.external_id : min), onScreen[0].external_id);
  const history = await slack.call<{ messages: HistoryMessage[] }>("conversations.history", { channel: conversation.external_id, oldest, inclusive: true, limit: 200 });
  const [owner] = await db.query<{ slack_user_id: string | null }>("select slack_user_id from users where id = $1", [ownerId]);
  const myId = owner?.slack_user_id ?? "";
  let changed = (await saveExtras(db, conversationId, myId, history.messages)) + (await noteScopes(db, ownerId, slack));

  const inSlack = new Map(history.messages.map((m) => [m.ts, m.reply_count ?? 0]));
  const behind = onScreen.filter((m) => (inSlack.get(m.external_id) ?? 0) > m.replies).map((m) => m.external_id);
  const here = new Set(onScreen.map((m) => m.external_id));
  const lively = history.messages
    .filter((m) => (m.reply_count ?? 0) > 0 && here.has(m.ts))
    .sort((a, b) => Number(b.latest_reply ?? b.ts) - Number(a.latest_reply ?? a.ts))
    .slice(0, FRESH_THREADS)
    .map((m) => m.ts);
  const threads = [...new Set([...behind, ...lively])].slice(0, CHECKED_THREADS);
  if (!threads.length) return { added: 0, changed };

  const look = await lookup(db, ownerId);
  let added = 0;
  for (const thread of threads) {
    const res = await slack.call<{ messages: HistoryMessage[] }>("conversations.replies", { channel: conversation.external_id, ts: thread, limit: 200 });
    for (const reply of res.messages) {
      if (reply.subtype && reply.subtype !== "thread_broadcast") continue;
      for (const id of [reply.user, ...mentionedIds(reply.text ?? "")]) await learnName(db, ownerId, look, slack, id);
      if (await storeMessage(db, ownerId, conversationId, look, reply, thread)) added++;
    }
    changed += await saveExtras(db, conversationId, myId, res.messages);
  }
  if (added) {
    const known = look.channels.get(conversation.external_id);
    const kind = known?.kind ?? "public";
    await refreshConversation(db, conversationId, { kind, partner: kind === "im" ? (look.names.get(known?.userId ?? "") ?? null) : null }, false);
  }
  return { added, changed };
}

export async function slackPull({ db, ownerId, now, cursor }: JobContext, slack: SlackClient): Promise<JobResult> {
  const look = await lookup(db, ownerId);
  const lastTs = typeof cursor.lastTs === "string" ? cursor.lastTs : String((now - BACKFILL_DAYS * 86_400_000) / 1000);
  // Search works in whole days, so ask from the day before the bookmark and drop what is already stored.
  const query = `after:${day(Number(lastTs) * 1000 - 2 * 86_400_000)}`;

  const touched = new Map<string, { kind: SlackKind; partner: string | null; tagged: boolean; isNew: boolean; firstTs: string; channelId: string }>();
  // Threads the owner is already part of: a new reply in one of these comes in even from a
  // channel that is not ticked and without tagging them.
  const following = new Set<string>();
  for (const row of await db.query<{ conversation_id: string; thread_ts: string }>("select distinct conversation_id, thread_ts from messages where owner_id = $1 and thread_ts is not null and at > $2", [ownerId, now - FOLLOW_DAYS * 86_400_000])) {
    following.add(`${row.conversation_id}:${row.thread_ts}`);
  }
  // Threads to read whole once the search is done: a reply alone says little without the
  // message it answers and the replies around it.
  const threads = new Map<string, { conversationId: string; channelId: string; thread: string }>();
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
      const conversationId = `slack:${m.channel.id}`;
      const thread = threadOf(m.permalink);
      if (!wanted(kind, known?.selected ?? false, raw, look.myId) && !(thread && following.has(`${conversationId}:${thread}`))) {
        leftOut++;
        continue;
      }

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
      if (await storeMessage(db, ownerId, conversationId, look, m, thread)) stored++;
      if (thread) threads.set(`${conversationId}:${thread}`, { conversationId, channelId: m.channel.id, thread });
      if (Number(m.ts) > Number(newest)) newest = m.ts;
    }
  }

  // Each thread that was touched is read whole: the message that started it and every reply.
  // The search ran newest first, so when there are too many for one run the newest are read.
  for (const { conversationId, channelId, thread } of [...threads.values()].slice(0, MAX_THREADS)) {
    const res = await slack.call<{ messages: HistoryMessage[] }>("conversations.replies", { channel: channelId, ts: thread, limit: 200 });
    for (const m of res.messages) {
      if (m.subtype && m.subtype !== "thread_broadcast") continue;
      for (const id of [m.user, ...mentionedIds(m.text ?? "")]) await learnName(db, ownerId, look, slack, id);
      if (await storeMessage(db, ownerId, conversationId, look, m, thread)) stored++;
    }
    // The search that found these carries no reactions and only some pictures. The thread does.
    await saveExtras(db, conversationId, look.myId, res.messages);
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
