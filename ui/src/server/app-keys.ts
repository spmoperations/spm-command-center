// App keys: the keys of a service's app that every login through it needs, as opposed to a
// person's own login (their token, their Telegram session, their Google login).
//   Google     the OAuth client's Client ID and secret, from Google Cloud
//   Telegram   the api_id and api_hash, from my.telegram.org
//   Anthropic  the AI key, for finding tasks in messages
//   Slack      one Slack app's Client ID and Client Secret, so each person connects with one click
//
// They are kept in the database, sealed like every login, for each person: anyone can save keys
// of their own and connect their accounts with them. Someone who has none uses the owner's, the
// team's keys. Each Google account and Telegram login remembers the keys it was made with and
// keeps using them, so saving new keys never touches an account connected before.
//
// The server's settings (GOOGLE_CLIENT_ID and the rest) are copied in once as the owner's keys,
// on a server that may use them (see `adoptSettingsKeys`), and are read as a last resort while
// nothing is saved. The settings the whole site needs stay where they are: the database address,
// SECRETS_KEY, the owner's login, CRON_SECRET and the switches.
import crypto from "node:crypto";
import type { Db } from "./db";
import { OWNER_ID } from "./owner";
import { seal, unseal } from "./secrets";

export type KeyProvider = "google" | "telegram" | "anthropic" | "slack";
export interface GoogleKeys { clientId: string; clientSecret: string }
export interface TelegramKeys { apiId: number; apiHash: string }
export interface AnthropicKeys { apiKey: string; workspaceId?: string }
export interface SlackKeys { clientId: string; clientSecret: string }
export type KeysOf<P extends KeyProvider> = P extends "google" ? GoogleKeys : P extends "telegram" ? TelegramKeys : P extends "slack" ? SlackKeys : AnthropicKeys;

/** Keys as a connection uses them. `id` is the saved row they are; null for the server's settings. */
export interface Keys<P extends KeyProvider> {
  id: string | null;
  /** Whose they are: the person's own, the owner's (the team's), or the server's settings. */
  whose: "own" | "team" | "settings";
  keys: KeysOf<P>;
  label: string;
}

const NAME: Record<KeyProvider, string> = { google: "Google", telegram: "Telegram", anthropic: "the AI", slack: "Slack" };

/** A setting as it was meant: a value pasted with quotes or spaces around it still counts. */
export const setting = (name: string) => (process.env[name] ?? "").trim().replace(/^["']+|["']+$/g, "").trim();
const clean = (value: unknown) => String(value ?? "").trim().replace(/^["']+|["']+$/g, "").trim();

// ---------- What keys look like ----------

/** What is wrong with keys typed in or set, or null when they look right. `field` names each one as the person sees it. */
export function keysProblem<P extends KeyProvider>(provider: P, given: Record<string, unknown>, field: (name: string) => string = (n) => n): string | null {
  if (provider === "google") {
    const id = clean(given.clientId);
    const secret = clean(given.clientSecret);
    if (!id && !secret) return `Google's app keys are missing: ${field("clientId")} and ${field("clientSecret")}.`;
    if (!id) return `${field("clientId")} is missing.`;
    if (!secret) return `${field("clientSecret")} is missing.`;
    if (!id.endsWith(".apps.googleusercontent.com")) return `${field("clientId")} does not look right. It is the Client ID of the OAuth client in Google Cloud, and ends with .apps.googleusercontent.com.`;
    return null;
  }
  if (provider === "telegram") {
    const id = clean(given.apiId);
    const hash = clean(given.apiHash);
    if (!id && !hash) return `Telegram's app keys are missing: ${field("apiId")} and ${field("apiHash")}.`;
    if (!id) return `${field("apiId")} is missing.`;
    if (!hash) return `${field("apiHash")} is missing.`;
    if (!/^[1-9]\d*$/.test(id)) return `${field("apiId")} is not a number. It is the App api_id from my.telegram.org, digits only.`;
    if (!/^[0-9a-f]{32}$/i.test(hash)) return `${field("apiHash")} does not look right. It is the App api_hash from my.telegram.org: 32 letters and digits.`;
    return null;
  }
  if (provider === "slack") {
    const id = clean(given.clientId);
    const secret = clean(given.clientSecret);
    if (!id && !secret) return `Slack's app keys are missing: ${field("clientId")} and ${field("clientSecret")}.`;
    if (!id) return `${field("clientId")} is missing.`;
    if (!secret) return `${field("clientSecret")} is missing.`;
    if (!/^\d+\.\d+$/.test(id)) return `${field("clientId")} does not look right. It is on the Slack app's Basic Information page: digits, a dot, digits.`;
    if (!/^[0-9a-f]{32}$/i.test(secret)) return `${field("clientSecret")} does not look right. It is on the Slack app's Basic Information page, under Show: 32 letters and digits.`;
    return null;
  }
  return clean(given.apiKey) ? null : `${field("apiKey")} is missing.`;
}

/** Keys typed in, tidied: spaces and quotes around them dropped. */
export function tidyKeys<P extends KeyProvider>(provider: P, given: Record<string, unknown>): KeysOf<P> {
  if (provider === "google") return { clientId: clean(given.clientId), clientSecret: clean(given.clientSecret) } as KeysOf<P>;
  if (provider === "telegram") return { apiId: Number(clean(given.apiId)), apiHash: clean(given.apiHash).toLowerCase() } as KeysOf<P>;
  if (provider === "slack") return { clientId: clean(given.clientId), clientSecret: clean(given.clientSecret).toLowerCase() } as KeysOf<P>;
  const workspaceId = clean(given.workspaceId);
  return { apiKey: clean(given.apiKey), ...(workspaceId ? { workspaceId } : {}) } as KeysOf<P>;
}

/** What may be shown of keys: never a secret, and only part of an id. */
export function keysLabel<P extends KeyProvider>(provider: P, keys: KeysOf<P>): string {
  if (provider === "google") {
    const id = (keys as GoogleKeys).clientId;
    return `Client ID ${id.slice(0, 6)}…${id.replace(".apps.googleusercontent.com", "").slice(-4)}`;
  }
  if (provider === "telegram") return `api_id …${String((keys as TelegramKeys).apiId).slice(-3)}`;
  if (provider === "slack") return `Client ID …${(keys as SlackKeys).clientId.slice(-4)}`;
  return `key …${(keys as AnthropicKeys).apiKey.slice(-4)}`;
}

// ---------- The server's settings ----------

const SETTINGS: Record<KeyProvider, Record<string, string>> = {
  google: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" },
  telegram: { apiId: "TELEGRAM_API_ID", apiHash: "TELEGRAM_API_HASH" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY", workspaceId: "ANTHROPIC_WORKSPACE_ID" },
  slack: { clientId: "SLACK_CLIENT_ID", clientSecret: "SLACK_CLIENT_SECRET" },
};

const fromSettings = (provider: KeyProvider): Record<string, string> => Object.fromEntries(Object.entries(SETTINGS[provider]).map(([k, name]) => [k, setting(name)]));

/** The keys in the server's settings, when they are there and look right. */
export function settingsKeys<P extends KeyProvider>(provider: P): Keys<P> | null {
  const given = fromSettings(provider);
  if (keysProblem(provider, given)) return null;
  const keys = tidyKeys(provider, given);
  return { id: null, whose: "settings", keys, label: keysLabel(provider, keys) };
}

/** What is wrong with the keys in the server's settings, naming the settings, or null. */
export const settingsProblem = (provider: KeyProvider) => keysProblem(provider, fromSettings(provider), (k) => SETTINGS[provider][k]);

/**
 * Google and Telegram hold someone's own account, so with the hosted database they are used
 * only on the server meant to hold it: the live site says so with GOOGLE_HOSTED=true and
 * TELEGRAM_HOSTED=true. A developer's machine never does, so their own account and their own
 * keys never reach the hosted database. Null when this server may use it.
 */
export function hostedProblem(provider: KeyProvider): string | null {
  if (provider === "anthropic" || provider === "slack" || !process.env.DATABASE_URL) return null;
  return setting(provider === "google" ? "GOOGLE_HOSTED" : "TELEGRAM_HOSTED").toLowerCase() === "true" ? null : offHere(provider);
}

/** Why Google or Telegram is off on this server: it uses the hosted database and is not the live site. */
export const offHere = (provider: "google" | "telegram") =>
  `${NAME[provider]} is switched off while the app uses the hosted database. The live site turns it on with ${provider === "google" ? "GOOGLE_HOSTED" : "TELEGRAM_HOSTED"}=true (on a host: for Production, followed by a redeploy). On your own machine, start the app with: npm run dev:local`;

// ---------- Saved keys ----------

interface KeyRow {
  id: string;
  owner_id: string;
  provider: KeyProvider;
  secret: string;
  label: string;
  from_env: boolean;
  created_at: number;
  retired_at: number | null;
}

const asKeys = <P extends KeyProvider>(row: KeyRow, ownerId: string): Keys<P> => ({
  id: row.id,
  whose: row.owner_id === ownerId ? "own" : "team",
  keys: JSON.parse(unseal(row.secret)) as KeysOf<P>,
  label: row.label,
});

const current = async (db: Db, ownerId: string, provider: KeyProvider) =>
  (await db.query<KeyRow>("select * from app_keys where owner_id = $1 and provider = $2 and retired_at is null", [ownerId, provider]))[0] ?? null;

/**
 * The keys a new connection by this person uses: their own, else the owner's (the team's), else
 * the server's settings. Null when there are none anywhere.
 */
export async function keysForNew<P extends KeyProvider>(db: Db, ownerId: string, provider: P): Promise<Keys<P> | null> {
  const own = await current(db, ownerId, provider);
  if (own) return asKeys<P>(own, ownerId);
  if (ownerId !== OWNER_ID) {
    const team = await current(db, OWNER_ID, provider);
    if (team) return asKeys<P>(team, ownerId);
  }
  return settingsKeys(provider);
}

/**
 * The keys a connection was made with, by the id it remembers, even when newer ones have been
 * saved since. Only the person's own keys or the team's. With no id, it was made before keys were
 * kept here, with the server's settings: those were copied in as the owner's first keys.
 */
export async function keysById<P extends KeyProvider>(db: Db, ownerId: string, provider: P, id: string | null | undefined): Promise<Keys<P> | null> {
  if (id) {
    const [row] = await db.query<KeyRow>("select * from app_keys where id = $1 and provider = $2 and owner_id in ($3, $4)", [id, provider, ownerId, OWNER_ID]);
    return row ? asKeys<P>(row, ownerId) : null;
  }
  const [first] = await db.query<KeyRow>("select * from app_keys where owner_id = $1 and provider = $2 and from_env order by created_at limit 1", [OWNER_ID, provider]);
  return first ? asKeys<P>(first, ownerId) : settingsKeys(provider);
}

/**
 * Saves keys as this person's own. The ones they had before stop being used for new connections
 * and stay for the accounts connected with them. Answers with the new keys' id.
 */
export async function saveKeys<P extends KeyProvider>(db: Db, ownerId: string, provider: P, keys: KeysOf<P>, now: number, fromEnv = false): Promise<string> {
  const id = `k_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.run("update app_keys set retired_at = $3 where owner_id = $1 and provider = $2 and retired_at is null", [ownerId, provider, now]);
  await db.run("insert into app_keys (id, owner_id, provider, secret, label, from_env, created_at) values ($1, $2, $3, $4, $5, $6, $7)", [
    id,
    ownerId,
    provider,
    seal(JSON.stringify(keys)),
    keysLabel(provider, keys),
    fromEnv,
    now,
  ]);
  return id;
}

/** Stops using this person's own keys for new connections: they go back to the team's. Accounts connected with them keep them. */
export async function retireKeys(db: Db, ownerId: string, provider: KeyProvider, now: number): Promise<void> {
  await db.run("update app_keys set retired_at = $3 where owner_id = $1 and provider = $2 and retired_at is null", [ownerId, provider, now]);
}

/**
 * Copies the keys in the server's settings into the database, once, as the owner's keys: the
 * accounts connected before keys were kept here were connected with exactly these. Into a local
 * database, or into the hosted one from the live site only; only on a server that may use them
 * (see `hostedProblem`); and only while the owner has saved none for that app.
 * Answers with what was copied, never a value.
 */
export async function adoptSettingsKeys(db: Db, now = Date.now()): Promise<string[]> {
  const notes: string[] = [];
  // Into the hosted database only from the live site itself: Vercel says so with VERCEL=1, and
  // the live site sets GOOGLE_HOSTED and TELEGRAM_HOSTED. A developer's machine pointed at it
  // has none of these, and never copies its own keys there.
  const liveSite = Boolean(process.env.VERCEL) || setting("GOOGLE_HOSTED").toLowerCase() === "true" || setting("TELEGRAM_HOSTED").toLowerCase() === "true";
  if (process.env.DATABASE_URL && !liveSite) return notes;
  for (const provider of ["google", "telegram", "anthropic", "slack"] as const) {
    const keys = settingsKeys(provider);
    if (!keys || hostedProblem(provider)) continue;
    // In a transaction, so two servers starting together copy them once.
    await db.transaction(async (tx) => {
      const [{ n }] = await tx.query<{ n: number }>("select count(*)::int as n from app_keys where owner_id = $1 and provider = $2", [OWNER_ID, provider]);
      if (n > 0) return;
      await saveKeys(tx, OWNER_ID, provider, keys.keys, now, true);
      notes.push(`${NAME[provider]}: the app keys in the settings are kept in the database now (${keys.label})`);
    }).catch((error) => notes.push(`${NAME[provider]}: the app keys could not be copied: ${(error as Error).message}`));
  }
  return notes;
}

/** For the screens: which keys a new connection by this person uses, and their own if they saved some. Never a secret. */
export async function keysOnScreen(db: Db, ownerId: string, provider: KeyProvider): Promise<{ using: "own" | "team" | "settings" | null; label: string | null; own: string | null }> {
  const keys = await keysForNew(db, ownerId, provider);
  const own = await current(db, ownerId, provider);
  return { using: keys?.whose ?? null, label: keys?.label ?? null, own: own?.label ?? null };
}
