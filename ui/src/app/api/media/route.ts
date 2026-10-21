import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedInAs, signInFirst } from "@/server/http";
import { pictureResponse } from "@/server/pictures";

export const maxDuration = 30;

/**
 * A picture, sticker or profile picture that belongs to a message. The pages ask for it
 * with an ordinary <img>, and only a signed-in person gets it.
 */
export async function GET(request: Request) {
  await connection();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    return await pictureResponse(await ready(), owner, new URL(request.url).searchParams);
  } catch (error) {
    return failed(error, 500);
  }
}
