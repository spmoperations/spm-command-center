import { connection } from "next/server";
import { tick, type JobRun } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromScheduler } from "@/server/http";
import { OWNER_ID } from "@/server/owner";
import { scheduledOwners } from "@/server/team";

// Reading Slack and Fathom can take a while. This is the most a host lets one request run.
export const maxDuration = 300;

/**
 * The automatic sync on a host. A scheduler (Vercel Cron, see vercel.json) calls this every
 * few minutes, and it runs whichever checks are due by the timers set in Settings: the
 * owner's first, then each team member's, each with their own connections and timers.
 *
 * There is no login here, because no person is involved. The caller must send the secret in
 * CRON_SECRET, which Vercel does by itself once that variable is set on the project.
 */
export async function GET(request: Request) {
  await connection();
  if (!fromScheduler(request)) return new Response("Unauthorized", { status: 401 });
  try {
    const db = await ready();
    const runs: (JobRun & { owner: string })[] = [];
    for (const owner of await scheduledOwners(db)) {
      // One person's failing checks never hold up the next person's.
      try {
        for (const run of await tick(db, owner)) runs.push({ ...run, owner });
      } catch (error) {
        console.error(`[command-center] checks for one person failed: ${(error as Error).message}`);
      }
    }
    // Which person a run was for is not said: only the owner's runs are named, the rest are counted.
    return Response.json({ ok: runs.every((r) => r.ok), ran: runs.filter((r) => r.owner === OWNER_ID).map((r) => ({ check: r.jobId, ok: r.ok, result: r.message })), team: runs.filter((r) => r.owner !== OWNER_ID).length });
  } catch (error) {
    return failed(error, 500);
  }
}
