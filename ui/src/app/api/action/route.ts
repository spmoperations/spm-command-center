import { runJob } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";
import { applyAction, loadState, sendingEnabled } from "@/server/repo";

// Actions that put a message in the outbox. With sending on, it goes out straight away.
const SENDS = new Set(["sendReply", "replyEmail", "composeEmail", "delegateTask", "delegateConversation"]);

/** One change made on screen: { type, args }. Answers with the fresh state. */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const { type, args } = (await request.json()) as { type: string; args?: unknown[] };
    const db = await ready();
    await applyAction(db, type, args ?? [], owner);
    if (SENDS.has(type) && sendingEnabled()) await runJob(db, "outbox-retry", owner);
    return Response.json(await loadState(db, owner));
  } catch (error) {
    return failed(error);
  }
}
