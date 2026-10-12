import { ready } from "@/server/boot";
import { failed, signedIn, signInFirst } from "@/server/http";
import { loadTranscript, OWNER_ID } from "@/server/repo";

/** A call's transcript. Loaded on its own because transcripts run to hundreds of lines. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!signedIn(request)) return signInFirst();
  try {
    const { id } = await params;
    return Response.json({ transcript: await loadTranscript(await ready(), OWNER_ID, decodeURIComponent(id)) });
  } catch (error) {
    return failed(error, 500);
  }
}
