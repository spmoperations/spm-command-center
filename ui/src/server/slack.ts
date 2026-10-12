// A small client for Slack's Web API, used with the person's own user token (xoxp-).
// Reads go out as GET. The two calls that send a message are POST and are only ever
// reached through the outbox, which is switched off unless SENDING_ENABLED=true.

/** A service asked us to slow down. The job stops and may not run again before `waitSeconds`. */
export class RateLimited extends Error {
  constructor(public service: string, public waitSeconds: number) {
    super(`${service} asked us to wait ${waitSeconds} seconds`);
  }
}

export class SlackError extends Error {
  constructor(public method: string, public code: string) {
    super(`Slack ${method} failed: ${code}`);
  }
}

type Params = Record<string, string | number | boolean | undefined>;
export type Fetch = typeof fetch;

const WRITE_METHODS = new Set(["chat.postMessage", "conversations.open"]);

export interface SlackClient {
  call<T = Record<string, unknown>>(method: string, params?: Params): Promise<T>;
  /** Follows Slack's cursor until the list ends or `maxPages` is reached. */
  list<T>(method: string, key: string, params?: Params, maxPages?: number): Promise<T[]>;
}

export function slackClient(token: string, fetchImpl: Fetch = fetch): SlackClient {
  async function call<T>(method: string, params: Params = {}): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    const write = WRITE_METHODS.has(method);
    const res = await fetchImpl(`https://slack.com/api/${method}${write ? "" : `?${body}`}`, {
      method: write ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, ...(write ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: write ? body : undefined,
    });
    if (res.status === 429) throw new RateLimited("Slack", Number(res.headers.get("retry-after") ?? 60));
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      if (data.error === "ratelimited") throw new RateLimited("Slack", Number(res.headers.get("retry-after") ?? 60));
      throw new SlackError(method, data.error ?? `http ${res.status}`);
    }
    return data as T;
  }

  async function list<T>(method: string, key: string, params: Params = {}, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const data = await call<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(method, { ...params, cursor });
      out.push(...((data[key] as T[] | undefined) ?? []));
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  return { call, list };
}

/** Checks a token and says whose it is. Used when connecting, before anything is stored. */
export async function verifySlackToken(token: string, fetchImpl: Fetch = fetch) {
  const who = await slackClient(token, fetchImpl).call<{ user: string; user_id: string; team: string; team_id: string; bot_id?: string }>("auth.test");
  if (who.bot_id) throw new SlackError("auth.test", "this is a bot token, a user token is needed");
  return { userId: who.user_id, teamId: who.team_id, label: `${who.user} · ${who.team}` };
}
