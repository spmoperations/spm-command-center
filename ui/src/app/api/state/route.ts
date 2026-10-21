import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedInAs, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

/** Everything the screens show, read fresh from the database on every request. */
export async function GET(request: Request) {
  await connection();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    return Response.json(await loadState(await ready(), owner));
  } catch (error) {
    return failed(error, 500);
  }
}
