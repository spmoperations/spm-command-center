import { addCalendarEvent, deleteCalendarEvent, respondToEvent, updateCalendarEvent, type EventForm } from "@/jobs/calendar";
import { ready } from "@/server/boot";
import { googleApi, GoogleSaid, type InviteAnswer } from "@/server/google";
import { failed, fromDashboard, refused, signedIn, signInFirst } from "@/server/http";
import { loadState, OWNER_ID } from "@/server/repo";

type Body = EventForm & { action?: "add" | "update" | "delete" | "respond"; eventId?: string; answer?: InviteAnswer };

/**
 * The Calendar tab's changes to Google Calendar: a new event (with its guests invited), a change
 * or a delete of one the owner made, and an answer to an invitation.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  if (!signedIn(request)) return signInFirst();
  try {
    const body = (await request.json()) as Body;
    if (typeof body.account !== "string") return failed(new Error("Which calendar?"));
    const action = body.action ?? "add";
    if (action !== "add" && typeof body.eventId !== "string") return failed(new Error("Which event?"));
    const db = await ready();
    const open = (email: string) => googleApi(db, OWNER_ID, email);
    const done =
      action === "add"
        ? await addCalendarEvent(db, OWNER_ID, body, open)
        : action === "update"
          ? await updateCalendarEvent(db, OWNER_ID, body.eventId!, body, open)
          : action === "delete"
            ? await deleteCalendarEvent(db, OWNER_ID, body.account, body.eventId!, open)
            : await respondToEvent(db, OWNER_ID, body.account, body.eventId!, body.answer as InviteAnswer, open);
    return Response.json({ ...done, state: await loadState(db) });
  } catch (error) {
    return failed(error instanceof GoogleSaid ? error : new Error(`Google Calendar did not take it: ${(error as Error).message}`));
  }
}
