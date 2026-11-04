import { ready } from "@/server/boot";
import { sendMyTask } from "@/server/my-tasks";

/** Someone with a task login sends the owner a task, when the owner allowed it: { title, description, due, line }. */
export async function POST(request: Request) {
  return sendMyTask(request, await ready());
}
