import { slackReadThreads } from "@/jobs/slack";
import { telegramRefresh } from "@/jobs/telegram";
import { ready } from "@/server/boot";
import { secretFor } from "@/server/connections";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState, OWNER_ID } from "@/server/repo";
import { RateLimited, slackClient } from "@/server/slack";
import { telegramApi, telegramConnected } from "@/server/telegram";

export const maxDuration = 60;

/**
 * { id } brings one conversation up to date when a person opens it. On Slack: the threads
 * under its messages, and the pictures and reactions on them. On Telegram: anything written
 * since the last check, and the reactions as they are now. Read-only on the other side.
 * Answers with how many messages were added, and the fresh state when anything changed.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const { id } = (await request.json()) as { id?: unknown };
    if (typeof id !== "string") return failed(new Error("Which conversation?"));
    const db = await ready();
    // An email is read whole by the Gmail check: there is nothing more to fetch when it is opened.
    if (id.startsWith("gmail:")) return Response.json({ added: 0 });
    if (id.startsWith("telegram:")) {
      if (!(await telegramConnected(db, OWNER_ID))) return Response.json({ added: 0 });
      const telegram = await telegramApi(db, OWNER_ID);
      try {
        const { added, changed } = await telegramRefresh({ db, ownerId: OWNER_ID, now: Date.now() }, telegram, id);
        return Response.json(added || changed ? { added, state: await loadState(db) } : { added });
      } finally {
        await telegram.close();
      }
    }
    const token = await secretFor(db, OWNER_ID, "slack");
    if (!token) return Response.json({ added: 0 });
    const { added, changed } = await slackReadThreads({ db, ownerId: OWNER_ID }, slackClient(token), id);
    return Response.json(added || changed ? { added, state: await loadState(db) } : { added });
  } catch (error) {
    // Slack asking for a pause is not worth an error on screen: the threads come next time.
    if (error instanceof RateLimited) return Response.json({ added: 0 });
    return failed(error, 500);
  }
}
