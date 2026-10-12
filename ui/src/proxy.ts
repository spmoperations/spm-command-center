// Runs before every page and API request. Anyone who is not signed in is sent to the login
// page, or told so if they asked the API. The API routes check the session again themselves,
// so this is the first lock on the door and not the only one.
import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE } from "@/server/session";

// The login page and its request are open to everyone. So is the scheduler's route: it has
// no session, and checks its own secret instead.
const OPEN = new Set(["/login", "/api/login", "/api/cron"]);

export function proxy(request: NextRequest) {
  const { pathname, protocol, host } = request.nextUrl;
  // Redirects keep the address the person typed. Next rewrites 127.0.0.1 to "localhost" in
  // its own copy of the URL, and the session cookie would not follow to a different host.
  const site = `${protocol}//${request.headers.get("host") ?? host}`;
  const signedIn = readSession(request.cookies.get(SESSION_COOKIE)?.value) !== null;
  if (OPEN.has(pathname)) {
    // Someone already signed in has no use for the login page.
    return signedIn && pathname === "/login" ? NextResponse.redirect(new URL("/", site)) : NextResponse.next();
  }
  if (signedIn) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const login = new URL("/login", site);
  if (pathname !== "/") login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the files a page is built from.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
