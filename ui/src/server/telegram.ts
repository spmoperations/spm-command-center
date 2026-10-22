// Telegram, through a person's own account (not a bot), so the dashboard sees their chats
// and replies as them.
//
// The login is kept the way the Slack token is: encrypted, in the `connections` table of the
// database the app is using. On a developer's machine that is the local database, so a
// developer's own account never leaves their machine. With the hosted database Telegram
// stays off unless TELEGRAM_HOSTED=true says this server is the one meant to hold someone's
// Telegram: the live site sets it, a developer's machine does not.
import fs from "node:fs";
import path from "node:path";
import { maskPhone } from "@/core/providers";
import type { Reaction } from "@/core/types";
import type { Db } from "./db";
import { hostedProblem, keysById, keysForNew, offHere, settingsKeys, settingsProblem, type TelegramKeys } from "./app-keys";
import { seal, unseal } from "./secrets";
import { RateLimited } from "./slack";

export const TELEGRAM_OFF_HERE = offHere("telegram");

/**
 * Why this person cannot connect Telegram here, in words for them, or null when they can:
 * Telegram may not be used on this server, or there are no app keys anywhere (their own, the
 * team's, or the server's settings). See app-keys.ts.
 */
export async function telegramBlocked(db: Db, ownerId: string): Promise<string | null> {
  const hosted = hostedProblem("telegram");
  if (hosted) return hosted;
  if (await keysForNew(db, ownerId, "telegram")) return null;
  return `Telegram's app keys are not in place yet. Save an api_id and api_hash from my.telegram.org on the Connections page, under Telegram, App keys. ${settingsProblem("telegram") ?? ""}`.trim();
}

/** This person can connect Telegram here. */
export const telegramAvailable = async (db: Db, ownerId: string) => (await telegramBlocked(db, ownerId)) === null;

/** The app keys in the server's settings look right. */
export const telegramConfigured = () => settingsKeys("telegram") !== null;

/** Telegram may be used on this server at all. Each login has the keys it was made with. */
const mayUseTelegram = () => hostedProblem("telegram") === null;

/** Something already put in words for the person. It is shown as it is. */
class Said extends Error {}

function mustBeAvailable(): void {
  const hosted = hostedProblem("telegram");
  if (hosted) throw new Said(hosted);
}

// ---------- The saved login ----------

/** The saved login, decrypted, and the keys it was made with. Null when Telegram is not connected, or may not be used here. */
async function savedSession(db: Db, ownerId: string): Promise<{ session: string; keyId: string | null } | null> {
  if (!mayUseTelegram()) return null;
  const [row] = await db.query<{ secret: string; app_key_id: string | null }>("select secret, app_key_id from connections where owner_id = $1 and provider = 'telegram'", [ownerId]);
  return row ? { session: unseal(row.secret), keyId: row.app_key_id } : null;
}

/** True when someone has logged in to Telegram here. */
export async function telegramConnected(db: Db, ownerId: string): Promise<boolean> {
  if (!mayUseTelegram()) return false;
  const [row] = await db.query<{ provider: string }>("select provider from connections where owner_id = $1 and provider = 'telegram'", [ownerId]);
  return Boolean(row);
}

/** Keeps the login, encrypted, and answers with how the account is shown: a name and a number mostly hidden. */
async function saveSession(db: Db, ownerId: string, session: string, name: string, phone: string, keyId: string | null): Promise<string> {
  const label = [name, maskPhone(phone.startsWith("+") ? phone : `+${phone}`)].filter(Boolean).join(" · ") || "Connected";
  await db.run(
    `insert into connections (owner_id, provider, secret, label, connected_at, app_key_id) values ($1, 'telegram', $2, $3, $4, $5)
     on conflict (owner_id, provider) do update set secret = excluded.secret, label = excluded.label, connected_at = excluded.connected_at, app_key_id = excluded.app_key_id`,
    [ownerId, seal(session), label, Date.now(), keyId],
  );
  return label;
}

const forgetSession = (db: Db, ownerId: string) => db.run("delete from connections where owner_id = $1 and provider = 'telegram'", [ownerId]);

/**
 * An earlier version kept the login in a file beside the local database. On a developer's
 * machine it is moved into that database once, and the file is removed. Never with a hosted
 * database: a login made on someone's own machine stays there.
 */
export async function adoptTelegramFile(db: Db, ownerId: string): Promise<boolean> {
  if (process.env.DATABASE_URL || !telegramConfigured()) return false;
  const file = process.env.TELEGRAM_SESSION_FILE ?? path.join(process.cwd(), ".data", "telegram-session.json");
  let saved: { v?: number; session?: string; name?: string; phone?: string; connectedAt?: number };
  try {
    saved = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  } catch {
    return false;
  }
  if (saved.v !== 1 || !saved.session) return false;
  // It was sealed with this machine's key already, so it goes in as it is.
  await db.run("insert into connections (owner_id, provider, secret, label, connected_at) values ($1, 'telegram', $2, $3, $4) on conflict (owner_id, provider) do nothing", [
    ownerId,
    saved.session,
    [saved.name, saved.phone].filter(Boolean).join(" · ") || "Connected",
    saved.connectedAt ?? Date.now(),
  ]);
  fs.rmSync(/* turbopackIgnore: true */ file, { force: true });
  return true;
}

// ---------- Talking to Telegram ----------

type Library = typeof import("teleproto");
type Client = InstanceType<Library["TelegramClient"]>;

interface Named { firstName?: string; lastName?: string; title?: string; username?: string }
const nameOf = (entity: unknown): string => {
  const e = (entity ?? {}) as Named;
  return [e.firstName, e.lastName].filter(Boolean).join(" ") || e.title || e.username || "Someone";
};

/** The library is loaded only when Telegram is used, so nothing else pays for it. `keys` are the app keys the login is made with. */
async function newClient(session: string, keys: TelegramKeys): Promise<{ client: Client; lib: Library }> {
  mustBeAvailable();
  const lib = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const client = new lib.TelegramClient(new StringSession(session), keys.apiId, keys.apiHash, {
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

const codeOf = (error: unknown): string => {
  const e = error as { errorMessage?: string; message?: string };
  return e?.errorMessage ?? e?.message ?? "";
};

/** Telegram's error codes, in words a person can act on. */
function explain(error: unknown): string {
  if (error instanceof Said) return error.message;
  const code = codeOf(error);
  const seconds = (error as { seconds?: number })?.seconds;
  if (typeof seconds === "number") {
    const minutes = Math.ceil(seconds / 60);
    return `Telegram asks you to wait ${minutes > 90 ? `${Math.ceil(minutes / 60)} hours` : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`} before trying again.`;
  }
  if (/PHONE_NUMBER_INVALID/.test(code)) return "Telegram does not know that phone number. Check the country code.";
  if (/PHONE_NUMBER_BANNED/.test(code)) return "Telegram has blocked that phone number.";
  if (/PHONE_CODE_EXPIRED/.test(code)) return "That code has expired. Start again to get a new one.";
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY|EMAIL_CODE_INVALID|CODE_INVALID/.test(code)) return "That code is not right. Check it and try again.";
  if (/PASSWORD_HASH_INVALID/.test(code)) return "That password is not right. Try again.";
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code)) return "Telegram did not accept the app keys. Check the api_id and api_hash against the app on my.telegram.org.";
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|AUTH_KEY_DUPLICATED|USER_DEACTIVATED/.test(code)) return "Telegram has signed this connection out. Connect again.";
  if (/AUTH_USER_CANCEL|LOGIN_CANCELLED/.test(code)) return "The Telegram login was cancelled.";
  if (/No account is registered/.test(code)) return "There is no Telegram account with that phone number.";
  if (/requires a login email/.test(code)) return "Telegram wants a login email on this account first. Add one in the Telegram app under Settings, Privacy and Security, then try again.";
  return code ? `Telegram answered: ${code}` : "Telegram could not be reached.";
}

// ---------- Logging in, one step per request ----------
//
// Each step is a request of its own, and on a host two requests may land on two different
// servers. So nothing about a login in progress is kept in memory. What the next step needs
// (the connection's keys, the phone number and the id Telegram gave the code) goes back to
// the browser sealed, in a cookie only this server can read, and comes in again with the
// next step.

/** What the login needs next, or that it is done. */
export type TelegramStep =
  // `email` is set when Telegram sent the code to the account's email instead: its address, mostly hidden.
  | { need: "code"; viaApp: boolean; email?: string; error?: string }
  | { need: "password"; hint?: string; error?: string }
  | { connected: true; label: string };

/** One step's answer. `pending` is what the next step needs, sealed. Null when the login is over. */
export interface LoginTurn { step: TelegramStep; pending: string | null }

type CodeRoute = "app" | "sms" | "email";

/** The part of Telegram a login uses. The tests swap in a fake. */
export interface TelegramDoor {
  /** Asks Telegram to send a login code to that number. */
  sendCode(phone: string): Promise<{ hash: string; via: CodeRoute; email?: string }>;
  /** Hands in the code. "password" when the account wants its password as well. */
  signIn(phone: string, hash: string, code: string, via: CodeRoute): Promise<"done" | "password">;
  passwordHint(): Promise<string | undefined>;
  checkPassword(password: string): Promise<void>;
  me(): Promise<{ name: string; phone: string }>;
  /** The connection's keys: carried into the next step, and kept once the login is done. */
  session(): string;
  close(): Promise<void>;
}
export type OpenDoor = (session: string, keys: TelegramKeys) => Promise<TelegramDoor>;

async function openDoor(session: string, keys: TelegramKeys): Promise<TelegramDoor> {
  const { client, lib } = await newClient(session, keys);
  await client.connect();
  return {
    async sendCode(phone) {
      const sent = (await client.sendCode(keys, phone)) as { phoneCodeHash?: string; isCodeViaApp?: boolean; emailRequired?: boolean; emailCodeSent?: boolean; emailOptions?: { emailPattern?: string } };
      if (sent.emailRequired) throw new Error("Telegram requires a login email for this account");
      if (typeof sent.phoneCodeHash !== "string") throw new Said("Telegram did not send a code. Try again in a minute.");
      return { hash: sent.phoneCodeHash, via: sent.emailCodeSent ? "email" : sent.isCodeViaApp ? "app" : "sms", email: sent.emailOptions?.emailPattern };
    },
    async signIn(phone, hash, code, via) {
      try {
        const how = via === "email" ? { emailVerification: new lib.Api.EmailVerificationCode({ code }) } : { phoneCode: code };
        const result = await client.invoke(new lib.Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, ...how }));
        if (!(result instanceof lib.Api.auth.Authorization)) throw new Error("No account is registered with this phone number");
        return "done";
      } catch (error) {
        if (codeOf(error) === "SESSION_PASSWORD_NEEDED") return "password";
        throw error;
      }
    },
    passwordHint: async () => (await client.invoke(new lib.Api.account.GetPassword())).hint || undefined,
    async checkPassword(password) {
      // The library reports a wrong password through `onError`, then gives up with a general error.
      let failure: unknown;
      try {
        await client.signInWithPassword(keys, {
          password: async () => password,
          onError: async (error) => {
            failure = error;
            return true;
          },
        });
      } catch (error) {
        throw failure ?? error;
      }
    },
    async me() {
      const me = await client.getMe();
      return { name: nameOf(me), phone: (me as { phone?: string }).phone ?? "" };
    },
    session: () => String(client.session.save()),
    close: () => hangUp(client),
  };
}

/** A login that has been started and not finished. */
interface Pending { v: 1; session: string; phone: string; hash: string; via: CodeRoute; email?: string; hint?: string; wantsPassword?: boolean; at: number; keyId?: string | null }

const LOGIN_MINUTES = 10;
const TIMED_OUT = "That login has timed out. Start again with your phone number.";

function readPending(token: string | null | undefined): Pending {
  try {
    const pending = JSON.parse(unseal(token ?? "")) as Pending;
    if (pending.v === 1 && Date.now() - pending.at < LOGIN_MINUTES * 60_000) return pending;
  } catch {
    // Not ours, changed, or cut short.
  }
  throw new Said(TIMED_OUT);
}

/** Throws, in plain words, when there is no login in progress to continue. */
export const mustHaveLoginInProgress = (token: string | null | undefined): void => void readPending(token);

const codeStep = (p: Pick<Pending, "via" | "email">, error?: string): TelegramStep => ({ need: "code", viaApp: p.via === "app", email: p.via === "email" ? p.email || "your email" : undefined, error });

async function finish(db: Db, ownerId: string, door: TelegramDoor, phone: string, keyId: string | null): Promise<LoginTurn> {
  const me = await door.me();
  return { step: { connected: true, label: await saveSession(db, ownerId, door.session(), me.name, me.phone || phone, keyId) }, pending: null };
}

/** Runs one step against Telegram, and puts whatever goes wrong in words. */
async function step<T>(session: string, keys: TelegramKeys, open: OpenDoor, work: (door: TelegramDoor) => Promise<T>): Promise<T> {
  mustBeAvailable();
  let door: TelegramDoor | undefined;
  try {
    door = await open(session, keys);
    return await work(door);
  } catch (error) {
    throw new Said(explain(error));
  } finally {
    await door?.close();
  }
}

/** Step 1: asks Telegram to send a login code to that number. */
export async function startTelegramLogin(db: Db, ownerId: string, phone: string, open: OpenDoor = openDoor): Promise<LoginTurn> {
  const blocked = await telegramBlocked(db, ownerId);
  if (blocked) throw new Said(blocked);
  // The keys this login is made with: the person's own, else the team's. The login keeps them.
  const keys = (await keysForNew(db, ownerId, "telegram"))!;
  return step("", keys.keys, open, async (door) => {
    const sent = await door.sendCode(phone);
    const pending: Pending = { v: 1, session: door.session(), phone, hash: sent.hash, via: sent.via, email: sent.email, at: Date.now(), keyId: keys.id };
    return { step: codeStep(pending), pending: seal(JSON.stringify(pending)) };
  });
}

/** Step 2: the code Telegram sent. Answers with a password request, or connected. */
export async function giveTelegramCode(db: Db, ownerId: string, token: string | null | undefined, code: string, open: OpenDoor = openDoor): Promise<LoginTurn> {
  const pending = readPending(token);
  if (pending.wantsPassword) throw new Said("Telegram is waiting for your password, not a code.");
  const keys = await keysById(db, ownerId, "telegram", pending.keyId);
  if (!keys) throw new Said(TIMED_OUT);
  return step(pending.session, keys.keys, open, async (door) => {
    let outcome: "done" | "password";
    try {
      outcome = await door.signIn(pending.phone, pending.hash, code.trim(), pending.via);
    } catch (error) {
      // A wrong code is asked for again. Anything else ends the login.
      if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY|EMAIL_CODE_INVALID|CODE_INVALID/.test(codeOf(error))) return { step: codeStep(pending, explain(error)), pending: token! };
      throw error;
    }
    if (outcome === "done") return finish(db, ownerId, door, pending.phone, keys.id);
    const hint = await door.passwordHint().catch(() => undefined);
    const next: Pending = { ...pending, session: door.session(), hint, wantsPassword: true, at: Date.now() };
    return { step: { need: "password", hint }, pending: seal(JSON.stringify(next)) };
  });
}

/** Step 3, only for accounts with two-step verification: the Telegram password. It is used once and never kept. */
export async function giveTelegramPassword(db: Db, ownerId: string, token: string | null | undefined, password: string, open: OpenDoor = openDoor): Promise<LoginTurn> {
  const pending = readPending(token);
  if (!pending.wantsPassword) throw new Said("Telegram has not asked for a password.");
  const keys = await keysById(db, ownerId, "telegram", pending.keyId);
  if (!keys) throw new Said(TIMED_OUT);
  return step(pending.session, keys.keys, open, async (door) => {
    try {
      await door.checkPassword(password);
    } catch (error) {
      if (/PASSWORD_HASH_INVALID/.test(codeOf(error))) return { step: { need: "password", hint: pending.hint, error: explain(error) }, pending: token! };
      throw error;
    }
    return finish(db, ownerId, door, pending.phone, keys.id);
  });
}

/** Signs the session out on Telegram's side too, then removes the saved login. */
export async function disconnectTelegram(db: Db, ownerId: string): Promise<void> {
  const saved = await savedSession(db, ownerId);
  const keys = saved && (await keysById(db, ownerId, "telegram", saved.keyId));
  if (saved && keys) {
    try {
      const { client, lib } = await newClient(saved.session, keys.keys);
      await client.connect();
      await client.invoke(new lib.Api.auth.LogOut());
      await hangUp(client);
    } catch {
      // Telegram unreachable or the session already ended: removing the saved login is what matters.
    }
  }
  await forgetSession(db, ownerId);
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
  /** When the newest message was written, epoch milliseconds. */
  at?: number;
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
export async function telegramApi(db: Db, ownerId: string): Promise<TelegramApi> {
  const saved = await savedSession(db, ownerId);
  if (!saved) {
    mustBeAvailable();
    throw new Error("Telegram is not connected.");
  }
  // The keys this login was made with, even if newer ones have been saved since. Without them
  // nothing is asked of Telegram, and the login stays as it is.
  const keys = await keysById(db, ownerId, "telegram", saved.keyId);
  if (!keys) throw new Error("The app keys this Telegram login was made with are not here any more. Nothing was changed; put the same keys back to go on reading it.");
  const { client } = await newClient(saved.session, keys.keys);
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
    await forgetSession(db, ownerId);
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
        return { id: String(d.id), name: d.title ?? d.name ?? nameOf(d.entity), kind, topId: d.message?.id ?? 0, at: d.date ? d.date * 1000 : undefined };
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
