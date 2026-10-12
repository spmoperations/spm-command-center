import { JOBS } from "@/core/jobs";
import type { JobId } from "@/core/types";
import { runNow, tick } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

/**
 * { id } runs that check now ("Run now"); { id: "tick" } runs whatever is due.
 * A scheduler on the host calls the tick form once a minute.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const { id } = (await request.json()) as { id: string };
    const db = await ready();
    if (id !== "tick" && !JOBS.some((j) => j.id === id)) return failed(new Error(`Unknown check: ${id}`));
    const runs = id === "tick" ? await tick(db) : await runNow(db, id as JobId);
    return Response.json({ runs, state: await loadState(db) });
  } catch (error) {
    return failed(error);
  }
}
