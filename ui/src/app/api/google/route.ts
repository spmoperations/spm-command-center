import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { forgetGoogle, loadState, OWNER_ID } from "@/server/repo";

/**
 * Disconnects one Google account, named by `email`. With `forget`, the emails read from it
 * are removed too. Connecting is done by /api/google/start and /api/google/callback.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const body = (await request.json()) as { step?: unknown; email?: unknown; forget?: unknown };
    if (body.step !== "disconnect") return failed(new Error("Unknown step."));
    if (typeof body.email !== "string" || !body.email.includes("@")) return failed(new Error("Which Google account?"));
    const db = await ready();
    await forgetGoogle(db, OWNER_ID, body.email, body.forget === true);
    return Response.json({ disconnected: true, state: await loadState(db) });
  } catch (error) {
    return failed(error);
  }
}
