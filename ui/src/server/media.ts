// Pictures that belong to messages.
//
// Slack keeps its pictures: only their addresses are stored, and the dashboard fetches one
// with the owner's token when it is looked at. Telegram's are different. They can only be
// read through the logged-in account, so the ones worth showing are saved in a folder beside
// the local database (`.data/telegram-media`, which git ignores) and served from there.
// Telegram is local-only, so that folder exists only on the machine the app runs on.
import fs from "node:fs";
import path from "node:path";

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
  /** Telegram: the file's name inside its chat's folder on this machine. */
  file?: string;
}

export interface StoredReaction { emoji: string; count: number; mine?: boolean }

/** The kinds of picture a browser shows safely. Anything else is not served. */
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

// ---------- Telegram's folder on this machine ----------

// The "turbopackIgnore" notes tell the build these files are made at run time, on this
// machine, and are not something to pack with the server.
const mediaDir = () => process.env.TELEGRAM_MEDIA_DIR ?? path.join(process.cwd(), ".data", "telegram-media");
/** Folder and file names are ids and numbers. Anything else is refused, so a name can never point outside the folder. */
const SAFE = /^-?[A-Za-z0-9][A-Za-z0-9_-]*(\.[a-z0-9]{1,5})?$/;
const AVATARS = "avatars";
const AVATAR_DAYS = 7;

function place(folder: string, name: string): string | null {
  return SAFE.test(folder) && SAFE.test(name) ? path.join(/* turbopackIgnore: true */ mediaDir(), folder, name) : null;
}

/** Saves a picture of a message and returns the file's name, or null when the bytes are not a picture. */
export function saveTelegramPicture(chatId: string, messageId: number, bytes: Buffer): string | null {
  const type = pictureType(bytes);
  const name = `${messageId}.${type?.ext ?? ""}`;
  const file = type && place(chatId, name);
  if (!file) return null;
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ file, bytes, { mode: 0o600 });
  return name;
}

export function readTelegramPicture(chatId: string, name: string): Buffer | null {
  const file = place(chatId, name);
  try {
    return file ? fs.readFileSync(/* turbopackIgnore: true */ file) : null;
  } catch {
    return null;
  }
}

const avatarFile = (id: string) => place(AVATARS, `${id}.jpg`);

/** Saves a profile picture. No bytes means "asked, and there is none": an empty file is kept so nobody is asked about twice. */
export function saveTelegramAvatar(id: string, bytes: Buffer | null): void {
  const file = avatarFile(id);
  if (!file) return;
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
  fs.writeFileSync(/* turbopackIgnore: true */ file, bytes && pictureType(bytes) ? bytes : Buffer.alloc(0), { mode: 0o600 });
}

export function readTelegramAvatar(id: string): Buffer | null {
  const file = avatarFile(id);
  try {
    const bytes = file ? fs.readFileSync(/* turbopackIgnore: true */ file) : null;
    return bytes?.length ? bytes : null;
  } catch {
    return null;
  }
}

/** True when this person's picture has not been asked for lately. People change their pictures, so it is asked again after a week. */
export function telegramAvatarIsDue(id: string, now: number): boolean {
  const file = avatarFile(id);
  if (!file) return false;
  try {
    return now - fs.statSync(/* turbopackIgnore: true */ file).mtimeMs > AVATAR_DAYS * 86_400_000;
  } catch {
    return true;
  }
}

/** The ids of everyone whose picture is saved here. */
export function telegramAvatarIds(): Set<string> {
  const ids = new Set<string>();
  try {
    const dir = path.join(/* turbopackIgnore: true */ mediaDir(), AVATARS);
    for (const entry of fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jpg") && fs.statSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dir, entry.name)).size > 0) ids.add(entry.name.slice(0, -4));
    }
  } catch {
    // No folder yet: nobody has a picture.
  }
  return ids;
}

/** Removes every Telegram picture from this machine. Used when Telegram is disconnected and its chats are removed. */
export function forgetTelegramMedia(): void {
  fs.rmSync(/* turbopackIgnore: true */ mediaDir(), { recursive: true, force: true });
}
