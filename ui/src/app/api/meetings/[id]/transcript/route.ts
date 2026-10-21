import { ready } from "@/server/boot";
import { failed, signedInAs, signInFirst } from "@/server/http";
import { loadTranscript } from "@/server/repo";

/** A call's transcript. Loaded on its own because transcripts run to hundreds of lines. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const { id } = await params;
    return Response.json({ transcript: await loadTranscript(await ready(), owner, decodeURIComponent(id)) });
  } catch (error) {
    return failed(error, 500);
  }
}
