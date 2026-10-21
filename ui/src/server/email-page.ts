// One email shown as its sender laid it out, for the frame under an email in the Emails tab.
//
// The page is the email's own HTML, made safe (see `emailPage`), and served under a policy that
// lets it run nothing: no scripts, no forms, nothing loaded but pictures, styles and fonts. The
// dashboard shows it in a sandboxed frame as well. It is fetched from Gmail when it is opened,
// so the database only keeps the text.
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
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": POLICY, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "private, max-age=300" },
  });

const note = (text: string) => page(`<!doctype html><meta charset="utf-8"><body style="margin:0;padding:14px 16px;font:14px/1.5 -apple-system,Helvetica,Arial,sans-serif;color:#5f6368;background:#fff">${text}</body>`);

/** The email `messageId` of the email row `conversationId`, if both are the owner's. */
export async function emailPageResponse(db: Db, ownerId: string, conversationId: string, messageId: string, open: (email: string) => Promise<GoogleApi> = (email) => googleApi(db, ownerId, email)): Promise<Response> {
  const [row] = await db.query<{ external_id: string }>(
    "select c.external_id from conversations c join messages m on m.owner_id = c.owner_id and m.conversation_id = c.id where c.owner_id = $1 and c.id = $2 and c.source = 'gmail' and m.external_id = $3",
    [ownerId, conversationId, messageId],
  );
  if (!row) return note("This email is not in the dashboard any more.");
  // An email row's external id is "<account>:<thread>".
  const account = row.external_id.slice(0, row.external_id.lastIndexOf(":"));
  try {
    return page(emailPage(await (await open(account)).message(messageId)));
  } catch (error) {
    return note(error instanceof GoogleSaid ? error.message : "This email could not be loaded from Gmail just now. Use Open in Gmail to read it there.");
  }
}
