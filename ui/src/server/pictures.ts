// Hands a message's picture to the browser.
//
// A Telegram picture is kept in the database. A Slack picture stays with Slack, which only
// gives it to the owner's token, so it is fetched with that token and passed straight on.
// Either way the browser asks the dashboard, and only a signed-in person gets an answer.
import { secretFor } from "./connections";
import type { Db } from "./db";
import { isPictureType, readPicture, readTelegramAvatar, type StoredPicture } from "./media";
import { SLACK_FILES_HOST, SLACK_FILES_SCOPE, type Fetch } from "./slack";

export const SLACK_NEEDS_FILES =
  "Slack will not hand over this picture. The Slack app needs one more permission, files:read, and then has to be installed again.";

/**
 * What goes out with every picture. It may not be treated as anything but a picture, and it
 * may not run anything, even when someone opens it in a tab of its own.
 */
const headers = (type: string) => ({
  "content-type": type,
  "cache-control": "private, max-age=3600",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
});

const none = (error = "There is no such picture.", status = 404) => Response.json({ error }, { status });

const kept = (found: { bytes: Buffer; mime: string } | null): Response => (found ? new Response(new Uint8Array(found.bytes), { headers: headers(found.mime) }) : none());

/** The owner's token goes to Slack's file server and nowhere else. */
function onSlack(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.hostname === SLACK_FILES_HOST;
  } catch {
    return false;
  }
}

/**
 * `avatar=<id>` is a Telegram profile picture. `m=<message id>&n=<which>` is a picture or
 * sticker of that message, and `full=1` asks for the full size where there is one.
 */
export async function pictureResponse(db: Db, ownerId: string, query: URLSearchParams, fetchImpl: Fetch = fetch): Promise<Response> {
  const avatar = query.get("avatar");
  if (avatar) return kept(await readTelegramAvatar(db, ownerId, avatar));

  const id = query.get("m");
  const n = Number(query.get("n") ?? 0);
  if (!id || !Number.isInteger(n) || n < 0) return none("Which picture?", 400);
  const [row] = await db.query<{ attachments: StoredPicture[] | null; source: string; chat: string }>(
    "select m.attachments, c.source, c.external_id as chat from messages m join conversations c on c.id = m.conversation_id where m.owner_id = $1 and m.id = $2",
    [ownerId, id],
  );
  const found = row?.attachments?.[n];
  if (!found) return none();
  // Only a key under this chat's own name is looked up, whatever the message row says.
  if (row.source === "telegram") return kept(found.key?.startsWith(`telegram/${row.chat}/`) ? await readPicture(db, ownerId, found.key) : null);

  const address = (query.get("full") && found.url) || found.thumb || found.url;
  if (!address || !onSlack(address)) return none();
  // Known not to be allowed: say so without asking Slack every time a picture scrolls past.
  const [slack] = await db.query<{ scopes: string | null }>("select scopes from connections where owner_id = $1 and provider = 'slack'", [ownerId]);
  if (slack?.scopes && !slack.scopes.split(",").includes(SLACK_FILES_SCOPE)) return none(SLACK_NEEDS_FILES, 403);
  const token = await secretFor(db, ownerId, "slack");
  if (!token) return none("Slack is not connected.", 403);
  // Slack answers a token that may not read files with a redirect to its login page.
  const res = await fetchImpl(address, { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
  const type = res.headers.get("content-type");
  if (res.status !== 200 || !isPictureType(type)) return none(SLACK_NEEDS_FILES, 403);
  return new Response(res.body, { headers: headers(type!.split(";")[0].trim().toLowerCase()) });
}
