// The checks the Command Center runs. Each one is its own small script with its own timer,
// set from Settings. Only `task-suggest` calls an AI model; everything else is plain code.
// Listed in the order they run: sorting before the request finder, which uses the priority.
import type { JobId, JobSetting, Provider } from "./types";

/** What a job needs before it can run: a provider the person connects, or the AI key set on the server. */
export type Connection = Provider | "ai";

export interface JobDefinition {
  id: JobId;
  name: string;
  /** Tab the results show up in. */
  tab: string;
  /** Minutes between runs by default. */
  defaultMin: number;
  /** Fastest allowed, so a timer cannot be set quick enough to hit a service's limit. */
  minMin: number;
  usesAI: boolean;
  /** Connection that must exist before the job can run. */
  needs: Connection | null;
  /** Runs right after other jobs rather than on its own timer. */
  follows?: JobId[];
  /**
   * False for a check that cannot work yet. It is left off the Timers screen and is not run
   * on a timer. Set it to true once the thing it waits for is there.
   */
  live: boolean;
}

export const JOBS: JobDefinition[] = [
  { id: "slack-pull", name: "Gets new Slack messages", tab: "Inbox", defaultMin: 60, minMin: 5, usesAI: false, needs: "slack", live: true },
  // Local-only for now: it runs only where the server says Telegram can be used (see `liveJobs`).
  { id: "telegram-pull", name: "Gets new Telegram messages", tab: "Inbox", defaultMin: 60, minMin: 30, usesAI: false, needs: "telegram", live: false },
  { id: "fathom-pull", name: "Gets new calls from Fathom", tab: "Meetings", defaultMin: 60, minMin: 15, usesAI: false, needs: "fathom", live: true },
  // Like Telegram, these run only where the server says Google can be used (see `liveJobs`).
  { id: "gmail-pull", name: "Gets new emails from Gmail", tab: "Inbox", defaultMin: 15, minMin: 5, usesAI: false, needs: "google", live: false },
  { id: "calendar-pull", name: "Gets the meetings coming up", tab: "Meetings", defaultMin: 30, minMin: 10, usesAI: false, needs: "google", live: false },
  { id: "inbox-rules", name: "Marks what is urgent, adds labels", tab: "Inbox", defaultMin: 60, minMin: 5, usesAI: false, needs: null, follows: ["slack-pull", "telegram-pull", "gmail-pull"], live: true },
  { id: "request-finder", name: "Finds messages that ask you for something", tab: "Tasks", defaultMin: 60, minMin: 5, usesAI: false, needs: null, follows: ["slack-pull", "telegram-pull", "gmail-pull"], live: true },
  // Built and tested, but the Claude account has no credit, so every run fails. Set live to true once it has.
  { id: "task-suggest", name: "Finds other tasks in your messages", tab: "Tasks", defaultMin: 60, minMin: 15, usesAI: true, needs: "ai", live: false },
  { id: "slack-directory-sync", name: "Updates your channel and team list", tab: "Settings", defaultMin: 1440, minMin: 60, usesAI: false, needs: "slack", live: true },
  { id: "outbox-retry", name: "Retries anything that failed to send", tab: "Inbox", defaultMin: 1, minMin: 1, usesAI: false, needs: null, live: true },
];

/** The checks that work on this server. The Telegram and Google ones join them where those can be used. */
export const liveJobs = (telegram: boolean, google = false) =>
  JOBS.filter((j) => j.live || (telegram && j.id === "telegram-pull") || (google && (j.id === "gmail-pull" || j.id === "calendar-pull")));

export const jobById = (id: JobId) => JOBS.find((j) => j.id === id)!;

export const defaultJobSettings = (): JobSetting[] =>
  JOBS.map((j) => ({ id: j.id, intervalMin: j.defaultMin, enabled: true }));

/** Keeps a requested timer at or above the job's fastest allowed value. */
export function clampInterval(id: JobId, minutes: number): number {
  const job = jobById(id);
  if (!Number.isFinite(minutes)) return job.defaultMin;
  return Math.max(job.minMin, Math.round(minutes));
}

/** When the job should next run. A job that has never run is due straight away. */
export function nextRunAt(setting: JobSetting, lastRunAt: number | null, notBefore: number | null = null): number | null {
  if (!setting.enabled) return null;
  const byTimer = lastRunAt == null ? 0 : lastRunAt + setting.intervalMin * 60_000;
  return Math.max(byTimer, notBefore ?? 0);
}

export function isDue(setting: JobSetting, lastRunAt: number | null, now: number, notBefore: number | null = null): boolean {
  const next = nextRunAt(setting, lastRunAt, notBefore);
  return next != null && next <= now;
}

/**
 * When a service answers "slow down" (Slack's Retry-After, Telegram's FLOOD_WAIT),
 * the job must not run again before the wait is over.
 */
export const waitUntil = (now: number, retryAfterSeconds: number) => now + Math.max(0, retryAfterSeconds) * 1000;

export function describeInterval(minutes: number): string {
  if (minutes === 1) return "Every minute";
  if (minutes < 60) return `Every ${minutes} minutes`;
  if (minutes === 60) return "Every hour";
  if (minutes === 1440) return "Once a day";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}
