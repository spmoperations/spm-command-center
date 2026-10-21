import { addCalendarEvent, deleteCalendarEvent, respondToEvent, updateCalendarEvent, type EventForm } from "@/jobs/calendar";
import { ready } from "@/server/boot";
import { googleApi, GoogleSaid, type InviteAnswer } from "@/server/google";
import { failed, fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

type Body = EventForm & { action?: "add" | "update" | "delete" | "respond"; eventId?: string; answer?: InviteAnswer };

/**
 * The Calendar tab's changes to Google Calendar: a new event (with its guests invited), a change
 * or a delete of one the owner made, and an answer to an invitation.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const body = (await request.json()) as Body;
    if (typeof body.account !== "string") return failed(new Error("Which calendar?"));
    const action = body.action ?? "add";
    if (action !== "add" && typeof body.eventId !== "string") return failed(new Error("Which event?"));
    const db = await ready();
    const open = (email: string) => googleApi(db, owner, email);
    const done =
      action === "add"
        ? await addCalendarEvent(db, owner, body, open)
        : action === "update"
          ? await updateCalendarEvent(db, owner, body.eventId!, body, open)
          : action === "delete"
            ? await deleteCalendarEvent(db, owner, body.account, body.eventId!, open)
            : await respondToEvent(db, owner, body.account, body.eventId!, body.answer as InviteAnswer, open);
    return Response.json({ ...done, state: await loadState(db, owner) });
  } catch (error) {
    return failed(error instanceof GoogleSaid ? error : new Error(`Google Calendar did not take it: ${(error as Error).message}`));
  }
}
