import { after } from "next/server";
import { normalizePhone } from "@/core/providers";
import { runNow } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";
import { forgetTelegramMedia } from "@/server/media";
import { loadState } from "@/server/repo";
import { isHttps } from "@/server/session";
import { hostedProblem } from "@/server/app-keys";
import { disconnectTelegram, giveTelegramCode, giveTelegramPassword, mustHaveLoginInProgress, startTelegramLogin, type LoginTurn } from "@/server/telegram";

// Waiting for Telegram to send a code can take a few seconds.
export const maxDuration = 60;

type Body =
  | { step: "start"; phone?: unknown }
  | { step: "code"; code?: unknown }
  | { step: "password"; password?: unknown }
  | { step: "cancel" }
  | { step: "disconnect"; forget?: unknown };

/** The login in progress travels in this cookie, sealed, between one step and the next. Only this route ever sees it. */
const LOGIN_COOKIE = "cc_telegram_login";

function loginCookie(request: Request, value: string | null): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `${LOGIN_COOKIE}=${value ?? ""}; Path=/api/telegram; HttpOnly; SameSite=Strict; Max-Age=${value ? 600 : 0}${secure}`;
}

function pendingOf(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === LOGIN_COOKIE) return part.slice(at + 1).trim() || null;
  }
  return null;
}

/**
 * Connecting Telegram, one step per request: the phone number, then the code Telegram sends,
 * then the account's password if it has one. Works only on a server that may use Telegram.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  // Refused before anything is sent to Telegram on a server that may not hold a Telegram login.
  const hosted = hostedProblem("telegram");
  if (hosted) return failed(new Error(hosted));
  const answer = (body: unknown, pending: string | null) => Response.json(body, { headers: { "set-cookie": loginCookie(request, pending) } });
  try {
    const body = (await request.json()) as Body;
    let turn: LoginTurn;

    if (body.step === "start") {
      const phone = normalizePhone(String(body.phone ?? ""));
      if (!phone) return failed(new Error("Type the number with its country code, for example +44 7700 900123."));
      turn = await startTelegramLogin(await ready(), owner, phone);
    } else if (body.step === "code") {
      mustHaveLoginInProgress(pendingOf(request));
      turn = await giveTelegramCode(await ready(), owner, pendingOf(request), String(body.code ?? ""));
    } else if (body.step === "password") {
      mustHaveLoginInProgress(pendingOf(request));
      turn = await giveTelegramPassword(await ready(), owner, pendingOf(request), String(body.password ?? ""));
    } else if (body.step === "cancel") {
      return answer({ cancelled: true }, null);
    } else if (body.step === "disconnect") {
      const db = await ready();
      await disconnectTelegram(db, owner);
      // "forget" also removes the chats that were read and their pictures, so nothing of the account is left here.
      if (body.forget === true) {
        await db.run("delete from conversations where owner_id = $1 and source = 'telegram'", [owner]);
        await db.run("delete from telegram_chats where owner_id = $1", [owner]);
        await forgetTelegramMedia(db, owner);
      }
      await db.run("update jobs set cursor = '{}', last_run_at = null where owner_id = $1 and job_id = 'telegram-pull'", [owner]);
      return answer({ disconnected: true, state: await loadState(db, owner) }, null);
    } else {
      return failed(new Error("Unknown step."));
    }

    if (!("connected" in turn.step)) return answer(turn.step, turn.pending);
    const db = await ready();
    // Fill the inbox once the answer has gone out, so the person is not left waiting on this
    // request. `after` keeps a host's server awake until the read is done.
    after(() => runNow(db, "telegram-pull", owner).catch((error) => console.error("[command-center] first Telegram read failed:", (error as Error).message)));
    return answer({ ...turn.step, state: await loadState(db, owner) }, null);
  } catch (error) {
    return failed(error);
  }
}
