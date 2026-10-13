import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, signedIn, signInFirst } from "@/server/http";
import { pictureResponse } from "@/server/pictures";
import { OWNER_ID } from "@/server/repo";

export const maxDuration = 30;

/**
 * A picture, sticker or profile picture that belongs to a message. The pages ask for it
 * with an ordinary <img>, and only a signed-in person gets it.
 */
export async function GET(request: Request) {
  await connection();
  if (!signedIn(request)) return signInFirst();
  try {
    return await pictureResponse(await ready(), OWNER_ID, new URL(request.url).searchParams);
  } catch (error) {
    return failed(error, 500);
  }
}
