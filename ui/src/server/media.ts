// Pictures that belong to messages.
//
// Slack keeps its pictures: only their addresses are stored, and the dashboard fetches one
// with the owner's token when it is looked at. Telegram's are different. They can only be
// read through the logged-in account, one download each, so the ones worth showing are kept
// in the database (the `media` table) and served from there. On a developer's machine that
// is the local database, so they never leave it.
//
// A picture the owner pastes into a reply is kept in the same table, under "upload/", from the
// moment it is added until long after it is sent: the reply shows it here.
import crypto from "node:crypto";
import { MOST_PICTURE_BYTES } from "@/core/config";
import type { Db } from "./db";

/** A picture or sticker of a message, as it is stored with the message. */
export interface StoredPicture {
  kind: "image" | "sticker";
  name: string;
  w?: number;
  h?: number;
  /** Slack: a smaller copy for the screen, the full picture, and the message's page in Slack. */
  thumb?: string;
  url?: string;
  link?: string;
  /** Telegram, or a picture the owner added to a reply: where it is kept in the `media` table. */
  key?: string;
}

/** The kinds of picture a browser shows safely. Anything else is neither kept nor served. */
const KINDS: [string, string, (b: Buffer) => boolean][] = [
  ["image/jpeg", "jpg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/png", "png", (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/gif", "gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  ["image/webp", "webp", (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** What a file really is, read from its first bytes. Null for anything that is not a picture. */
export function pictureType(bytes: Buffer): { mime: string; ext: string } | null {
  const found = KINDS.find(([, , is]) => bytes.length > 12 && is(bytes));
  return found ? { mime: found[0], ext: found[1] } : null;
}

/** True for a content type the dashboard is willing to pass on from Slack. */
export const isPictureType = (type: string | null) => KINDS.some(([mime]) => (type ?? "").split(";")[0].trim().toLowerCase() === mime);

// ---------- Telegram's pictures, kept in the database ----------

const AVATAR_DAYS = 7;
/** Chats and people are numbers, sometimes with a minus. Nothing else may be part of a key. */
const ID = /^-?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const telegramPictureKey = (chatId: string, messageId: number) => (ID.test(chatId) && Number.isInteger(messageId) ? `telegram/${chatId}/${messageId}` : null);
const avatarKey = (id: string) => (ID.test(id) ? `telegram/avatar/${id}` : null);

async function put(db: Db, ownerId: string, key: string, mime: string, bytes: Buffer, now: number): Promise<void> {
  await db.run(
    `insert into media (owner_id, key, mime, bytes, saved_at) values ($1, $2, $3, $4, $5)
     on conflict (owner_id, key) do update set mime = excluded.mime, bytes = excluded.bytes, saved_at = excluded.saved_at`,
    [ownerId, key, mime, bytes, now],
  );
}

/** A stored picture by its key. Null when there is none, or when what is stored is not a picture. */
export async function readPicture(db: Db, ownerId: string, key: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const [row] = await db.query<{ mime: string; bytes: Uint8Array }>("select mime, bytes from media where owner_id = $1 and key = $2", [ownerId, key]);
  if (!row?.bytes?.length) return null;
  const bytes = Buffer.from(row.bytes);
  // Checked again on the way out: what goes to the browser is what the bytes are, not what the row says.
  const type = pictureType(bytes);
  return type ? { bytes, mime: type.mime } : null;
}

/** Keeps a picture of a message and returns its key, or null when the bytes are not a picture. */
export async function saveTelegramPicture(db: Db, ownerId: string, chatId: string, messageId: number, bytes: Buffer, now: number): Promise<string | null> {
  const type = pictureType(bytes);
  const key = telegramPictureKey(chatId, messageId);
  if (!type || !key) return null;
  await put(db, ownerId, key, type.mime, bytes, now);
  return key;
}

/** Keeps a profile picture. No bytes means "asked, and there is none": an empty row is kept so nobody is asked about twice. */
export async function saveTelegramAvatar(db: Db, ownerId: string, id: string, bytes: Buffer | null, now: number): Promise<void> {
  const key = avatarKey(id);
  if (!key) return;
  const type = bytes && pictureType(bytes);
  await put(db, ownerId, key, type ? type.mime : "", type ? bytes! : Buffer.alloc(0), now);
}

export async function readTelegramAvatar(db: Db, ownerId: string, id: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const key = avatarKey(id);
  return key ? readPicture(db, ownerId, key) : null;
}

/** Of these people, the ones whose picture has not been asked for lately. People change their pictures, so it is asked again after a week. */
export async function telegramAvatarsDue(db: Db, ownerId: string, ids: string[], now: number): Promise<string[]> {
  const wanted = ids.filter((id) => avatarKey(id));
  if (!wanted.length) return [];
  const fresh = new Set(
    (await db.query<{ key: string }>(
      "select key from media where owner_id = $1 and saved_at > $2 and key in (select jsonb_array_elements_text($3::jsonb))",
      [ownerId, now - AVATAR_DAYS * 86_400_000, JSON.stringify(wanted.map(avatarKey))],
    )).map((r) => r.key),
  );
  return wanted.filter((id) => !fresh.has(avatarKey(id)!));
}

/** The ids of everyone whose profile picture is kept. */
export async function telegramAvatarIds(db: Db, ownerId: string): Promise<Set<string>> {
  const rows = await db.query<{ key: string }>("select key from media where owner_id = $1 and key like 'telegram/avatar/%' and mime <> ''", [ownerId]);
  return new Set(rows.map((r) => r.key.slice("telegram/avatar/".length)));
}

/** Removes every Telegram picture. Used when Telegram is disconnected and its chats are removed. */
export async function forgetTelegramMedia(db: Db, ownerId: string): Promise<void> {
  await db.run("delete from media where owner_id = $1 and key like 'telegram/%'", [ownerId]);
}

// ---------- Pictures the owner adds to a reply ----------

/** A picture added to a reply that was never sent is let go after this long. */
const UNSENT_MS = 24 * 3_600_000;
const UPLOAD = /^upload\/[A-Za-z0-9_-]{16,64}\.(jpg|png|gif|webp)$/;

export const isUploadKey = (key: string | undefined): boolean => typeof key === "string" && UPLOAD.test(key);

/** Keeps a picture the owner pasted or picked for a reply, until it is sent. Null when the bytes are not a picture, or too big. */
export async function saveUpload(db: Db, ownerId: string, bytes: Buffer, now: number): Promise<{ key: string; mime: string } | null> {
  const type = pictureType(bytes);
  if (!type || bytes.length > MOST_PICTURE_BYTES) return null;
  const key = `upload/${crypto.randomBytes(18).toString("base64url")}.${type.ext}`;
  await put(db, ownerId, key, type.mime, bytes, now);
  await forgetUnsentUploads(db, ownerId, now);
  return { key, mime: type.mime };
}

/** Lets go of the pictures added to a reply over a day ago that no message carries: taken out again, or never sent. */
export async function forgetUnsentUploads(db: Db, ownerId: string, now: number): Promise<void> {
  await db.run(
    `delete from media where owner_id = $1 and key like 'upload/%' and saved_at < $2
     and not exists (select 1 from messages m where m.owner_id = $1 and m.attachments @> jsonb_build_array(jsonb_build_object('key', media.key)))`,
    [ownerId, now - UNSENT_MS],
  );
}
