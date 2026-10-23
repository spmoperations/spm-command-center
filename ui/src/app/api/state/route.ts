import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedInAs, signInFirst } from "@/server/http";
import { stampsFrom, stateUpdate } from "@/server/repo";

/**
 * Everything the screens show, read fresh from the database. With `have` (the stamps of what the
 * page already has), only what changed since, or `{ unchanged: true }`. `open` is the
 * conversation open on the page: it comes whole.
 */
export async function GET(request: Request) {
  await connection();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const url = new URL(request.url);
    return Response.json(await stateUpdate(await ready(), owner, stampsFrom(url.searchParams.get("have")), url.searchParams.get("open")));
  } catch (error) {
    return failed(error, 500);
  }
}
