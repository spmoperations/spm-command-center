// Runs the checks. Each job is one function in this folder; this file decides when a job is
// due, gives it its bookmark, records the result, and backs off when a service asks it to wait.
import { INBOX_DAYS } from "@/core/config";
import { isDue, jobById, JOBS, liveJobs, waitUntil } from "@/core/jobs";
import type { JobId, JobSetting } from "@/core/types";
import { aiConfigured } from "@/server/ai";
import { secretFor } from "@/server/connections";
import type { Db } from "@/server/db";
import { ageOutInbox, OWNER_ID, resortInbox, sendingEnabled } from "@/server/repo";
import { RateLimited, slackClient } from "@/server/slack";
import { telegramApi, telegramAvailable, telegramBlocked, telegramConnected } from "@/server/telegram";
import { fathomPull } from "./fathom";
import { outboxSend } from "./outbox";
import { requestFinder } from "./request-finder";
import { slackDirectorySync, slackPull } from "./slack";
import { taskSuggest } from "./task-suggest";
import { telegramPull } from "./telegram";

export interface JobContext {
  db: Db;
  ownerId: string;
  /** Epoch milliseconds. */
  now: number;
  /** The job's bookmark from its last successful run. */
  cursor: Record<string, unknown>;
}

export interface JobResult {
  items: number;
  message?: string;
  cursor?: Record<string, unknown>;
}

export interface JobRun {
  jobId: JobId;
  ok: boolean;
  items: number;
  message: string;
}

/** Thrown when a job cannot run yet for a reason the owner can fix. */
class NotReady extends Error {}

async function execute(jobId: JobId, ctx: JobContext): Promise<JobResult> {
  const slack = async () => {
    const token = await secretFor(ctx.db, ctx.ownerId, "slack");
    if (!token) throw new NotReady("Slack is not connected");
    return slackClient(token);
  };
  switch (jobId) {
    case "slack-directory-sync":
      return slackDirectorySync(ctx, await slack());
    case "slack-pull":
      return slackPull(ctx, await slack());
    case "fathom-pull": {
      const key = await secretFor(ctx.db, ctx.ownerId, "fathom");
      if (!key) throw new NotReady("Fathom is not connected");
      return fathomPull(ctx, key);
    }
    case "inbox-rules": {
      const changed = await resortInbox(ctx.db, ctx.ownerId);
      // Then what has had nothing new for a few days leaves the inbox.
      const aged = await ageOutInbox(ctx.db, ctx.ownerId, ctx.now);
      return { items: changed + aged, message: `${changed} re-sorted${aged ? `, ${aged} older than ${INBOX_DAYS} days cleared` : ""}` };
    }
    case "request-finder":
      return requestFinder(ctx);
    case "task-suggest":
      if (!aiConfigured()) throw new NotReady("The AI key is not set");
      return taskSuggest(ctx);
    case "outbox-retry": {
      const token = await secretFor(ctx.db, ctx.ownerId, "slack");
      // Telegram is opened only if something is waiting to go there.
      return outboxSend(ctx, token ? slackClient(token) : null, (await telegramConnected(ctx.db, ctx.ownerId)) ? () => telegramApi(ctx.db, ctx.ownerId) : null);
    }
    case "telegram-pull": {
      const blocked = telegramBlocked();
      if (blocked) throw new NotReady(blocked);
      if (!(await telegramConnected(ctx.db, ctx.ownerId))) throw new NotReady("Telegram is not connected");
      const telegram = await telegramApi(ctx.db, ctx.ownerId);
      try {
        return await telegramPull(ctx, telegram);
      } finally {
        await telegram.close();
      }
    }
  }
}

/** The services that are connected. A Telegram login counts only on a server that may use Telegram. */
async function connectedTo(db: Db, ownerId: string): Promise<Set<string>> {
  const connected = new Set((await db.query<{ provider: string }>("select provider from connections where owner_id = $1", [ownerId])).map((r) => r.provider));
  if (!telegramAvailable()) connected.delete("telegram");
  return connected;
}

const running = new Set<string>();
/** A run that never reported back (a crashed server) stops blocking the next one after this long. */
const STALE_RUN_MS = 6 * 60_000;

/** Runs one job now, whatever its timer says, and records what happened. */
export async function runJob(db: Db, jobId: JobId, ownerId = OWNER_ID, now = Date.now()): Promise<JobRun> {
  const lock = `${ownerId}:${jobId}`;
  if (running.has(lock)) return { jobId, ok: false, items: 0, message: "Already running" };
  running.add(lock);
  try {
    // On a host the same check can be started twice at once, by two servers. The job's row is
    // held while this one claims the run, so only one of them goes ahead.
    const claimed = await db.transaction(async (tx) => {
      const [job] = await tx.query<{ cursor: Record<string, unknown> }>("select cursor from jobs where owner_id = $1 and job_id = $2 for update", [ownerId, jobId]);
      const [busy] = await tx.query<{ id: number }>("select id from job_runs where owner_id = $1 and job_id = $2 and finished_at is null and started_at > $3 limit 1", [ownerId, jobId, now - STALE_RUN_MS]);
      if (busy) return null;
      const [{ id }] = await tx.query<{ id: number }>("insert into job_runs (owner_id, job_id, started_at) values ($1, $2, $3) returning id", [ownerId, jobId, now]);
      return { job, runId: id };
    });
    if (!claimed) return { jobId, ok: false, items: 0, message: "Already running" };
    const { job, runId } = claimed;
    let run: JobRun;
    try {
      const result = await execute(jobId, { db, ownerId, now, cursor: job?.cursor ?? {} });
      await db.run("update jobs set last_run_at = $1, not_before = null, cursor = coalesce($2::jsonb, cursor) where owner_id = $3 and job_id = $4", [now, result.cursor ? JSON.stringify(result.cursor) : null, ownerId, jobId]);
      run = { jobId, ok: true, items: result.items, message: result.message ?? "Done" };
    } catch (error) {
      if (error instanceof RateLimited) {
        await db.run("update jobs set not_before = $1 where owner_id = $2 and job_id = $3", [waitUntil(now, error.waitSeconds), ownerId, jobId]);
      } else if (!(error instanceof NotReady)) {
        // A failed run still counts as a run, so a broken job is retried on its timer and not every minute.
        await db.run("update jobs set last_run_at = $1 where owner_id = $2 and job_id = $3", [now, ownerId, jobId]);
      }
      run = { jobId, ok: false, items: 0, message: (error as Error).message };
    }
    await db.run("update job_runs set finished_at = $1, ok = $2, items = $3, message = $4 where id = $5", [Date.now(), run.ok, run.items, run.message, runId]);
    // Keep the log short: the last 50 runs of each job are plenty to see what happened.
    await db.run("delete from job_runs where owner_id = $1 and job_id = $2 and id not in (select id from job_runs where owner_id = $1 and job_id = $2 order by id desc limit 50)", [ownerId, jobId]);
    return run;
  } finally {
    running.delete(lock);
  }
}

/** Runs every job whose timer is up. Called once a minute. */
export async function tick(db: Db, ownerId = OWNER_ID, now = Date.now()): Promise<JobRun[]> {
  const rows = await db.query<{ job_id: JobId; interval_min: number; enabled: boolean; last_run_at: number | null; not_before: number | null }>("select job_id, interval_min, enabled, last_run_at, not_before from jobs where owner_id = $1", [ownerId]);
  const connected = await connectedTo(db, ownerId);
  const live = new Set(liveJobs(telegramAvailable()).map((j) => j.id));
  const runs: JobRun[] = [];
  // In the order they are defined: the people and channel list before messages, messages before tasks.
  for (const def of [...JOBS].sort((a, b) => Number(b.id === "slack-directory-sync") - Number(a.id === "slack-directory-sync"))) {
    const row = rows.find((r) => r.job_id === def.id);
    // A check that cannot work yet is not run on a timer. It can still be run by hand.
    if (!row || def.follows || !live.has(def.id)) continue;
    // A job whose source is not connected is skipped quietly, not logged as a failure every minute.
    if (def.needs && (def.needs === "ai" ? !aiConfigured() : !connected.has(def.needs))) continue;
    const setting: JobSetting = { id: def.id, intervalMin: row.interval_min, enabled: row.enabled };
    if (!isDue(setting, row.last_run_at == null ? null : Number(row.last_run_at), now, row.not_before == null ? null : Number(row.not_before))) continue;
    const run = await runJob(db, def.id, ownerId, now);
    runs.push(run);
    // Jobs that follow another run right after it succeeds.
    if (run.ok) for (const follower of JOBS.filter((j) => j.follows?.includes(def.id))) runs.push(await runJob(db, follower.id, ownerId, now));
  }
  return runs;
}

/**
 * What "Sync now" does: every working check whose source is connected, whatever its timer
 * says. The people and channel list goes first, then messages, then calls.
 */
export async function syncAll(db: Db, ownerId = OWNER_ID): Promise<JobRun[]> {
  const connected = await connectedTo(db, ownerId);
  const live = new Set(liveJobs(telegramAvailable()).map((j) => j.id));
  const runs: JobRun[] = [];
  for (const def of [...JOBS].sort((a, b) => Number(b.id === "slack-directory-sync") - Number(a.id === "slack-directory-sync"))) {
    if (!live.has(def.id) || def.follows) continue;
    if (def.needs && (def.needs === "ai" ? !aiConfigured() : !connected.has(def.needs))) continue;
    // Nothing leaves the outbox while sending is switched off.
    if (def.id === "outbox-retry" && !sendingEnabled()) continue;
    runs.push(...(await runNow(db, def.id, ownerId)));
  }
  return runs;
}

/** What "Run now" does: the job itself, then anything that follows it. */
export async function runNow(db: Db, jobId: JobId, ownerId = OWNER_ID, now = Date.now()): Promise<JobRun[]> {
  const runs = [await runJob(db, jobId, ownerId, now)];
  if (runs[0].ok) for (const follower of JOBS.filter((j) => j.follows?.includes(jobId))) runs.push(await runJob(db, follower.id, ownerId, now));
  return runs;
}

export const jobName = (id: JobId) => jobById(id).name;
