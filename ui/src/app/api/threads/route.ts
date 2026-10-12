import { slackReadThreads } from "@/jobs/slack";
import { ready } from "@/server/boot";
import { secretFor } from "@/server/connections";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState, OWNER_ID } from "@/server/repo";
import { RateLimited, slackClient } from "@/server/slack";

export const maxDuration = 60;

/**
 * { id } reads the threads under the messages of one conversation, when a person opens it.
 * Read-only on Slack's side. Answers with how many messages were added, and the fresh state
 * when there were any.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const { id } = (await request.json()) as { id?: unknown };
    if (typeof id !== "string") return failed(new Error("Which conversation?"));
    const db = await ready();
    const token = await secretFor(db, OWNER_ID, "slack");
    if (!token) return Response.json({ added: 0 });
    const added = await slackReadThreads({ db, ownerId: OWNER_ID }, slackClient(token), id);
    return Response.json(added ? { added, state: await loadState(db) } : { added });
  } catch (error) {
    // Slack asking for a pause is not worth an error on screen: the threads come next time.
    if (error instanceof RateLimited) return Response.json({ added: 0 });
    return failed(error, 500);
  }
}
