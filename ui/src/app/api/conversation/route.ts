import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedInAs, signInFirst } from "@/server/http";
import { loadConversation } from "@/server/repo";

/** ?id= One conversation, whole, when it is opened: the inbox brings only each chat's newest messages. */
export async function GET(request: Request) {
  await connection();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return failed(new Error("Which conversation?"));
    return Response.json({ conversation: await loadConversation(await ready(), owner, id) });
  } catch (error) {
    return failed(error, 500);
  }
}
