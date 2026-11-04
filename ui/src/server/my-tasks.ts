// The requests of the page of someone who signs in to see only their tasks (app/my-tasks), kept
// here so the tests can run them: reading their tickets, moving one along the board and, when the
// owner allowed it, sending the owner a task.
import type { MyTasksAnswer, TicketStatus } from "@/core/types";
import type { Db } from "./db";
import { failed, fromDashboard, refused, signInFirst } from "./http";
import { sessionOf } from "./session";
import { memberOfSession, type Member } from "./task-logins";
import { mayMemberSend, memberSendsTicket, memberSentTickets, memberSetsStatus, memberTickets } from "./tickets";

/** Their name, their tickets and, when they may send the owner tasks, those they sent. */
async function answer(db: Db, member: Member): Promise<MyTasksAnswer> {
  const [tasks, send] = await Promise.all([memberTickets(db, member.id), mayMemberSend(db, member.id)]);
  return { name: member.name, tasks, ...(send ? { send: { to: send.to, sent: await memberSentTickets(db, member.id) } } : {}) };
}

/** Their page's data, and nothing else. Signed out when the session is not a task login's, or no longer matches it. */
export async function myTasks(request: Request, db: Db): Promise<Response> {
  try {
    const member = await memberOfSession(db, sessionOf(request));
    if (!member) return signInFirst(request);
    return Response.json(await answer(db, member));
  } catch (error) {
    return failed(error, 500);
  }
}

/** Moves one of their own tickets along the board: { id, status }. Answers with their page as it is now. */
export async function moveMyTask(request: Request, db: Db): Promise<Response> {
  if (!fromDashboard(request)) return refused();
  try {
    const member = await memberOfSession(db, sessionOf(request));
    if (!member) return signInFirst(request);
    // The status is checked against the board's own (see memberSetsStatus).
    const { id, status } = (await request.json()) as { id?: unknown; status?: unknown };
    await db.transaction((tx) => memberSetsStatus(tx, member, String(id ?? ""), status as TicketStatus));
    return Response.json(await answer(db, member));
  } catch (error) {
    return failed(error);
  }
}

/**
 * Sends the owner a task: { title, description, due, line }. Refused unless the owner turned it
 * on for them (see `memberSendsTicket`). Answers with the task's name on the board and their page as it is now.
 */
export async function sendMyTask(request: Request, db: Db): Promise<Response> {
  if (!fromDashboard(request)) return refused();
  try {
    const member = await memberOfSession(db, sessionOf(request));
    if (!member) return signInFirst(request);
    const input = (await request.json()) as { title?: unknown; description?: unknown; due?: unknown; line?: unknown };
    const ticket = await db.transaction((tx) => memberSendsTicket(tx, member, input));
    return Response.json({ ticket, ...(await answer(db, member)) });
  } catch (error) {
    return failed(error);
  }
}
