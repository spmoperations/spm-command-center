// One email shown as its sender laid it out, for the frame under an email in the Emails tab.
//
// The page is the email's own HTML, made safe (see `emailPage`), and served under a policy that
// lets it run nothing: no scripts, no forms, nothing loaded but pictures, styles and fonts. The
// dashboard shows it in a sandboxed frame as well. It is fetched from Gmail when it is opened,
// so the database only keeps the text. An email does not change once sent, so the page is kept
// for a while: in this server's memory, and in the browser.
import type { Db } from "./db";
import { emailPage } from "./gmail";
import { googleApi, GoogleSaid, type GoogleApi } from "./google";

const POLICY = [
  "default-src 'none'",
  "img-src https: http: data:",
  "style-src 'unsafe-inline' https:",
  "font-src https: data:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox",
].join("; ");

const page = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": POLICY, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "private, max-age=3600" },
  });

const note = (text: string) => page(`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:14px 16px;font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#5f6368;background:#fff">${text}</body>`);

/** Emails shown lately, kept in this server's memory so opening one again is instant: the newest few hundred, for half an hour. */
const PAGES_KEPT = 300;
const PAGE_MS = 30 * 60_000;
const pages = new Map<string, { html: string; until: number }>();

function keep(key: string, html: string): void {
  pages.delete(key);
  pages.set(key, { html, until: Date.now() + PAGE_MS });
  // A Map keeps the order things were put in: the first is the one shown longest ago.
  while (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value!);
}

/**
 * The email `messageId` of the email row `conversationId`, if both are the owner's. The tests
 * hand in their own pretend Gmail as `open`, and then nothing is kept.
 */
export async function emailPageResponse(db: Db, ownerId: string, conversationId: string, messageId: string, open?: (email: string) => Promise<GoogleApi>): Promise<Response> {
  const [row] = await db.query<{ external_id: string }>(
    "select c.external_id from conversations c join messages m on m.owner_id = c.owner_id and m.conversation_id = c.id where c.owner_id = $1 and c.id = $2 and c.source = 'gmail' and m.external_id = $3",
    [ownerId, conversationId, messageId],
  );
  if (!row) return note("This email is not in the dashboard any more.");
  // An email row's external id is "<account>:<thread>".
  const account = row.external_id.slice(0, row.external_id.lastIndexOf(":"));
  const key = `${ownerId}\n${account}\n${messageId}`;
  const shown = open ? undefined : pages.get(key);
  if (shown && shown.until > Date.now()) return page(shown.html);
  try {
    const html = emailPage(await (await (open ?? ((email: string) => googleApi(db, ownerId, email)))(account)).message(messageId));
    if (!open) keep(key, html);
    return page(html);
  } catch (error) {
    return note(error instanceof GoogleSaid ? error.message : "This email could not be loaded from Gmail just now. Use Open in Gmail to read it there.");
  }
}
