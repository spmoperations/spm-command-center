import { runJob } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";
import { applyAction, sendingEnabled, stampsFrom, stateUpdate } from "@/server/repo";

// Actions that put a message in the outbox. With sending on, it goes out straight away.
const SENDS = new Set(["sendReply", "replyEmail", "composeEmail", "delegateTask", "delegateConversation"]);

/** One change made on screen: { type, args }. Answers with what changed (see /api/state for `have` and `open`). */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const { type, args, have, open } = (await request.json()) as { type: string; args?: unknown[]; have?: unknown; open?: unknown };
    const db = await ready();
    await applyAction(db, type, args ?? [], owner);
    if (SENDS.has(type) && sendingEnabled()) await runJob(db, "outbox-retry", owner);
    // Only the parts the change touched come back: every part's fingerprint covers what a change
    // made on the page can touch (see stateStamps), and the page keeps the rest as it has them.
    return Response.json(await stateUpdate(db, owner, stampsFrom(have), typeof open === "string" ? open : null));
  } catch (error) {
    return failed(error);
  }
}
