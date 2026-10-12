import { JOBS } from "@/core/jobs";
import type { JobId } from "@/core/types";
import { runNow, syncAll, tick } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

// Reading Slack and Fathom can take a while. This is the most a host lets one request run.
export const maxDuration = 300;

/**
 * { id } runs that check now ("Run now"); { id: "sync" } runs every working check ("Sync now");
 * { id: "tick" } runs whatever is due. A host's scheduler uses GET /api/cron for that instead.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const { id } = (await request.json()) as { id: string };
    const db = await ready();
    if (id !== "tick" && id !== "sync" && !JOBS.some((j) => j.id === id)) return failed(new Error(`Unknown check: ${id}`));
    const runs = id === "tick" ? await tick(db) : id === "sync" ? await syncAll(db) : await runNow(db, id as JobId);
    return Response.json({ runs, state: await loadState(db) });
  } catch (error) {
    return failed(error);
  }
}
