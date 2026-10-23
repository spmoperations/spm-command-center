import { connection } from "next/server";
import { ready } from "@/server/boot";
import { failed, refused, sameSite, signedInAs, signInFirst } from "@/server/http";
import { pictureResponse, uploadResponse } from "@/server/pictures";

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

/**
 * A picture pasted or picked for a reply, as its own bytes with the picture's type. Only the
 * dashboard's own pages send one: a picture type cannot be sent from another site without the
 * browser asking first, and it would refuse.
 */
export async function POST(request: Request) {
  if (!sameSite(request) || !(request.headers.get("content-type") ?? "").startsWith("image/")) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    return await uploadResponse(await ready(), owner, request);
  } catch (error) {
    return failed(error, 500);
  }
}
