import { bookingPageName } from "@/server/calendly";
import { fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";

/**
 * The name of a Calendly booking page: { link } gives { name }, such as "Introduction Session",
 * or null when the page cannot be read. Settings keeps it with a booking link added by hand, so
 * the calls booked through it are known from the calendar. Reads the public page only.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!(await signedInAs(request))) return signInFirst(request);
  const { link } = (await request.json().catch(() => ({}))) as { link?: unknown };
  return Response.json({ name: typeof link === "string" ? await bookingPageName(link.slice(0, 500)) : null });
}
