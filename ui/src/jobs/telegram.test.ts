import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as telegramRoute } from "@/app/api/telegram/route";
import { liveSources } from "@/core/config";
import { liveProviders } from "@/core/providers";
import type { Db } from "@/server/db";
import { forgetTelegramMedia } from "@/server/media";
import { pictureResponse } from "@/server/pictures";
import { applyAction, loadState, OWNER_ID } from "@/server/repo";
import { seal, unseal } from "@/server/secrets";
import { createSession, SESSION_COOKIE } from "@/server/session";
import {
  adoptTelegramFile, describeTelegramMedia, giveTelegramCode, giveTelegramPassword, startTelegramLogin, TELEGRAM_OFF_HERE, telegramAvailable, telegramBlocked, telegramConnected, telegramReactions,
  type OpenDoor, type TelegramMessage,
} from "@/server/telegram";
import { fakeSlack, fakeTelegram, NOW, reset, seed, testDb, TINY, type FakeTelegram } from "@/server/testing";
import { outboxSend } from "./outbox";
import { runJob, syncAll, type JobContext } from "./runner";
import { telegramPull, telegramRefresh } from "./telegram";

let db: Db;
let folder: string;
const ctx = (cursor: Record<string, unknown> = {}): JobContext => ({ db, ownerId: OWNER_ID, now: NOW, cursor });

const MINUTE = 60_000;
const DAY = 86_400_000;
const HOSTED = "postgres://user:secret@db.example.com:5432/postgres";
const said = (id: number, text: string, more: Partial<TelegramMessage> = {}): TelegramMessage => ({ id, at: NOW - (100 - id) * MINUTE, text, out: false, sender: "Dana Whitfield", senderId: "", mentioned: false, reactions: [], ...more });

/** One of each kind of chat Telegram has. */
const account = (): FakeTelegram =>
  fakeTelegram([
    { id: "501", name: "Dana Whitfield", kind: "direct", topId: 3, messages: [said(1, "Are we still on for Thursday?"), said(2, "Yes, 3pm works", { out: true }), said(3, "Can you send the deck first?")] },
    { id: "-701", name: "Launch crew", kind: "group", topId: 9, messages: [said(8, "Lunch?", { sender: "Sam Ortiz" }), said(9, "Can you confirm the date?", { sender: "Sam Ortiz", mentioned: true })] },
    { id: "-702", name: "Book club", kind: "group", topId: 4, messages: [said(4, "Next month's pick is in", { sender: "Ines Marsh" })] },
    { id: "-1009", name: "Daily news", kind: "channel", topId: 50, messages: [said(50, "Headline")] },
    { id: "88", name: "Reminder bot", kind: "bot", topId: 2, messages: [said(2, "Ping")] },
    { id: "1", name: "Saved Messages", kind: "self", topId: 7, messages: [said(7, "A note to myself", { out: true })] },
    { id: "777000", name: "Telegram", kind: "service", topId: 6, messages: [said(6, "Login code: 12345. Do not give this code to anyone.", { sender: "Telegram" })] },
  ]);

/** The app keys are set, as on a server that has them. */
function withKeys() {
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
}

/** As if a person had logged in here: the keys are set and a sealed login is kept. */
async function connected() {
  withKeys();
  await db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, 'telegram', $2, 'Dana Whitfield · +44 •••• 0123', $3)", [OWNER_ID, seal("a-login-that-is-never-used"), NOW]);
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  await reset(db);
  // Every test gets an empty folder for a login file from an earlier version, never the real one.
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "command-center-telegram-"));
  process.env.TELEGRAM_SESSION_FILE = path.join(folder, "telegram-session.json");
});
afterEach(() => {
  for (const name of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_HOSTED", "DATABASE_URL", "SENDING_ENABLED", "LOGIN_EMAIL", "LOGIN_PASSWORD"]) delete process.env[name];
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("where Telegram may be used", () => {
  it("needs its app keys, and with a hosted database also the server's say-so", () => {
    expect([telegramAvailable(), telegramBlocked()]).toEqual([false, "Telegram's app keys are not set: TELEGRAM_API_ID and TELEGRAM_API_HASH. Add them to the environment. On a host that means for Production, followed by a redeploy."]);
    withKeys();
    expect([telegramAvailable(), telegramBlocked()]).toEqual([true, null]);
    // A developer's machine pointed at the hosted database: off, so their own account cannot end up there.
    process.env.DATABASE_URL = HOSTED;
    expect([telegramAvailable(), telegramBlocked()]).toEqual([false, TELEGRAM_OFF_HERE]);
    // The live site says it is the one meant to hold a Telegram login.
    process.env.TELEGRAM_HOSTED = "true";
    expect([telegramAvailable(), telegramBlocked()]).toEqual([true, null]);
  });

  it("says exactly which setting is missing or wrong, and forgives quotes and spaces pasted around a value", async () => {
    process.env.TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
    expect(telegramBlocked()).toMatch(/^TELEGRAM_API_ID is not set\. TELEGRAM_API_HASH is\./);
    process.env.TELEGRAM_API_ID = "TELEGRAM_API_ID=12345";
    expect(telegramBlocked()).toBe("TELEGRAM_API_ID is not a number. It should be the App api_id from my.telegram.org, digits only.");
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "";
    expect(telegramBlocked()).toMatch(/^TELEGRAM_API_HASH is not set\. TELEGRAM_API_ID is\./);
    process.env.TELEGRAM_API_HASH = "too-short";
    expect(telegramBlocked()).toMatch(/^TELEGRAM_API_HASH does not look right\./);

    // Pasted the way they sit in a settings file: still good.
    process.env.TELEGRAM_API_ID = ' "12345" ';
    process.env.TELEGRAM_API_HASH = "'0123456789abcdef0123456789ABCDEF'\n";
    expect([telegramAvailable(), telegramBlocked()]).toEqual([true, null]);
    process.env.DATABASE_URL = HOSTED;
    expect(telegramBlocked()).toBe(TELEGRAM_OFF_HERE);
    process.env.TELEGRAM_HOSTED = ' "True" ';
    expect([telegramAvailable(), telegramBlocked()]).toEqual([true, null]);
    // The screens are told the same sentence, so the Connections tab can show it.
    delete process.env.TELEGRAM_HOSTED;
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.telegramAvailable, state.telegramBlocked]).toEqual([false, TELEGRAM_OFF_HERE]);
  });

  it("shows who is connected by name and a masked number", async () => {
    await connected();
    expect(await telegramConnected(db, OWNER_ID)).toBe(true);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).connections.telegram).toEqual({ connected: true, connectedAt: NOW, label: "Dana Whitfield · +44 •••• 0123" });
  });

  it("takes no notice of a saved login on a server that may not use Telegram", async () => {
    await connected();
    process.env.DATABASE_URL = HOSTED;
    expect(await telegramConnected(db, OWNER_ID)).toBe(false);
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.telegramAvailable, state.localData, state.connections.telegram]).toEqual([false, false, { connected: false }]);
    expect(await runJob(db, "telegram-pull", OWNER_ID, NOW)).toMatchObject({ ok: false, items: 0, message: TELEGRAM_OFF_HERE });
    expect((await syncAll(db)).map((r) => r.jobId)).not.toContain("telegram-pull");
  });

  it("uses a saved login on the live site once the server says so", async () => {
    await connected();
    process.env.DATABASE_URL = HOSTED;
    process.env.TELEGRAM_HOSTED = "true";
    expect(await telegramConnected(db, OWNER_ID)).toBe(true);
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.telegramAvailable, state.localData, state.connections.telegram.connected]).toEqual([true, false, true]);
  });

  it("joins the list of apps, sources and checks only where it can be used", () => {
    expect([liveProviders(false), liveProviders(true)]).toEqual([["slack", "fathom"], ["slack", "telegram", "fathom"]]);
    expect([liveSources(false), liveSources(true)]).toEqual([["slack"], ["slack", "telegram"]]);
  });

  it("says it is not connected when nobody has logged in", async () => {
    withKeys();
    expect(await telegramConnected(db, OWNER_ID)).toBe(false);
    expect(await runJob(db, "telegram-pull", OWNER_ID, NOW)).toMatchObject({ ok: false, message: "Telegram is not connected" });
  });

  it("moves a login an earlier version kept in a file into the local database, once, and never into a hosted one", async () => {
    withKeys();
    const file = process.env.TELEGRAM_SESSION_FILE!;
    const old = JSON.stringify({ v: 1, session: seal("the-old-login"), name: "Dana Whitfield", phone: "+44 •••• 0123", connectedAt: NOW });
    fs.writeFileSync(file, old);
    process.env.DATABASE_URL = HOSTED;
    process.env.TELEGRAM_HOSTED = "true";
    expect([await adoptTelegramFile(db, OWNER_ID), fs.existsSync(file)]).toEqual([false, true]);
    expect(await db.query("select provider from connections")).toEqual([]);

    delete process.env.DATABASE_URL;
    delete process.env.TELEGRAM_HOSTED;
    expect([await adoptTelegramFile(db, OWNER_ID), fs.existsSync(file)]).toEqual([true, false]);
    const [row] = await db.query<{ secret: string; label: string; connected_at: number }>("select secret, label, connected_at from connections where provider = 'telegram'");
    expect([unseal(row.secret), row.label, Number(row.connected_at)]).toEqual(["the-old-login", "Dana Whitfield · +44 •••• 0123", NOW]);
    expect(await adoptTelegramFile(db, OWNER_ID)).toBe(false);
  });
});

describe("logging in to Telegram, one request per step", () => {
  const failure = (code: string, more: Record<string, unknown> = {}) => Object.assign(new Error(code), { errorMessage: code, ...more });
  interface Script { via?: "app" | "sms" | "email"; code?: string; password?: string; hint?: string; sendFails?: Error; codeExpired?: boolean }

  /**
   * A pretend Telegram. Each request opens its own connection from the keys it was handed,
   * as two different servers would, and nothing is shared between them but those keys.
   */
  function telegram(script: Script = {}) {
    const asked: string[] = [];
    const open: OpenDoor = async (session) => {
      let keys = session || "keys";
      asked.push(`open ${session || "(new)"}`);
      return {
        sendCode: async (phone) => {
          asked.push(`sendCode ${phone}`);
          if (script.sendFails) throw script.sendFails;
          return { hash: "hash-1", via: script.via ?? "app", email: script.via === "email" ? "d***@example.com" : undefined };
        },
        signIn: async (phone, hash, code, via) => {
          asked.push(`signIn ${phone} ${hash} ${code} ${via}`);
          if (script.codeExpired) throw failure("PHONE_CODE_EXPIRED");
          if (code !== (script.code ?? "12345")) throw failure("PHONE_CODE_INVALID");
          keys += script.password ? "+code" : "+in";
          return script.password ? "password" : "done";
        },
        passwordHint: async () => script.hint,
        checkPassword: async (password) => {
          asked.push("checkPassword");
          if (password !== script.password) throw failure("PASSWORD_HASH_INVALID");
          keys += "+in";
        },
        me: async () => ({ name: "Dana Whitfield", phone: "447700900123" }),
        session: () => keys,
        close: async () => void asked.push("close"),
      };
    };
    return { open, asked };
  }
  const saved = async () => (await db.query<{ secret: string; label: string }>("select secret, label from connections where provider = 'telegram'")).map((r) => [unseal(r.secret), r.label]);

  beforeEach(withKeys);

  it("sends the code, takes it in a second request, and keeps the login sealed in the database", async () => {
    const t = telegram();
    const first = await startTelegramLogin("+447700900123", t.open);
    expect(first.step).toEqual({ need: "code", viaApp: true });
    // What travels to the browser and back is sealed: the connection's keys cannot be read from it.
    expect([typeof first.pending, first.pending!.includes("keys"), unseal(first.pending!).includes('"session":"keys"')]).toEqual(["string", false, true]);
    expect(await saved()).toEqual([]);

    const second = await giveTelegramCode(db, OWNER_ID, first.pending, " 12345 ", t.open);
    expect(second).toEqual({ step: { connected: true, label: "Dana Whitfield · +44 •••• 0123" }, pending: null });
    expect(t.asked).toEqual(["open (new)", "sendCode +447700900123", "close", "open keys", "signIn +447700900123 hash-1 12345 app", "close"]);
    expect(await saved()).toEqual([["keys+in", "Dana Whitfield · +44 •••• 0123"]]);
    const [{ secret }] = await db.query<{ secret: string }>("select secret from connections where provider = 'telegram'");
    expect(secret.includes("keys")).toBe(false);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).connections.telegram).toMatchObject({ connected: true, label: "Dana Whitfield · +44 •••• 0123" });
  });

  it("asks for the code again when it is wrong, with the same login still good", async () => {
    const t = telegram();
    const first = await startTelegramLogin("+447700900123", t.open);
    const wrong = await giveTelegramCode(db, OWNER_ID, first.pending, "00000", t.open);
    expect(wrong).toEqual({ step: { need: "code", viaApp: true, error: "That code is not right. Check it and try again." }, pending: first.pending });
    expect(await saved()).toEqual([]);
    expect((await giveTelegramCode(db, OWNER_ID, wrong.pending, "12345", t.open)).step).toMatchObject({ connected: true });
  });

  it("asks for the account's password when it has one, again when it is wrong, and never keeps it", async () => {
    const t = telegram({ password: "open sesame", hint: "the usual" });
    const first = await startTelegramLogin("+447700900123", t.open);
    const afterCode = await giveTelegramCode(db, OWNER_ID, first.pending, "12345", t.open);
    expect(afterCode.step).toEqual({ need: "password", hint: "the usual" });
    expect(afterCode.pending).not.toBe(first.pending);
    await expect(giveTelegramCode(db, OWNER_ID, afterCode.pending, "12345", t.open)).rejects.toThrow("Telegram is waiting for your password, not a code.");

    const wrong = await giveTelegramPassword(db, OWNER_ID, afterCode.pending, "guess", t.open);
    expect(wrong).toEqual({ step: { need: "password", hint: "the usual", error: "That password is not right. Try again." }, pending: afterCode.pending });
    expect(await saved()).toEqual([]);

    expect(await giveTelegramPassword(db, OWNER_ID, wrong.pending, "open sesame", t.open)).toEqual({ step: { connected: true, label: "Dana Whitfield · +44 •••• 0123" }, pending: null });
    expect(await saved()).toEqual([["keys+code+in", "Dana Whitfield · +44 •••• 0123"]]);
    // The password opened the door once. It is in no table and in nothing sent back.
    expect(JSON.stringify([await db.query("select * from connections"), unseal(afterCode.pending!)])).not.toContain("open sesame");
  });

  it("will not take a password before Telegram has asked for one", async () => {
    const t = telegram();
    const first = await startTelegramLogin("+447700900123", t.open);
    await expect(giveTelegramPassword(db, OWNER_ID, first.pending, "anything", t.open)).rejects.toThrow("Telegram has not asked for a password.");
  });

  it("starts over when the code has expired, the login is too old, or what comes back is not its own", async () => {
    const over = "That login has timed out. Start again with your phone number.";
    const expiring = telegram({ codeExpired: true });
    const first = await startTelegramLogin("+447700900123", expiring.open);
    await expect(giveTelegramCode(db, OWNER_ID, first.pending, "12345", expiring.open)).rejects.toThrow("That code has expired. Start again to get a new one.");

    const t = telegram();
    const old = seal(JSON.stringify({ ...JSON.parse(unseal(first.pending!)), at: Date.now() - 11 * MINUTE }));
    for (const token of [old, null, "", "not-a-sealed-thing", `${first.pending!.slice(0, -4)}AAAA`]) {
      await expect(giveTelegramCode(db, OWNER_ID, token, "12345", t.open)).rejects.toThrow(over);
      await expect(giveTelegramPassword(db, OWNER_ID, token, "x", t.open)).rejects.toThrow(over);
    }
    // Nothing was asked of Telegram for any of them.
    expect(t.asked).toEqual([]);
    expect(await saved()).toEqual([]);
  });

  it("puts Telegram's refusals in plain words", async () => {
    const start = (sendFails: Error) => startTelegramLogin("+447700900123", telegram({ sendFails }).open);
    await expect(start(failure("PHONE_NUMBER_INVALID"))).rejects.toThrow("Telegram does not know that phone number. Check the country code.");
    await expect(start(failure("FLOOD_WAIT_120", { seconds: 120 }))).rejects.toThrow("Telegram asks you to wait 2 minutes before trying again.");
    await expect(start(failure("API_ID_INVALID"))).rejects.toThrow("Telegram did not accept the app keys. Check TELEGRAM_API_ID and TELEGRAM_API_HASH.");
    await expect(start(new Error("Telegram requires a login email for this account"))).rejects.toThrow("Telegram wants a login email on this account first.");
    // The connection is closed even when a step fails.
    const t = telegram({ sendFails: failure("PHONE_NUMBER_BANNED") });
    await expect(startTelegramLogin("+447700900123", t.open)).rejects.toThrow("Telegram has blocked that phone number.");
    expect(t.asked).toEqual(["open (new)", "sendCode +447700900123", "close"]);
  });

  it("says when the code went to the account's email or by text message, and hands it in the right way", async () => {
    const byEmail = telegram({ via: "email", code: "123456" });
    const first = await startTelegramLogin("+447700900123", byEmail.open);
    expect(first.step).toEqual({ need: "code", viaApp: false, email: "d***@example.com" });
    await giveTelegramCode(db, OWNER_ID, first.pending, "123456", byEmail.open);
    expect(byEmail.asked).toContain("signIn +447700900123 hash-1 123456 email");
    expect((await startTelegramLogin("+447700900123", telegram({ via: "sms" }).open)).step).toEqual({ need: "code", viaApp: false });
  });

  it("does nothing on a server that may not use Telegram", async () => {
    process.env.DATABASE_URL = HOSTED;
    const t = telegram();
    await expect(startTelegramLogin("+447700900123", t.open)).rejects.toThrow(TELEGRAM_OFF_HERE);
    expect(t.asked).toEqual([]);
  });
});

describe("the Telegram login request", () => {
  const post = (body: unknown, more: { signedIn?: boolean; cookie?: string } = {}) => {
    process.env.LOGIN_EMAIL = "jeremy@example.com";
    process.env.LOGIN_PASSWORD = "correct horse battery";
    const cookies = [more.signedIn === false ? "" : `${SESSION_COOKIE}=${createSession("jeremy@example.com")}`, more.cookie ?? ""].filter(Boolean).join("; ");
    return telegramRoute(
      new Request("http://127.0.0.1:3000/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:3000", ...(cookies ? { cookie: cookies } : {}) },
        body: JSON.stringify(body),
      }),
    );
  };
  const answer = async (response: Response) => [response.status, ((await response.json()) as { error?: string }).error];
  const over = "That login has timed out. Start again with your phone number.";

  it("is only for a signed-in person", async () => {
    withKeys();
    expect(await answer(await post({ step: "start", phone: "+447700900123" }, { signedIn: false }))).toEqual([401, "Please sign in."]);
  });

  it("is refused on a server that may not use Telegram, before anything is sent to Telegram", async () => {
    withKeys();
    process.env.DATABASE_URL = HOSTED;
    expect(await answer(await post({ step: "start", phone: "+447700900123" }))).toEqual([400, TELEGRAM_OFF_HERE]);
    expect(await answer(await post({ step: "disconnect", forget: true }))).toEqual([400, TELEGRAM_OFF_HERE]);
  });

  it("asks for a real phone number, and for the steps in order", async () => {
    withKeys();
    expect(await answer(await post({ step: "start", phone: "07700 900123" }))).toEqual([400, "Type the number with its country code, for example +44 7700 900123."]);
    expect(await answer(await post({ step: "code", code: "12345" }))).toEqual([400, over]);
    expect(await answer(await post({ step: "password", password: "x" }))).toEqual([400, over]);
    expect(await answer(await post({ step: "code", code: "12345" }, { cookie: "cc_telegram_login=made-up" }))).toEqual([400, over]);
    expect(await answer(await post({ step: "anything else" }))).toEqual([400, "Unknown step."]);
  });

  it("forgets a login in progress when it is cancelled", async () => {
    withKeys();
    const res = await post({ step: "cancel" }, { cookie: "cc_telegram_login=something" });
    expect([res.status, res.headers.get("set-cookie")]).toEqual([200, "cc_telegram_login=; Path=/api/telegram; HttpOnly; SameSite=Strict; Max-Age=0"]);
  });
});

describe("Telegram job", () => {
  it("brings in one-to-one chats and group messages addressed to the owner, and leaves the rest alone", async () => {
    const telegram = account();
    const result = await telegramPull(ctx(), telegram);
    expect(result).toMatchObject({ items: 5, message: "5 new messages in 2 chats. 1 group with nothing addressed to you was left out", cursor: { seen: { "501": 3, "-701": 9, "-702": 4 } } });
    // Channels, bots, Saved Messages and Telegram's own account are never even opened.
    expect(telegram.read).toEqual(["501", "-701", "-702"]);

    const inbox = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.filter((c) => c.source === "telegram");
    expect(inbox.map((c) => c.id).sort()).toEqual(["telegram:-701", "telegram:501"]);
    const direct = inbox.find((c) => c.id === "telegram:501")!;
    expect(direct).toMatchObject({ from: "Dana Whitfield", ctx: "Direct message", direct: true, tagged: false, text: "Can you send the deck first?", replied: false });
    expect(direct.thread.map((m) => [m.me, m.text])).toEqual([[false, "Are we still on for Thursday?"], [true, "Yes, 3pm works"], [false, "Can you send the deck first?"]]);
    expect(inbox.find((c) => c.id === "telegram:-701")).toMatchObject({ from: "Sam Ortiz", ctx: "Launch crew", direct: false, tagged: true, text: "Can you confirm the date?" });
  });

  it("opens a chat again only when it has something new, and reads only the new part", async () => {
    const telegram = account();
    const first = await telegramPull(ctx(), telegram);
    telegram.read.length = 0;
    expect(await telegramPull(ctx(first.cursor), telegram)).toMatchObject({ items: 0, message: "0 new messages in 0 chats" });
    expect(telegram.read).toEqual([]);

    const dana = telegram.chatList[0];
    dana.messages.push(said(4, "Never mind, found it"));
    dana.topId = 4;
    const again = await telegramPull(ctx(first.cursor), telegram);
    expect(again).toMatchObject({ items: 1, message: "1 new message in 1 chat", cursor: { seen: { "501": 4 } } });
    expect(telegram.read).toEqual(["501"]);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:501")!.thread).toHaveLength(4);
  });

  it("goes back only a few days the first time, and stores nothing twice", async () => {
    const telegram = fakeTelegram([{ id: "501", name: "Dana Whitfield", kind: "direct", topId: 2, messages: [said(1, "An old one", { at: NOW - 5 * DAY }), said(2, "A new one")] }]);
    expect((await telegramPull(ctx(), telegram)).items).toBe(1);
    // The bookmark lost: the same messages come back and change nothing.
    expect((await telegramPull(ctx(), telegram)).items).toBe(0);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:501")!.thread.map((m) => m.text)).toEqual(["A new one"]);
  });

  it("never keeps Telegram's own account, where login codes arrive, and removes a copy read before", async () => {
    await db.run("insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, last_text, last_at) values ('telegram:777000', $1, 'telegram', '777000', 'Telegram', 'Direct message', true, 'Login code: 12345', $2)", [OWNER_ID, NOW]);
    await db.run("insert into messages (id, conversation_id, owner_id, external_id, sender_name, body, at) values ('telegram:777000:6', 'telegram:777000', $1, '6', 'Telegram', 'Login code: 12345', $2)", [OWNER_ID, NOW]);
    const telegram = account();
    await telegramPull(ctx(), telegram);
    expect(telegram.read).not.toContain("777000");
    expect(await db.query("select id from conversations where id = 'telegram:777000'")).toEqual([]);
    expect(await db.query("select id from messages where body like '%Login code%'")).toEqual([]);
  });

  it("brings a group in later, once someone there tags the owner", async () => {
    const telegram = account();
    const first = await telegramPull(ctx(), telegram);
    const club = telegram.chatList[2];
    club.messages.push(said(5, "Are you coming on Friday?", { sender: "Ines Marsh", mentioned: true }));
    club.topId = 5;
    await telegramPull(ctx(first.cursor), telegram);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:-702")).toMatchObject({ from: "Ines Marsh", ctx: "Book club", tagged: true, text: "Are you coming on Friday?" });
  });

  it("keeps the names of the groups and channels, reads the whole list once a day, and forgets one that is gone", async () => {
    const telegram = account();
    telegram.chatList[1].at = NOW - MINUTE;
    const asked: number[] = [];
    const chats = telegram.chats;
    telegram.chats = (limit) => {
      asked.push(limit);
      return chats(limit);
    };
    const names = () => db.query<{ id: string; name: string; kind: string; last_at: number | null }>("select id, name, kind, last_at from telegram_chats order by id");

    const first = await telegramPull(ctx(), telegram);
    expect(first.cursor).toMatchObject({ listedAt: NOW });
    expect(await names()).toEqual([
      { id: "-1009", name: "Daily news", kind: "channel", last_at: null },
      { id: "-701", name: "Launch crew", kind: "group", last_at: NOW - MINUTE },
      { id: "-702", name: "Book club", kind: "group", last_at: null },
    ]);
    // Only the names: the channel is still never opened.
    expect(telegram.read).not.toContain("-1009");

    // Between the daily reads, only the recent chats are read, and a group missing from them stays.
    telegram.chatList.splice(2, 1);
    telegram.chatList[1].name = "Launch crew (Q4)";
    const later = await telegramPull({ ...ctx(first.cursor), now: NOW + 3_600_000 }, telegram);
    expect(later.cursor).toMatchObject({ listedAt: NOW });
    expect((await names()).map((c) => c.name)).toEqual(["Daily news", "Launch crew (Q4)", "Book club"]);

    // A day on, the whole list again: the group that was left is forgotten.
    const nextDay = await telegramPull({ ...ctx(later.cursor), now: NOW + DAY }, telegram);
    expect(nextDay.cursor).toMatchObject({ listedAt: NOW + DAY });
    expect((await names()).map((c) => c.id)).toEqual(["-1009", "-701"]);
    expect(asked).toEqual([200, 30, 200]);
  });
});

describe("sending to Telegram", () => {
  const slack = () => fakeSlack({ "chat.postMessage": () => ({ ok: true }) });
  const reply = async () => {
    await telegramPull(ctx(), account());
    await applyAction(db, "sendReply", ["telegram:501", "Sending it now", false], OWNER_ID, new Date(NOW));
  };

  it("keeps a reply in the outbox while sending is switched off", async () => {
    await reply();
    const telegram = account();
    expect(await outboxSend(ctx(), null, async () => telegram)).toMatchObject({ items: 0, message: "1 waiting. Sending is switched off." });
    expect(telegram.sent).toEqual([]);
  });

  it("when switched on, sends the reply to that chat from the connected account, and marks it sent", async () => {
    await reply();
    process.env.SENDING_ENABLED = "true";
    const telegram = account();
    expect(await outboxSend(ctx(), null, async () => telegram)).toMatchObject({ items: 1, message: "Sent 1 of 1" });
    expect([telegram.sent, telegram.closed]).toEqual([[["501", "Sending it now"]], 1]);
    expect((await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:501")!.thread.at(-1)).toMatchObject({ me: true, text: "Sending it now", status: "sent" });
  });

  it("never sends a Telegram reply through Slack, and keeps it waiting while Telegram is not connected", async () => {
    await reply();
    process.env.SENDING_ENABLED = "true";
    const viaSlack = slack();
    expect((await outboxSend(ctx(), viaSlack, null)).items).toBe(0);
    expect(viaSlack.calls).toEqual([]);
    expect(await db.query("select status, last_error from outbox")).toEqual([{ status: "queued", last_error: "Telegram is not connected" }]);
  });

  it("does not open Telegram when only Slack messages are waiting", async () => {
    await seed(db);
    await applyAction(db, "sendReply", ["slack:D1", "Swapping it today", false], OWNER_ID, new Date(NOW));
    process.env.SENDING_ENABLED = "true";
    let opened = 0;
    const viaSlack = slack();
    await outboxSend(ctx(), viaSlack, async () => {
      opened++;
      return account();
    });
    expect([opened, viaSlack.calls]).toEqual([0, [["chat.postMessage", { channel: "D1", text: "Swapping it today" }]]]);
  });

  it("does not offer a Telegram chat as a place to post a Slack assignment", async () => {
    const telegram = fakeTelegram([{ id: "-703", name: "#launch", kind: "group", topId: 1, messages: [said(1, "Can you take the venue?", { sender: "Sam Ortiz", mentioned: true })] }]);
    await telegramPull(ctx(), telegram);
    await seed(db);
    await expect(applyAction(db, "delegateConversation", ["telegram:-703", "u_luis", "", "2026-10-09", "chat"], OWNER_ID, new Date(NOW))).rejects.toThrow("This task did not come from a channel or a group message.");
    expect(await db.query("select id from outbox")).toEqual([]);
  });
});

describe("what a Telegram message carries besides text", () => {
  const size = (type: string, w: number, h: number, className = "PhotoSize") => ({ className, type, w, h });
  const photo = (sizes: unknown[]) => ({ className: "MessageMediaPhoto", photo: { className: "Photo", sizes } });
  const file = (mimeType: string, attributes: unknown[], more: Record<string, unknown> = {}) => ({ className: "MessageMediaDocument", document: { className: "Document", mimeType, size: 40_000, attributes, ...more } });

  it("fetches a photo at a size for the screen, not the largest there is", () => {
    const sizes = [{ className: "PhotoStrippedSize", type: "i" }, size("m", 320, 240), size("x", 800, 600), size("y", 1280, 960, "PhotoSizeProgressive")];
    expect(describeTelegramMedia(photo(sizes))).toEqual({ label: "(sent a photo)", media: { kind: "image", name: "Photo", w: 800, h: 600 }, fetch: "x" });
    // A small photo is fetched as it is.
    expect(describeTelegramMedia(photo([size("m", 320, 240)]))).toMatchObject({ media: { w: 320, h: 240 }, fetch: "m" });
    expect(describeTelegramMedia(photo([]))).toEqual({ label: "(sent a photo)" });
  });

  it("shows a still sticker as it is, and a moving one by its still preview", () => {
    const sticker = { className: "DocumentAttributeSticker", alt: "😀" };
    expect(describeTelegramMedia(file("image/webp", [sticker, { className: "DocumentAttributeImageSize", w: 512, h: 512 }]))).toEqual({ label: "(sent a sticker 😀)", media: { kind: "sticker", name: "Sticker 😀", w: 512, h: 512 }, fetch: "" });
    expect(describeTelegramMedia(file("video/webm", [sticker, { className: "DocumentAttributeVideo", w: 512, h: 512 }], { thumbs: [size("m", 320, 320)] }))).toEqual({ label: "(sent a sticker 😀)", media: { kind: "sticker", name: "Sticker 😀", w: 320, h: 320 }, fetch: "m" });
    expect(describeTelegramMedia(file("application/x-tgsticker", [sticker]))).toEqual({ label: "(sent a sticker 😀)" });
  });

  it("names a video, a GIF, a voice note and a document, and fetches none of them", () => {
    const video = { className: "DocumentAttributeVideo", w: 1280, h: 720 };
    expect(describeTelegramMedia(file("video/mp4", [video], { thumbs: [size("m", 320, 180)] }))).toEqual({ label: "(sent a video)" });
    expect(describeTelegramMedia(file("video/mp4", [video, { className: "DocumentAttributeAnimated" }]))).toEqual({ label: "(sent a GIF)" });
    expect(describeTelegramMedia(file("audio/ogg", [{ className: "DocumentAttributeAudio", voice: true }]))).toEqual({ label: "(sent a voice message)" });
    expect(describeTelegramMedia(file("application/pdf", [{ className: "DocumentAttributeFilename", fileName: "plan.pdf" }]))).toEqual({ label: "(sent a file)" });
    expect(describeTelegramMedia({ className: "MessageMediaGeo" })).toEqual({ label: "(sent a location)" });
    expect([describeTelegramMedia(undefined), describeTelegramMedia({ className: "MessageMediaWebPage" })]).toEqual([null, null]);
  });

  it("fetches a picture sent as a file, unless it is very large", () => {
    const named = [{ className: "DocumentAttributeFilename", fileName: "floorplan.png" }, { className: "DocumentAttributeImageSize", w: 2000, h: 1000 }];
    expect(describeTelegramMedia(file("image/png", named))).toEqual({ label: "(sent a picture)", media: { kind: "image", name: "floorplan.png", w: 2000, h: 1000 }, fetch: "" });
    expect(describeTelegramMedia(file("image/png", named, { size: 9_000_000 }))).toEqual({ label: "(sent a file)" });
  });

  it("reads the reactions, marks the owner's own, and names a custom emoji it has no picture for", () => {
    expect(telegramReactions({ results: [
      { count: 2, chosenOrder: 0, reaction: { className: "ReactionEmoji", emoticon: "👍" } },
      { count: 1, reaction: { className: "ReactionEmoji", emoticon: "🔥" } },
      { count: 3, reaction: { className: "ReactionCustomEmoji" } },
    ] })).toEqual([{ emoji: "👍", count: 2, mine: true }, { emoji: "🔥", count: 1 }, { emoji: ":custom:", count: 3 }]);
    expect([telegramReactions(undefined), telegramReactions({})]).toEqual([[], []]);
  });
});

describe("pictures, stickers and reactions from Telegram", () => {
  const picture = (url: string) => pictureResponse(db, OWNER_ID, new URLSearchParams(url.split("?")[1]));
  const thread = async (id: string) => (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === id)!.thread;
  const withPictures = (): FakeTelegram => {
    const telegram = fakeTelegram([
      {
        id: "501", name: "Dana Whitfield", kind: "direct", topId: 4,
        messages: [
          said(1, "Here is the venue", { media: { kind: "image", name: "Photo", w: 800, h: 600 } }),
          said(2, "(sent a sticker 😀)", { media: { kind: "sticker", name: "Sticker 😀", w: 512, h: 512 } }),
          said(3, "(sent a video)"),
          said(4, "Does that work?", { reactions: [{ emoji: "👍", count: 1, mine: true }] }),
        ],
      },
    ]);
    telegram.files = { "501:1": TINY.jpg, "501:2": TINY.webp };
    telegram.faces = { "501": TINY.jpg };
    return telegram;
  };

  it("keeps the pictures and stickers, and never fetches a video", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    expect(telegram.fetched.filter((f) => !f.startsWith("face:")).sort()).toEqual(["501:1", "501:2"]);
    expect(await db.query("select key, mime from media order by key")).toEqual([{ key: "telegram/501/1", mime: "image/jpeg" }, { key: "telegram/501/2", mime: "image/webp" }, { key: "telegram/avatar/501", mime: "image/jpeg" }]);

    const [venue, sticker, video, question] = await thread("telegram:501");
    expect(venue.attachments).toEqual([{ kind: "image", name: "Photo", w: 800, h: 600, src: "/api/media?m=telegram%3A501%3A1&n=0" }]);
    expect(sticker.attachments).toEqual([{ kind: "sticker", name: "Sticker 😀", w: 512, h: 512, src: "/api/media?m=telegram%3A501%3A2&n=0" }]);
    expect([video.text, video.attachments]).toEqual(["(sent a video)", undefined]);
    expect(question.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);

    const served = await picture(venue.attachments![0].src);
    expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    expect(Buffer.from(await served.arrayBuffer()).equals(TINY.jpg)).toBe(true);
    expect((await picture(sticker.attachments![0].src)).headers.get("content-type")).toBe("image/webp");
  });

  it("keeps nothing that turns out not to be a picture, and shows the message without one", async () => {
    const telegram = withPictures();
    telegram.files["501:1"] = Buffer.from("this is an animation file, not a picture at all");
    delete telegram.files["501:2"];
    await telegramPull(ctx(), telegram);
    expect((await thread("telegram:501")).map((m) => m.attachments)).toEqual([undefined, undefined, undefined, undefined]);
    expect(await db.query("select key from media where key like 'telegram/501/%'")).toEqual([]);
  });

  it("shows the other person's profile picture on the row and beside their messages", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    const chat = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:501")!;
    expect(chat.avatar).toBe("/api/media?avatar=501");
    expect(chat.thread.map((m) => m.avatar)).toEqual(Array(4).fill("/api/media?avatar=501"));
    const served = await picture(chat.avatar!);
    expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
  });

  it("asks once about someone with no profile picture, and shows their initials", async () => {
    const telegram = withPictures();
    telegram.faces = {};
    const first = await telegramPull(ctx(), telegram);
    telegram.chatList[0].messages.push(said(5, "Hello again"));
    telegram.chatList[0].topId = 5;
    await telegramPull(ctx(first.cursor), telegram);
    expect(telegram.fetched.filter((f) => f === "face:501")).toHaveLength(1);
    const chat = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:501")!;
    expect([chat.avatar, chat.thread[0].avatar]).toEqual([undefined, undefined]);
    expect((await picture("/api/media?avatar=501")).status).toBe(404);
  });

  it("in a group, shows each person's own picture, and whoever wrote last on the row", async () => {
    const telegram = fakeTelegram([{ id: "-701", name: "Launch crew", kind: "group", topId: 3, messages: [
      said(1, "Morning", { sender: "Ines Marsh", senderId: "u-ines" }),
      said(2, "On my way", { out: true, senderId: "u-me" }),
      said(3, "Can you confirm the date?", { sender: "Sam Ortiz", senderId: "u-sam", mentioned: true }),
    ] }]);
    telegram.faces = { "u-ines": TINY.jpg, "u-sam": TINY.png };
    await telegramPull(ctx(), telegram);
    const chat = (await loadState(db, OWNER_ID, new Date(NOW))).inbox.find((c) => c.id === "telegram:-701")!;
    expect(chat.thread.map((m) => m.avatar)).toEqual(["/api/media?avatar=u-ines", undefined, "/api/media?avatar=u-sam"]);
    expect(chat.avatar).toBe("/api/media?avatar=u-sam");
    // The owner's own picture is never asked for: their messages show without one.
    expect(telegram.fetched.filter((f) => f.startsWith("face:")).sort()).toEqual(["face:u-ines", "face:u-sam"]);
  });

  it("when a chat is opened, brings in what is new and the reactions as they are now, and no older history", async () => {
    const telegram = withPictures();
    telegram.chatList[0].messages.unshift(said(0, "Something from last month", { at: NOW - 30 * DAY }));
    await telegramPull(ctx(), telegram);
    expect((await thread("telegram:501")).map((m) => m.text)).not.toContain("Something from last month");

    const messages = telegram.chatList[0].messages;
    messages.find((m) => m.id === 1)!.reactions = [{ emoji: "❤️", count: 1 }];
    messages.find((m) => m.id === 4)!.reactions = [];
    messages.push(said(5, "Any update?"));
    telegram.fetched.length = 0;
    expect(await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "telegram:501")).toEqual({ added: 1, changed: 2 });
    const after = await thread("telegram:501");
    expect(after.map((m) => [m.text, m.reactions])).toEqual([["Here is the venue", [{ emoji: "❤️", count: 1 }]], ["(sent a sticker 😀)", undefined], ["(sent a video)", undefined], ["Does that work?", undefined], ["Any update?", undefined]]);
    // Nothing already on this machine is fetched again.
    expect(telegram.fetched).toEqual([]);
    expect(await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "telegram:501")).toEqual({ added: 0, changed: 0 });
    expect(await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "telegram:nope")).toEqual({ added: 0, changed: 0 });
    expect(await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "slack:D1")).toEqual({ added: 0, changed: 0 });
  });

  it("fetches a picture that was missed the next time the chat is opened", async () => {
    const telegram = withPictures();
    delete telegram.files["501:1"];
    await telegramPull(ctx(), telegram);
    expect((await thread("telegram:501"))[0].attachments).toBeUndefined();
    telegram.files["501:1"] = TINY.png;
    expect((await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "telegram:501")).changed).toBe(1);
    expect((await thread("telegram:501"))[0].attachments).toHaveLength(1);
  });

  it("fetches again a picture that an earlier version kept as a file", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    await db.run("update messages set attachments = $1::jsonb where id = 'telegram:501:1'", [JSON.stringify([{ kind: "image", name: "Photo", file: "1.jpg" }])]);
    await db.run("delete from media where key = 'telegram/501/1'");
    telegram.fetched.length = 0;
    await telegramRefresh({ db, ownerId: OWNER_ID, now: NOW }, telegram, "telegram:501");
    expect(telegram.fetched).toEqual(["501:1"]);
    expect((await picture("/api/media?m=telegram%3A501%3A1&n=0")).status).toBe(200);
  });

  it("hands out only its own pictures, by number and id, and nothing once they are removed", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    for (const bad of ["/api/media?avatar=..%2F501%2F1", "/api/media?avatar=..", "/api/media?avatar=501%2F..%2F..%2Fpg", "/api/media?m=telegram%3A501%3A1&n=5", "/api/media?m=telegram%3A501%3A3&n=0", "/api/media?m=telegram%3A501%3A1&n=-1", "/api/media?n=0"]) {
      expect([bad, (await picture(bad)).status >= 400]).toEqual([bad, true]);
    }
    // Whatever a message row says, only a picture kept under its own chat is handed out.
    for (const key of ["telegram/avatar/501", "telegram/502/1", "../telegram/501/2", "telegram/501/../avatar/501"]) {
      await db.run("update messages set attachments = $1::jsonb where id = 'telegram:501:1'", [JSON.stringify([{ kind: "image", name: "x", key }])]);
      expect([key, (await picture("/api/media?m=telegram%3A501%3A1&n=0")).status]).toEqual([key, 404]);
    }

    await forgetTelegramMedia(db, OWNER_ID);
    expect((await picture("/api/media?m=telegram%3A501%3A2&n=0")).status).toBe(404);
    expect((await picture("/api/media?avatar=501")).status).toBe(404);
  });
});
