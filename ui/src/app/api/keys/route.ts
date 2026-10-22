import { keysProblem, retireKeys, saveKeys, tidyKeys, type KeyProvider } from "@/server/app-keys";
import { checkAiKey } from "@/server/ai";
import { ready } from "@/server/boot";
import { checkGoogleKeys } from "@/server/google";
import { failed, fromDashboard, refused, signedInAs, signInFirst, siteOf } from "@/server/http";
import { loadState } from "@/server/repo";

// Checking keys with Google or Anthropic takes a moment.
export const maxDuration = 30;

/** How each key is named on screen, for messages about it. */
const FIELD: Record<string, string> = { clientId: "Client ID", clientSecret: "Client secret", apiId: "api_id", apiHash: "api_hash", apiKey: "API key" };
const PROVIDERS: KeyProvider[] = ["google", "telegram", "anthropic", "slack"];

/**
 * A person's own app keys: { step: "save", provider, keys } checks them and keeps them, sealed,
 * for that person's new connections; { step: "stop", provider } goes back to the team's keys.
 * Accounts connected before keep the keys they were connected with. The keys are never sent back.
 */
export async function POST(request: Request) {
  if (!fromDashboard(request)) return refused();
  const owner = await signedInAs(request);
  if (!owner) return signInFirst(request);
  try {
    const body = (await request.json()) as { step?: unknown; provider?: unknown; keys?: unknown };
    const provider = PROVIDERS.find((p) => p === body.provider);
    if (!provider) return failed(new Error("Which app's keys?"));
    const db = await ready();
    if (body.step === "stop") {
      await retireKeys(db, owner, provider, Date.now());
      return Response.json({ state: await loadState(db, owner) });
    }
    if (body.step !== "save" || typeof body.keys !== "object" || !body.keys) return failed(new Error("Unknown step."));
    const given = body.keys as Record<string, unknown>;
    const problem = keysProblem(provider, given, (k) => FIELD[k] ?? k);
    if (problem) return failed(new Error(problem));
    const keys = tidyKeys(provider, given);
    // Checked with the service first where it can be: wrong keys are never saved.
    if (provider === "google") await checkGoogleKeys(keys as Parameters<typeof checkGoogleKeys>[0], `${siteOf(request)}/api/google/callback`);
    if (provider === "anthropic") await checkAiKey(keys as Parameters<typeof checkAiKey>[0]);
    // Slack cannot check its keys without a real login: a wrong one shows on the first Connect Slack.
    await saveKeys(db, owner, provider, keys, Date.now());
    return Response.json({ state: await loadState(db, owner) });
  } catch (error) {
    return failed(error);
  }
}
