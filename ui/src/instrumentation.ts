// Runs once when the server starts. In development it also starts the ticker: once a minute
// it runs whichever checks are due. On a host without a long-lived server, a scheduled request
// to POST /api/jobs/tick does the same job.
export async function register() {
  // On Vercel there is no server that stays up between requests, so a timer in here would
  // never fire reliably. There the scheduler calls GET /api/cron instead (see vercel.json).
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.TICKER === "off" || process.env.VERCEL) return;
  const holder = globalThis as unknown as { __commandCenterTicker?: ReturnType<typeof setInterval> };
  if (holder.__commandCenterTicker) return;
  const { ready } = await import("./server/boot");
  const { tick } = await import("./jobs/runner");
  const beat = async () => {
    try {
      const runs = await tick(await ready());
      for (const run of runs) console.log(`[command-center] ${run.jobId}: ${run.ok ? "ok" : "failed"} - ${run.message}`);
    } catch (error) {
      console.error("[command-center] tick failed:", (error as Error).message);
    }
  };
  holder.__commandCenterTicker = setInterval(beat, 60_000);
  // First beat shortly after start, so a fresh server fills in without waiting a minute.
  setTimeout(beat, 3_000);
}
