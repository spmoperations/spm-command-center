import { ready } from "@/server/boot";
import { emailPageResponse } from "@/server/email-page";
import { signedInAs, signInFirst } from "@/server/http";

/** One email as its sender laid it out: /api/gmail/message?c=<email row>&m=<Gmail message id>. */
export async function GET(request: Request) {
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  const q = new URL(request.url).searchParams;
  return emailPageResponse(await ready(), owner, q.get("c") ?? "", q.get("m") ?? "");
}
