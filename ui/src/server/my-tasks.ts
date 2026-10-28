// The two requests of the page of someone who signs in to see only their tasks (app/my-tasks),
// kept here so the tests can run them: reading their tickets, and moving one along the board.
import type { TicketStatus } from "@/core/types";
import type { Db } from "./db";
import { failed, fromDashboard, refused, signInFirst } from "./http";
import { sessionOf } from "./session";
import { memberOfSession } from "./task-logins";
import { memberSetsStatus, memberTickets } from "./tickets";

/** Their name and their tickets, and nothing else. Signed out when the session is not a task login's, or no longer matches it. */
export async function myTasks(request: Request, db: Db): Promise<Response> {
  try {
    const member = await memberOfSession(db, sessionOf(request));
    if (!member) return signInFirst(request);
    return Response.json({ name: member.name, tasks: await memberTickets(db, member.id) });
  } catch (error) {
    return failed(error, 500);
  }
}

/** Moves one of their own tickets along the board: { id, status }. Answers with their tickets as they are now. */
export async function moveMyTask(request: Request, db: Db): Promise<Response> {
  if (!fromDashboard(request)) return refused();
  try {
    const member = await memberOfSession(db, sessionOf(request));
    if (!member) return signInFirst(request);
    // The status is checked against the board's own (see memberSetsStatus).
    const { id, status } = (await request.json()) as { id?: unknown; status?: unknown };
    await db.transaction((tx) => memberSetsStatus(tx, member, String(id ?? ""), status as TicketStatus));
    return Response.json({ name: member.name, tasks: await memberTickets(db, member.id) });
  } catch (error) {
    return failed(error);
  }
}
