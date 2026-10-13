import { normalizePhone } from "@/core/providers";
import { runNow } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { forgetTelegramMedia } from "@/server/media";
import { loadState, OWNER_ID } from "@/server/repo";
import {
  cancelTelegramLogin, disconnectTelegram, giveTelegramCode, giveTelegramPassword, startTelegramLogin, telegramBlocked, type TelegramStep,
} from "@/server/telegram";

// Waiting for Telegram to send a code can take a few seconds.
export const maxDuration = 60;

type Body =
  | { step: "start"; phone?: unknown }
  | { step: "code"; code?: unknown }
  | { step: "password"; password?: unknown }
  | { step: "cancel" }
  | { step: "disconnect"; forget?: unknown };

/**
 * Connecting Telegram, one step per request: the phone number, then the code Telegram sends,
 * then the account's password if it has one. Works only where the data stays on this machine.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  const blocked = telegramBlocked();
  if (blocked) return failed(new Error(blocked));
  try {
    const body = (await request.json()) as Body;
    let step: TelegramStep | null = null;

    if (body.step === "start") {
      const phone = normalizePhone(String(body.phone ?? ""));
      if (!phone) return failed(new Error("Type the number with its country code, for example +44 7700 900123."));
      step = await startTelegramLogin(phone);
    } else if (body.step === "code") {
      step = await giveTelegramCode(String(body.code ?? ""));
    } else if (body.step === "password") {
      step = await giveTelegramPassword(String(body.password ?? ""));
    } else if (body.step === "cancel") {
      await cancelTelegramLogin();
      return Response.json({ cancelled: true });
    } else if (body.step === "disconnect") {
      await disconnectTelegram();
      const db = await ready();
      // "forget" also removes the chats that were read, so nothing of the account is left here.
      if (body.forget === true) {
        await db.run("delete from conversations where owner_id = $1 and source = 'telegram'", [OWNER_ID]);
        forgetTelegramMedia();
      }
      await db.run("update jobs set cursor = '{}', last_run_at = null where owner_id = $1 and job_id = 'telegram-pull'", [OWNER_ID]);
      return Response.json({ disconnected: true, state: await loadState(db) });
    } else {
      return failed(new Error("Unknown step."));
    }

    if (!("connected" in step)) return Response.json(step);
    const db = await ready();
    // Fill the inbox in the background, so the person is not left waiting on this request.
    void runNow(db, "telegram-pull").catch((error) => console.error("[command-center] first Telegram read failed:", (error as Error).message));
    return Response.json({ ...step, state: await loadState(db) });
  } catch (error) {
    return failed(error);
  }
}
