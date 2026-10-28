// Runs before every page and API request. Anyone who is not signed in is sent to the login
// page, or told so if they asked the API. The API routes check the session again themselves,
// so this is the first lock on the door and not the only one.
import { NextResponse, type NextRequest } from "next/server";
import { readSession, SESSION_COOKIE } from "@/server/session";

// The login page and its requests are open to everyone, Sign in with Google and Google's way
// back among them. So is the scheduler's route: it has no session, and checks its own secret instead.
const OPEN = new Set(["/login", "/api/login", "/api/login/google", "/api/google/callback", "/api/cron"]);

// All that a task login may open: its own tickets, and signing out (see server/task-logins.ts).
const MY_TASKS = "/my-tasks";
const FOR_MEMBERS = new Set([MY_TASKS, "/api/my-tasks", "/api/logout"]);

export function proxy(request: NextRequest) {
  const { pathname, protocol, host, search, searchParams } = request.nextUrl;
  // Redirects keep the address the person typed. Next rewrites 127.0.0.1 to "localhost" in
  // its own copy of the URL, and the session cookie would not follow to a different host.
  const site = `${protocol}//${request.headers.get("host") ?? host}`;
  const session = readSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (OPEN.has(pathname)) {
    // Someone already signed in has no use for the login page.
    return session && pathname === "/login" ? NextResponse.redirect(new URL(session.member ? MY_TASKS : "/", site)) : NextResponse.next();
  }
  if (session?.member) {
    if (FOR_MEMBERS.has(pathname)) return NextResponse.next();
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "This login shows only your own tasks." }, { status: 403 });
    // Any other page, such as a ticket's link in a Slack message, opens their own tasks.
    const mine = new URL(MY_TASKS, site);
    const task = searchParams.get("task");
    if (task) mine.searchParams.set("task", task);
    return NextResponse.redirect(mine);
  }
  // The owner and team logins have the whole board.
  if (session) return pathname === MY_TASKS ? NextResponse.redirect(new URL("/tasks", site)) : NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const login = new URL("/login", site);
  // The page asked for, with its query, so a ticket's link still opens that ticket after signing in.
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the files a page is built from.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
