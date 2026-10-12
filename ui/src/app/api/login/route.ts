import { failed, fromDashboard, refused, sameSite } from "@/server/http";
import { checkLogin, clearFailures, createSession, isHttps, lockedFor, loginConfigured, recordFailure, sessionCookie } from "@/server/session";

type Problem = "setup" | "locked" | "wrong";
const PROBLEM: Record<Problem, [message: string, status: number]> = {
  setup: ["Sign-in is not set up yet. Add LOGIN_EMAIL and LOGIN_PASSWORD to .env.local and restart.", 503],
  locked: ["Too many wrong tries. Wait a few minutes and try again.", 429],
  wrong: ["That email and password do not match.", 401],
};

/**
 * Signs a person in. The login page sends { email, password } as JSON. If its script has not
 * loaded yet, the browser sends the form itself: that works too, and answers with a redirect.
 */
export async function POST(request: Request) {
  const plainForm = (request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded");
  if (plainForm ? !sameSite(request) : !fromDashboard(request)) return refused();
  const no = (problem: Problem) =>
    plainForm ? new Response(null, { status: 303, headers: { Location: `/login?error=${problem}` } }) : failed(new Error(PROBLEM[problem][0]), PROBLEM[problem][1]);

  if (!loginConfigured()) return no("setup");
  // Wrong passwords are counted per caller and for everyone together.
  const caller = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (Math.max(lockedFor(caller), lockedFor("everyone")) > 0) return no("locked");
  try {
    const { email, password } = (plainForm ? Object.fromEntries(await request.formData()) : await request.json()) as { email?: unknown; password?: unknown };
    if (typeof email !== "string" || typeof password !== "string" || !checkLogin(email, password)) {
      recordFailure(caller);
      recordFailure("everyone");
      return no("wrong");
    }
    clearFailures(caller);
    const cookie = { "Set-Cookie": sessionCookie(createSession(email.trim().toLowerCase()), isHttps(request)) };
    return plainForm ? new Response(null, { status: 303, headers: { Location: "/", ...cookie } }) : Response.json({ ok: true }, { headers: cookie });
  } catch (error) {
    return failed(error);
  }
}
