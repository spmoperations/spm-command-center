// The Gmail check. Brings every new email in each connected account's inbox into the
// dashboard's inbox, from the moment the account was connected. It only reads: nothing is
// archived or marked as read. Sending is the outbox's (see outbox.ts).
//
// One inbox row per email thread. Each account is read from where its mailbox stood last time
// (Gmail's history of what arrived), so nothing is missed however much comes in between two
// runs. Gmail keeps that history for about a week; after a longer gap the check looks by date.
//
// Everything in the inbox comes in. Newsletters, automatic mail and Gmail's Promotions,
// Social, Updates and Forums tabs come in as not addressed to the owner, so the sorting rules
// put them low.
import type { Email } from "@/server/gmail";
import { readEmail } from "@/server/gmail";
import { googleCan, GoogleSaid, HistoryGone, type GoogleAccount, type GoogleApi } from "@/server/google";
import { RateLimited } from "@/server/slack";
import type { JobContext, JobResult } from "./runner";
import { refreshConversation } from "./slack";

/** Threads opened in one run, over all accounts. What is left waits for the next run. */
const MAX_THREADS = Number(process.env.GMAIL_MAX_THREADS ?? 50);
/** The newest emails of a long thread that are kept. The rest are in Gmail. */
const MESSAGES_PER_THREAD = 10;
/** Pages of mailbox history read in one run, 500 emails each. */
const MAX_PAGES = 10;
/** When looking by date, a little further back than the last run, for mail that arrives late. */
const OVERLAP = 10 * 60_000;

/** Where one account's reading stands. */
interface AccountCursor {
  /** Gmail's history id the next run reads from. */
  history?: string;
  /** Threads found but not opened yet, for the next run. */
  pending?: string[];
  /** When this account was last read. */
  at?: number;
}

/** The subject without the "Re:" and "Fwd:" a reply adds in front. */
const subjectOf = (emails: Email[]) => (emails.find((e) => e.subject)?.subject ?? "").replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || "(no subject)";

/** The inbox row of one thread in one account. */
export const gmailRowId = (account: string, threadId: string) => `gmail:${account}:${threadId}`;

/** What arrived in one account since its bookmark, as thread ids, oldest first, and the new bookmark. */
async function arrived(google: GoogleApi, account: GoogleAccount, before: AccountCursor): Promise<{ threads: string[]; history: string }> {
  const from = before.history ?? account.startHistory;
  // Connected before Gmail was allowed, or Gmail gave no starting point: from now on.
  if (!from) return { threads: [], history: await google.mailboxNow() };
  try {
    const threads: string[] = [];
    let history = from;
    let page: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const got = await google.changes(from, page);
      threads.push(...got.added.map((m) => m.threadId));
      history = got.historyId;
      page = got.next;
      if (!page) break;
    }
    return { threads, history };
  } catch (error) {
    if (!(error instanceof HistoryGone)) throw error;
    const since = before.at ?? account.connectedAt;
    const found = await google.threads(`in:inbox after:${Math.floor((since - OVERLAP) / 1000)}`, MAX_THREADS);
    return { threads: found.map((t) => t.id).reverse(), history: await google.mailboxNow() };
  }
}

export async function gmailPull({ db, ownerId, now, cursor }: JobContext, accounts: GoogleAccount[], open: (email: string) => Promise<GoogleApi>): Promise<JobResult> {
  const kept = (cursor.accounts as Record<string, AccountCursor> | undefined) ?? {};
  const next: Record<string, AccountCursor> = {};
  const [owner] = await db.query<{ name: string }>("select name from users where id = $1", [ownerId]);
  const ownerName = owner?.name ?? "You";
  let budget = MAX_THREADS;
  let stored = 0;
  let touched = 0;
  let waiting = 0;
  const signedOut: string[] = [];

  for (const account of accounts.filter((a) => googleCan(a.scopes).gmail)) {
    const before = kept[account.email] ?? {};
    let google: GoogleApi;
    try {
      google = await open(account.email);
    } catch (error) {
      // One account signed out does not stop the others.
      if (error instanceof GoogleSaid) {
        signedOut.push(account.email);
        continue;
      }
      throw error;
    }
    const { threads, history } = await arrived(google, account, before);
    const queue = [...new Set([...(before.pending ?? []), ...threads])];
    const reading = queue.slice(0, Math.max(0, budget));
    const later = queue.slice(reading.length);
    budget -= reading.length;
    waiting += later.length;
    const me = account.email.toLowerCase();

    for (const threadId of reading) {
      let thread;
      try {
        thread = await google.thread(threadId);
      } catch (error) {
        if (error instanceof RateLimited) throw error;
        // Deleted since it arrived: nothing to show.
        continue;
      }
      const emails = (thread.messages ?? [])
        .filter((m) => !(m.labelIds ?? []).some((l) => l === "DRAFT" || l === "SPAM" || l === "TRASH"))
        .map((m) => readEmail(m, me))
        .sort((a, b) => a.at - b.at)
        .slice(-MESSAGES_PER_THREAD);
      const incoming = emails.filter((e) => !e.me);
      if (!incoming.length) continue;
      const latest = incoming[incoming.length - 1];
      // Written to the owner by a person. A newsletter, Gmail's other tabs, or being copied in do not count.
      const direct = !latest.bulk && latest.tab === "primary" && latest.to.some((a) => a.email === me);
      const conversationId = gmailRowId(me, thread.id);
      await db.run(
        `insert into conversations (id, owner_id, source, external_id, from_name, ctx, direct, last_at) values ($1, $2, 'gmail', $3, $4, $5, $6, 0)
         on conflict (id) do update set ctx = excluded.ctx, direct = excluded.direct`,
        [conversationId, ownerId, `${me}:${thread.id}`, latest.from.name, subjectOf(emails), direct],
      );
      for (const e of emails) {
        // Who it was to, and the headers a reply needs to stay in this thread for everyone.
        const details = { to: e.to, cc: e.cc, messageId: e.messageId, references: e.references };
        // A reply sent from the dashboard is here already, under the id Gmail gave it.
        stored += await db.run(
          `insert into messages (id, conversation_id, owner_id, external_id, sender_name, sender_id, me, body, at, scanned, email)
           select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb
           where not exists (select 1 from messages where conversation_id = $2 and external_id = $4)
           on conflict (id) do nothing`,
          [`${conversationId}:${e.id}`, conversationId, ownerId, e.id, e.me ? ownerName : e.from.name, e.me ? null : e.from.email, e.me, e.text, e.at, e.me, JSON.stringify(details)],
        );
      }
      touched++;
      await refreshConversation(db, conversationId, { kind: direct ? "im" : "mpim", partner: null }, false);
    }
    next[account.email] = { history, pending: later, at: now };
  }

  const parts = [`${stored} new ${stored === 1 ? "email" : "emails"} in ${touched} ${touched === 1 ? "thread" : "threads"}`];
  if (waiting) parts.push(`${waiting} more ${waiting === 1 ? "thread" : "threads"} next time`);
  if (signedOut.length) parts.push(`connect again: ${signedOut.join(", ")}`);
  return { items: stored, cursor: { accounts: next }, message: parts.join(". ") };
}
