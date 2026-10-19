// Sends what is waiting in the outbox through the owner's own Slack, Telegram or Gmail account.
//
// Sending is OFF unless SENDING_ENABLED=true. While it is off, replies, emails and delegation
// messages stay queued and nothing leaves the dashboard. This is the only code that writes to
// Slack, sends to Telegram or sends email.
import { rawEmail } from "@/server/gmail";
import type { GoogleApi } from "@/server/google";
import { sendingEnabled, type EmailDetails } from "@/server/repo";
import type { SlackClient } from "@/server/slack";
import type { TelegramApi } from "@/server/telegram";
import type { JobContext, JobResult } from "./runner";

const BATCH = 20;
const MAX_ATTEMPTS = 5;

interface Queued {
  id: string;
  source: "slack" | "telegram" | "gmail";
  target: string | null;
  to_name: string;
  ctx: string;
  body: string;
  message_id: string | null;
  thread_ts: string | null;
  attempts: number;
  after_id: string | null;
  details: EmailDetails | null;
}

/**
 * `openTelegram` connects to Telegram with the saved login, and `openGoogle` to one Google
 * account. Each is called only when something is waiting to go there, and is null where that
 * service is not connected.
 */
export async function outboxSend(
  { db, ownerId, now }: JobContext,
  slack: SlackClient | null,
  openTelegram: (() => Promise<TelegramApi>) | null = null,
  openGoogle: ((email: string) => Promise<GoogleApi>) | null = null,
): Promise<JobResult> {
  const queued = await db.query<Queued>("select id, source, target, to_name, ctx, body, message_id, thread_ts, attempts, after_id, details from outbox where owner_id = $1 and status = 'queued' order by created_at limit $2", [ownerId, BATCH]);
  if (!queued.length) return { items: 0, message: "Nothing waiting to send" };
  if (!sendingEnabled()) return { items: 0, message: `${queued.length} waiting. Sending is switched off.` };
  if (!slack && !openTelegram && !openGoogle) return { items: 0, message: `${queued.length} waiting. Slack is not connected.` };

  let telegram: TelegramApi | null = null;
  const google = new Map<string, GoogleApi>();
  let sent = 0;
  for (const item of queued) {
    try {
      if (item.after_id) {
        // This one goes under another message, in its thread, so that one has to go first.
        const [first] = await db.query<{ status: string; thread_ts: string | null }>("select p.status, c.thread_ts from outbox c join outbox p on p.id = c.after_id where c.id = $1", [item.id]);
        if (first?.status === "queued") continue;
        if (first?.status === "failed") {
          await db.run("update outbox set status = 'failed', last_error = 'The message this goes under could not be sent' where id = $1", [item.id]);
          continue;
        }
        item.thread_ts = first?.thread_ts ?? item.thread_ts;
      }
      if (item.source === "gmail") {
        const email = item.details;
        if (!openGoogle) throw new Error("Google is not connected");
        if (!email?.account || !email.to.length) throw new Error(`There is no address to send this email to ${item.to_name}`);
        let account = google.get(email.account);
        if (!account) google.set(email.account, (account = await openGoogle(email.account)));
        const out = await account.send(rawEmail({ to: email.to, cc: email.cc, subject: email.subject, body: item.body, inReplyTo: email.inReplyTo, references: email.references }), email.threadId);
        await db.run("update outbox set status = 'sent', sent_at = $1, attempts = attempts + 1, last_error = null where id = $2", [now, item.id]);
        // Under the id Gmail gave it, so the Gmail check does not bring it in a second time.
        if (item.message_id) await db.run("update messages set status = 'sent', external_id = $1 where id = $2", [out.id || null, item.message_id]);
        sent++;
        continue;
      }
      if (item.source === "telegram") {
        if (!openTelegram) throw new Error("Telegram is not connected");
        if (!item.target) throw new Error(`There is no Telegram chat to send this to ${item.to_name}`);
        telegram ??= await openTelegram();
        await telegram.send(item.target, item.body);
        await db.run("update outbox set status = 'sent', sent_at = $1, attempts = attempts + 1, last_error = null where id = $2", [now, item.id]);
        if (item.message_id) await db.run("update messages set status = 'sent' where id = $1", [item.message_id]);
        sent++;
        continue;
      }
      if (!slack) throw new Error("Slack is not connected");
      if (!item.target) throw new Error(`${item.to_name} has no Slack account linked in Settings`);
      // A person's id means a direct message: open (or find) that conversation first.
      const channel = item.target.startsWith("U") || item.target.startsWith("W")
        ? (await slack.call<{ channel: { id: string } }>("conversations.open", { users: item.target })).channel.id
        : item.target;
      // A reply written under a thread goes into that thread, not to the top of the channel.
      const posted = await slack.call<{ ts?: string }>("chat.postMessage", { channel, text: item.body, ...(item.thread_ts ? { thread_ts: item.thread_ts } : {}) });
      await db.run("update outbox set status = 'sent', sent_at = $1, attempts = attempts + 1, last_error = null where id = $2", [now, item.id]);
      // Whatever waits to go under this message now knows its thread: the message itself, or the thread it was posted in.
      if (posted?.ts) await db.run("update outbox set thread_ts = coalesce(thread_ts, $1) where after_id = $2 and status = 'queued'", [posted.ts, item.id]);
      if (item.message_id) await db.run("update messages set status = 'sent' where id = $1", [item.message_id]);
      sent++;
    } catch (error) {
      const failed = item.attempts + 1 >= MAX_ATTEMPTS;
      await db.run("update outbox set attempts = attempts + 1, last_error = $1, status = $2 where id = $3", [(error as Error).message, failed ? "failed" : "queued", item.id]);
      if (failed && item.message_id) await db.run("update messages set status = 'failed' where id = $1", [item.message_id]);
    }
  }
  await telegram?.close();
  return { items: sent, message: `Sent ${sent} of ${queued.length}` };
}
