import { connection } from "next/server";
import { failed, fromDashboard, refused, sameSite } from "@/server/http";
import { ready } from "@/server/boot";
import { googleSignInOffered } from "@/server/google-sign-in";
import { clearFailures, createSession, isHttps, lockedFor, loginConfigured, recordFailure, sessionCookie } from "@/server/session";
import { memberByPassword, signedInNow } from "@/server/task-logins";
import { signInAs } from "@/server/team";

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
    // The owner's login (LOGIN_EMAIL) or a team member's; else someone on the team list who sees only their tasks.
    const given = typeof email === "string" && typeof password === "string" ? { email, password } : null;
    const who = given ? await signInAs(ready, given.email, given.password) : null;
    const member = given && !who ? await memberByPassword(await ready(), given.email, given.password) : null;
    if (!given || (!who && !member)) {
      recordFailure(caller);
      recordFailure("everyone");
      return no("wrong");
    }
    clearFailures(caller);
    if (member) await signedInNow(await ready(), member.member.id, Date.now());
    const session = member ? createSession(member.member.email, Date.now(), member.mark, true) : createSession(given.email.trim().toLowerCase(), Date.now(), who!.mark);
    const cookie = { "Set-Cookie": sessionCookie(session, isHttps(request)) };
    return plainForm ? new Response(null, { status: 303, headers: { Location: member ? "/my-tasks" : "/", ...cookie } }) : Response.json({ ok: true }, { headers: cookie });
  } catch (error) {
    return failed(error);
  }
}

/** What the login page offers besides the email and password: Sign in with Google, where it is set up. */
export async function GET() {
  // Read when asked, never when the site is built.
  await connection();
  try {
    return Response.json({ google: await googleSignInOffered(await ready()) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ google: false });
  }
}
