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
import { seal } from "@/server/secrets";
import { createSession, SESSION_COOKIE } from "@/server/session";
import { describeTelegramMedia, TELEGRAM_LOCAL_ONLY, telegramAccount, telegramAvailable, telegramBlocked, telegramReactions, type TelegramMessage } from "@/server/telegram";
import { fakeSlack, fakeTelegram, NOW, reset, seed, testDb, TINY, type FakeTelegram } from "@/server/testing";
import { outboxSend } from "./outbox";
import { runJob, syncAll, type JobContext } from "./runner";
import { telegramPull, telegramRefresh } from "./telegram";

let db: Db;
let folder: string;
const ctx = (cursor: Record<string, unknown> = {}): JobContext => ({ db, ownerId: OWNER_ID, now: NOW, cursor });

const MINUTE = 60_000;
const DAY = 86_400_000;
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

/** As if a person had logged in on this machine: the keys are set and a sealed login is saved. */
function connected() {
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(process.env.TELEGRAM_SESSION_FILE!, JSON.stringify({ v: 1, session: seal("a-login-that-is-never-used"), name: "Dana Whitfield", phone: "+44 •••• 0123", connectedAt: NOW }));
}

beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db.close());
beforeEach(async () => {
  await reset(db);
  // Every test gets an empty folder for the saved login, never the real one.
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "command-center-telegram-"));
  process.env.TELEGRAM_SESSION_FILE = path.join(folder, "telegram-session.json");
  process.env.TELEGRAM_MEDIA_DIR = path.join(folder, "media");
});
afterEach(() => {
  for (const name of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "DATABASE_URL", "SENDING_ENABLED", "LOGIN_EMAIL", "LOGIN_PASSWORD"]) delete process.env[name];
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("where Telegram may be used", () => {
  it("needs its app keys, and is off while the data is in a hosted database", () => {
    expect([telegramAvailable(), telegramBlocked()]).toEqual([false, "Telegram's app keys are not set. Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env.local."]);
    connected();
    expect([telegramAvailable(), telegramBlocked()]).toEqual([true, null]);
    process.env.DATABASE_URL = "postgres://user:secret@db.example.com:5432/postgres";
    expect([telegramAvailable(), telegramBlocked()]).toEqual([false, TELEGRAM_LOCAL_ONLY]);
  });

  it("shows who is connected by name and a masked number, and nothing at all with a hosted database", async () => {
    connected();
    expect(telegramAccount()).toEqual({ label: "Dana Whitfield · +44 •••• 0123", connectedAt: NOW });
    expect((await loadState(db, OWNER_ID, new Date(NOW))).connections.telegram).toEqual({ connected: true, connectedAt: NOW, label: "Dana Whitfield · +44 •••• 0123" });

    process.env.DATABASE_URL = "postgres://user:secret@db.example.com:5432/postgres";
    expect(telegramAccount()).toBeNull();
    const state = await loadState(db, OWNER_ID, new Date(NOW));
    expect([state.telegramAvailable, state.localData, state.connections.telegram]).toEqual([false, false, { connected: false }]);
  });

  it("keeps the login in its file, sealed, and never in the database", async () => {
    connected();
    expect(fs.readFileSync(process.env.TELEGRAM_SESSION_FILE!, "utf8")).not.toContain("a-login-that-is-never-used");
    expect(await db.query("select provider from connections where owner_id = $1", [OWNER_ID])).toEqual([]);
  });

  it("joins the list of apps, sources and checks only where it can be used", () => {
    expect([liveProviders(false), liveProviders(true)]).toEqual([["slack", "fathom"], ["slack", "telegram", "fathom"]]);
    expect([liveSources(false), liveSources(true)]).toEqual([["slack"], ["slack", "telegram"]]);
  });

  it("does not run its check with a hosted database, even with a login saved, and says why", async () => {
    connected();
    process.env.DATABASE_URL = "postgres://user:secret@db.example.com:5432/postgres";
    expect(await runJob(db, "telegram-pull", OWNER_ID, NOW)).toMatchObject({ ok: false, items: 0, message: TELEGRAM_LOCAL_ONLY });
    expect((await syncAll(db)).map((r) => r.jobId)).not.toContain("telegram-pull");
  });

  it("says it is not connected when nobody has logged in", async () => {
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
    expect(await runJob(db, "telegram-pull", OWNER_ID, NOW)).toMatchObject({ ok: false, message: "Telegram is not connected" });
  });
});

describe("the Telegram login request", () => {
  const post = (body: unknown, signedIn = true) => {
    process.env.LOGIN_EMAIL = "jeremy@example.com";
    process.env.LOGIN_PASSWORD = "correct horse battery";
    return telegramRoute(
      new Request("http://127.0.0.1:3000/api/telegram", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:3000", ...(signedIn ? { cookie: `${SESSION_COOKIE}=${createSession("jeremy@example.com")}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  };
  const answer = async (response: Response) => [response.status, ((await response.json()) as { error?: string }).error];

  it("is only for a signed-in person", async () => {
    connected();
    expect(await answer(await post({ step: "start", phone: "+447700900123" }, false))).toEqual([401, "Please sign in."]);
  });

  it("is refused with a hosted database, before anything is sent to Telegram", async () => {
    connected();
    process.env.DATABASE_URL = "postgres://user:secret@db.example.com:5432/postgres";
    expect(await answer(await post({ step: "start", phone: "+447700900123" }))).toEqual([400, TELEGRAM_LOCAL_ONLY]);
    expect(await answer(await post({ step: "disconnect", forget: true }))).toEqual([400, TELEGRAM_LOCAL_ONLY]);
  });

  it("asks for a real phone number, and for the steps in order", async () => {
    connected();
    expect(await answer(await post({ step: "start", phone: "07700 900123" }))).toEqual([400, "Type the number with its country code, for example +44 7700 900123."]);
    expect(await answer(await post({ step: "code", code: "12345" }))).toEqual([400, "That login has timed out. Start again with your phone number."]);
    expect(await answer(await post({ step: "password", password: "x" }))).toEqual([400, "That login has timed out. Start again with your phone number."]);
    expect(await answer(await post({ step: "anything else" }))).toEqual([400, "Unknown step."]);
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

  it("saves the pictures and stickers on this machine, and never fetches a video", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    expect(telegram.fetched.filter((f) => !f.startsWith("face:")).sort()).toEqual(["501:1", "501:2"]);
    expect(fs.readdirSync(path.join(folder, "media", "501")).sort()).toEqual(["1.jpg", "2.webp"]);

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
    expect(fs.existsSync(path.join(folder, "media", "501"))).toBe(false);
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

  it("hands out only its own files, by number and id, and nothing once they are removed", async () => {
    const telegram = withPictures();
    await telegramPull(ctx(), telegram);
    for (const bad of ["/api/media?avatar=..%2F501%2F1", "/api/media?avatar=..", "/api/media?avatar=501%2F..%2F..%2Fpg", "/api/media?m=telegram%3A501%3A1&n=5", "/api/media?m=telegram%3A501%3A3&n=0", "/api/media?m=telegram%3A501%3A1&n=-1", "/api/media?n=0"]) {
      expect([bad, (await picture(bad)).status >= 400]).toEqual([bad, true]);
    }
    // A file name stored with a message can never point outside the chat's own folder.
    await db.run("update messages set attachments = $1::jsonb where id = 'telegram:501:1'", [JSON.stringify([{ kind: "image", name: "x", file: "../avatars/501.jpg" }])]);
    expect((await picture("/api/media?m=telegram%3A501%3A1&n=0")).status).toBe(404);

    forgetTelegramMedia();
    expect((await picture("/api/media?m=telegram%3A501%3A2&n=0")).status).toBe(404);
    expect((await picture("/api/media?avatar=501")).status).toBe(404);
  });
});
