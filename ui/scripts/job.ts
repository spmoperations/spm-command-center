// Runs one check from the command line, the same way the dashboard does.
//   npm run job -- slack-pull      one job, plus anything that follows it
//   npm run job -- tick            every job whose timer is up
import { JOBS } from "@/core/jobs";
import type { JobId } from "@/core/types";
import { runNow, tick } from "@/jobs/runner";
import { ready } from "@/server/boot";

async function main() {
  const [name] = process.argv.slice(2);
  if (name !== "tick" && !JOBS.some((j) => j.id === name)) {
    console.error(`Usage: npm run job -- <${["tick", ...JOBS.map((j) => j.id)].join(" | ")}>`);
    process.exit(1);
  }
  const db = await ready();
  const runs = name === "tick" ? await tick(db) : await runNow(db, name as JobId);
  for (const run of runs) console.log(`${run.jobId}: ${run.ok ? "ok" : "FAILED"} - ${run.message}`);
  if (!runs.length) console.log("Nothing was due.");
  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
