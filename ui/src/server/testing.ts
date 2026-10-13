// Helpers for tests: an in-memory database with a little known data, and a fake Slack.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { openDb, openRemote, type Db } from "./db";
import { ensureOwner, OWNER_ID } from "./repo";
import type { SlackClient } from "./slack";
import type { TelegramApi, TelegramChat, TelegramMessage } from "./telegram";

const TABLES = ["outbox", "quick_links", "focus_items", "metric_logs", "metrics", "rules", "suggestions", "tasks", "team_members", "meetings", "messages", "conversations", "slack_channels", "slack_users", "job_runs", "jobs", "connections", "users"];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/**
 * A fresh database for one test file. With TEST_DRIVER=postgres the same in-memory database
 * is reached over a socket through the driver used for the hosted database (Supabase), so
 * that path is tested without a real server.
 */
export async function testDb(): Promise<Db> {
  process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
  // No test may ever read a real Telegram login saved on this machine.
  process.env.TELEGRAM_SESSION_FILE ??= path.join(os.tmpdir(), `command-center-test-${process.pid}`, "telegram-session.json");
  process.env.TELEGRAM_MEDIA_DIR ??= path.join(os.tmpdir(), `command-center-test-${process.pid}`, "telegram-media");
  if (process.env.TEST_DRIVER !== "postgres") return openDb();
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const engine = await PGlite.create();
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: engine, port, host: "127.0.0.1" });
  await server.start();
  const db = await openRemote(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  return {
    ...db,
    close: async () => {
      await db.close();
      await server.stop();
      await engine.close();
    },
  };
}

/** Empties every table and sets the owner up again, as on a first start. */
export async function reset(db: Db): Promise<void> {
  await db.run(`truncate ${TABLES.join(", ")} cascade`);
  await ensureOwner(db);
  await db.run("update users set name = 'Jeremy Moser', email = 'jeremy@example.com', slack_user_id = 'UME' where id = $1", [OWNER_ID]);
}

export const NOW = Date.parse("2026-10-08T12:00:00Z");

/** Two conversations, a teammate and a task: enough for the actions to work on. */
export async function seed(db: Db): Promise<void> {
  await db.run("insert into team_members (id, owner_id, name, role, depts, handles, slack_user_id) values ('u_luis', $1, 'Luis Ramos', 'Lead editor', '[\"Client Sales\"]', '[\"Hooks\"]', 'ULUIS')", [OWNER_ID]);
  await db.run("insert into team_members (id, owner_id, name, role, depts, handles) values ('u_rene', $1, 'Rene Park', 'Bookkeeper', '[\"Finances\"]', '[\"Invoices\"]')", [OWNER_ID]);
  const conversations: [string, string, string, string, boolean, boolean, string][] = [
    ["slack:D1", "D1", "Maya Chen", "Direct message", true, false, "Can we swap the hook on clip 4 before Friday?"],
    ["slack:C1", "C1", "Priya", "#sales", false, false, "Booked 2 more discovery calls for tomorrow."],
  ];
  for (const [id, external, from, ctx, direct, tagged, text] of conversations) {
    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, tagged, last_text, last_at) values ($1, $2, 'slack', $3, $4, $5, $6, $7, $8, $9)", [id, OWNER_ID, external, from, ctx, direct, tagged, text, NOW - 60_000]);
    await db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, body, at) values ($1, $2, $3, '1.0', $4, $5, $6)", [`${id}:1.0`, id, OWNER_ID, from, text, NOW - 60_000]);
  }
  await db.run("insert into tasks (id, owner_id, title, dept, project, pri, due, created_at) values ('t_hook', $1, 'Swap hook on Harbor clip 4', 'Client Sales', 'Harbor Realty', 'high', '2026-10-09', $2)", [OWNER_ID, NOW]);
}

export type FakeSlack = SlackClient & { calls: [string, Record<string, unknown>][] };

/** A Slack that answers from `routes` and remembers what it was asked. An unknown method fails the test. */
export function fakeSlack(routes: Record<string, (params: Record<string, unknown>) => unknown>): FakeSlack {
  const calls: FakeSlack["calls"] = [];
  const call = async <T,>(method: string, params: Record<string, unknown> = {}) => {
    calls.push([method, params]);
    const route = routes[method];
    if (!route) throw new Error(`Unexpected Slack call in a test: ${method}`);
    return route(params) as T;
  };
  return {
    calls,
    call: call as SlackClient["call"],
    list: (async (method: string, key: string, params: Record<string, unknown> = {}) => ((await call<Record<string, unknown[]>>(method, params))[key] ?? [])) as SlackClient["list"],
  };
}

export type FakeTelegram = TelegramApi & {
  chatList: (TelegramChat & { messages: TelegramMessage[] })[];
  read: string[];
  sent: [string, string][];
  closed: number;
  /** The bytes behind each picture ("<chat>:<message>") and each profile picture (by id). */
  files: Record<string, Buffer>;
  faces: Record<string, Buffer>;
  /** What was fetched, in order: "<chat>:<message>" for a picture, "face:<id>" for a profile picture. */
  fetched: string[];
};

/** The first bytes of a real picture of each kind, enough to be recognised as one. */
export const TINY = {
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]),
  webp: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]),
};

/** A Telegram with these chats and messages. It remembers which chats were read, what was fetched and what was sent. */
export function fakeTelegram(chatList: FakeTelegram["chatList"]): FakeTelegram {
  const fake: FakeTelegram = {
    chatList,
    read: [],
    sent: [],
    closed: 0,
    files: {},
    faces: {},
    fetched: [],
    download: async (chatId, messageId) => {
      fake.fetched.push(`${chatId}:${messageId}`);
      return fake.files[`${chatId}:${messageId}`] ?? null;
    },
    picture: async (id) => {
      fake.fetched.push(`face:${id}`);
      return fake.faces[id] ?? null;
    },
    chats: async (limit) => fake.chatList.slice(0, limit).map(({ id, name, kind, topId }) => ({ id, name, kind, topId })),
    messages: async (chatId, { afterId, limit }) => {
      fake.read.push(chatId);
      const chat = fake.chatList.find((c) => c.id === chatId);
      if (!chat) throw new Error(`Unexpected Telegram chat in a test: ${chatId}`);
      return chat.messages.filter((m) => m.id > afterId).slice(-limit);
    },
    send: async (chatId, text) => {
      fake.sent.push([chatId, text]);
    },
    close: async () => {
      fake.closed++;
    },
  };
  return fake;
}
