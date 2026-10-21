import type { Provider } from "@/core/types";
import { runNow } from "@/jobs/runner";
import { ready } from "@/server/boot";
import { connect, ConnectionError } from "@/server/connections";
import { failed, fromDashboard, refused, signedInAs, signInFirst } from "@/server/http";
import { loadState } from "@/server/repo";

/**
 * Connects a service: { provider, secret }. The key is checked with the service, stored
 * encrypted, and never sent back to the browser.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const { provider, secret } = (await request.json()) as { provider: Provider; secret: string };
    const db = await ready();
    const { label } = await connect(db, owner, provider, secret);
    // Fill the dashboard in the background, so the person is not left waiting on this request.
    void (async () => {
      if (provider === "slack") {
        await runNow(db, "slack-directory-sync", owner);
        await runNow(db, "slack-pull", owner);
      } else if (provider === "fathom") {
        await runNow(db, "fathom-pull", owner);
      }
    })().catch((error) => console.error("[command-center] first read failed:", (error as Error).message));
    return Response.json({ label, state: await loadState(db, owner) });
  } catch (error) {
    return failed(error, error instanceof ConnectionError ? 400 : 500);
  }
}
