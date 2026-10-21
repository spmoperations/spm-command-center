import { ready } from "@/server/boot";
import { emailPageResponse } from "@/server/email-page";
import { signedIn, signInFirst } from "@/server/http";
import { OWNER_ID } from "@/server/repo";

/** One email as its sender laid it out: /api/gmail/message?c=<email row>&m=<Gmail message id>. */
export async function GET(request: Request) {
  if (!signedIn(request)) return signInFirst();
  const q = new URL(request.url).searchParams;
  return emailPageResponse(await ready(), OWNER_ID, q.get("c") ?? "", q.get("m") ?? "");
}
