import { fromDashboard, refused } from "@/server/http";
import { clearedCookie, isHttps } from "@/server/session";

/** Signs the person out by clearing the session cookie. */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearedCookie(isHttps(request)) } });
}
