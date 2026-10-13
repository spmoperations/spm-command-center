// Telegram, through a person's own account (not a bot), so the dashboard sees their chats
// and replies as them.
//
// LOCAL ONLY FOR NOW. Telegram runs only while the app keeps its data on this machine, that
// is, while DATABASE_URL is not set. With a hosted database (Supabase) every function here
// refuses, so a person's Telegram login and chats can never end up there. The login itself
// (the session) is not kept in any database at all: it is encrypted and saved in a file in
// `.data`, which git ignores.
import fs from "node:fs";
import path from "node:path";
import { maskPhone } from "@/core/providers";
import type { Reaction } from "@/core/types";
import { seal, unseal } from "./secrets";
import { RateLimited } from "./slack";

/** The app keys from my.telegram.org are in the environment. */
export const telegramConfigured = () => Boolean(Number(process.env.TELEGRAM_API_ID) && process.env.TELEGRAM_API_HASH);

/** Telegram can be used: its keys are set, and the data stays on this machine. */
export const telegramAvailable = () => telegramConfigured() && !process.env.DATABASE_URL;

export const TELEGRAM_LOCAL_ONLY =
  "Telegram is local-only for now, so it stays off while the app uses the hosted database. Start the app with: npm run dev:local";

/** Why Telegram cannot be used here, in words for the person, or null when it can. */
export const telegramBlocked = (): string | null =>
  !telegramConfigured() ? "Telegram's app keys are not set. Add TELEGRAM_API_ID and TELEGRAM_API_HASH to .env.local." : process.env.DATABASE_URL ? TELEGRAM_LOCAL_ONLY : null;

function mustBeAvailable(): void {
  const blocked = telegramBlocked();
  if (blocked) throw new Error(blocked);
}

// ---------- The saved login ----------

interface Saved { v: 1; session: string; name: string; phone: string; connectedAt: number }

// Next to the local database, in the folder git ignores. The tests point it somewhere else.
// The "turbopackIgnore" notes below tell the build this file is made at run time, on this
// machine, and is not something to pack with the server.
const sessionFile = () => process.env.TELEGRAM_SESSION_FILE ?? path.join(process.cwd(), ".data", "telegram-session.json");

function readSaved(): Saved | null {
  if (!telegramAvailable()) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ sessionFile(), "utf8")) as Saved;
    return saved.v === 1 && saved.session ? saved : null;
  } catch {
    return null;
  }
}

/** Who is connected, for showing on screen. Never the session itself. */
export function telegramAccount(): { label: string; connectedAt: number } | null {
  const saved = readSaved();
  return saved ? { label: [saved.name, saved.phone].filter(Boolean).join(" · "), connectedAt: saved.connectedAt } : null;
}

function save(session: string, name: string, phone: string): void {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(sessionFile()), { recursive: true });
  const saved: Saved = { v: 1, session: seal(session), name, phone: maskPhone(phone.startsWith("+") ? phone : `+${phone}`), connectedAt: Date.now() };
  fs.writeFileSync(/* turbopackIgnore: true */ sessionFile(), JSON.stringify(saved), { mode: 0o600 });
}

const forget = () => fs.rmSync(/* turbopackIgnore: true */ sessionFile(), { force: true });

// ---------- Talking to Telegram ----------

type Library = typeof import("teleproto");
type Client = InstanceType<Library["TelegramClient"]>;

interface Named { firstName?: string; lastName?: string; title?: string; username?: string }
const nameOf = (entity: unknown): string => {
  const e = (entity ?? {}) as Named;
  return [e.firstName, e.lastName].filter(Boolean).join(" ") || e.title || e.username || "Someone";
};

/** The library is loaded only when Telegram is used, so nothing else pays for it. */
async function newClient(session: string): Promise<{ client: Client; lib: Library }> {
  mustBeAvailable();
  const lib = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const client = new lib.TelegramClient(new StringSession(session), Number(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH!, {
    connectionRetries: 3,
    deviceModel: "SPM Command Center",
    appVersion: "1.0",
  });
  client.setLogLevel("none" as Parameters<Client["setLogLevel"]>[0]);
  return { client, lib };
}

async function hangUp(client: Client): Promise<void> {
  try {
    await client.disconnect();
    await client.destroy();
  } catch {
    // Already gone.
  }
}

/** Telegram's error codes, in words a person can act on. */
function explain(error: unknown): string {
  const e = error as { errorMessage?: string; seconds?: number; message?: string };
  const code = e?.errorMessage ?? e?.message ?? "";
  if (typeof e?.seconds === "number") {
    const minutes = Math.ceil(e.seconds / 60);
    return `Telegram asks you to wait ${minutes > 90 ? `${Math.ceil(minutes / 60)} hours` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`} before trying again.`;
  }
  if (/PHONE_NUMBER_INVALID/.test(code)) return "Telegram does not know that phone number. Check the country code.";
  if (/PHONE_NUMBER_BANNED/.test(code)) return "Telegram has blocked that phone number.";
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(code)) return "That code is not right. Check it and try again.";
  if (/PHONE_CODE_EXPIRED/.test(code)) return "That code has expired. Start again to get a new one.";
  if (/PASSWORD_HASH_INVALID/.test(code)) return "That password is not right. Try again.";
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code)) return "Telegram did not accept the app keys in .env.local. Check TELEGRAM_API_ID and TELEGRAM_API_HASH.";
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED/.test(code)) return "Telegram has signed this connection out. Connect again.";
  if (/AUTH_USER_CANCEL|LOGIN_CANCELLED/.test(code)) return "The Telegram login was cancelled.";
  if (/EMAIL_CODE_INVALID|CODE_INVALID/.test(code)) return "That code is not right. Check it and try again.";
  if (/No account is registered/.test(code)) return "There is no Telegram account with that phone number.";
  if (/requires a login email/.test(code)) return "Telegram wants a login email on this account first. Add one in the Telegram app under Settings, Privacy and Security, then try again.";
  return code ? `Telegram answered: ${code}` : "Telegram could not be reached.";
}

// ---------- Logging in, one step per request ----------

/** What the login needs next, or that it is done. */
export type TelegramStep =
  // `email` is set when Telegram sent the code to the account's email instead: its address, mostly hidden.
  | { need: "code"; viaApp: boolean; email?: string; error?: string }
  | { need: "password"; hint?: string; error?: string }
  | { connected: true; label: string };

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A step nobody is waiting on any more must not crash the server.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** One login in progress. Telegram's library asks for the code and the password through callbacks; each request answers one. */
interface Login {
  client: Client;
  next: Deferred<TelegramStep>;
  code?: Deferred<string>;
  password?: Deferred<string>;
  lastError?: string;
  timer: ReturnType<typeof setTimeout>;
}

const LOGIN_MINUTES = 10;
// Kept across hot reloads in development, like the database handle.
const holder = globalThis as unknown as { __telegramLogin?: Login };

class Cancelled extends Error {}

/** Abandons a login that is under way. */
export async function cancelTelegramLogin(): Promise<void> {
  const login = holder.__telegramLogin;
  if (!login) return;
  holder.__telegramLogin = undefined;
  clearTimeout(login.timer);
  const stop = new Cancelled("LOGIN_CANCELLED");
  login.code?.reject(stop);
  login.password?.reject(stop);
  login.next.reject(stop);
  await hangUp(login.client);
}

/** Step 1: asks Telegram to send a login code to that number. */
export async function startTelegramLogin(phone: string): Promise<TelegramStep> {
  await cancelTelegramLogin();
  const { client } = await newClient("");
  const login: Login = {
    client,
    next: deferred<TelegramStep>(),
    timer: setTimeout(() => void cancelTelegramLogin(), LOGIN_MINUTES * 60_000),
  };
  holder.__telegramLogin = login;

  // Runs in the background: it pauses inside the callbacks until the next request arrives.
  void client
    .start({
      phoneNumber: phone,
      phoneCode: async (viaApp) => {
        login.code = deferred<string>();
        login.next.resolve({ need: "code", viaApp: viaApp !== false, error: login.lastError });
        login.lastError = undefined;
        return login.code.promise;
      },
      // Some accounts get the code by email instead of inside Telegram. It is the same step.
      emailVerification: async (info) => {
        login.code = deferred<string>();
        login.next.resolve({ need: "code", viaApp: false, email: info.emailPattern || "your email", error: login.lastError });
        login.lastError = undefined;
        return { type: "code" as const, code: await login.code.promise };
      },
      password: async (hint) => {
        login.password = deferred<string>();
        login.next.resolve({ need: "password", hint: hint || undefined, error: login.lastError });
        login.lastError = undefined;
        return login.password.promise;
      },
      // A wrong code or password is asked for again; anything else ends the login.
      onError: async (error) => {
        const code = (error as { errorMessage?: string }).errorMessage ?? "";
        if (!(error instanceof Cancelled) && /PHONE_CODE_INVALID|PHONE_CODE_EMPTY|EMAIL_CODE_INVALID|CODE_INVALID|PASSWORD_HASH_INVALID/.test(code)) {
          login.lastError = explain(error);
          return false;
        }
        login.next.reject(new Error(explain(error)));
        return true;
      },
    })
    .then(async () => {
      const me = await client.getMe();
      save(String(client.session.save()), nameOf(me), (me as { phone?: string }).phone ?? phone);
      login.next.resolve({ connected: true, label: telegramAccount()?.label ?? nameOf(me) });
    })
    .catch((error: unknown) => login.next.reject(new Error(explain(error))))
    .finally(async () => {
      if (holder.__telegramLogin === login) holder.__telegramLogin = undefined;
      clearTimeout(login.timer);
      await hangUp(client);
    });

  return login.next.promise;
}

function current(): Login {
  const login = holder.__telegramLogin;
  if (!login) throw new Error("That login has timed out. Start again with your phone number.");
  return login;
}

/** Step 2: the code Telegram sent. Answers with a password request, or connected. */
export async function giveTelegramCode(code: string): Promise<TelegramStep> {
  const login = current();
  if (!login.code) throw new Error("Telegram has not asked for a code yet.");
  const waiting = login.code;
  login.code = undefined;
  login.next = deferred<TelegramStep>();
  waiting.resolve(code.trim());
  return login.next.promise;
}

/** Step 3, only for accounts with two-step verification: the Telegram password. */
export async function giveTelegramPassword(password: string): Promise<TelegramStep> {
  const login = current();
  if (!login.password) throw new Error("Telegram has not asked for a password.");
  const waiting = login.password;
  login.password = undefined;
  login.next = deferred<TelegramStep>();
  waiting.resolve(password);
  return login.next.promise;
}

/** Signs the session out on Telegram's side too, then removes it from this machine. */
export async function disconnectTelegram(): Promise<void> {
  const saved = readSaved();
  if (saved) {
    try {
      const { client, lib } = await newClient(unseal(saved.session));
      await client.connect();
      await client.invoke(new lib.Api.auth.LogOut());
      await hangUp(client);
    } catch {
      // Telegram unreachable or the session already ended: removing the file is what matters.
    }
  }
  forget();
}

// ---------- What the checks use ----------

export interface TelegramChat {
  /** Telegram's id for the chat, as text. */
  id: string;
  name: string;
  /** "direct" is one person; "self" is Saved Messages; "service" is Telegram's own account, which sends login codes. */
  kind: "direct" | "group" | "channel" | "bot" | "self" | "service";
  /** Id of the newest message in the chat. */
  topId: number;
}

/** A picture or sticker that came with a message. */
export interface TelegramMedia {
  kind: "image" | "sticker";
  name: string;
  w?: number;
  h?: number;
}

export interface TelegramMessage {
  id: number;
  /** Epoch milliseconds. */
  at: number;
  text: string;
  /** Written by the connected account. */
  out: boolean;
  sender: string;
  /** Telegram's id for who wrote it, as text. Empty when Telegram does not say. */
  senderId: string;
  /** Tags or replies to the connected account. */
  mentioned: boolean;
  /** Set when there is a picture or sticker to fetch with `download`. Videos and other files are only named in the text. */
  media?: TelegramMedia;
  reactions: Reaction[];
}

/** The few things the checks do with Telegram. The tests swap in a fake. */
export interface TelegramApi {
  /** The most recently active chats. Call this before `messages` or `send`. */
  chats(limit: number): Promise<TelegramChat[]>;
  /** Messages newer than `afterId`, oldest first. */
  messages(chatId: string, options: { afterId: number; limit: number }): Promise<TelegramMessage[]>;
  send(chatId: string, text: string): Promise<void>;
  /** The picture or sticker of a message read through this connection, at a size for the screen. Null when it cannot be had. */
  download(chatId: string, messageId: number): Promise<Buffer | null>;
  /** The small profile picture of a chat, or of someone whose message was read through this connection. Null when there is none. */
  picture(id: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

/** Telegram's own account. Login codes and "new login" notices arrive from it. */
const TELEGRAM_SERVICE_ID = "777000";

const MEDIA: Record<string, string> = {
  MessageMediaPhoto: "(sent a photo)",
  MessageMediaDocument: "(sent a file)",
  MessageMediaGeo: "(sent a location)",
  MessageMediaGeoLive: "(sent a location)",
  MessageMediaVenue: "(sent a location)",
  MessageMediaContact: "(sent a contact)",
  MessageMediaPoll: "(sent a poll)",
};

// ---------- Pictures, stickers and reactions ----------

/** A picture sent as a file is fetched only up to this size. */
const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
/** Wide enough to look sharp in the conversation. Nothing larger is fetched when this exists. */
const SCREEN_PX = 600;

// Only the parts of Telegram's objects that are read here.
interface RawSize { className: string; type?: string; w?: number; h?: number }
interface RawDocument { className: string; mimeType?: string; size?: unknown; thumbs?: RawSize[]; attributes?: { className: string; alt?: string; w?: number; h?: number; voice?: boolean; fileName?: string }[] }
interface RawMedia { className: string; photo?: { className: string; sizes?: RawSize[] }; document?: RawDocument }
interface RawReactions { results?: { count?: number; chosenOrder?: number; reaction?: { className: string; emoticon?: string } }[] }

/** The size to fetch: the smallest that still looks sharp on screen, or else the largest there is. */
function screenSize(sizes: RawSize[] = []): RawSize | undefined {
  const real = sizes.filter((s) => (s.className === "PhotoSize" || s.className === "PhotoSizeProgressive") && s.type && s.w && s.h).sort((a, b) => Math.max(a.w!, a.h!) - Math.max(b.w!, b.h!));
  return real.find((s) => Math.max(s.w!, s.h!) >= SCREEN_PX) ?? real.at(-1);
}

/**
 * What a message carries besides text: what to call it, and whether there is a picture to
 * fetch. `fetch` is the name of the size to ask for, or "" for the file itself.
 * Videos, moving GIFs, voice notes and documents are named and never fetched.
 */
export function describeTelegramMedia(raw: unknown): { label: string; media?: TelegramMedia; fetch?: string } | null {
  const m = raw as RawMedia | undefined;
  if (!m?.className) return null;
  if (m.className === "MessageMediaPhoto") {
    const size = m.photo?.className === "Photo" ? screenSize(m.photo.sizes) : undefined;
    return size ? { label: "(sent a photo)", media: { kind: "image", name: "Photo", w: size.w, h: size.h }, fetch: size.type } : { label: "(sent a photo)" };
  }
  if (m.className === "MessageMediaDocument" && m.document?.className === "Document") {
    const doc = m.document;
    const part = (name: string) => doc.attributes?.find((a) => a.className === name);
    const sticker = part("DocumentAttributeSticker");
    if (sticker) {
      const which = sticker.alt ? ` ${sticker.alt}` : "";
      const label = `(sent a sticker${which})`;
      // A still sticker is a small picture. A moving one is a video or an animation file, so its still preview is shown.
      if (doc.mimeType === "image/webp") {
        const box = part("DocumentAttributeImageSize");
        return { label, media: { kind: "sticker", name: `Sticker${which}`, w: box?.w, h: box?.h }, fetch: "" };
      }
      const preview = screenSize(doc.thumbs);
      return preview ? { label, media: { kind: "sticker", name: `Sticker${which}`, w: preview.w, h: preview.h }, fetch: preview.type } : { label };
    }
    if (part("DocumentAttributeAnimated")) return { label: "(sent a GIF)" };
    if (part("DocumentAttributeVideo")) return { label: "(sent a video)" };
    const audio = part("DocumentAttributeAudio");
    if (audio) return { label: audio.voice ? "(sent a voice message)" : "(sent an audio file)" };
    if (/^image\/(jpeg|png|webp|gif)$/.test(doc.mimeType ?? "") && Number(String(doc.size ?? 0)) <= MAX_PICTURE_BYTES) {
      const box = part("DocumentAttributeImageSize");
      return { label: "(sent a picture)", media: { kind: "image", name: (part("DocumentAttributeFilename")?.fileName ?? "Picture").slice(0, 120), w: box?.w, h: box?.h }, fetch: "" };
    }
    return { label: "(sent a file)" };
  }
  return MEDIA[m.className] ? { label: MEDIA[m.className] } : null;
}

/** The reactions on a message. One of Telegram's custom emoji has no picture here, so it reads ":custom:". */
export function telegramReactions(raw: unknown): Reaction[] {
  const merged = new Map<string, Reaction>();
  for (const r of (raw as RawReactions | undefined)?.results ?? []) {
    const emoji = r.reaction?.className === "ReactionEmoji" && r.reaction.emoticon ? r.reaction.emoticon : r.reaction?.className === "ReactionPaid" ? "⭐" : ":custom:";
    const entry = merged.get(emoji) ?? { emoji, count: 0 };
    entry.count += r.count ?? 1;
    if (typeof r.chosenOrder === "number") entry.mine = true;
    merged.set(emoji, entry);
  }
  return [...merged.values()];
}

/** Connects with the saved login. Throws a plain sentence when there is none or Telegram has ended it. */
export async function telegramApi(): Promise<TelegramApi> {
  const saved = readSaved();
  if (!saved) {
    mustBeAvailable();
    throw new Error("Telegram is not connected.");
  }
  const { client } = await newClient(unseal(saved.session));
  // "Slow down" from Telegram stops the check until the wait is over, like Slack's.
  const guard = async <T,>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      const seconds = (error as { seconds?: number }).seconds;
      if (typeof seconds === "number") throw new RateLimited("Telegram", seconds);
      throw new Error(explain(error));
    }
  };
  await guard(() => client.connect());
  if (!(await guard(() => client.checkAuthorization()))) {
    await hangUp(client);
    forget();
    throw new Error("Telegram has signed this connection out. Connect again.");
  }

  type Dialog = Awaited<ReturnType<Client["getDialogs"]>>[number];
  type Read = Awaited<ReturnType<Client["getMessages"]>>[number];
  const known = new Map<string, Dialog>();
  // What was read through this connection: a picture can only be fetched from the message it came with.
  const read = new Map<string, { message: Read; fetch: string }>();
  const people = new Map<string, unknown>();
  const asBytes = (got: unknown): Buffer | null => (Buffer.isBuffer(got) && got.length ? got : null);
  const dialog = async (chatId: string): Promise<Dialog> => {
    if (!known.size) for (const d of await guard(() => client.getDialogs({ limit: 100 }))) known.set(String(d.id), d);
    const found = known.get(chatId);
    if (!found) throw new Error("That Telegram chat is no longer in your recent chats.");
    return found;
  };

  return {
    async chats(limit) {
      const dialogs = await guard(() => client.getDialogs({ limit }));
      return dialogs.map((d): TelegramChat => {
        known.set(String(d.id), d);
        if (d.entity) people.set(String(d.id), d.entity);
        const entity = (d.entity ?? {}) as { bot?: boolean; self?: boolean; support?: boolean };
        const service = String(d.id) === TELEGRAM_SERVICE_ID || Boolean(entity.support);
        const kind = d.isUser ? (service ? "service" : entity.self ? "self" : entity.bot ? "bot" : "direct") : d.isGroup ? "group" : "channel";
        return { id: String(d.id), name: d.title ?? d.name ?? nameOf(d.entity), kind, topId: d.message?.id ?? 0 };
      });
    },
    async messages(chatId, { afterId, limit }) {
      const chat = await dialog(chatId);
      const found = await guard(() => client.getMessages(chat.inputEntity, { limit, minId: afterId }));
      return found
        .filter((m) => m.className === "Message")
        .map((m): TelegramMessage => {
          const extra = describeTelegramMedia(m.media);
          if (extra?.media) read.set(`${chatId}:${m.id}`, { message: m, fetch: extra.fetch ?? "" });
          // In a one-to-one chat the other person is the chat itself.
          const senderId = m.senderId != null ? String(m.senderId) : m.out ? "" : chatId;
          if (m.sender && senderId) people.set(senderId, m.sender);
          return {
            id: m.id,
            at: m.date * 1000,
            text: m.message || extra?.label || "(sent something that has no text)",
            out: Boolean(m.out),
            sender: m.sender ? nameOf(m.sender) : (chat.title ?? chat.name ?? "Someone"),
            senderId,
            mentioned: Boolean(m.mentioned),
            media: extra?.media,
            reactions: telegramReactions(m.reactions),
          };
        })
        .sort((a, b) => a.id - b.id);
    },
    async send(chatId, text) {
      const chat = await dialog(chatId);
      await guard(() => client.sendMessage(chat.inputEntity, { message: text }));
    },
    async download(chatId, messageId) {
      const found = read.get(`${chatId}:${messageId}`);
      if (!found) return null;
      // The size is asked for by its name: the library takes that for every kind of size.
      const options = found.fetch ? { thumb: found.fetch as unknown as number } : {};
      return asBytes(await guard(() => client.downloadMedia(found.message, options)));
    },
    async picture(id) {
      const who = people.get(id) ?? (await dialog(id).then((d) => d.entity, () => undefined));
      if (!who) return null;
      return asBytes(await guard(() => client.downloadProfilePhoto(who as Parameters<Client["downloadProfilePhoto"]>[0], { isBig: false })));
    },
    close: () => hangUp(client),
  };
}
