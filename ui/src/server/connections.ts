// Connecting a service: check the key with the service first, then store it encrypted.
import type { Provider } from "@/core/types";
import type { Db } from "./db";
import { verifyFathomKey } from "./fathom";
import { seal, unseal } from "./secrets";
import { verifySlackToken, type Fetch } from "./slack";

export class ConnectionError extends Error {}

export async function connect(db: Db, ownerId: string, provider: Provider, secret: string, fetchImpl: Fetch = fetch): Promise<{ label: string }> {
  const value = secret.trim();
  let label: string;
  let externalId: string | null = null;
  if (provider === "slack") {
    const who = await verifySlackToken(value, fetchImpl).catch((e: Error) => {
      throw new ConnectionError(`Slack did not accept that token (${e.message}).`);
    });
    label = who.label;
    externalId = who.userId;
    await db.run("update users set slack_user_id = $1 where id = $2", [who.userId, ownerId]);
  } else if (provider === "fathom") {
    const who = await verifyFathomKey(value, fetchImpl).catch((e: Error) => {
      throw new ConnectionError(`Fathom did not accept that key (${e.message}).`);
    });
    label = who.label;
    if (who.email) await db.run("update users set email = coalesce(email, $1) where id = $2", [who.email, ownerId]);
  } else if (provider === "google") {
    throw new ConnectionError("Google is connected with the Connect Google button, not with a key.");
  } else {
    throw new ConnectionError("Telegram cannot be connected yet. It needs its app keys set up first.");
  }
  await db.run(
    `insert into connections (owner_id, provider, secret, label, external_id, connected_at) values ($1, $2, $3, $4, $5, $6)
     on conflict (owner_id, provider) do update set secret = excluded.secret, label = excluded.label, external_id = excluded.external_id, connected_at = excluded.connected_at`,
    [ownerId, provider, seal(value), label, externalId, Date.now()],
  );
  return { label };
}

/** The stored key for a service, or null when it is not connected. */
export async function secretFor(db: Db, ownerId: string, provider: Provider): Promise<string | null> {
  const [row] = await db.query<{ secret: string }>("select secret from connections where owner_id = $1 and provider = $2", [ownerId, provider]);
  return row ? unseal(row.secret) : null;
}

/**
 * Development convenience: a key placed in .env.local is connected on first start, exactly as
 * if it had been pasted on the Connections tab. A service that is already connected is left alone.
 */
export async function connectFromEnv(db: Db, ownerId: string): Promise<string[]> {
  const fromEnv: [Provider, string | undefined][] = [["slack", process.env.SLACK_USER_TOKEN], ["fathom", process.env.FATHOM_API_KEY]];
  const notes: string[] = [];
  for (const [provider, value] of fromEnv) {
    if (!value || (await secretFor(db, ownerId, provider))) continue;
    try {
      const { label } = await connect(db, ownerId, provider, value);
      notes.push(`${provider}: connected as ${label}`);
    } catch (e) {
      notes.push(`${provider}: ${(e as Error).message}`);
    }
  }
  return notes;
}
