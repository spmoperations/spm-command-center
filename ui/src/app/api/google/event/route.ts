import { addCalendarEvent, type EventForm } from "@/jobs/calendar";
import { ready } from "@/server/boot";
import { googleApi, GoogleSaid } from "@/server/google";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState, OWNER_ID } from "@/server/repo";

/** New event on the Calendar tab: adds it to the chosen account's Google Calendar, with its guests invited. */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const form = (await request.json()) as EventForm;
    if (typeof form.account !== "string") return failed(new Error("Which calendar?"));
    const db = await ready();
    const made = await addCalendarEvent(db, OWNER_ID, form, (email) => googleApi(db, OWNER_ID, email));
    return Response.json({ ...made, state: await loadState(db) });
  } catch (error) {
    return failed(error instanceof GoogleSaid ? error : new Error(`Google Calendar did not add the event: ${(error as Error).message}`));
  }
}
