import { connection } from "next/server";
import { ready } from "@/server/boot";
import { moveMyTask, myTasks } from "@/server/my-tasks";

/** What someone on the team list signed in with a task login sees: their name and their tickets, and nothing else. */
export async function GET(request: Request) {
  await connection();
  return myTasks(request, await ready());
}

/** Moves one of their own tickets along the board: { id, status }. */
export async function POST(request: Request) {
  return moveMyTask(request, await ready());
}
