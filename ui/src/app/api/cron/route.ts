import { connection } from "next/server";
import { tick } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromScheduler } from "@/server/http";

// Reading Slack and Fathom can take a while. This is the most a host lets one request run.
export const maxDuration = 300;

/**
 * The automatic sync on a host. A scheduler (Vercel Cron, see vercel.json) calls this every
 * few minutes, and it runs whichever checks are due by the timers set in Settings.
 *
 * There is no login here, because no person is involved. The caller must send the secret in
 * CRON_SECRET, which Vercel does by itself once that variable is set on the project.
 */
export async function GET(request: Request) {
  await connection();
  if (!fromScheduler(request)) return new Response("Unauthorized", { status: 401 });
  try {
    const runs = await tick(await ready());
    return Response.json({ ok: runs.every((r) => r.ok), ran: runs.map((r) => ({ check: r.jobId, ok: r.ok, result: r.message })) });
  } catch (error) {
    return failed(error, 500);
  }
}
