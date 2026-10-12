import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedIn, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

/** Everything the screens show, read fresh from the database on every request. */
export async function GET(request: Request) {
  await connection();
  if (!signedIn(request)) return signInFirst();
  try {
    return Response.json(await loadState(await ready()));
  } catch (error) {
    return failed(error, 500);
  }
}
