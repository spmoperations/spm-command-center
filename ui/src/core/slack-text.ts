// Slack stores messages in its own markup. These helpers turn it into text a person can read,
// and answer "is this person tagged here?". Plain logic, no network. Bold, italics, code and
// lists are left as Slack wrote them; `core/message-format.ts` lays them out on screen.
import { emojify } from "node-emoji";
// Slack's own names for the standard emoji ("thumbsup", "rolling_on_the_floor_laughing",
// "flag-in"), made from the emoji-data project's list (MIT), which is where Slack's names
// come from. A general emoji library knows many of them under other names.
import slackEmoji from "./slack-emoji.json";
import type { Reaction } from "./types";

const SLACK_EMOJI = new Map(Object.entries(slackEmoji as Record<string, string>));

/** The emoji a Slack name stands for. Undefined for a workspace's own custom emoji, which have no picture here. */
function emojiNamed(name: string): string | undefined {
  const known = SLACK_EMOJI.get(name);
  if (known) return known;
  const code = `:${name}:`;
  const found = emojify(code);
  return found === code ? undefined : found;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** `names` maps a Slack user id to a display name. */
export function slackToText(raw: string, names: (userId: string) => string | undefined = () => undefined): string {
  return raw
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id: string, label?: string) => `@${names(id) ?? label ?? "someone"}`)
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name: string) => `#${name || "channel"}`)
    .replace(/<#[A-Z0-9]+>/g, "#channel")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => label ?? "@group")
    .replace(/<!date\^[^|>]*\|([^>]+)>/g, "$1")
    // A link keeps its address: "[label](url)", or just the address when the label is the address.
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => (sameLink(url, label) ? url : `[${label.replace(/[[\]]/g, "")}](${url})`))
    // An email address or a phone number reads as itself, not as a link.
    .replace(/<(?:mailto|tel):[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<((?:https?|mailto|tel):[^>]+)>/g, (_, url: string) => url.replace(/^(?:mailto|tel):/, ""))
    .replace(/&(amp|lt|gt);/g, (m) => ENTITIES[m])
    // ":raised_hands:" becomes the emoji itself. A workspace's own custom emoji have no picture
    // here, so their names are dropped along with skin-tone markers. Numbers between colons
    // are left alone: "10:30:00" is a time, not an emoji.
    .replace(/:skin-tone-\d:/g, "")
    .replace(/:[a-z0-9_+-]+:/g, (code) => emojiNamed(code.slice(1, -1)) ?? (/[a-z]/.test(code) ? "" : code))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * A reaction's name as the emoji itself: "thumbsup" becomes the thumb. A workspace's own
 * custom emoji has no picture here, so it stays as ":name:". Skin tones are left off.
 */
export function reactionEmoji(name: string): string {
  const base = name.split("::")[0];
  return emojiNamed(base) ?? `:${base}:`;
}

/** The reactions on a Slack message, as Slack lists them, ready to show. */
export function slackReactions(raw: unknown, myId: string): Reaction[] {
  if (!Array.isArray(raw)) return [];
  // The same emoji in two skin tones is one reaction here.
  const merged = new Map<string, Reaction>();
  for (const r of raw as { name?: string; count?: number; users?: string[] }[]) {
    if (!r?.name) continue;
    const emoji = reactionEmoji(r.name);
    const entry = merged.get(emoji) ?? { emoji, count: 0 };
    entry.count += r.count ?? r.users?.length ?? 1;
    if (r.users?.includes(myId)) entry.mine = true;
    merged.set(emoji, entry);
  }
  return [...merged.values()];
}

/** Slack shortens the visible part of a pasted link; it is still the same link. */
function sameLink(url: string, label: string): boolean {
  const bare = (v: string) => v.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const shown = bare(label).replace(/…|\.\.\./g, "");
  return bare(url) === bare(label) || (shown.length > 8 && bare(url).startsWith(shown.slice(0, 12)));
}

/** Every person tagged in a message, so their names can be looked up before it is stored. */
export const mentionedIds = (raw: string): string[] => [...raw.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]);

/** Apps often send a card and no text. This reads the card's own short description. */
export function attachmentText(attachments: unknown): string {
  if (!Array.isArray(attachments)) return "";
  for (const a of attachments as { pretext?: string; title?: string; text?: string; fallback?: string }[]) {
    const text = [a.pretext, a.title, a.text].filter(Boolean).join("\n") || a.fallback;
    if (text) return text;
  }
  return "";
}

const SECRET = /\b(?:xox[abeoprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;

/**
 * Replaces anything that looks like an access key or token. People do paste keys into chats;
 * this runs on every line before it is sent to the AI, so a key never leaves with it.
 */
export const redactSecrets = (text: string) => text.replace(SECRET, "[key removed]");

/** True when the message tags this user directly. */
export const mentionsUser = (raw: string, userId: string) => raw.includes(`<@${userId}>`) || raw.includes(`<@${userId}|`);

/** Slack timestamps are seconds with a fraction, as a string ("1760000000.123456"). */
export const slackTsToMs = (ts: string) => Math.round(Number(ts) * 1000);

export type SlackKind = "public" | "private" | "mpim" | "im";

export function channelKind(c: { is_im?: boolean; is_mpim?: boolean; is_private?: boolean; is_group?: boolean }): SlackKind {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  return c.is_private || c.is_group ? "private" : "public";
}

/** How a conversation is named in the inbox. */
export function contextLabel(kind: SlackKind, name: string): string {
  if (kind === "im") return "Direct message";
  if (kind === "mpim") return "Group message";
  return `#${name}`;
}

/**
 * The thread a search result is part of, read from its link. Slack's search does not say so
 * any other way: the link of a reply, and of a first message that has replies, ends in
 * "?thread_ts=<the first message's id>". Null for a message outside any thread.
 */
export function threadOf(permalink: string | undefined): string | null {
  if (!permalink) return null;
  try {
    return new URL(permalink).searchParams.get("thread_ts") || null;
  } catch {
    return null;
  }
}

